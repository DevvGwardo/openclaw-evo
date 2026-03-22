/**
 * OpenClaw Evo — Progress Frontier
 *
 * Tracks the running-best overall score across evolution cycles,
 * inspired by autoresearch's "running minimum" progress chart.
 *
 * Each cycle records { cycle, score, bestScore, timestamp }.
 * The frontier is the monotonically-improving best score over time —
 * showing how the system improves (or plateaus) across cycles.
 *
 * Persisted to the memory store so it survives restarts.
 */

import { store } from '../memory/store.js';

const FRONTIER_KEY = 'progress-frontier';

export interface FrontierPoint {
  cycle: number;
  score: number;      // actual score this cycle
  bestScore: number;  // running best up to this cycle
  timestamp: string;  // ISO
  skillsDeployed: number;
  experimentsRun: number;
}

export interface FrontierData {
  points: FrontierPoint[];
  currentBest: number;
  improvementFromBaseline: number; // % improvement from first to best
}

export const frontier = {
  /**
   * Record a new data point after a cycle completes.
   * Automatically computes the running-best.
   */
  async record(point: Omit<FrontierPoint, 'bestScore'>): Promise<FrontierPoint> {
    const data = await this.load();

    const prevBest = data.points.length > 0
      ? data.points[data.points.length - 1].bestScore
      : 0;

    const fullPoint: FrontierPoint = {
      ...point,
      bestScore: Math.max(prevBest, point.score),
    };

    data.points.push(fullPoint);

    // Keep last 500 points to prevent unbounded growth
    if (data.points.length > 500) {
      data.points = data.points.slice(-500);
    }

    await store.save(FRONTIER_KEY, data);
    return fullPoint;
  },

  /**
   * Load the full frontier data from the memory store.
   */
  async load(): Promise<{ points: FrontierPoint[] }> {
    const saved = await store.load<{ points: FrontierPoint[] }>(FRONTIER_KEY);
    return saved ?? { points: [] };
  },

  /**
   * Get the frontier data with computed summary stats.
   */
  async get(): Promise<FrontierData> {
    const data = await this.load();
    const points = data.points;

    if (points.length === 0) {
      return { points: [], currentBest: 0, improvementFromBaseline: 0 };
    }

    const currentBest = points[points.length - 1].bestScore;
    const baseline = points[0].score;
    const improvementFromBaseline = baseline > 0
      ? ((currentBest - baseline) / baseline) * 100
      : currentBest > 0 ? 100 : 0;

    return { points, currentBest, improvementFromBaseline };
  },

  /**
   * Get just the last N frontier points (for dashboard polling).
   */
  async recent(n = 50): Promise<FrontierPoint[]> {
    const data = await this.load();
    return data.points.slice(-n);
  },
};
