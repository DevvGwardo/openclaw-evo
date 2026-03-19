/**
 * scorer.ts — Performance scoring for OpenClaw Evo
 *
 * Scores agent performance across multiple dimensions:
 *   accuracy, efficiency, speed, reliability, coverage
 *
 * Takes SessionMetrics[] and returns a PerformanceScore.
 */

import type { SessionMetrics, PerformanceScore } from '../types.js';

// ── Defaults & tuning ────────────────────────────────────────────────────────

const DEFAULT_BASELINE_TIME_MS = 60_000; // 1 minute baseline per session
const DEFAULT_OPTIMAL_CALLS = 3;         // optimal tool calls per session

const WEIGHTS = {
  accuracy:   0.25,
  efficiency: 0.20,
  speed:      0.20,
  reliability:0.25,
  coverage:   0.10,
} as const;

const LOG_PREFIX = '[scorer]';

/**
 * Compute performance scores from a batch of session metrics.
 *
 * @param sessions       All sessions to score
 * @param baselineTimeMs Per-session time baseline (default 60 s)
 * @param optimalCalls    Per-session optimal tool call count (default 3)
 */
export function scoreSessions(
  sessions: SessionMetrics[],
  baselineTimeMs = DEFAULT_BASELINE_TIME_MS,
  optimalCalls = DEFAULT_OPTIMAL_CALLS,
): PerformanceScore {
  if (sessions.length === 0) {
    console.warn(`${LOG_PREFIX} No sessions provided — returning zero scores`);
    return zeroScore();
  }

  const accuracy   = calcAccuracy(sessions);
  const efficiency = calcEfficiency(sessions, optimalCalls);
  const speed      = calcSpeed(sessions, baselineTimeMs);
  const reliability= calcReliability(sessions);
  const coverage   = calcCoverage(sessions);

  const overall = weightedOverall(accuracy, efficiency, speed, reliability, coverage);

  const score: PerformanceScore = {
    accuracy,
    efficiency,
    speed,
    reliability,
    coverage,
    overall,
  };

  console.log(
    `${LOG_PREFIX} Scored ${sessions.length} sessions — overall: ${overall.toFixed(1)} ` +
    `(acc=${accuracy.toFixed(1)} eff=${efficiency.toFixed(1)} spd=${speed.toFixed(1)} ` +
    `rel=${reliability.toFixed(1)} cov=${coverage.toFixed(1)})`,
  );

  return score;
}

// ── Dimension calculators ─────────────────────────────────────────────────────

/**
 * Accuracy: fraction of sessions that completed successfully.
 *   100 × (successful sessions / total sessions)
 */
export function calcAccuracy(sessions: SessionMetrics[]): number {
  if (sessions.length === 0) return 0;
  const ok = sessions.filter((s) => s.success).length;
  return cap100((ok / sessions.length) * 100);
}

/**
 * Efficiency: how close actual tool calls are to optimal.
 *   min(100, optimalCalls / actualCalls × 100)
 *
 * A session that uses exactly optimalCalls gets 100.
 * Fewer calls than optimal are penalised (over-efficiency is capped at 100).
 * We treat "too many calls" as inefficient — ratio inverts.
 */
export function calcEfficiency(sessions: SessionMetrics[], optimalCalls: number): number {
  if (sessions.length === 0) return 0;

  const scores = sessions.map((s) => {
    if (s.totalToolCalls === 0) return optimalCalls > 0 ? 100 : 100; // no calls = perfect (no waste)
    // ratio > 1 means we used fewer calls than optimal (good)
    // ratio < 1 means we used more calls than optimal (bad)
    const ratio = optimalCalls / s.totalToolCalls;
    return Math.min(100, ratio * 100);
  });

  return cap100(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/**
 * Speed: how actual session duration compares to baseline.
 *   min(100, baselineTime / actualTime × 100)
 *
 * If actualTime > baselineTime the score drops below 100.
 */
export function calcSpeed(sessions: SessionMetrics[], baselineTimeMs: number): number {
  if (sessions.length === 0) return 0;

  const scores = sessions.map((s) => {
    const duration = (s.endTime ?? Date.now()) - s.startTime;
    if (duration <= 0) return 100; // still running
    return Math.min(100, (baselineTimeMs / duration) * 100);
  });

  return cap100(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/**
 * Reliability: 100 minus the error rate across all tool calls.
 *   100 - (totalErrors / totalCalls × 100)
 */
export function calcReliability(sessions: SessionMetrics[]): number {
  const totalCalls = sessions.reduce((a, s) => a + s.totalToolCalls, 0);
  const totalErrors = sessions.reduce((a, s) => a + s.errorCount, 0);
  if (totalCalls === 0) return 100;
  return cap100(100 - (totalErrors / totalCalls) * 100);
}

/**
 * Coverage: percentage of unique task types successfully handled.
 * Sessions with no taskType are excluded from the denominator.
 */
export function calcCoverage(sessions: SessionMetrics[]): number {
  const withType = sessions.filter((s) => s.taskType != null);
  if (withType.length === 0) return 0;
  const covered = new Set(
    sessions
      .filter((s) => s.success && s.taskType != null)
      .map((s) => s.taskType),
  );
  const unique = new Set(withType.map((s) => s.taskType));
  return cap100((covered.size / unique.size) * 100);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function weightedOverall(
  accuracy: number,
  efficiency: number,
  speed: number,
  reliability: number,
  coverage: number,
): number {
  return cap100(
    WEIGHTS.accuracy    * accuracy    +
    WEIGHTS.efficiency  * efficiency  +
    WEIGHTS.speed       * speed       +
    WEIGHTS.reliability * reliability +
    WEIGHTS.coverage    * coverage,
  );
}

function cap100(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function zeroScore(): PerformanceScore {
  return { accuracy: 0, efficiency: 0, speed: 0, reliability: 0, coverage: 0, overall: 0 };
}
