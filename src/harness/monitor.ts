/**
 * Hermes Harness Monitor
 * Wraps Hermes event hooks with self-monitoring.
 * Emits structured HarnessEvent objects for the hub to process.
 */

import { WebSocket } from 'ws';
import type {
  HarnessEvent,
  ToolLifecycle,
  ToolCall,
} from '../types.js';
import { getHarnessConfig } from './toolAnalyzer.js';

export type HarnessListener = (_event: HarnessEvent) => void;
export type OpenClawEventHook = (_data: unknown) => void;

interface MonitorConfig {
  gatewayUrl: string;
  gatewayToken: string;
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

// ── WebSocket protocol helpers ─────────────────────────────────────────────────

const GATEWAY_PROTOCOL_VERSION = 3;

// Frame types from the gateway protocol
type FrameType = 'req' | 'res' | 'evt';
type EventName = 'connect.challenge' | 'tick' | 'chat' | 'agent' | 'session.update' | 'btw';

interface WsFrame {
  type: FrameType;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  event?: string;
  payload?: unknown;
  ok?: boolean;
  error?: { message: string };
}

interface ChallengePayload {
  nonce: string;
  ts: number;
}

interface TickPayload {
  interval?: number;
}

interface ChatPayload {
  sessionKey?: string;
  state?: string;
  message?: { role?: string; content?: string };
  runId?: string;
}

interface AgentPayload {
  sessionKey?: string;
  type?: string;
  message?: { role?: string; content?: unknown };
}

interface SessionUpdatePayload {
  sessionKey?: string;
  state?: string;
  [key: string]: unknown;
}

// ── HarnessMonitor ─────────────────────────────────────────────────────────────

/**
 * HarnessMonitor
 *
 * Connects to the OpenClaw gateway via WebSocket and wraps its event hooks
 * with self-monitoring: deduplication, latency tracking, and structured event
 * emission for downstream consumers (evaluator, session tracker, etc.).
 */
export class HarnessMonitor {
  private readonly config: MonitorConfig;
  private readonly listeners = new Set<HarnessListener>();
  private readonly eventBuffer = new Map<string, HarnessEvent[]>();
  private abortController?: AbortController;
  private isRunning = false;
  private ws?: WebSocket;
  private wsBackoff = 0;
  private readonly maxBackoffSecs = 30;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Tracks the last event timestamp per session to detect stalls */
  private readonly lastEventPerSession = new Map<string, number>();
  /** Tracks event counts per type for self-monitoring */
  private readonly eventCounts = new Map<string, number>();

  constructor(config: Partial<MonitorConfig> = {}) {
    // Load persisted harness tuning (falls back to defaults)
    const saved = getHarnessConfig();

    this.config = {
      gatewayUrl: config.gatewayUrl ?? 'http://localhost:18789',
      gatewayToken: config.gatewayToken ?? process.env.HERMES_GATEWAY_TOKEN ?? '',
      pollIntervalMs: config.pollIntervalMs ?? saved.pollIntervalMs,
      idleThresholdMs: saved.idleThresholdMs,
      onEvent: config.onEvent,
    };

    if (this.config.onEvent) {
      this.addListener(this.config.onEvent);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start the monitor (passive mode — no WebSocket) */
  start(): void {
    if (this.isRunning) {
      console.log('[HarnessMonitor] Already running, ignoring start()');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    console.log(
      `[HarnessMonitor] Starting (passive) — gateway: ${this.config.gatewayUrl}, ` +
        `idle threshold: ${this.config.idleThresholdMs}ms`
    );

    // NOTE: WebSocket connections disabled — the gateway doesn't expose a /ws
    // endpoint, so connections close immediately (code 1000) and crash the
    // process.  The evolution cycle fetches sessions via HTTP directly.
    // Re-enable with USE_WS=true if the gateway adds WebSocket support.
    if (process.env.USE_WS === 'true') {
      this.connectWs();
    }
  }

  /** Stop the monitor and close the WebSocket connection */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[HarnessMonitor] Stopping');
    this.abortController?.abort();
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
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

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  private scheduleReconnect(delayMs: number): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.isRunning || this.abortController?.signal.aborted) return;
      this.connectWs();
    }, delayMs);
  }

  private buildWsUrl(): string {
    const url = this.config.gatewayUrl;
    // Support both http:// and https:// — convert to ws:// / wss://
    return url.replace(/^http/, 'ws');
  }

  private connectWs(): void {
    if (!this.isRunning || this.abortController?.signal.aborted) return;

    const wsUrl = this.buildWsUrl();
    console.log(`[HarnessMonitor] Connecting to gateway at ${wsUrl}…`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[HarnessMonitor] WebSocket constructor failed:', err);
      this.handleDisconnect(err as Error);
      return;
    }

    this.ws.onopen = () => {
      console.log('[HarnessMonitor] WebSocket connected');
      this.wsBackoff = 0;
    };

    this.ws.onerror = (event) => {
      // Log but don't throw — onclose handles reconnection
      console.error('[HarnessMonitor] WebSocket error:', event.message);
    };

    this.ws.onclose = (event) => {
      if (!this.isRunning || this.abortController?.signal.aborted) return;
      console.warn(`[HarnessMonitor] WebSocket closed (code=${event.code}), reconnecting…`);
      this.handleDisconnect(new Error(`WebSocket closed ${event.code}`));
    };

    this.ws.onmessage = (msg) => {
      void this.handleWsMessage(msg.data);
    };
  }

