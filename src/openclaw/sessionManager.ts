/**
 * OpenClaw Evo — Session Manager
 *
 * Manages OpenClaw sessions for the evolution system.
 */

import { Gateway, type OpenClawSession } from './gateway.js';
import type { SessionMetrics, ToolCall } from '../types.js';

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
    const toolCalls: ToolCall[] = [];
    let errorCount = 0;
    let totalLatency = 0;

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (text.includes('error') || text.includes('failed')) errorCount++;
      }
    }

    return {
      sessionId: sessionKey,
      toolCalls,
      startTime: Date.now() - 60000,
      success: errorCount === 0,
      errorCount,
      totalToolCalls: toolCalls.length,
      avgLatencyMs: toolCalls.length > 0 ? totalLatency / toolCalls.length : 0,
    };
  }

  async isHealthy(): Promise<boolean> {
    const status = await this.gateway.getStatus();
    return status.connected;
  }
}
