/**
 * Hermes Evo — Hermes Gateway Client
 *
 * HTTP client for the Hermes Gateway API.
 * Used to list sessions, get history, and invoke tools.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getGatewayToken(): string {
  try {
    const configPath = join(homedir(), '.hermes', 'hermes-agent', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.token ?? config?.auth?.token ?? config?.gateway?.auth?.token ?? '';
  } catch {
    try {
      const authPath = join(homedir(), '.hermes', 'auth.json');
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      return auth?.token ?? '';
    } catch { return ''; }
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

    // Gateway wraps response in { content: [{ type: "text", text: "{\"count\":N,\"sessions\":[...]}" }] }
    const result = resp.result as { content?: { type: string; text: string }[] } | undefined;
    const content = result?.content;
    if (Array.isArray(content) && content.length > 0 && typeof content[0].text === 'string') {
      const inner = JSON.parse(content[0].text);
      return (inner.sessions ?? []) as OpenClawSession[];
    }

    // Fallback: try direct result.sessions
    const details = resp.result as { sessions?: OpenClawSession[] } | undefined;
    return details?.sessions ?? [];
  }

  async getSessionHistory(sessionKey: string, limit = 30, includeTools = true): Promise<Record<string, unknown>[]> {
    const resp = await this.request('sessions_history', { sessionKey, limit, includeTools });

    // Gateway wraps response in { content: [{ type: "text", text: "JSON" }] }
    const result = resp.result as { content?: { type: string; text: string }[] } | undefined;
    const content = result?.content;
    if (Array.isArray(content) && content.length > 0 && typeof content[0].text === 'string') {
      const inner = JSON.parse(content[0].text);
      // Response may be { messages: [...] } or a direct array
      if (Array.isArray(inner)) return inner;
      if (Array.isArray(inner?.messages)) return inner.messages;
    }

    // Fallback: try unwrapped formats
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

  /**
   * POST directly to /tools/invoke — bypasses the 'tools_invoke' tool wrapper.
   * Use this for spawning sessions when the gateway doesn't expose tools_invoke
   * as a callable tool.
   */
  async postTool(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getGatewayToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}/tools/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool, args }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${tool} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  async getStatus(): Promise<{ connected: boolean; version?: string }> {
    try {
      // Simple HTTP GET to the gateway root — the gateway doesn't expose
      // a gateway_status tool, so we just check if it responds at all.
      const headers: Record<string, string> = {};
      const token = getGatewayToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(this.baseUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return { connected: res.ok || res.status < 500 };
    } catch {
      return { connected: false };
    }
  }
}
