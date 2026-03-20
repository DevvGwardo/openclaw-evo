/**
 * scorer.ts — Performance scoring for OpenClaw Evo
 *
 * Scores agent performance across multiple dimensions:
 *   accuracy, efficiency, speed, reliability, coverage
 *
 * Takes SessionMetrics[] and returns a PerformanceScore.
 */

import type { SessionMetrics, PerformanceScore, FailurePattern } from '../types.js';
import { store } from '../memory/store.js';
import { WEIGHT_CONFIG_KEY, DEFAULT_WEIGHTS } from '../constants.js';

// ── Defaults & tuning ────────────────────────────────────────────────────────

const DEFAULT_BASELINE_TIME_MS = 60_000; // 1 minute baseline per session
const DEFAULT_OPTIMAL_CALLS = 3;         // optimal tool calls per session

const WEIGHT_MIN = 0.05;
const WEIGHT_MAX = 0.40;

const LOG_PREFIX = '[scorer]';

// ── Adaptive weights ─────────────────────────────────────────────────────────

export interface AdaptiveWeights {
  accuracy: number;
  efficiency: number;
  speed: number;
  reliability: number;
  coverage: number;
}

/** Read weights from the memory store, falling back to defaults. */
export async function getWeights(): Promise<AdaptiveWeights> {
  const saved = await store.load<AdaptiveWeights>(WEIGHT_CONFIG_KEY);
  if (saved) return saved;
  return { ...DEFAULT_WEIGHTS };
}

/** Persist the given weights to the memory store. */
export async function saveWeights(weights: AdaptiveWeights): Promise<void> {
  await store.save(WEIGHT_CONFIG_KEY, weights);
}

/**
 * Tune weights based on observed failure patterns and historical results.
 *
 * Rules:
 *   - Reliability errors in >20% of sessions  → increase reliability, decrease speed
 *   - Coverage gaps (coverage < 60)          → increase coverage
 *   - Consistently low efficiency (<50)       → increase efficiency
 * All weights stay bounded in [WEIGHT_MIN, WEIGHT_MAX] then are renormalised to sum=1.
 */
export function tuneWeights(
  historicalResults: SessionMetrics[],
  patterns: FailurePattern[],
): AdaptiveWeights {
  const weights: AdaptiveWeights = { ...DEFAULT_WEIGHTS };

  if (historicalResults.length === 0) return weights;

  // ── Reliability error rate ────────────────────────────────────────────────
  const sessionsWithErrors = historicalResults.filter((s) => s.errorCount > 0).length;
  const errorRate = sessionsWithErrors / historicalResults.length;
  if (errorRate > 0.05) {
    weights.reliability = Math.min(WEIGHT_MAX, weights.reliability + 0.05);
    weights.speed       = Math.max(WEIGHT_MIN, weights.speed - 0.05);
  }

  // ── Coverage gaps ─────────────────────────────────────────────────────────
  const coverage = calcCoverage(historicalResults);
  if (coverage < 80) {
    weights.coverage = Math.min(WEIGHT_MAX, weights.coverage + 0.05);
  }

  // ── Low efficiency ────────────────────────────────────────────────────────
  const efficiency = calcEfficiency(historicalResults, DEFAULT_OPTIMAL_CALLS);
  if (efficiency < 70) {
    weights.efficiency = Math.min(WEIGHT_MAX, weights.efficiency + 0.05);
  }

  // ── Renormalise so weights sum to 1 ──────────────────────────────────────
  const total = weights.accuracy + weights.efficiency + weights.speed +
                 weights.reliability + weights.coverage;
  if (total === 0) return { ...DEFAULT_WEIGHTS };
  const factor = 1 / total;
  const tuned: AdaptiveWeights = {
    accuracy:    clamp(weights.accuracy    * factor, WEIGHT_MIN, WEIGHT_MAX),
    efficiency:  clamp(weights.efficiency  * factor, WEIGHT_MIN, WEIGHT_MAX),
    speed:       clamp(weights.speed        * factor, WEIGHT_MIN, WEIGHT_MAX),
    reliability: clamp(weights.reliability * factor, WEIGHT_MIN, WEIGHT_MAX),
    coverage:    clamp(weights.coverage    * factor, WEIGHT_MIN, WEIGHT_MAX),
  };

  // Final renormalise pass to guarantee sum===1 after clamping
  const finalTotal = tuned.accuracy + tuned.efficiency + tuned.speed +
                     tuned.reliability + tuned.coverage;
  if (finalTotal === 0) return { ...DEFAULT_WEIGHTS };
  const finalFactor = 1 / finalTotal;
  return {
    accuracy:    tuned.accuracy    * finalFactor,
    efficiency:  tuned.efficiency  * finalFactor,
    speed:       tuned.speed        * finalFactor,
    reliability: tuned.reliability * finalFactor,
    coverage:    tuned.coverage     * finalFactor,
  };
}

