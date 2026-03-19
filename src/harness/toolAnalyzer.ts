/**
 * Tool Analyzer
 * Detects tool call success/failure patterns, identifies bottlenecks,
 * and surfaces trends for the evaluator and tool builder.
 */

import type { ToolLifecycle, FailurePattern, FailureContext, SessionMetrics } from '../types.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface ToolStats {
  toolName: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  reliability: number;       // 0-100
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  errorTypes: Map<string, number>;
}

interface Bottleneck {
  toolName: string;
  reason: 'high_latency' | 'high_error_rate' | 'frequent_timeouts' | 'low_throughput';
  severity: 'low' | 'medium' | 'high';
  metric: number;
  threshold: number;
  suggestion: string;
}

/**
 * ToolAnalyzer
 *
 * Consumes ToolLifecycle arrays (e.g., from SessionTracker) and produces:
 * - Per-tool reliability and latency statistics
 * - FailurePattern[] for the failure corpus
 * - Bottleneck[] for performance recommendations
 */
export class ToolAnalyzer {
  // Config thresholds (can be overridden at construction)
  private readonly config: {
    latencyP95ThresholdMs: number;
    errorRateThresholdPct: number;
    minSampleSize: number;
    reliabilityGood: number;
    reliabilityPoor: number;
  };

  constructor(
    thresholds: Partial<typeof ToolAnalyzer.defaultThresholds> = {}
  ) {
    this.config = { ...ToolAnalyzer.defaultThresholds, ...thresholds };
    console.log('[ToolAnalyzer] Initialized with thresholds:', this.config);
  }

  private static readonly defaultThresholds = {
    latencyP95ThresholdMs: 5_000,   // 5s — high latency flag
    errorRateThresholdPct: 20,       // >20% error rate is a problem
    minSampleSize: 3,                // Need at least 3 calls to surface patterns
    reliabilityGood: 80,             // >80% = good
    reliabilityPoor: 50,             // <50% = poor
  } as const;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Analyze a batch of tool lifecycles and return comprehensive stats.
   */
  analyze(lifecycles: ToolLifecycle[]): ToolAnalysisResult {
    const byTool = this.aggregateByTool(lifecycles);
    const failurePatterns = this.detectFailurePatterns(lifecycles);
    const bottlenecks = this.detectBottlenecks(byTool);
    const recommendations = this.buildRecommendations(byTool, bottlenecks);

    const overallReliability =
      lifecycles.length > 0
        ? (lifecycles.filter((t) => t.success).length / lifecycles.length) * 100
        : 100;

    return {
      byTool: Object.fromEntries(byTool),
      failurePatterns,
      bottlenecks,
      recommendations,
      summary: {
        totalCalls: lifecycles.length,
        uniqueTools: byTool.size,
        overallReliability,
        totalFailures: lifecycles.filter((t) => !t.success).length,
      },
    };
  }

  /**
   * Compare two sets of lifecycles (e.g., control vs treatment in an experiment).
   */
  compare(
    baseline: ToolLifecycle[],
    treatment: ToolLifecycle[]
  ): ToolComparison {
    const baseStats = this.computeOverallStats(baseline);
    const treatStats = this.computeOverallStats(treatment);

    const reliabilityDelta = treatStats.reliability - baseStats.reliability;
    const latencyDelta = treatStats.avgLatencyMs - baseStats.avgLatencyMs;
    const errorRateDelta = treatStats.errorRatePct - baseStats.errorRatePct;

    return {
      baseline: baseStats,
      treatment: treatStats,
      delta: {
        reliabilityPct: reliabilityDelta,
        avgLatencyMs: latencyDelta,
        errorRatePct: errorRateDelta,
      },
      improved: reliabilityDelta > 0 || latencyDelta < 0,
    };
  }

  // ── Core Analysis ─────────────────────────────────────────────────────────

