/**
 * formatDuration — Convert milliseconds to a human-readable duration string.
 * Examples: 154000 → "2m 34s", 3600000 → "1h 0m", 45000 → "45s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * formatPercent — Format a number 0–100 as a percentage string.
 * Example: 85.237 → "85.2%"
 */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

/**
 * formatDate — Format a Date for display.
 * If today: "15:04:32" (time only)
 * Otherwise: "Mar 19 12:34" (abbreviated month + day + time)
 */
export function formatDate(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const timeStr = `${hh}:${mm}:${ss}`;

  if (isToday) return timeStr;

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const mon = months[d.getMonth()];
  const day = d.getDate().toString().padStart(2, '0');
  return `${mon} ${day} ${timeStr}`;
}

/**
 * calculateTrend — Detect direction of a numeric series.
 * Requires at least 2 data points.
 */
export function calculateTrend(values: number[]): 'up' | 'down' | 'stable' {
  if (!Array.isArray(values) || values.length < 2) return 'stable';
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 'stable';

  // Simple linear regression slope
  const n = valid.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = valid.reduce((a, b) => a + b, 0);
  const sumXY = valid.reduce((acc, y, x) => acc + x * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 'stable';

  const slope = (n * sumXY - sumX * sumY) / denominator;

  // Threshold of ~0.01 per step to avoid noise
  const threshold = 0.01;
  if (slope > threshold) return 'up';
  if (slope < -threshold) return 'down';
  return 'stable';
}

/**
 * colorForScore — Return a CSS color string for a score 0–100.
 *   0–39  → red   ("#ef4444")
 *   40–69 → yellow("#eab308")
 *   70–100 → green ("#22c55e")
 */
export function colorForScore(score: number): string {
  if (!Number.isFinite(score)) return '#9ca3af';
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#eab308';
  return '#ef4444';
}

// ── Session Data Extraction Helpers ─────────────────────────────────────────

import type { ToolCall } from './types.js';

/**
 * Extract structured ToolCall[] from gateway session history messages.
 * Handles both Anthropic format (tool_use/tool_result content blocks)
 * and OpenAI format (tool_calls array + role:"tool" messages).
 */
export function extractToolCallsFromHistory(
  messages: Record<string, unknown>[],
  sessionStartTime: number,
): ToolCall[] {
  // Try Anthropic format first, fall back to OpenAI format
  const anthropic = extractAnthropic(messages, sessionStartTime);
  if (anthropic.length > 0) return anthropic;

  const openai = extractOpenAI(messages, sessionStartTime);
  if (openai.length > 0) return openai;

  // OpenClaw gateway uses toolResult role messages (non-standard format)
  const gateway = extractGatewayToolResult(messages, sessionStartTime);
  if (gateway.length > 0) return gateway;

  // Last resort: scan for any structured tool data in message metadata
  return extractFromMetadata(messages, sessionStartTime);
}

/**
 * OpenClaw gateway format: role=toolResult with toolCallId, toolName,
 * content, isError, timestamp fields.
 *
 * NOTE: The gateway's sessions_history returns toolResult messages but does NOT
 * include the original assistant messages with tool_use blocks. Therefore, when
 * we encounter toolResult messages without a matching tool_use, we reconstruct
 * a minimal ToolCall directly from the result data.
 */
function extractGatewayToolResult(messages: Record<string, unknown>[], sessionStartTime: number): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Index toolResult messages by their toolCallId
  const resultMap = new Map<string, { content?: unknown; isError?: boolean; timestamp?: number }>();
  for (const msg of messages) {
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      resultMap.set(msg.toolCallId as string, {
        content: msg.content,
        isError: msg.isError === true || msg.is_error === true,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      });
    }
  }

  // Index toolResult messages by position for fallback pairing
  const toolResultMsgs: Array<{ name: string; content?: unknown; isError?: boolean; timestamp?: number; toolCallId: string }> = [];
  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      toolResultMsgs.push({
        toolCallId: (msg.toolCallId as string) ?? `tool-result-${toolResultMsgs.length}`,
        name: (msg.toolName as string) ?? 'unknown',
        content: msg.content,
        isError: msg.isError === true || msg.is_error === true,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      });
    }
  }

  let callIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use') {
          const id = (block.id as string) ?? `tool-${callIndex}`;
          const result = resultMap.get(id);

          // Primary: gateway-reported error flag
          // Secondary: scan content for command-failure indicators
          // (gateway sets isError=False even when commands return non-zero exit codes)
          const content = result?.content != null
            ? typeof result.content === 'string' ? result.content as string : JSON.stringify(result.content)
            : '';
          const hasError = result?.isError === true || isContentFailure(content);

          const errorStr = hasError && result?.content != null
            ? typeof result.content === 'string'
              ? result.content as string
              : JSON.stringify(result.content)
            : undefined;

          const startTime = result?.timestamp ?? (sessionStartTime + callIndex * 1000);
          const endTime = result?.timestamp ? startTime + 500 : undefined;

          toolCalls.push({
            id,
            name: (block.name as string) ?? 'unknown',
            input: (block.input as Record<string, unknown>) ?? {},
            output: !hasError ? (result?.content as string) : undefined,
            error: errorStr,
            startTime,
            endTime,
            success: result != null ? !hasError : false,
          });
          callIndex++;
        }
      }
    }
  }

  // If no tool_calls were found via tool_use pairing (gateway doesn't store
  // the originating assistant messages), reconstruct them from toolResult entries.
  // Each toolResult is treated as a completed tool call.
  if (toolCalls.length === 0 && toolResultMsgs.length > 0) {
    for (let i = 0; i < toolResultMsgs.length; i++) {
      const r = toolResultMsgs[i];
      const content = r.content != null
        ? typeof r.content === 'string' ? r.content as string : JSON.stringify(r.content)
        : '';
      const hasError = r.isError || isContentFailure(content);
      const errorStr = hasError && r.content != null
        ? typeof r.content === 'string' ? r.content as string : JSON.stringify(r.content)
        : undefined;

      toolCalls.push({
        id: r.toolCallId,
        name: r.name,
        input: {},
        output: !hasError ? (r.content as string) : undefined,
        error: errorStr,
        startTime: r.timestamp ?? (sessionStartTime + i * 1000),
        endTime: r.timestamp ? r.timestamp + 500 : undefined,
        success: !hasError,
      });
    }
  }

  return toolCalls;
}

