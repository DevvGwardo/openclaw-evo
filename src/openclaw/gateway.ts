/**
 * OpenClaw Evo — OpenClaw Gateway Client
 *
 * HTTP client for the OpenClaw Gateway API.
 * Used to list sessions, get history, and invoke tools.
 */

import { readFileSync } from 'fs';
import { homedir, join } from 'path';

function getGatewayToken(): string {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token ?? '';
  } catch {
    return '';
  }
}

export interface OpenClawSession {
  key: string;
  kind: string;
  channel?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
  model?: string;
  totalTokens?: number;
  lastChannel?: string;
  transcriptPath?: string;
  parentKey?: string;
}

export interface ToolResult {
  ok: boolean;
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  error?: { message: string; type: string };
}

export class Gateway {
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:18789') {
    this.baseUrl = baseUrl;
  }

  private async request(tool: string, args: Record<string, unknown> = {}, sessionKey?: string): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { tool, args };
    if (sessionKey) body.sessionKey = sessionKey;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getGatewayToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}/tools/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${tool} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  async listSessions(limit = 50, activeMinutes?: number): Promise<OpenClawSession[]> {
    const args: Record<string, unknown> = { limit, messageLimit: 0 };
    if (activeMinutes !== undefined && activeMinutes > 0) {
      args.activeMinutes = activeMinutes;
    }
    const resp = await this.request('sessions_list', args);
    console.log('[Gateway] sessions_list raw response keys:', Object.keys(resp));
    console.log('[Gateway] sessions_list result:', JSON.stringify(resp.result ?? 'none').slice(0, 200));
    const details = resp.result as { sessions?: OpenClawSession[] } | undefined;
    return details?.sessions ?? [];
  }

  async getSessionHistory(sessionKey: string, limit = 30, includeTools = true): Promise<Record<string, unknown>[]> {
    const resp = await this.request('sessions_history', { sessionKey, limit, includeTools });
    const details = resp.result as Record<string, unknown> | undefined;
    if (Array.isArray(details)) return details;
    if (Array.isArray((details as Record<string, unknown>)?.messages)) {
      return ((details as Record<string, unknown>).messages as Record<string, unknown>[]);
    }
    return [];
  }

  async invokeTool(tool: string, args: Record<string, unknown> = {}, sessionKey?: string): Promise<ToolResult> {
    const resp = await this.request('tools_invoke', { tool, args, sessionKey });
    return resp as unknown as ToolResult;
  }

  async getStatus(): Promise<{ connected: boolean; version?: string }> {
    try {
      const resp = await this.request('gateway_status', {});
      return { connected: true, version: (resp.result as { version?: string })?.version };
    } catch {
      return { connected: false };
    }
  }
}