  private aggregateByTool(lifecycles: ToolLifecycle[]): Map<string, ToolStats> {
    const map = new Map<string, ToolStats>();

    for (const lc of lifecycles) {
      const toolName = lc.toolName;

      if (!map.has(toolName)) {
        map.set(toolName, {
          toolName,
          totalCalls: 0,
          successfulCalls: 0,
          failedCalls: 0,
          reliability: 100,
          avgLatencyMs: 0,
          minLatencyMs: Infinity,
          maxLatencyMs: 0,
          errorTypes: new Map(),
        });
      }

      const stats = map.get(toolName)!;
      stats.totalCalls++;

      if (lc.success) {
        stats.successfulCalls++;
      } else {
        stats.failedCalls++;
        const errKey = this.classifyError(lc.error);
        stats.errorTypes.set(errKey, (stats.errorTypes.get(errKey) ?? 0) + 1);
      }

      if (lc.endTime) {
        const latency = lc.endTime - lc.startTime;
        stats.minLatencyMs = Math.min(stats.minLatencyMs, latency);
        stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency);
        stats.avgLatencyMs =
          (stats.avgLatencyMs * (stats.totalCalls - 1) + latency) /
          stats.totalCalls;
      }

      stats.reliability =
        stats.totalCalls > 0
          ? (stats.successfulCalls / stats.totalCalls) * 100
          : 100;
    }

    // Fix minLatencyMs for tools that never had a completed call
    for (const stats of map.values()) {
      if (stats.minLatencyMs === Infinity) stats.minLatencyMs = 0;
    }