/**
 * Score sessions using tuned (adaptive) weights stored in the memory system.
 * Loads weights from the store, tunes them with the supplied data, saves the result,
 * then scores using the new weights.
 */
export async function adaptiveScoreSessions(
  sessions: SessionMetrics[],
  patterns: FailurePattern[] = [],
  baselineTimeMs = DEFAULT_BASELINE_TIME_MS,
  optimalCalls = DEFAULT_OPTIMAL_CALLS,
): Promise<PerformanceScore> {
  const currentWeights = await getWeights();
  const tunedWeights = tuneWeights(sessions, patterns);
  await saveWeights(tunedWeights);

  return scoreSessionsWithWeights(sessions, tunedWeights, baselineTimeMs, optimalCalls);
}

// ── Score with explicit weights (used by both scoreSessions and adaptiveScoreSessions) ──

function scoreSessionsWithWeights(
  sessions: SessionMetrics[],
  weights: AdaptiveWeights,
  baselineTimeMs: number,
  optimalCalls: number,
): PerformanceScore {
  const accuracy    = calcAccuracy(sessions);
  const efficiency  = calcEfficiency(sessions, optimalCalls);
  const speed       = calcSpeed(sessions, baselineTimeMs);
  const reliability = calcReliability(sessions);
  const coverage    = calcCoverage(sessions);

  const overall = weightedOverall(accuracy, efficiency, speed, reliability, coverage, weights);

  const score: PerformanceScore = {
    accuracy,
    efficiency,
    speed,
    reliability,
    coverage,
    overall,
  };

  console.log(
    `${LOG_PREFIX} Adaptive scored ${sessions.length} sessions — overall: ${overall.toFixed(1)} ` +
    `(acc=${accuracy.toFixed(1)} eff=${efficiency.toFixed(1)} spd=${speed.toFixed(1)} ` +
    `rel=${reliability.toFixed(1)} cov=${coverage.toFixed(1)})`,
  );

  return score;
}

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
  return scoreSessionsWithWeights(sessions, { ...DEFAULT_WEIGHTS }, baselineTimeMs, optimalCalls);
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
    if (s.totalToolCalls === 0) return 0; // no tool calls = no work accomplished
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
    // Prefer actual tool latency over wall-clock if available
    if (s.avgLatencyMs > 0 && s.totalToolCalls > 0) {
      const totalToolTime = s.avgLatencyMs * s.totalToolCalls;
      return Math.min(100, (baselineTimeMs / totalToolTime) * 100);
    }
    // Fall back to wall-clock duration
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
  weights: AdaptiveWeights = { ...DEFAULT_WEIGHTS },
): number {
  return cap100(
    weights.accuracy    * accuracy    +
    weights.efficiency  * efficiency  +
    weights.speed       * speed       +
    weights.reliability * reliability +
    weights.coverage    * coverage,
  );
}

function cap100(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function zeroScore(): PerformanceScore {
  return { accuracy: 0, efficiency: 0, speed: 0, reliability: 0, coverage: 0, overall: 0 };
}