/**
 * Detect command failures from tool result content.
 * The gateway sets isError=False for non-zero exit codes from exec/bash commands,
 * so we scan the output for common error signatures.
 */
function isContentFailure(content: string): boolean {
  if (!content) return false;

  // Skip long content — tool results with substantial output are almost certainly successful
  // (real errors are typically short messages)
  if (content.length > 2000) return false;

  // Skip JSON-wrapped gateway content arrays — these are successful tool responses
  if (content.startsWith('[{"type":"text"')) return false;

  const lower = content.toLowerCase();

  // Command error signatures (cat:, ls:, grep:, curl:, etc. indicate CLI failure)
  if (/^(cat|ls|grep|curl|wget|node|python|bash):\s*.*/m.test(content)) return true;

  // Specific error patterns (not just the word "error" appearing anywhere)
  if (lower.includes('no such file') || lower.includes('cannot find') ||
      lower.includes('enoent') || lower.includes('not found') ||
      lower.includes('connection refused') || lower.includes('couldn\'t connect') ||
      lower.includes('permission denied') || lower.includes('operation not permitted') ||
      lower.includes('does not exist') ||
      lower.includes('url rejected')) return true;

  // Exit code failures (but only as standalone indicators, not in prose)
  if (/exit code [1-9]\d*/i.test(content) && content.length < 500) return true;

  // JSON error responses (structured errors, not incidental "error" in text)
  try {
    const parsed = JSON.parse(content);
    if (parsed?.status === 'error' || (parsed?.error && typeof parsed.error === 'object')) return true;
  } catch { /* not JSON */ }

  return false;
}

/** Anthropic format: tool_use/tool_result content blocks */
function extractAnthropic(messages: Record<string, unknown>[], sessionStartTime: number): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Index tool_result blocks by tool_use_id for pairing
  const resultMap = new Map<string, { content?: unknown; isError?: boolean }>();
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resultMap.set(block.tool_use_id, {
            content: block.content,
            isError: block.is_error === true,
          });
        }
      }
    }
  }

  let callIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use') {
          const id = typeof block.id === 'string' ? block.id : `tool-${callIndex}`;
          const result = resultMap.get(id);
          const hasError = result?.isError === true;
          const errorStr = hasError && result?.content != null
            ? typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content)
            : undefined;

          const startTime = sessionStartTime + callIndex * 1000;
          const endTime = result != null ? startTime + 500 : undefined;

          toolCalls.push({
            id,
            name: (block.name as string) ?? 'unknown',
            input: (block.input as Record<string, unknown>) ?? {},
            output: hasError ? undefined : result?.content,
            error: errorStr,
            startTime,
            endTime,
            success: result != null ? !hasError : false,
          });
          callIndex++;
        }
      }
    }
  }

  return toolCalls;
}