    return map;
  }

  private detectFailurePatterns(lifecycles: ToolLifecycle[]): FailurePattern[] {
    // Group failures by tool + error type
    const groups = new Map<string, FailureGroup>();

    for (const lc of lifecycles) {
      if (lc.success) continue;

      const errType = this.classifyError(lc.error);
      const key = `${lc.toolName}::${errType}`;

      if (!groups.has(key)) {
        groups.set(key, {
          toolName: lc.toolName,
          errorType: errType,
          errorMessage: lc.error ?? '(no error message)',
          occurrences: [],
          severity: 'medium',
        });
      }

      groups.get(key)!.occurrences.push(lc);
    }

    const patterns: FailurePattern[] = [];

    for (const [key, group] of groups) {
      if (group.occurrences.length < this.config.minSampleSize) continue;

      const severity = this.inferSeverity(group);
      const exampleContexts: FailureContext[] = group.occurrences.slice(0, 3).map((lc) => ({
        sessionId: lc.sessionId,
        taskDescription: lc.sessionId, // task info may not be available here
        toolInput: lc.input,
        errorOutput: lc.error ?? '',
        timestamp: new Date(lc.startTime),
      }));

      const timestamps = group.occurrences.map((lc) => lc.startTime).sort();

      patterns.push({
        id: `fp-${group.toolName.replace(/[^a-z0-9]/gi, '_')}-${group.errorType}`,
        toolName: group.toolName,
        errorType: group.errorType,
        errorMessage: group.errorMessage,
        frequency: group.occurrences.length,
        severity,
        exampleContexts,
        firstSeen: new Date(Math.min(...timestamps)),
        lastSeen: new Date(Math.max(...timestamps)),
        autoFixAvailable: this.canAutoFix(group.errorType),
        suggestedFix: this.suggestFix(group),
      });
    }

    // Sort by frequency descending
    patterns.sort((a, b) => b.frequency - a.frequency);
    return patterns;
  }

  private detectBottlenecks(byTool: Map<string, ToolStats>): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    for (const stats of byTool.values()) {
      if (stats.totalCalls < this.config.minSampleSize) continue;

      const errorRatePct = (stats.failedCalls / stats.totalCalls) * 100;

      // High error rate
      if (errorRatePct > this.config.errorRateThresholdPct) {
        bottlenecks.push({
          toolName: stats.toolName,
          reason: 'high_error_rate',
          severity: errorRatePct > 50 ? 'high' : 'medium',
          metric: errorRatePct,
          threshold: this.config.errorRateThresholdPct,
          suggestion: `Error rate ${errorRatePct.toFixed(1)}% exceeds ${this.config.errorRateThresholdPct}% threshold. Investigate ${stats.errorTypes.size} distinct error type(s).`,
        });
      }

      // High latency — check max (proxy for P95)
      if (stats.maxLatencyMs > this.config.latencyP95ThresholdMs) {
        bottlenecks.push({
          toolName: stats.toolName,
          reason: 'high_latency',
          severity: stats.maxLatencyMs > 30_000 ? 'high' : 'medium',
          metric: stats.maxLatencyMs,
          threshold: this.config.latencyP95ThresholdMs,
          suggestion: `Max latency ${stats.maxLatencyMs}ms exceeds ${this.config.latencyP95ThresholdMs}ms threshold. Review tool implementation or add caching.`,
        });
      }

      // Low reliability
      if (stats.reliability < this.config.reliabilityPoor) {
        bottlenecks.push({
          toolName: stats.toolName,
          reason: 'high_error_rate',
          severity: 'high',
          metric: stats.reliability,
          threshold: this.config.reliabilityGood,
          suggestion: `Reliability ${stats.reliability.toFixed(1)}% is critically low. Prioritize fixing ${stats.toolName}.`,
        });
      }
    }

    return bottlenecks;
  }

  private buildRecommendations(
    byTool: Map<string, ToolStats>,
    bottlenecks: Bottleneck[]
  ): string[] {
    const recommendations: string[] = [];

    for (const [toolName, stats] of byTool) {
      if (stats.totalCalls < this.config.minSampleSize) continue;

      if (stats.reliability < this.config.reliabilityGood) {
        recommendations.push(
          `Improve reliability of "${toolName}" (currently ${stats.reliability.toFixed(1)}%).`
        );
      }

      if (stats.avgLatencyMs > this.config.latencyP95ThresholdMs / 2) {
        recommendations.push(
          `Consider adding caching or batching to "${toolName}" to reduce avg latency (${stats.avgLatencyMs.toFixed(0)}ms).`
        );
      }
    }

    for (const bn of bottlenecks) {
      if (bn.severity === 'high') {
        recommendations.push(`[HIGH] ${bn.suggestion}`);
      }
    }

    return recommendations;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Classify a raw error string into a short error type key */
  private classifyError(error?: string): string {
    if (!error) return 'UNKNOWN_ERROR';
    const lower = error.toLowerCase();
    if (lower.includes('timeout')) return 'TIMEOUT';
    if (lower.includes('econnrefused') || lower.includes('connect')) return 'CONNECTION_ERROR';
    if (lower.includes('enotfound') || lower.includes('not found')) return 'NOT_FOUND';
    if (lower.includes('permission')) return 'PERMISSION_DENIED';
    if (lower.includes('rate limit') || lower.includes('429')) return 'RATE_LIMIT';
    if (lower.includes('unauthorized') || lower.includes('auth')) return 'AUTH_ERROR';
    if (lower.includes('validation') || lower.includes('invalid')) return 'VALIDATION_ERROR';
    if (lower.includes('enoent') || lower.includes('does not exist')) return 'FILE_NOT_FOUND';
    return 'GENERIC_ERROR';
  }

  private inferSeverity(group: FailureGroup): FailurePattern['severity'] {
    const rate = group.occurrences.length;
    if (rate >= 10) return 'critical';
    if (rate >= 5) return 'high';
    if (rate >= 3) return 'medium';
    return 'low';
  }

  private canAutoFix(errorType: string): boolean {
    const autoFixable = new Set([
      'TIMEOUT',
      'RATE_LIMIT',
      'CONNECTION_ERROR',
      'FILE_NOT_FOUND',
    ]);
    return autoFixable.has(errorType);
  }

  private suggestFix(group: FailureGroup): string {
    switch (group.errorType) {
      case 'TIMEOUT':
        return `Add retry logic with exponential backoff for "${group.toolName}".`;
      case 'RATE_LIMIT':
        return `Add rate limiting / request queueing before calling "${group.toolName}".`;
      case 'CONNECTION_ERROR':
        return `Add connection pooling and retry for "${group.toolName}".`;
      case 'FILE_NOT_FOUND':
        return `Ensure required files exist or add graceful fallback in "${group.toolName}".`;
      default:
        return `Investigate error pattern in "${group.toolName}": ${group.errorMessage}`;
    }
  }

  private computeOverallStats(lifecycles: ToolLifecycle[]): {
    reliability: number;
    avgLatencyMs: number;
    errorRatePct: number;
    totalCalls: number;
  } {
    const total = lifecycles.length;
    const errors = lifecycles.filter((t) => !t.success).length;
    const completed = lifecycles.filter((t) => t.endTime);
    const totalLatency = completed.reduce((s, t) => s + ((t.endTime ?? 0) - t.startTime), 0);

    return {
      reliability: total > 0 ? (lifecycles.filter((t) => t.success).length / total) * 100 : 100,
      avgLatencyMs: completed.length > 0 ? totalLatency / completed.length : 0,
      errorRatePct: total > 0 ? (errors / total) * 100 : 0,
      totalCalls: total,
    };
  }
}

