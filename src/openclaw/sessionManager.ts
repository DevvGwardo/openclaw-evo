/**
 * OpenClaw Evo — Session Manager
 *
 * Manages OpenClaw sessions for the evolution system.
 */

import { Gateway, type OpenClawSession } from './gateway.js';
import type { SessionMetrics, ToolCall } from '../types.js';
import { extractToolCallsFromHistory, inferTaskType } from '../utils.js';

export class SessionManager {
  private gateway: Gateway;

  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  async getActiveSessions(): Promise<OpenClawSession[]> {
    // Fetch sessions active in the last 10 minutes so we catch
    // recently completed cron sessions, not just currently running ones
    return this.gateway.listSessions(50, 10);
  }

  async getSessionMetrics(sessionKey: string): Promise<SessionMetrics> {
    const messages = await this.gateway.getSessionHistory(sessionKey, 50, true);
    const now = Date.now();
    const toolCalls = extractToolCallsFromHistory(messages, now - 60000);
    const failedCalls = toolCalls.filter((tc) => !tc.success).length;
    const completedCalls = toolCalls.filter((tc) => tc.endTime != null);
    const totalLatencyMs = completedCalls.reduce((sum, tc) => sum + (tc.endTime! - tc.startTime), 0);
    const avgLatencyMs = completedCalls.length > 0 ? totalLatencyMs / completedCalls.length : 0;
    const taskType = inferTaskType({}, messages);

    return {
      sessionId: sessionKey,
      toolCalls,
      startTime: now - 60000,
      success: failedCalls === 0 && toolCalls.length > 0,
      errorCount: failedCalls,
      totalToolCalls: toolCalls.length,
      avgLatencyMs,
      taskType,
    };
  }

  async isHealthy(): Promise<boolean> {
    const status = await this.gateway.getStatus();
    return status.connected;
  }
}
