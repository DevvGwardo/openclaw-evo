/**
 * Gateway Watchdog
 *
 * Monitors the OpenClaw gateway health and restarts it automatically
 * when it goes down. Integrates with EvoHub as an optional supervisor.
 *
 * Behaviour:
 *   1. Polls gateway health every WATCHDOG_CHECK_INTERVAL_MS (default 15s)
 *   2. After WATCHDOG_FAILURE_THRESHOLD consecutive failures (default 3),
 *      attempts to restart via `openclaw gateway start`
 *   3. Waits WATCHDOG_RESTART_COOLDOWN_MS (default 60s) before retrying
 *   4. Emits events for the hub to log/react to
 */

import { spawn } from 'child_process';
import { Gateway } from './openclaw/gateway.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  /** Gateway URL to monitor */
  gatewayUrl: string;
  /** How often to check health (ms) */
  checkIntervalMs: number;
  /** Consecutive failures before restart attempt */
  failureThreshold: number;
  /** Cooldown after a restart attempt (ms) */
  restartCooldownMs: number;
  /** Max restart attempts before giving up (0 = unlimited) */
  maxRestarts: number;
  /** Command to restart the gateway */
  restartCommand: string;
  /** Arguments for restart command */
  restartArgs: string[];
  /** Enable the watchdog */
  enabled: boolean;
}

const envInt = (key: string, fallback: number) =>
  parseInt(process.env[key] ?? String(fallback));

const envBool = (key: string, fallback: boolean) => {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  gatewayUrl:        process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789',
  checkIntervalMs:   envInt('WATCHDOG_CHECK_INTERVAL_MS', 15_000),
  failureThreshold:  envInt('WATCHDOG_FAILURE_THRESHOLD', 3),
  restartCooldownMs: envInt('WATCHDOG_RESTART_COOLDOWN_MS', 60_000),
  maxRestarts:       envInt('WATCHDOG_MAX_RESTARTS', 10),
  restartCommand:    process.env.WATCHDOG_RESTART_CMD ?? 'openclaw',
  restartArgs:       (process.env.WATCHDOG_RESTART_ARGS ?? 'gateway start').split(' '),
  enabled:           envBool('WATCHDOG_ENABLED', true),
};

// ── Events ──────────────────────────────────────────────────────────────────

export type WatchdogEvent =
  | { type: 'health_ok';       version?: string }
  | { type: 'health_fail';     consecutiveFailures: number }
  | { type: 'restarting';      attempt: number }
  | { type: 'restart_success'; attempt: number; uptimeCheckMs: number }
  | { type: 'restart_failed';  attempt: number; error: string }
  | { type: 'cooldown';        untilMs: number }
  | { type: 'max_restarts';    total: number }
  | { type: 'stopped' };

export type WatchdogListener = (_event: WatchdogEvent) => void;

// ── Watchdog ────────────────────────────────────────────────────────────────

export class GatewayWatchdog {
  private readonly config: WatchdogConfig;
  private readonly gateway: Gateway;
  private readonly listeners = new Set<WatchdogListener>();

  private checkTimer?: ReturnType<typeof setInterval>;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  private consecutiveFailures = 0;
  private totalRestarts = 0;
  private lastRestartAt = 0;
  private inCooldown = false;
  private gatewayUp = true;
  private gaveUp = false;

  constructor(config: Partial<WatchdogConfig> = {}) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
    this.gateway = new Gateway(this.config.gatewayUrl);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  addListener(fn: WatchdogListener): void {
    this.listeners.add(fn);
  }

  removeListener(fn: WatchdogListener): void {
    this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      console.log('[Watchdog] Disabled via config, skipping');
      return;
    }

    this.running = true;
    console.log(
      `[Watchdog] Started — checking ${this.config.gatewayUrl} every ${this.config.checkIntervalMs / 1000}s, ` +
      `restart after ${this.config.failureThreshold} failures`
    );