// ── Internal Types ──────────────────────────────────────────────────────────

interface FailureGroup {
  toolName: string;
  errorType: string;
  errorMessage: string;
  occurrences: ToolLifecycle[];
  severity: FailurePattern['severity'];
}

// ── Output Types ─────────────────────────────────────────────────────────────

export interface ToolAnalysisResult {
  byTool: Record<string, ToolStats>;
  failurePatterns: FailurePattern[];
  bottlenecks: Bottleneck[];
  recommendations: string[];
  summary: {
    totalCalls: number;
    uniqueTools: number;
    overallReliability: number;
    totalFailures: number;
  };
}

export interface ToolComparison {
  baseline: {
    reliability: number;
    avgLatencyMs: number;
    errorRatePct: number;
    totalCalls: number;
  };
  treatment: {
    reliability: number;
    avgLatencyMs: number;
    errorRatePct: number;
    totalCalls: number;
  };
  delta: {
    reliabilityPct: number;
    avgLatencyMs: number;
    errorRatePct: number;
  };
  improved: boolean;
}

// ── Self-Improving Harness ──────────────────────────────────────────────────

/**
 * Insight produced by analyzeAndRecommend().
 * Describes recommended monitoring parameter adjustments and learned patterns.
 */
export interface HarnessInsight {
  recommendedPollIntervalMs: number;
  recommendedIdleThresholdMs: number;
  /** Tools that generate high-value monitoring events (worth watching closely) */
  highValueToolPatterns: string[];
  /** Event types that have been flagged as low-value (candidates for filtering) */
  lowValueEvents: string[];
}

/**
 * Persisted harness tuning configuration.
 */
export interface HarnessConfig {
  pollIntervalMs: number;
  idleThresholdMs: number;
  highValueToolPatterns: string[];
  lowValueEvents: string[];
  version: number;
}

const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  pollIntervalMs: 10_000,
  idleThresholdMs: 30_000,
  highValueToolPatterns: [],
  lowValueEvents: [],
  version: 1,
};

const HARNESS_CONFIG_FILE = join(import.meta.dirname, 'harness-config.json');

