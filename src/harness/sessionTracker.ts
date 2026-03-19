/**
 * Session Tracker
 * Tracks session lifecycles and tool lifecycles within sessions.
 * Provides structured SessionMetrics data to the evaluator.
 */

import type {
  SessionLifecycle,
  ToolLifecycle,
  SessionMetrics,
  ToolCall,
  HarnessEvent,
} from '../types.js';
import { buildToolLifecycle } from './monitor.js';

interface ActiveTool {
  callEvent: HarnessEvent;
  toolName: string;
  startedAt: number;
}

/**
 * SessionTracker
 *
 * Consumes HarnessEvent stream (via processEvent) and maintains:
 * - Active session registry (sessionId → SessionLifecycle)
 * - Active tool call stack per session (for pairing call/result events)
 * - Computed SessionMetrics for completed sessions
 *
 * Callers register a callback to receive SessionMetrics when sessions end.
 */
export class SessionTracker {
  // sessionId → live session state
  private readonly sessions = new Map<string, SessionLifecycle>();

  // sessionId → stack of in-flight tool calls awaiting results
  private readonly activeTools = new Map<string, Map<string, ActiveTool>>();

  // Subscribers notified when a session completes
  private readonly completionListeners = Array<
    (metrics: SessionMetrics, session: SessionLifecycle) => void
  >();

