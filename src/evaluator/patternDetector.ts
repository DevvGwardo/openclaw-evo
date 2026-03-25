/**
 * patternDetector.ts — Failure pattern detection for OpenClaw Evo
 *
 * Analyzes SessionMetrics[] to surface recurring failure patterns.
 * Groups failures by (toolName + errorType + errorMessage prefix ≤50 chars).
 * Assigns severity and returns enriched FailurePattern[] with example contexts.
 */

import type {
  SessionMetrics,
  ToolCall,
  FailurePattern,
  FailureContext,
} from '../types.js';

const LOG_PREFIX = '[patternDetector]';

const ERROR_MSG_PREFIX_LEN = 50;
const MIN_FREQUENCY = 1; // every single failure is a pattern by default

// ── Severity heuristics ───────────────────────────────────────────────────────

/** Keywords that suggest a failure prevented task completion. */
const COMPLETION_BLOCKERS = [
  'fatal', 'crash', 'unhandled', 'panic', 'cannot proceed',
  'unauthorized', 'permission denied', 'forbidden', 'blocked',
];

/** Keywords that suggest a failure caused measurable delay. */
const DELAY_SIGNALS = [
  'timeout', 'timed out', 'slow', 'retry', 'rate limit', 'backoff',
  'too many requests', 'throttl',
];

/** Keywords that suggest a failure required retry / manual recovery. */
const RETRY_SIGNALS = [
  'retry', 'recoverable', 'transient', 'network', 'connection reset',
  'temporary', 'unavailable', 'econnrefused', 'etimedout',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect failure patterns across a set of sessions.
 *
 * @param sessions Sessions to analyze (may include successful ones — they're filtered)
 * @param minFrequency Minimum occurrence count to surface a pattern (default 1)
 */
export function detectPatterns(
  sessions: SessionMetrics[],
  minFrequency = MIN_FREQUENCY,
): FailurePattern[] {
  // Debug: print session composition
  const failures = collectFailures(sessions);
  console.log(`${LOG_PREFIX} Collected ${failures.length} failed tool calls from ${sessions.length} sessions`);

  const groups = groupByKey(failures);
  const patterns: FailurePattern[] = [];

  for (const [key, items] of Object.entries(groups)) {
    if (items.length < minFrequency) continue;

    const pattern = buildPattern(key, items);
    patterns.push(pattern);

    console.log(
      `${LOG_PREFIX} Pattern "${pattern.toolName}/${pattern.errorType}" ` +
      `→ freq=${pattern.frequency} sev=${pattern.severity}`,
    );
  }

  // Sort by frequency descending
  patterns.sort((a, b) => b.frequency - a.frequency);

  return patterns;
}

// ── Step 1: collect failures ─────────────────────────────────────────────────

interface FailureEntry {
  toolCall: ToolCall;
  session: SessionMetrics;
}

function collectFailures(sessions: SessionMetrics[]): FailureEntry[] {
  const entries: FailureEntry[] = [];
  for (const session of sessions) {
    for (const tc of session.toolCalls) {
      if (!tc.success || tc.error) {
        entries.push({ toolCall: tc, session });
      }
    }
  }
  return entries;
}

// ── Step 2: group by composite key ──────────────────────────────────────────

/**
 * Group key = `${toolName}::${errorType}::${errorMsgPrefix}`
 * errorType is derived from the error string when not explicitly set.
 */
function groupKey(tc: ToolCall): string {
  const toolName = tc.name ?? 'unknown';
  const errorType = inferErrorType(tc.error);
  const msgPrefix = (tc.error ?? '').trim();

  // For CLI command errors, drop the path-varying suffix — group all instances
  // of "cat:" failures together regardless of which file was missing, etc.
  const cliMatch = /^(cat|ls|grep|curl|wget|node|python|bash|chmod|mv|rm|echo):\s*/.exec(msgPrefix);
  if (cliMatch) {
    // Group all CLI errors of the same command together (no msgPrefix)
    return `${toolName}::${errorType}::CLI`;
  }

  return `${toolName}::${errorType}::${msgPrefix.slice(0, ERROR_MSG_PREFIX_LEN)}`;
}

function groupByKey(entries: FailureEntry[]): Record<string, FailureEntry[]> {
  const map = new Map<string, FailureEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry.toolCall);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(entry);
  }
  return Object.fromEntries(map);
}

// ── Step 3: build FailurePattern ──────────────────────────────────────────────

function buildPattern(key: string, entries: FailureEntry[]): FailurePattern {
  const [toolName, errorType, errorMsgPrefix] = key.split('::');

  const timestamps = entries.map((e) =>
    e.toolCall.startTime,
  ).filter(Boolean);

  const severity = inferSeverity(errorType, errorMsgPrefix, entries.length);
  const examples = buildExamples(entries);

  return {
    id: `fp-${simpleHash(key)}`,
    toolName,
    errorType,
    errorMessage: errorMsgPrefix,
    frequency: entries.length,
    severity,
    exampleContexts: examples,
    firstSeen: new Date(Math.min(...timestamps)),
    lastSeen: new Date(Math.max(...timestamps)),
    autoFixAvailable: false, // set by caller / hub after skill generation
  };
}

function buildExamples(entries: FailureEntry[]): FailureContext[] {
  return entries.slice(0, 3).map((e) => ({
    sessionId: e.session.sessionId,
    taskDescription: e.session.taskType ?? 'unknown',
    toolInput: e.toolCall.input ?? {},
    errorOutput: e.toolCall.error ?? '',
    timestamp: new Date(e.toolCall.startTime),
  }));
}

// ── Step 4: severity inference ────────────────────────────────────────────────

type Severity = FailurePattern['severity'];

function inferSeverity(
  errorType: string,
  errorMsgPrefix: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _freq: number,
): Severity {
  const combined = `${errorType} ${errorMsgPrefix}`.toLowerCase();

  // Critical: prevents completion outright
  if (COMPLETION_BLOCKERS.some((kw) => combined.includes(kw))) return 'critical';

  // High: causes measurable delay (timeouts, throttling)
  if (DELAY_SIGNALS.some((kw) => combined.includes(kw))) return 'high';

  // Medium: requires retry or manual intervention
  if (RETRY_SIGNALS.some((kw) => combined.includes(kw))) return 'medium';

  // Low: everything else — usually cosmetic / non-blocking
  return 'low';
}

// ── Step 5: error type inference ─────────────────────────────────────────────

function inferErrorType(error?: string): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();

  if (lower.includes('timeout'))          return 'timeout';
  if (lower.includes('unauthorized') ||
      lower.includes('auth') &&
      (lower.includes('fail') || lower.includes('denied'))) return 'auth_error';
  if (lower.includes('not found') ||
      lower.includes('enoent') ||
      lower.includes('404'))             return 'not_found';
  if (lower.includes('rate limit') ||
      lower.includes('throttl') ||
      lower.includes('too many'))        return 'rate_limit';
  if (lower.includes('connection') ||
      lower.includes('network') ||
      lower.includes('econnrefused') ||
      lower.includes('etimedout'))       return 'network_error';
  if (lower.includes('validation') ||
      lower.includes('invalid') ||
      lower.includes('schema'))          return 'validation_error';
  if (lower.includes('permission') ||
      lower.includes('forbidden') ||
      lower.includes('access denied'))   return 'permission_error';

  return 'unknown';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simple non-crypto hash for stable deterministic IDs.
 * Good enough for in-memory pattern keys.
 */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
