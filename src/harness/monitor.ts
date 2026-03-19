/**
 * Harness Monitor
 * Wraps OpenClaw event hooks with self-monitoring.
 * Emits structured HarnessEvent objects for the hub to process.
 */

import type {
  HarnessEvent,
  ToolLifecycle,
  SessionLifecycle,
  ToolCall,
} from '../types.js';
import { getHarnessConfig } from './toolAnalyzer.js';

export type HarnessListener = (event: HarnessEvent) => void;
export type OpenClawEventHook = (data: unknown) => void;

interface MonitorConfig {
  gatewayUrl: string;
  pollIntervalMs: number;
  idleThresholdMs: number;
  onEvent?: HarnessListener;
}

/**
 * OpenClaw's event types (as observed from the gateway API).
 * These are the hooks we wrap for self-monitoring.
 */
export const OPENCLAW_EVENT_TYPES = [
  'session_start',
  'session_end',
  'tool_call',
  'tool_result',
  'error',
  'heartbeat',
] as const;

export type OpenClawEventType = (typeof OPENCLAW_EVENT_TYPES)[number];

/**
 * Maps raw OpenClaw gateway event payloads to our typed HarnessEvent.
 */
function toHarnessEvent(
  rawType: string,
  sessionId: string,
  data: unknown
): HarnessEvent {
  const type = OPENCLAW_EVENT_TYPES.includes(rawType as OpenClawEventType)
    ? (rawType as HarnessEvent['type'])
    : 'error';

  return {
    type,
    sessionId,
    timestamp: new Date(),
    data,
  };
}

/**
 * HarnessMonitor
 *
 * Connects to the OpenClaw gateway and wraps its event hooks with
 * self-monitoring: deduplication, latency tracking, and structured
 * event emission for downstream consumers (evaluator, session tracker, etc.).
 */
export class HarnessMonitor {
  private readonly config: MonitorConfig;
  private readonly listeners = new Set<HarnessListener>();
  private readonly eventBuffer = new Map<string, HarnessEvent[]>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private abortController?: AbortController;
  private isRunning = false;

  /** Tracks the last event timestamp per session to detect stalls */
  private readonly lastEventPerSession = new Map<string, number>();
  /** Tracks event counts per type for self-monitoring */
  private readonly eventCounts = new Map<string, number>();