  constructor() {
    console.log('[SessionTracker] Initialized');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Process a harness event. Handles session_start, session_end,
   * tool_call, tool_result, and error events.
   */
  processEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'session_start':
        this.onSessionStart(event);
        break;
      case 'session_end':
        this.onSessionEnd(event);
        break;
      case 'tool_call':
        this.onToolCall(event);
        break;
      case 'tool_result':
        this.onToolResult(event);
        break;
      case 'error':
        this.onError(event);
        break;
      default:
        // heartbeat and unknown types are ignored
        break;
    }
  }

  /**
   * Register a callback fired when a session completes with its final metrics.
   */
  onSessionComplete(
    listener: (metrics: SessionMetrics, session: SessionLifecycle) => void
  ): void {
    this.completionListeners.push(listener);
  }

  /** Get all tracked active sessions */
  getActiveSessions(): SessionLifecycle[] {
    return Array.from(this.sessions.values()).filter((s) => !s.endTime);
  }

  /** Get a specific session by ID */
  getSession(sessionId: string): SessionLifecycle | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get all completed sessions within an optional time window */
  getCompletedSessions(since?: Date): SessionLifecycle[] {
    return Array.from(this.sessions.values()).filter((s) => {
      if (!s.endTime) return false;
      if (since) return s.endTime >= since;
      return true;
    });
  }

  /** Get the number of active (incomplete) sessions */
  get activeSessionCount(): number {
    return this.getActiveSessions().length;
  }

  /** Get a snapshot of all tool lifecycles for a session */
  getToolLifecycles(sessionId: string): ToolLifecycle[] {
    return this.sessions.get(sessionId)?.toolLifecycles ?? [];
  }

  // ── Event Handlers ────────────────────────────────────────────────────────

  private onSessionStart(event: HarnessEvent): void {
    const data = event.data as {
      sessionKey?: string;
      parentSessionId?: string;
      isSubagent?: boolean;
      taskDescription?: string;
    };

    const session: SessionLifecycle = {
      sessionId: event.sessionId,
      sessionKey: data?.sessionKey ?? event.sessionId,
      startTime: new Date(event.timestamp),
      toolLifecycles: [],
      parentSessionId: data?.parentSessionId,
      isSubagent: data?.isSubagent ?? false,
      taskDescription: data?.taskDescription,
    };

    this.sessions.set(event.sessionId, session);
    this.activeTools.set(event.sessionId, new Map());
    console.log(
      `[SessionTracker] Session started: ${event.sessionId} (subagent=${session.isSubagent})`
    );
  }

  private onSessionEnd(event: HarnessEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) {
      console.warn(
        `[SessionTracker] session_end for unknown session: ${event.sessionId}`
      );
      return;
    }

    session.endTime = new Date(event.timestamp);

    // Finalize any remaining open tool calls
    const active = this.activeTools.get(event.sessionId);
    if (active && active.size > 0) {
      console.warn(
        `[SessionTracker] Closing ${active.size} dangling tool call(s) for session ${event.sessionId}`
      );
      for (const [, tool] of active) {
        const lifecycle = buildToolLifecycle(tool.callEvent, null, tool.toolName);
        session.toolLifecycles.push(lifecycle);
      }
    }

    this.activeTools.delete(event.sessionId);

    const metrics = this.computeMetrics(session);
    console.log(
      `[SessionTracker] Session ended: ${event.sessionId} — ` +
        `toolCalls=${metrics.totalToolCalls}, errors=${metrics.errorCount}, ` +
        `avgLatency=${metrics.avgLatencyMs.toFixed(1)}ms, success=${metrics.success}`
    );

    for (const listener of this.completionListeners) {
      try {
        listener(metrics, session);
      } catch (err) {
        console.error('[SessionTracker] Completion listener threw:', err);
      }
    }
  }

  private onToolCall(event: HarnessEvent): void {
    const data = event.data as {
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      startTime?: number;
    };

    const toolName = data?.name ?? 'unknown';
    const toolId = data?.id ?? `${event.sessionId}:${Date.now()}`;

    const sessionTools = this.activeTools.get(event.sessionId);
    if (!sessionTools) {
      // Orphan tool call before session_start — create a synthetic session
      console.warn(
        `[SessionTracker] tool_call before session_start for ${event.sessionId}, creating synthetic session`
      );
      const synthetic: SessionLifecycle = {
        sessionId: event.sessionId,
        sessionKey: event.sessionId,
        startTime: new Date(event.timestamp),
        toolLifecycles: [],
        isSubagent: false,
      };
      this.sessions.set(event.sessionId, synthetic);
      this.activeTools.set(event.sessionId, new Map());
    }

    this.activeTools.get(event.sessionId)!.set(toolId, {
      callEvent: event,
      toolName,
      startedAt: data?.startTime ?? Date.now(),
    });

    console.log(
      `[SessionTracker] Tool call: ${toolName}[${toolId}] in session ${event.sessionId}`
    );
  }

  private onToolResult(event: HarnessEvent): void {
    const data = event.data as {
      id?: string;
      toolId?: string;
      name?: string;
      success?: boolean;
      error?: string;
      output?: unknown;
      endTime?: number;
    };

    const toolId = data?.id ?? data?.toolId;
    const toolName = data?.name ?? 'unknown';

    if (!toolId) {
      console.warn(
        `[SessionTracker] tool_result missing tool id in session ${event.sessionId}`
      );
      return;
    }

    const sessionTools = this.activeTools.get(event.sessionId);
    if (!sessionTools) {
      console.warn(
        `[SessionTracker] tool_result for unknown session: ${event.sessionId}`
      );
      return;
    }

    const activeTool = sessionTools.get(toolId);

    if (activeTool) {
      // Pair call + result into a ToolLifecycle
      const lifecycle = buildToolLifecycle(activeTool.callEvent, event, activeTool.toolName);
      const session = this.sessions.get(event.sessionId);
      if (session) {
        session.toolLifecycles.push(lifecycle);
      }
      sessionTools.delete(toolId);
    } else {
      // Orphan result — create lifecycle from result only
      console.log(
        `[SessionTracker] Orphan tool_result (no matching call): ${toolName}[${toolId}]`
      );
      const session = this.sessions.get(event.sessionId);
      if (session) {
        session.toolLifecycles.push({
          toolId,
          toolName,
          sessionId: event.sessionId,
          startTime: Date.now() - 1, // unknown
          endTime: Date.now(),
          success: data?.success ?? false,
          error: data?.error,
          input: {},
          output: data?.output,
        });
      }
    }
  }

  private onError(event: HarnessEvent): void {
    // Tag the current session with an error note if we have an active session
    const session = this.sessions.get(event.sessionId);
    if (session) {
      console.log(
        `[SessionTracker] Error event in session ${event.sessionId}: ${JSON.stringify(event.data)}`
      );
    }
  }

  // ── Metrics Computation ───────────────────────────────────────────────────

  /**
   * Compute SessionMetrics from a completed SessionLifecycle.
   */
  computeMetrics(session: SessionLifecycle): SessionMetrics {
    const toolLifecycles = session.toolLifecycles;

    const totalToolCalls = toolLifecycles.length;
    const errorCount = toolLifecycles.filter((t) => !t.success).length;
    const successfulCalls = toolLifecycles.filter((t) => t.success);

    const completedCalls = toolLifecycles.filter((t) => t.endTime);
    const totalLatencyMs = completedCalls.reduce((sum, t) => {
      const end = t.endTime ?? Date.now();
      return sum + (end - t.startTime);
    }, 0);

    const avgLatencyMs =
      completedCalls.length > 0 ? totalLatencyMs / completedCalls.length : 0;

    // Build ToolCall[] from lifecycles
    const toolCalls: ToolCall[] = toolLifecycles.map((l) => ({
      id: l.toolId,
      name: l.toolName,
      input: l.input,
      output: l.output,
      error: l.error,
      startTime: l.startTime,
      endTime: l.endTime,
      success: l.success,
    }));

    return {
      sessionId: session.sessionId,
      toolCalls,
      startTime: session.startTime.getTime(),
      endTime: session.endTime?.getTime(),
      success: errorCount === 0 && totalToolCalls > 0,
      errorCount,
      totalToolCalls,
      avgLatencyMs,
      taskType: session.taskDescription,
    };
  }
}
