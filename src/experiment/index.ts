/**
 * OpenClaw Evo — Experiment Module
 *
 * Re-exports all experiment sub-modules.
 */

export { experimentRunner } from './runner.js';
export { comparator, type StatisticalResult } from './comparator.js';
export { promoter } from './promoter.js';
export type { PromotionDecision } from '../types.js';