  constructor(config: Partial<MonitorConfig> = {}) {
    // Load persisted harness tuning (falls back to defaults)
    const saved = getHarnessConfig();

    this.config = {
      gatewayUrl: config.gatewayUrl ?? 'http://localhost:18789',
      pollIntervalMs: config.pollIntervalMs ?? saved.pollIntervalMs,
      idleThresholdMs: saved.idleThresholdMs,
      onEvent: config.onEvent,
    };

    if (this.config.onEvent) {
      this.addListener(this.config.onEvent);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start polling the OpenClaw gateway for events */
  start(): void {
    if (this.isRunning) {
      console.log('[HarnessMonitor] Already running, ignoring start()');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    console.log(
      `[HarnessMonitor] Starting — gateway: ${this.config.gatewayUrl}, poll interval: ${this.config.pollIntervalMs}ms, idle threshold: ${this.config.idleThresholdMs}ms`
    );

    this.pollLoop().catch((err) => {
      console.error('[HarnessMonitor] Poll loop fatal error:', err);
      this.isRunning = false;
    });
  }

  /** Stop polling and clean up */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[HarnessMonitor] Stopping');
    this.abortController?.abort();
    clearInterval(this.pollTimer);
    this.isRunning = false;
  }

  /** Register a listener for all harness events */
  addListener(listener: HarnessListener): void {
    this.listeners.add(listener);
  }

  /** Remove a previously registered listener */
  removeListener(listener: HarnessListener): void {
    this.listeners.delete(listener);
  }

  /** Get buffered events for a session (useful for evaluator) */
  getBufferedEvents(sessionId: string): HarnessEvent[] {
    return this.eventBuffer.get(sessionId) ?? [];
  }

  /** Clear buffered events for a session */
  flushBuffer(sessionId: string): void {
    this.eventBuffer.delete(sessionId);
  }

  /** Current running state */
  get running(): boolean {
    return this.isRunning;
  }

  /** Self-monitoring: event counts since start */
  get eventCounters(): Record<string, number> {
    return Object.fromEntries(this.eventCounts);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (!this.abortController?.signal.aborted) {
      await this.safeSleep(this.config.pollIntervalMs);
      if (this.abortController?.signal.aborted) break;
      this.checkIdleSessions();
      await this.pollGateway();
    }
  }

  /** Warn about sessions that have been silent longer than idleThresholdMs */
  private checkIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, lastTs] of this.lastEventPerSession) {
      const idleMs = now - lastTs;
      if (idleMs > this.config.idleThresholdMs) {
        console.warn(
          `[HarnessMonitor] Session "${sessionId}" has been idle for ${Math.round(idleMs / 1000)}s ` +
            `(threshold: ${this.config.idleThresholdMs}ms)`
        );
      }
    }
  }

  private async pollGateway(): Promise<void> {
    try {
      const url = `${this.config.gatewayUrl}/events`;
      const response = await fetch(url, {
        signal: this.abortController?.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        console.warn(
          `[HarnessMonitor] Gateway returned ${response.status} — will retry`
        );
        return;
      }

      const rawEvents = (await response.json()) as RawGatewayEvent[];
      await this.processRawEvents(rawEvents);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[HarnessMonitor] Failed to poll gateway:', err);
    }
  }

  private async processRawEvents(rawEvents: RawGatewayEvent[]): Promise<void> {
    for (const raw of rawEvents) {
      try {
        const event = toHarnessEvent(raw.type, raw.sessionId ?? 'unknown', raw.data);

        // Update self-monitoring state
        this.incrementCounter(event.type);
        this.lastEventPerSession.set(
          event.sessionId,
          Date.now()
        );

        // Buffer for session consumers
        const buffered = this.eventBuffer.get(event.sessionId) ?? [];
        buffered.push(event);
        this.eventBuffer.set(event.sessionId, buffered);

        // Emit to all listeners
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (err) {
            console.error('[HarnessMonitor] Listener threw:', err);
          }
        }
      } catch (err) {
        console.error('[HarnessMonitor] Failed to process raw event:', err);
      }
    }
  }

  private incrementCounter(type: string): void {
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
  }

  private safeSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Minimal shape of events returned by the OpenClaw gateway */
interface RawGatewayEvent {
  type: string;
  sessionId?: string;
  data?: unknown;
}

/**
 * Build a ToolLifecycle from a tool_call + tool_result event pair.
 * Used by sessionTracker to construct tool lifecycles from monitor events.
 */
export function buildToolLifecycle(
  callEvent: HarnessEvent,
  resultEvent: HarnessEvent | null,
  toolName: string
): ToolLifecycle {
  const callData = callEvent.data as Partial<ToolCall>;
  const resultData = resultEvent?.data as Partial<ToolCall> | null;

  const endTime = resultEvent?.timestamp
    ? new Date(resultEvent.timestamp).getTime()
    : undefined;

  return {
    toolId: callData?.id ?? callEvent.sessionId,
    toolName,
    sessionId: callEvent.sessionId,
    startTime: callData?.startTime ?? new Date(callEvent.timestamp).getTime(),
    endTime,
    success: resultData?.success ?? false,
    error: resultData?.error,
    input: callData?.input ?? {},
    output: resultData?.output,
  };
}

/**
 * Convenience: create a synthetic HarnessEvent for internal use.
 */
export function makeSyntheticEvent(
  type: HarnessEvent['type'],
  sessionId: string,
  data: unknown
): HarnessEvent {
  return {
    type,
    sessionId,
    timestamp: new Date(),
    data,
  };
}
