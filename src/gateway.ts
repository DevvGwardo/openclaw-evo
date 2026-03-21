/**
 * OpenClaw Evo — Gateway Session API
 *
 * Thin wrapper around the OpenClaw Gateway client that handles
 * session listing, history fetching, and conversion to SessionMetrics.
 * Extracted from hub.ts to keep gateway interaction separate from orchestration.
 */

import { Gateway, type OpenClawSession } from './openclaw/gateway.js';
import type { SessionMetrics, ToolCall } from './types.js';
import { extractToolCallsFromHistory, inferTaskType } from './utils.js';

/**
 * Fetch all active sessions from the gateway within the given window (minutes).
 * @param gatewayUrl - Base URL of the OpenClaw Gateway
 * @param activeMinutes - Look for sessions active within this many minutes
 * @param limit - Max sessions to fetch
 */
export async function fetchActiveSessions(
  gatewayUrl: string,
  activeMinutes = 30,
  limit = 50,
): Promise<OpenClawSession[]> {
  const gateway = new Gateway(gatewayUrl);
  return gateway.listSessions(limit, activeMinutes);
}

/**
 * Fetch session history for a given session key.
 * @param gatewayUrl - Base URL of the OpenClaw Gateway
 * @param sessionKey - The session key/id
 * @param messageLimit - Max messages to return
 * @param includeTools - Whether to include tool calls in the response
 */
export async function fetchSessionHistory(
  gatewayUrl: string,
  sessionKey: string,
  messageLimit = 50,
  includeTools = true,
): Promise<Record<string, unknown>[]> {
  const gateway = new Gateway(gatewayUrl);
  return gateway.getSessionHistory(sessionKey, messageLimit, includeTools);
}

/**
 * Convert a raw OpenClawSession into a full SessionMetrics object by
 * fetching its history and parsing tool calls.
 * @param gatewayUrl - Base URL of the OpenClaw Gateway
 * @param session - The session to build metrics for
 * @param seenSessionIds - Set of already-processed session IDs (for deduplication)
 */
export async function buildSessionMetrics(
  gatewayUrl: string,
  session: OpenClawSession,
  seenSessionIds: Set<string>,
): Promise<SessionMetrics | null> {
  if (seenSessionIds.has(session.key)) return null;
  seenSessionIds.add(session.key);

  const gateway = new Gateway(gatewayUrl);
  const now = Date.now();

  try {
    const messages = await gateway.getSessionHistory(session.key, 50, true);
    const sessionStart = session.updatedAt ?? now - 60000;
    const parsedToolCalls = extractToolCallsFromHistory(messages, sessionStart);
    const failedCalls = parsedToolCalls.filter((tc: ToolCall) => !tc.success).length;
    const completedCalls = parsedToolCalls.filter((tc: ToolCall) => tc.endTime != null);
    const totalLatencyMs = completedCalls.reduce(
      (sum: number, tc: ToolCall) => sum + (tc.endTime! - tc.startTime), 0,
    );
    const avgLatencyMs = completedCalls.length > 0 ? totalLatencyMs / completedCalls.length : 0;
    const taskType = inferTaskType(session, messages);

    return {
      sessionId: session.key,
      toolCalls: parsedToolCalls,
      startTime: sessionStart,
      endTime: now,
      success: failedCalls === 0,
      errorCount: failedCalls,
      totalToolCalls: parsedToolCalls.length,
      avgLatencyMs,
      taskType,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch and convert all active sessions to SessionMetrics.
 * Skips sessions already in `seenSessionIds`.
 */
export async function fetchAllSessionMetrics(
  gatewayUrl: string,
  seenSessionIds: Set<string>,
  activeMinutes = 30,
): Promise<SessionMetrics[]> {
  const sessions = await fetchActiveSessions(gatewayUrl, activeMinutes);
  const metrics: SessionMetrics[] = [];

  for (const session of sessions) {
    const m = await buildSessionMetrics(gatewayUrl, session, seenSessionIds);
    if (m) metrics.push(m);
  }

  return metrics;
}