/** OpenAI format: tool_calls array on assistant + role:"tool" messages */
function extractOpenAI(messages: Record<string, unknown>[], sessionStartTime: number): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Index tool results by tool_call_id
  const resultMap = new Map<string, { content?: unknown; isError?: boolean }>();
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      const content = msg.content;
      const isError = typeof content === 'string' && content.toLowerCase().includes('error');
      resultMap.set(msg.tool_call_id as string, { content, isError });
    }
  }

  let callIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const id = typeof tc.id === 'string' ? tc.id : `tool-${callIndex}`;
        const fn = tc.function as Record<string, unknown> | undefined;
        const name = (fn?.name as string) ?? (tc.name as string) ?? 'unknown';
        let input: Record<string, unknown> = {};
        if (typeof fn?.arguments === 'string') {
          try { input = JSON.parse(fn.arguments); } catch { /* ignore */ }
        } else if (typeof fn?.arguments === 'object' && fn?.arguments != null) {
          input = fn.arguments as Record<string, unknown>;
        }

        const result = resultMap.get(id);
        const hasError = result?.isError === true;
        const errorStr = hasError && result?.content != null
          ? typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
          : undefined;

        const startTime = sessionStartTime + callIndex * 1000;
        const endTime = result != null ? startTime + 500 : undefined;

        toolCalls.push({
          id,
          name,
          input,
          output: hasError ? undefined : result?.content,
          error: errorStr,
          startTime,
          endTime,
          success: result != null ? !hasError : true,
        });
        callIndex++;
      }
    }
  }

  return toolCalls;
}

/** Fallback: scan message metadata for tool call info (e.g. toolName, tool_name fields) */
function extractFromMetadata(messages: Record<string, unknown>[], sessionStartTime: number): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let callIndex = 0;

  for (const msg of messages) {
    // Some gateways store tool info as top-level fields on the message
    const toolName = (msg.toolName ?? msg.tool_name ?? msg.name) as string | undefined;
    if (toolName && msg.role !== 'user' && msg.role !== 'system') {
      const isError = msg.error != null || msg.is_error === true;
      const errorStr = isError
        ? typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)
        : undefined;

      const startTime = sessionStartTime + callIndex * 1000;
      toolCalls.push({
        id: (msg.id as string) ?? `tool-${callIndex}`,
        name: toolName,
        input: (msg.input as Record<string, unknown>) ?? {},
        output: msg.output ?? msg.result,
        error: errorStr,
        startTime,
        endTime: startTime + 500,
        success: !isError,
      });
      callIndex++;
    }
  }

  return toolCalls;
}

/**
 * Infer a taskType string from session metadata and message content.
 * Used for coverage scoring — the scorer needs sessions tagged by task type
 * to measure how many categories the bot handles successfully.
 */
export function inferTaskType(
  session: { kind?: string; channel?: string; displayName?: string },
  messages: Record<string, unknown>[],
): string {
  if (session.kind && session.kind !== 'chat') return session.kind;
  if (session.channel) return session.channel;

  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (firstUserMsg) {
    const text = typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content
      : Array.isArray(firstUserMsg.content)
        ? (firstUserMsg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join(' ')
        : '';
    if (text) return classifyTask(text);
  }

  return 'general';
}

/** Keyword-based task classification for coverage tracking. */
function classifyTask(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|issue)\b/.test(lower)) return 'debugging';
  if (/\b(add|create|build|implement|new feature)\b/.test(lower)) return 'feature';
  if (/\b(refactor|clean|improve|optimize)\b/.test(lower)) return 'refactoring';
  if (/\b(test|spec|coverage)\b/.test(lower)) return 'testing';
  if (/\b(deploy|release|ship|publish)\b/.test(lower)) return 'deployment';
  if (/\b(explain|what is|how does|why|understand)\b/.test(lower)) return 'inquiry';
  if (/\b(review|pr|pull request)\b/.test(lower)) return 'code-review';
  if (/\b(config|setup|install|configure)\b/.test(lower)) return 'configuration';
  return 'general';
}
