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
 * Pairs tool_use blocks (from assistant messages) with their corresponding
 * tool_result blocks (from user messages) by matching tool_use_id.
 */
export function extractToolCallsFromHistory(
  messages: Record<string, unknown>[],
  sessionStartTime: number,
): ToolCall[] {
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

  // Extract tool_use blocks from assistant messages and pair with results
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

          // Approximate timestamps from message ordering
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
