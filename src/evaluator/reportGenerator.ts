/**
 * reportGenerator.ts — Evaluation reports for OpenClaw Evo
 *
 * Produces EvaluationReport objects from session metrics and failure patterns.
 * Includes top patterns, auto-generated recommendations, and per-tool scores.
 */

import type {
  SessionMetrics,
  PerformanceScore,
  FailurePattern,
  EvaluationReport,
} from '../types.js';

import { scoreSessions } from './scorer.js';
import { detectPatterns } from './patternDetector.js';

const LOG_PREFIX = '[reportGenerator]';

/** All sessions with at least one failed tool call are considered "problematic tools". */
const PER_TOOL_MIN_CALLS = 1;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Full analysis: score sessions + detect patterns + generate recommendations.
 *
 * @param sessions All sessions to evaluate
 * @param existingPatterns Optional pre-detected patterns to reuse
 */
export function analyze(
  sessions: SessionMetrics[],
  existingPatterns?: FailurePattern[],
): EvaluationReport {
  console.log(`${LOG_PREFIX} Analyzing ${sessions.length} sessions…`);

  const periodStart = sessions.length > 0
    ? new Date(Math.min(...sessions.map((s) => s.startTime)))
    : new Date();
  const periodEnd = sessions.length > 0
    ? new Date(
        Math.max(
          ...sessions.map((s) => s.endTime ?? Date.now()),
        ),
      )
    : new Date();

  const successfulSessions = sessions.filter((s) => s.success).length;

  // 1. Overall performance score
  const overallScore = scoreSessions(sessions);

  // 2. Per-tool scores
  const toolScores = scorePerTool(sessions);

  // 3. Failure patterns
  const patterns = existingPatterns ?? detectPatterns(sessions);
  const topFailurePatterns = patterns.slice(0, 10); // top-10 by frequency

  // 4. Recommendations
  const recommendations = generateRecommendations(sessions, patterns, toolScores);

  const report: EvaluationReport = {
    timestamp: new Date(),
    periodStart,
    periodEnd,
    totalSessions: sessions.length,
    successfulSessions,
    overallScore,
    toolScores,
    topFailurePatterns,
    recommendations,
  };

  console.log(
    `${LOG_PREFIX} Report ready — ${successfulSessions}/${sessions.length} sessions OK, ` +
    `overall=${overallScore.overall.toFixed(1)}, ${recommendations.length} recommendations`,
  );

  return report;
}

/** Score only sessions associated with each distinct tool name. */
export function scorePerTool(sessions: SessionMetrics[]): Record<string, PerformanceScore> {
  const toolMap = new Map<string, SessionMetrics[]>();

  for (const session of sessions) {
    for (const tc of session.toolCalls) {
      const name = tc.name ?? 'unknown';
      if (!toolMap.has(name)) toolMap.set(name, []);
      // Enrich a synthetic session-level view per tool
      toolMap.get(name)!.push({
        ...session,
        toolCalls: [tc],
        totalToolCalls: 1,
        errorCount: tc.success ? 0 : 1,
      });
    }
  }

  const scores: Record<string, PerformanceScore> = {};
  for (const [toolName, toolSessions] of toolMap) {
    scores[toolName] = scoreSessions(toolSessions);
  }
  return scores;
}

// ── Recommendation engine ────────────────────────────────────────────────────

function generateRecommendations(
  sessions: SessionMetrics[],
  patterns: FailurePattern[],
  toolScores: Record<string, PerformanceScore>,
): string[] {
  const recs: string[] = [];

  recs.push(...severityRecommendations(patterns));
  recs.push(...reliabilityRecommendations(sessions));
  recs.push(...toolScoreRecommendations(toolScores));
  recs.push(...coverageRecommendations(sessions));

  // Deduplicate while preserving order
  return [...new Set(recs)];
}

function severityRecommendations(patterns: FailurePattern[]): string[] {
  const recs: string[] = [];

  const critical = patterns.filter((p) => p.severity === 'critical');
  for (const p of critical) {
    recs.push(
      `[critical] ${p.toolName}: ${p.errorType} — ${p.frequency} occurrence(s). ` +
      `This error prevents task completion. Investigate and fix urgently.`,
    );
  }

  const high = patterns.filter((p) => p.severity === 'high');
  for (const p of high) {
    recs.push(
      `[high] ${p.toolName}: ${p.errorType} — ${p.frequency} occurrence(s). ` +
      `This error causes significant delays. Prioritise improvement.`,
    );
  }

  return recs;
}

function reliabilityRecommendations(sessions: SessionMetrics[]): string[] {
  const recs: string[] = [];

  // Aggregate error counts by tool across all sessions
  const errorByTool = new Map<string, number>();
  const callByTool = new Map<string, number>();

  for (const session of sessions) {
    for (const tc of session.toolCalls) {
      const name = tc.name ?? 'unknown';
      callByTool.set(name, (callByTool.get(name) ?? 0) + 1);
      if (!tc.success) errorByTool.set(name, (errorByTool.get(name) ?? 0) + 1);
    }
  }

  for (const [toolName, errors] of errorByTool) {
    const total = callByTool.get(toolName) ?? 1;
    const errorRate = errors / total;
    if (errorRate > 0.2) {
      recs.push(
        `Consider improving ${toolName} error handling — ` +
        `${(errorRate * 100).toFixed(0)}% error rate (${errors}/${total} calls failed).`,
      );
    }
  }

  return recs;
}

function toolScoreRecommendations(toolScores: Record<string, PerformanceScore>): string[] {
  const recs: string[] = [];

  for (const [toolName, score] of Object.entries(toolScores)) {
    if (score.efficiency < 50) {
      recs.push(
        `${toolName} has low efficiency (${score.efficiency.toFixed(1)}). ` +
        `Review whether the tool is being called optimally or if unnecessary calls can be reduced.`,
      );
    }
    if (score.speed < 50) {
      recs.push(
        `${toolName} is running slow (speed score: ${score.speed.toFixed(1)}). ` +
        `Investigate whether caching, batching, or async patterns could improve throughput.`,
      );
    }
  }

  return recs;
}

function coverageRecommendations(sessions: SessionMetrics[]): string[] {
  const recs: string[] = [];

  const withType = sessions.filter((s) => s.taskType != null);
  if (withType.length === 0) return recs;

  const uniqueTypes = new Set(withType.map((s) => s.taskType));
  const handled = new Set(
    sessions.filter((s) => s.success && s.taskType).map((s) => s.taskType),
  );

  const uncovered = [...uniqueTypes].filter((t) => !handled.has(t));
  if (uncovered.length > 0) {
    recs.push(
      `${uncovered.length} task type(s) have no successful sessions: ${uncovered.join(', ')}. ` +
      `Consider adding skills to cover these scenarios.`,
    );
  }

  return recs;
}