/** Load persisted harness config, returning defaults if no file exists. */
export function getHarnessConfig(): HarnessConfig {
  try {
    if (existsSync(HARNESS_CONFIG_FILE)) {
      const raw = readFileSync(HARNESS_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<HarnessConfig>;
      return { ...DEFAULT_HARNESS_CONFIG, ...parsed };
    }
  } catch (err) {
    console.warn('[ToolAnalyzer] Failed to load harness config:', err);
  }
  return { ...DEFAULT_HARNESS_CONFIG };
}

/** Persist a harness config to disk. */
export function saveHarnessConfig(config: HarnessConfig): void {
  try {
    writeFileSync(HARNESS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[ToolAnalyzer] Harness config saved:', config);
  } catch (err) {
    console.error('[ToolAnalyzer] Failed to save harness config:', err);
  }
}

/**
 * Analyze historical session metrics and produce monitoring parameter recommendations.
 *
 * Heuristics:
 * - Latency std dev > 50% of mean  →  suggest faster poll interval
 * - Many events from same tool       →  add to highValueToolPatterns
 * - Event gaps > 5 s                 →  suggest increasing idle threshold
 * - Very low event rate             →  suggest reducing poll interval (save resources)
 */
export function analyzeAndRecommend(historicalMetrics: SessionMetrics[]): HarnessInsight {
  const insight: HarnessInsight = {
    recommendedPollIntervalMs: DEFAULT_HARNESS_CONFIG.pollIntervalMs,
    recommendedIdleThresholdMs: DEFAULT_HARNESS_CONFIG.idleThresholdMs,
    highValueToolPatterns: [],
    lowValueEvents: [],
  };

  if (historicalMetrics.length === 0) {
    return insight;
  }

  // ── Latency variability → poll interval ────────────────────────────────────
  const allLatencies: number[] = [];
  for (const session of historicalMetrics) {
    for (const tc of session.toolCalls) {
      if (tc.endTime) {
        allLatencies.push(tc.endTime - tc.startTime);
      }
    }
  }

  if (allLatencies.length >= 2) {
    const mean = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
    const variance =
      allLatencies.reduce((sum, v) => sum + (v - mean) ** 2, 0) / allLatencies.length;
    const stdDev = Math.sqrt(variance);

    if (mean > 0 && stdDev / mean > 0.5) {
      // Latency is highly variable — suggest faster polling to catch events sooner
      insight.recommendedPollIntervalMs = Math.max(
        2_000,
        Math.round(DEFAULT_HARNESS_CONFIG.pollIntervalMs / 2)
      );
    } else if (allLatencies.length > 20 && stdDev / mean < 0.1) {
      // Very stable latencies and high volume — safe to poll less aggressively
      insight.recommendedPollIntervalMs = Math.min(
        30_000,
        Math.round(DEFAULT_HARNESS_CONFIG.pollIntervalMs * 1.5)
      );
    }
  }

  // ── Event arrival gaps → idle threshold ───────────────────────────────────
  const sortedSessions = [...historicalMetrics].sort((a, b) => a.startTime - b.startTime);
  let maxGapMs = 0;
  for (let i = 1; i < sortedSessions.length; i++) {
    const gap = sortedSessions[i].startTime - (sortedSessions[i - 1].endTime ?? sortedSessions[i - 1].startTime);
    if (gap > maxGapMs) maxGapMs = gap;
  }

  if (maxGapMs > 5_000) {
    // Events arrive with >5s gaps — increase idle threshold to avoid false stall detection
    insight.recommendedIdleThresholdMs = Math.max(
      60_000,
      Math.round(maxGapMs * 3)
    );
  }

  // ── Event rate → poll frequency ────────────────────────────────────────────
  const totalEvents = historicalMetrics.reduce((sum, s) => sum + s.totalToolCalls, 0);
  const timeSpan =
    sortedSessions.length > 1
      ? sortedSessions[sortedSessions.length - 1].startTime - sortedSessions[0].startTime
      : 0;

  if (timeSpan > 0 && totalEvents / (timeSpan / 1000) < 0.05) {
    // Fewer than 0.05 events per second — suggest reducing poll frequency
    insight.recommendedPollIntervalMs = Math.min(
      60_000,
      Math.round(DEFAULT_HARNESS_CONFIG.pollIntervalMs * 3)
    );
  }

  // ── High-value tool patterns (tools with many calls) ───────────────────────
  const toolCallCounts = new Map<string, number>();
  for (const session of historicalMetrics) {
    for (const tc of session.toolCalls) {
      toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
    }
  }

  const threshold = Math.max(5, Math.floor(totalEvents * 0.1));
  for (const [toolName, count] of toolCallCounts) {
    if (count >= threshold) {
      insight.highValueToolPatterns.push(toolName);
    }
  }

  // ── Low-value event sources (tools that rarely contribute to failures) ─────
  const lowValueTools: string[] = [];
  for (const [toolName, count] of toolCallCounts) {
    // Tool with very few calls relative to the dominant tools, and no failures
    if (count <= 2 && insight.highValueToolPatterns.length > 3) {
      lowValueTools.push(toolName);
    }
  }
  insight.lowValueEvents = [...new Set(lowValueTools)];

  return insight;
}