    // Run first check immediately, then on interval
    void this.check();
    this.checkTimer = setInterval(() => void this.check(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.emit({ type: 'stopped' });
    console.log('[Watchdog] Stopped');
  }

  /** Current watchdog state for status display */
  getState() {
    return {
      running: this.running,
      gatewayUp: this.gatewayUp,
      consecutiveFailures: this.consecutiveFailures,
      totalRestarts: this.totalRestarts,
      lastRestartAt: this.lastRestartAt || undefined,
      inCooldown: this.inCooldown,
    };
  }

  // ── Health check ────────────────────────────────────────────────────────

  private async check(): Promise<void> {
    if (!this.running) return;

    try {
      const status = await this.gateway.getStatus();

      if (status.connected) {
        // Gateway is up
        if (!this.gatewayUp) {
          console.log(`[Watchdog] Gateway is back up${status.version ? ` (v${status.version})` : ''}`);
        }
        this.gatewayUp = true;
        this.consecutiveFailures = 0;
        // Reset restart counter so watchdog can protect again in the future
        if (this.gaveUp || this.totalRestarts > 0) {
          this.totalRestarts = 0;
          this.gaveUp = false;
        }
        this.emit({ type: 'health_ok', version: status.version });
        return;
      }
    } catch {
      // getStatus() already catches internally, but just in case
    }

    // Gateway is down
    this.gatewayUp = false;
    this.consecutiveFailures++;
    this.emit({ type: 'health_fail', consecutiveFailures: this.consecutiveFailures });

    // Don't spam logs after we've given up
    if (this.gaveUp) return;

    if (this.consecutiveFailures === 1) {
      console.warn(`[Watchdog] Gateway health check failed (1/${this.config.failureThreshold})`);
    } else {
      console.warn(
        `[Watchdog] Gateway down — ${this.consecutiveFailures}/${this.config.failureThreshold} consecutive failures`
      );
    }

    // Threshold reached — attempt restart
    if (this.consecutiveFailures >= this.config.failureThreshold && !this.inCooldown) {
      await this.attemptRestart();
    }
  }

  // ── Restart logic ───────────────────────────────────────────────────────

  private async attemptRestart(): Promise<void> {
    // Check max restarts
    if (this.config.maxRestarts > 0 && this.totalRestarts >= this.config.maxRestarts) {
      if (!this.gaveUp) {
        console.error(
          `[Watchdog] Reached max restart attempts (${this.config.maxRestarts}). ` +
          `Manual intervention required. Will resume if gateway comes back.`
        );
        this.emit({ type: 'max_restarts', total: this.totalRestarts });
        this.gaveUp = true;
      }
      return;
    }

    this.totalRestarts++;
    this.lastRestartAt = Date.now();

    console.log(
      `[Watchdog] Attempting restart #${this.totalRestarts}: ` +
      `${this.config.restartCommand} ${this.config.restartArgs.join(' ')}`
    );
    this.emit({ type: 'restarting', attempt: this.totalRestarts });

    try {
      await this.runRestart();

      // Wait a few seconds then verify gateway came back
      const verifyDelayMs = 5_000;
      await new Promise((r) => setTimeout(r, verifyDelayMs));

      const status = await this.gateway.getStatus();
      if (status.connected) {
        console.log(`[Watchdog] Restart #${this.totalRestarts} successful — gateway is up`);
        this.gatewayUp = true;
        this.consecutiveFailures = 0;
        this.emit({ type: 'restart_success', attempt: this.totalRestarts, uptimeCheckMs: verifyDelayMs });
      } else {
        console.warn(`[Watchdog] Restart #${this.totalRestarts} — gateway still not responding`);
        this.emit({ type: 'restart_failed', attempt: this.totalRestarts, error: 'Gateway not responding after restart' });
        this.startCooldown();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Watchdog] Restart #${this.totalRestarts} failed: ${msg}`);
      this.emit({ type: 'restart_failed', attempt: this.totalRestarts, error: msg });
      this.startCooldown();
    }
  }

  private runRestart(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.restartCommand, this.config.restartArgs, {
        stdio: 'pipe',
        detached: true,
        shell: process.platform === 'win32',
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Don't wait forever — timeout after 30s
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Restart command timed out after 30s'));
      }, 30_000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Exit code ${code}: ${stderr.trim().slice(0, 200)}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Detach so the gateway process outlives a potential Evo shutdown
      child.unref();
    });
  }

  private startCooldown(): void {
    this.inCooldown = true;
    const cooldownMs = this.config.restartCooldownMs;
    console.log(`[Watchdog] Cooldown — waiting ${cooldownMs / 1000}s before next restart attempt`);
    this.emit({ type: 'cooldown', untilMs: Date.now() + cooldownMs });

    this.cooldownTimer = setTimeout(() => {
      this.inCooldown = false;
      console.log('[Watchdog] Cooldown expired, will retry on next failure');
    }, cooldownMs);
  }

  // ── Event emission ──────────────────────────────────────────────────────

  private emit(event: WatchdogEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors crash the watchdog
      }
    }
  }
}