  private async handleWsMessage(rawData: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let frame: WsFrame;
    try {
      frame = JSON.parse(rawData as string) as WsFrame;
    } catch {
      console.warn('[HarnessMonitor] Received non-JSON frame, ignoring:', rawData);
      return;
    }

    if (frame.type === 'evt') {
      await this.handleGatewayEvent(frame);
    } else if (frame.type === 'res' && frame.ok === false) {
      console.error('[HarnessMonitor] Gateway error response:', frame.error?.message);
    }
  }

  private async handleGatewayEvent(frame: WsFrame): Promise<void> {
    const event = frame.event as EventName | string;
    const payload = frame.payload as
      | ChallengePayload
      | TickPayload
      | ChatPayload
      | AgentPayload
      | SessionUpdatePayload
      | undefined;

    switch (event) {
      case 'connect.challenge': {
        await this.sendConnectRequest((payload as ChallengePayload).nonce);
        break;
      }

      case 'tick': {
        if ((payload as TickPayload)?.interval) {
          // Gateway tick — used as a heartbeat signal
          const sessionKey = 'gateway';
          this.emitEvent(toHarnessEvent('heartbeat', sessionKey, payload));
        }
        break;
      }

      case 'session.update': {
        const p = payload as SessionUpdatePayload;
        if (!p?.sessionKey) break;
        const state = p.state?.toLowerCase() ?? '';
        if (state === 'starting' || state === 'start') {
          this.emitEvent(toHarnessEvent('session_start', p.sessionKey, p));
        } else if (state === 'ended' || state === 'end' || state === 'done') {
          this.emitEvent(toHarnessEvent('session_end', p.sessionKey, p));
        }
        break;
      }

      case 'chat': {
        // Chat events carry sessionKey and run state
        const p = payload as ChatPayload;
        if (!p?.sessionKey) break;
        if (p.state === 'delta' || p.state === 'final') {
          // Check if the message contains tool calls
          const msg = p.message as { role?: string; content?: unknown } | undefined;
          if (msg?.content) {
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                const block2 = block as { type?: string; name?: string; input?: unknown };
                if (block2.type === 'tool_use') {
                  this.emitEvent(toHarnessEvent('tool_call', p.sessionKey, {
                    tool: block2.name,
                    input: block2.input,
                    runId: p.runId,
                  }));
                }
              }
            }
          }
        }
        break;
      }

      case 'agent': {
        // Agent events can signal tool usage/results
        const p = payload as AgentPayload;
        if (!p?.sessionKey) break;
        const msg = p.message as { role?: string; content?: unknown } | undefined;
        if (msg?.content) {
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const block2 = block as { type?: string; name?: string; input?: unknown };
              if (block2.type === 'tool_use') {
                this.emitEvent(toHarnessEvent('tool_call', p.sessionKey, {
                  tool: block2.name,
                  input: block2.input,
                }));
              } else if (block2.type === 'tool_result') {
                this.emitEvent(toHarnessEvent('tool_result', p.sessionKey, {
                  tool: block2.name,
                  output: block2.input, // tool_result block has result in input field
                }));
              }
            }
          }
        }
        break;
      }

      default:
        // Emit unknown events as generic error events for debugging
        if (event && !event.startsWith('btw')) {
          console.debug(`[HarnessMonitor] Unknown gateway event: ${event}`);
        }
    }
  }

  private async sendConnectRequest(nonce: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Read device identity for signed auth if available
    let device: Record<string, unknown> | undefined;
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const homedir = process.env.HOME ?? '';
      const authPath = path.join(homedir, '.hermes', 'hermes-agent', 'identity', 'device-auth.json');
      const authData = JSON.parse(await fs.readFile(authPath, 'utf-8'));
      const operatorToken = authData?.tokens?.operator?.token;
      if (operatorToken && nonce) {
        // Build a minimal device identity from the stored key
        device = {
          id: authData.deviceId,
          nonce,
          signedAt: Date.now(),
        };
        // Token for auth
        if (!this.config.gatewayToken && operatorToken) {
          this.config.gatewayToken = operatorToken;
        }
      }
    } catch {
      // No device auth file — continue without device identity
    }

    const connectFrame: WsFrame = {
      type: 'req',
      id: crypto.randomUUID(),
      method: 'connect',
      params: {
        minProtocol: GATEWAY_PROTOCOL_VERSION,
        maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client: {
          id: 'evo-monitor',
          displayName: 'OpenClaw Evo Monitor',
          version: '1.0.0',
          platform: process.platform,
          mode: 'backend',
        },
        caps: [],
        auth: {
          token: this.config.gatewayToken || undefined,
        },
        role: 'operator',
        scopes: ['operator.admin'],
        device,
      },
    };

    this.ws.send(JSON.stringify(connectFrame));
  }

  private handleDisconnect(err: Error): void {
    if (!this.isRunning || this.abortController?.signal.aborted) return;

    const delayMs = Math.min(
      1000 * Math.pow(2, this.wsBackoff),
      this.maxBackoffSecs * 1000,
    );
    this.wsBackoff = Math.min(this.wsBackoff + 1, this.maxBackoffSecs);

    console.warn(
      `[HarnessMonitor] Reconnecting in ${Math.round(delayMs / 1000)}s ` +
        `(attempt ${this.wsBackoff}) after: ${err.message}`
    );

    this.scheduleReconnect(delayMs);
  }

  // ── Event emission ────────────────────────────────────────────────────────

  private emitEvent(event: HarnessEvent): void {
    // Update idle tracking
    this.lastEventPerSession.set(event.sessionId, Date.now());

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
  }

  private incrementCounter(type: string): void {
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
  }
}

/** Minimal shape of events returned by the OpenClaw gateway */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface _RawGatewayEvent {
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
