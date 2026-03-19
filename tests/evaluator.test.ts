/**
 * tests/evaluator.test.ts
 *
 * Tests for:
 *   - evaluator/scorer.ts   → scoreSessions() and dimension calculators
 *   - evaluator/patternDetector.ts → detectPatterns()
 *
 * Run with: npm test (vitest run)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  scoreSessions,
  calcAccuracy,
  calcEfficiency,
  calcSpeed,
  calcReliability,
  calcCoverage,
  weightedOverall,
} from '../src/evaluator/scorer.js';
import { detectPatterns } from '../src/evaluator/patternDetector.js';
import type { SessionMetrics, ToolCall, FailurePattern } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `tc-${Math.random().toString(36).slice(2)}`,
    name: 'testTool',
    input: {},
    startTime: Date.now() - 5000,
    endTime: Date.now(),
    success: true,
    error: undefined,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  const startTime = Date.now() - 10_000;
  const endTime = Date.now();
  const toolCalls: ToolCall[] = overrides.toolCalls ?? [makeToolCall({ startTime, endTime })];
  const totalToolCalls = overrides.totalToolCalls ?? toolCalls.length;
  const errorCount = overrides.errorCount ?? toolCalls.filter(t => !t.success).length;

  return {
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    toolCalls,
    startTime,
    endTime,
    success: overrides.success ?? true,
    errorCount,
    totalToolCalls,
    avgLatencyMs: 150,
    taskType: 'data_processing',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// scorer.ts — scoreSessions()
// ═══════════════════════════════════════════════════════════════════════════════

describe('scorer.ts — scoreSessions()', () => {

  // ── Perfect session ──────────────────────────────────────────────────────

  it('perfect session yields accuracy=100, reliability=100, efficiency=100', () => {
    const session = makeSession({
      toolCalls: [
        makeToolCall({ success: true }),
        makeToolCall({ success: true }),
        makeToolCall({ success: true }),
      ],
      totalToolCalls: 3,
      errorCount: 0,
      success: true,
    });

    const score = scoreSessions([session]);

    expect(score.accuracy).toBe(100);
    expect(score.reliability).toBe(100);
    expect(score.efficiency).toBe(100); // exactly 3 calls (optimal=3) → 100
  });

  // ── 1 error out of 4 tools → reliability=75 ─────────────────────────────

  it('session with 1 error out of 4 calls yields reliability=75', () => {
    const session = makeSession({
      toolCalls: [
        makeToolCall({ success: true }),
        makeToolCall({ success: false, error: 'timeout' }),
        makeToolCall({ success: true }),
        makeToolCall({ success: true }),
      ],
      totalToolCalls: 4,
      errorCount: 1,
      success: false,
    });

    const score = scoreSessions([session]);

    // reliability = 100 - (1/4 * 100) = 75
    expect(score.reliability).toBe(75);
  });

  // ── Empty sessions → all zeros ─────────────────────────────────────────

  it('empty sessions array returns all-zero score with a warning', () => {
    const score = scoreSessions([]);

    expect(score.accuracy).toBe(0);
    expect(score.efficiency).toBe(0);
    expect(score.speed).toBe(0);
    expect(score.reliability).toBe(0);
    expect(score.coverage).toBe(0);
    expect(score.overall).toBe(0);
  });

  // ── Multiple sessions averaged correctly ────────────────────────────────

  it('multiple sessions are averaged correctly across all dimensions', () => {
    const sessions: SessionMetrics[] = [
      // session 1: perfect, 3 calls, no errors, successful
      makeSession({
        toolCalls: [
          makeToolCall({ success: true }),
          makeToolCall({ success: true }),
          makeToolCall({ success: true }),
        ],
        totalToolCalls: 3,
        errorCount: 0,
        success: true,
        taskType: 'data_processing',
      }),
      // session 2: perfect too, different task type
      makeSession({
        toolCalls: [
          makeToolCall({ success: true }),
          makeToolCall({ success: true }),
        ],
        totalToolCalls: 2,
        errorCount: 0,
        success: true,
        taskType: 'web_search',
      }),
    ];

    const score = scoreSessions(sessions);

    // accuracy = 100 * (2/2) = 100 (both sessions succeeded)
    expect(score.accuracy).toBe(100);

    // reliability = 100 - (0/5 * 100) = 100
    expect(score.reliability).toBe(100);

    // efficiency: session 1 ratio = 3/3=1 → 100; session 2 ratio = 3/2=1.5 → capped at 100; avg = 100
    expect(score.efficiency).toBe(100);

    // coverage: 2 unique task types, both have successful sessions → 100
    expect(score.coverage).toBe(100);
  });

  it('two sessions with different task types both succeeding yields 100% coverage', () => {
    const sessions = [
      makeSession({ success: true, taskType: 'type_a' }),
      makeSession({ success: true, taskType: 'type_b' }),
    ];
    expect(calcCoverage(sessions)).toBe(100);
  });

  // ── calcAccuracy ────────────────────────────────────────────────────────

  describe('calcAccuracy()', () => {
    it('returns 0 for empty array', () => {
      expect(calcAccuracy([])).toBe(0);
    });

    it('returns 100 for all-successful sessions', () => {
      const sessions = [
        makeSession({ success: true }),
        makeSession({ success: true }),
      ];
      expect(calcAccuracy(sessions)).toBe(100);
    });

    it('returns 50 for half-successful sessions', () => {
      const sessions = [
        makeSession({ success: true }),
        makeSession({ success: false }),
      ];
      expect(calcAccuracy(sessions)).toBe(50);
    });
  });

  // ── calcEfficiency ──────────────────────────────────────────────────────

  describe('calcEfficiency()', () => {
    it('returns 100 when actual calls equal optimal', () => {
      const sessions = [makeSession({ totalToolCalls: 3 })];
      expect(calcEfficiency(sessions, 3)).toBe(100);
    });

    it('caps at 100 when fewer calls than optimal (over-efficient)', () => {
      const sessions = [makeSession({ totalToolCalls: 1 })];
      expect(calcEfficiency(sessions, 3)).toBe(100); // ratio = 3/1 = 3 → capped
    });

    it('penalizes using more calls than optimal', () => {
      const sessions = [makeSession({ totalToolCalls: 6 })];
      // ratio = 3/6 = 0.5 → 50
      expect(calcEfficiency(sessions, 3)).toBe(50);
    });

    it('treats zero calls as optimal (no waste)', () => {
      const sessions = [makeSession({ totalToolCalls: 0 })];
      expect(calcEfficiency(sessions, 3)).toBe(100);
    });
  });

  // ── calcSpeed ───────────────────────────────────────────────────────────

  describe('calcSpeed()', () => {
    it('returns 100 when duration equals baseline', () => {
      const baselineMs = 60_000;
      const start = Date.now() - baselineMs;
      const sessions = [makeSession({ startTime: start, endTime: Date.now() })];
      expect(calcSpeed(sessions, baselineMs)).toBe(100);
    });

    it('returns 100 when still running (no endTime) and startTime is very recent', () => {
      // When endTime is undefined, duration = Date.now() - startTime.
      // With a very recent startTime, duration ≈ 0, speed = (baseline/duration)*100 → capped at 100.
      const sessions = [makeSession({ startTime: Date.now(), endTime: undefined })];
      expect(calcSpeed(sessions, 60_000)).toBe(100);
    });

    it('caps at 100 when faster than baseline', () => {
      const start = Date.now() - 1_000;
      const sessions = [makeSession({ startTime: start, endTime: Date.now() })];
      // Duration ~1s, baseline 60s → (60000/1)*100 = 6_000_000 → capped at 100
      expect(calcSpeed(sessions, 60_000)).toBe(100);
    });

    it('drops below 100 when slower than baseline', () => {
      const start = Date.now() - 120_000;
      const sessions = [makeSession({ startTime: start, endTime: Date.now() })];
      // Duration 120s, baseline 60s → (60000/120000)*100 = 50
      expect(calcSpeed(sessions, 60_000)).toBe(50);
    });
  });

  // ── calcReliability ──────────────────────────────────────────────────────

  describe('calcReliability()', () => {
    it('returns 100 when no errors', () => {
      const sessions = [makeSession({ errorCount: 0, totalToolCalls: 5 })];
      expect(calcReliability(sessions)).toBe(100);
    });

    it('returns 0 when all calls errored', () => {
      const sessions = [makeSession({ errorCount: 5, totalToolCalls: 5 })];
      expect(calcReliability(sessions)).toBe(0);
    });

    it('handles zero total calls gracefully', () => {
      const sessions = [makeSession({ totalToolCalls: 0, errorCount: 0 })];
      expect(calcReliability(sessions)).toBe(100);
    });
  });

  // ── calcCoverage ────────────────────────────────────────────────────────

  describe('calcCoverage()', () => {
    it('returns 0 when no sessions have taskType', () => {
      const sessions = [
        makeSession({ taskType: undefined }),
        makeSession({ taskType: undefined }),
      ];
      expect(calcCoverage(sessions)).toBe(0);
    });

    it('returns 100 when all unique task types have at least one success', () => {
      const sessions = [
        makeSession({ taskType: 'type_a', success: true }),
        makeSession({ taskType: 'type_b', success: true }),
      ];
      expect(calcCoverage(sessions)).toBe(100);
    });

    it('returns 50 when only half of task types are covered', () => {
      const sessions = [
        makeSession({ taskType: 'type_a', success: true }),
        makeSession({ taskType: 'type_b', success: false }),
      ];
      expect(calcCoverage(sessions)).toBe(50);
    });
  });

  // ── weightedOverall ─────────────────────────────────────────────────────

  describe('weightedOverall()', () => {
    it('returns the weighted average of all dimensions', () => {
      // Weights: accuracy=0.25, efficiency=0.20, speed=0.20, reliability=0.25, coverage=0.10
      const overall = weightedOverall(100, 100, 100, 100, 100);
      expect(overall).toBe(100);
    });

    it('handles mixed scores correctly', () => {
      // accuracy=100 (×0.25=25), efficiency=50 (×0.20=10),
      // speed=50 (×0.20=10), reliability=100 (×0.25=25), coverage=0 (×0.10=0)
      const overall = weightedOverall(100, 50, 50, 100, 0);
      expect(overall).toBe(70);
    });

    it('caps at 100 even when raw sum exceeds', () => {
      // Each at 100 → 100, but also test over-cap case
      expect(weightedOverall(120, 120, 120, 120, 120)).toBe(100);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// patternDetector.ts — detectPatterns()
// ═══════════════════════════════════════════════════════════════════════════════

describe('patternDetector.ts — detectPatterns()', () => {

  // ── Groups same errors together ──────────────────────────────────────────

  it('groups tool calls with same toolName + errorType + errorMessage prefix together', () => {
    const start = Date.now();
    // Use EXACT same error string so the 50-char prefix matches
    const sameError = 'ENOENT: no such file or directory at /tmp';
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 's1',
        startTime: start,
        endTime: start + 1000,
        toolCalls: [
          makeToolCall({ name: 'read', success: false, error: sameError, startTime: start }),
          makeToolCall({ name: 'write', success: true, startTime: start + 100 }),
        ],
        totalToolCalls: 2,
        errorCount: 1,
        success: false,
        taskType: 'file_manipulation',
      }),
      makeSession({
        sessionId: 's2',
        startTime: start + 2000,
        endTime: start + 3000,
        toolCalls: [
          makeToolCall({ name: 'read', success: false, error: sameError, startTime: start + 2000 }),
          makeToolCall({ name: 'read', success: false, error: sameError, startTime: start + 2100 }),
        ],
        totalToolCalls: 2,
        errorCount: 2,
        success: false,
        taskType: 'file_manipulation',
      }),
    ];

    const patterns = detectPatterns(sessions, 1);

    // All 3 read/not_found failures should be grouped into one pattern with frequency=3
    const readPattern = patterns.find(p => p.toolName === 'read' && p.errorType === 'not_found');
    expect(readPattern).toBeDefined();
    expect(readPattern!.frequency).toBe(3);
  });

  // ── minFrequency filter works ───────────────────────────────────────────

  it('excludes patterns that appear fewer than minFrequency times', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 's1',
        startTime: start,
        endTime: start + 1000,
        toolCalls: [
          makeToolCall({ name: 'read', success: false, error: 'ENOENT: no such file', startTime: start }),
        ],
        totalToolCalls: 1,
        errorCount: 1,
        success: false,
      }),
    ];

    const patternsMin2 = detectPatterns(sessions, 2);
    expect(patternsMin2).toHaveLength(0);

    const patternsMin1 = detectPatterns(sessions, 1);
    expect(patternsMin1).toHaveLength(1);
  });

  // ── Severity assignment: completion blockers = critical ─────────────────

  it('assigns severity=critical when error message contains completion blocker keywords', () => {
    const start = Date.now();
    const blockerKeywords = [
      'fatal error',
      'crash',
      'unhandled rejection',
      'panic:',
      'cannot proceed',
      'unauthorized access',
      'permission denied',
      'access forbidden',
      'blocked by policy',
    ];

    const sessions: SessionMetrics[] = blockerKeywords.map((keyword, i) =>
      makeSession({
        sessionId: `s${i}`,
        startTime: start + i * 1000,
        endTime: start + i * 1000 + 500,
        toolCalls: [
          makeToolCall({
            name: 'api_call',
            success: false,
            error: `Operation failed: ${keyword} — cannot continue`,
            startTime: start + i * 1000,
          }),
        ],
        totalToolCalls: 1,
        errorCount: 1,
        success: false,
      }),
    );

    const patterns = detectPatterns(sessions, 1);

    // Each keyword creates its own pattern (different message prefixes)
    // "fatal error", "crash", "unhandled rejection", etc. should all be critical
    const criticalPatterns = patterns.filter(p => p.severity === 'critical');
    expect(criticalPatterns.length).toBeGreaterThan(0);
  });

  it('assigns severity=high for timeout/delay keywords', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 't1',
        startTime: start,
        endTime: start + 5000,
        toolCalls: [
          makeToolCall({ name: 'web_search', success: false, error: 'Request timeout after 30000ms', startTime: start }),
          makeToolCall({ name: 'web_fetch', success: false, error: 'Rate limit exceeded — throttled', startTime: start + 100 }),
        ],
        totalToolCalls: 2,
        errorCount: 2,
        success: false,
      }),
    ];

    const patterns = detectPatterns(sessions, 1);

    const timeoutPattern = patterns.find(p => p.errorType === 'timeout');
    expect(timeoutPattern?.severity).toBe('high');

    const rateLimitPattern = patterns.find(p => p.errorType === 'rate_limit');
    expect(rateLimitPattern?.severity).toBe('high');
  });

  it('assigns severity=medium for retry/recoverable keywords', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 't2',
        startTime: start,
        endTime: start + 2000,
        toolCalls: [
          makeToolCall({ name: 'api_call', success: false, error: 'transient network error: service temporarily unavailable', startTime: start }),
        ],
        totalToolCalls: 1,
        errorCount: 1,
        success: false,
      }),
    ];

    const patterns = detectPatterns(sessions, 1);
    const networkPattern = patterns.find(p => p.errorType === 'network_error');
    expect(networkPattern?.severity).toBe('medium');
  });

  it('returns patterns sorted by frequency descending', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      // High frequency pattern (3 occurrences)
      makeSession({
        sessionId: 'sA1',
        startTime: start,
        endTime: start + 1000,
        toolCalls: [
          makeToolCall({ name: 'read', success: false, error: 'ENOENT: file not found', startTime: start }),
          makeToolCall({ name: 'read', success: false, error: 'ENOENT: file not found', startTime: start + 50 }),
          makeToolCall({ name: 'read', success: false, error: 'ENOENT: file not found', startTime: start + 100 }),
        ],
        totalToolCalls: 3,
        errorCount: 3,
        success: false,
      }),
      // Lower frequency pattern (1 occurrence)
      makeSession({
        sessionId: 'sB1',
        startTime: start + 2000,
        endTime: start + 3000,
        toolCalls: [
          makeToolCall({ name: 'write', success: false, error: 'permission denied', startTime: start + 2000 }),
        ],
        totalToolCalls: 1,
        errorCount: 1,
        success: false,
      }),
    ];

    const patterns = detectPatterns(sessions, 1);
    expect(patterns[0].frequency).toBe(3);
    expect(patterns[1].frequency).toBe(1);
  });

  it('skips successful tool calls (only detects failures)', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 's_ok',
        startTime: start,
        endTime: start + 1000,
        toolCalls: [
          makeToolCall({ name: 'read', success: true, startTime: start }),
          makeToolCall({ name: 'write', success: true, startTime: start + 100 }),
        ],
        totalToolCalls: 2,
        errorCount: 0,
        success: true,
      }),
    ];

    const patterns = detectPatterns(sessions, 1);
    expect(patterns).toHaveLength(0);
  });

  it('populates exampleContexts with session metadata', () => {
    const start = Date.now();
    const sessions: SessionMetrics[] = [
      makeSession({
        sessionId: 's_example',
        startTime: start,
        endTime: start + 1000,
        taskType: 'file_manipulation',
        toolCalls: [
          makeToolCall({
            name: 'read',
            success: false,
            error: 'ENOENT: file not found',
            startTime: start,
            input: { path: '/tmp/test.txt' },
          }),
        ],
        totalToolCalls: 1,
        errorCount: 1,
        success: false,
      }),
    ];

    const patterns = detectPatterns(sessions, 1);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].exampleContexts).toHaveLength(1);
    expect(patterns[0].exampleContexts[0].sessionId).toBe('s_example');
    expect(patterns[0].exampleContexts[0].taskDescription).toBe('file_manipulation');
    expect(patterns[0].exampleContexts[0].errorOutput).toBe('ENOENT: file not found');
  });
});
