/**
 * OpenClaw Evo — Statistical Comparator
 *
 * Performs two-proportion z-test to determine whether a treatment arm
 * significantly outperforms the control arm in an experiment.
 */

import type { Experiment } from '../types.js';

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[comparator] ${msg}`, meta ?? ''),
  debug: (msg: string, meta?: Record<string, unknown>) =>
    process.env.DEBUG && console.log(`[comparator:debug] ${msg}`, meta ?? ''),
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StatisticalResult {
  /** Whether the difference is statistically significant at the tested confidence level */
  statisticallySignificant: boolean;
  /** Two-tailed p-value from the two-proportion z-test */
  pValue: number;
  /** Percentage improvement of treatment success rate over control */
  improvementPct: number;
  /** Confidence level = 1 - pValue (expressed 0–1) */
  confidence: number;
  /** Raw success rates for transparency */
  controlSuccessRate: number;
  treatmentSuccessRate: number;
  /** Pooled probability used in the test */
  pooledP: number;
  /** Standard error of the difference */
  standardError: number;
  /** Z-score of the difference */
  zScore: number;
}

// ── Error function approximation (for normal CDF) ─────────────────────────────

/**
 * Standard normal CDF using the error function (Abramowitz & Stegun approximation).
 * Accurate to ~7.5e-8 across the full range.
 */
function normalCDF(z: number): number {
  const sign = z >= 0 ? 1 : -1;
  z = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return 1 - sign * pdf * poly;
}

// ── Core test ─────────────────────────────────────────────────────────────────

/**
 * Two-proportion z-test for equality of proportions.
 *
 * H0: p_control = p_treatment
 * H1: p_treatment ≠ p_control  (two-tailed)
 *
 * Returns the raw z-statistic and associated p-value.
 */
function twoProportionZTest(
  nControl: number,
  xControl: number,
  nTreatment: number,
  xTreatment: number,
): { zScore: number; pValue: number; pooledP: number; standardError: number } {
  if (nControl === 0 || nTreatment === 0) {
    return { zScore: 0, pValue: 1, pooledP: 0, standardError: 0 };
  }

  const p1 = xControl / nControl; // control success rate
  const p2 = xTreatment / nTreatment; // treatment success rate
  const pooledP = (xControl + xTreatment) / (nControl + nTreatment);

  // Ensure pooled p is not exactly 0 or 1 (avoids divide-by-zero in se)
  const p = Math.max(0.0001, Math.min(0.9999, pooledP));
  const se = Math.sqrt(p * (1 - p) * (1 / nControl + 1 / nTreatment));

  if (se === 0) {
    return { zScore: 0, pValue: 1, pooledP, standardError: 0 };
  }

  const zScore = (p2 - p1) / se;
  // Two-tailed p-value
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  return { zScore, pValue, pooledP: p, standardError: se };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const comparator = {
  /**
   * Perform a two-proportion z-test on a completed experiment.
   *
   * Compares control vs. treatment success rates and returns a full
   * StatisticalResult including p-value, confidence, and improvement %.
   */
  compare(experiment: Experiment): StatisticalResult {
    const controlResults = experiment.controlResults;
    const treatmentResults = experiment.treatmentResults;

    const nC = controlResults.length;
    const nT = treatmentResults.length;
    const xC = controlResults.filter((r) => r.success).length;
    const xT = treatmentResults.filter((r) => r.success).length;

    const controlSuccessRate = nC > 0 ? xC / nC : 0;
    const treatmentSuccessRate = nT > 0 ? xT / nT : 0;

    const { zScore, pValue, pooledP, standardError } = twoProportionZTest(nC, xC, nT, xT);

    const improvementPct =
      controlSuccessRate > 0
        ? ((treatmentSuccessRate - controlSuccessRate) / controlSuccessRate) * 100
        : treatmentSuccessRate * 100;

    const confidence = Math.max(0, Math.min(1, 1 - pValue));
    const statisticallySignificant = pValue < 0.05; // conventional α = 0.05

    log.info(`Statistical comparison for experiment ${experiment.id}`, {
      nControl: nC,
      nTreatment: nT,
      controlSuccessRate: `${(controlSuccessRate * 100).toFixed(1)}%`,
      treatmentSuccessRate: `${(treatmentSuccessRate * 100).toFixed(1)}%`,
      zScore: zScore.toFixed(4),
      pValue: pValue.toFixed(6),
      confidence: `${(confidence * 100).toFixed(2)}%`,
      improvementPct: `${improvementPct.toFixed(2)}%`,
      statisticallySignificant,
    });

    log.debug('Detailed test parameters', {
      pooledP: pooledP.toFixed(6),
      standardError: standardError.toFixed(6),
      xControl: xC,
      xTreatment: xT,
    });

    return {
      statisticallySignificant,
      pValue,
      improvementPct: Math.round(improvementPct * 100) / 100,
      confidence: Math.round(confidence * 10000) / 10000,
      controlSuccessRate,
      treatmentSuccessRate,
      pooledP,
      standardError,
      zScore,
    };
  },

  /**
   * Convenience helper: is the result significant at the given confidence threshold?
   *
   * @param result  - StatisticalResult from `compare()`
   * @param confidenceThreshold - minimum confidence required (e.g. 0.95 for 95%)
   */
  isSignificant(result: StatisticalResult, confidenceThreshold: number = 0.95): boolean {
    const significant = result.confidence >= confidenceThreshold;
    log.debug('isSignificant check', {
      confidence: result.confidence,
      threshold: confidenceThreshold,
      result: significant,
    });
    return significant;
  },
};
