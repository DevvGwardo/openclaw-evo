/**
 * OpenClaw Evo — Experiment Promoter
 *
 * Evaluates completed experiments and promotes winning treatment skills
 * to ~/.openclaw/skills/ so OpenClaw can pick them up on next startup.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Experiment, GeneratedSkill, PromotionDecision } from '../types.js';
import { comparator } from './comparator.js';

const SKILLS_DIR = process.env.SKILL_OUTPUT_DIR ?? join(process.env.HOME ?? '~', '.openclaw', 'skills');

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[promoter] ${msg}`, meta ?? ''),
  error: (msg: string, err?: unknown) =>
    console.error(`[promoter] ${msg}`, err ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[promoter] ${msg}`, meta ?? ''),
  debug: (msg: string, meta?: Record<string, unknown>) =>
    process.env.DEBUG && console.log(`[promoter:debug] ${msg}`, meta ?? ''),
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_IMPROVEMENT_PCT = parseFloat(process.env.MIN_IMPROVEMENT_PCT ?? '5');
const DEFAULT_CONFIDENCE = parseFloat(process.env.STATISTICAL_CONFIDENCE ?? '0.95');
const PROMOTION_LOG = join(SKILLS_DIR, '.promotion-log.jsonl');

// ── State ─────────────────────────────────────────────────────────────────────

/** In-memory store of experiments — replace with a persistence layer as needed */
const experimentStore = new Map<string, Experiment>();

// ── Public API ─────────────────────────────────────────────────────────────────

export const promoter = {
  /**
   * Register an experiment so it can be looked up by ID later.
   */
  register(experiment: Experiment): void {
    experimentStore.set(experiment.id, experiment);
    log.info('Registered experiment', { id: experiment.id, status: experiment.status });
  },

  /**
   * Evaluate whether a completed experiment should be promoted.
   *
   * Returns immediately if the experiment was already promoted (experiment.promotedAt is set).
   * Otherwise applies the configured thresholds:
   *   - statistical confidence >= DEFAULT_CONFIDENCE (0.95)
   *   - improvementPct >= MIN_IMPROVEMENT_PCT
   */
  evaluate(experimentOrId: Experiment | string): PromotionDecision {
    const experiment = resolveExperiment(experimentOrId);

    if (!experiment) {
      return {
        promoted: false,
        reason: `Experiment not found: ${experimentOrId}`,
        experimentsValidated: experimentStore.size,
      };
    }

    if (experiment.status === 'pending' || experiment.status === 'running') {
      return {
        promoted: false,
        reason: `Experiment ${experiment.id} is still ${experiment.status}`,
        experimentsValidated: experimentStore.size,
      };
    }

    if (experiment.promotedAt) {
      log.info(`Experiment ${experiment.id} already promoted at ${experiment.promotedAt.toISOString()}`);
      return {
        promoted: true,
        reason: `Already promoted on ${experiment.promotedAt.toISOString()}`,
        experimentsValidated: experimentStore.size,
      };
    }

    if (experiment.status === 'rejected') {
      return {
        promoted: false,
        reason: `Experiment ${experiment.id} was explicitly rejected`,
        experimentsValidated: experimentStore.size,
      };
    }

    // Ensure statistical results are populated
    const statResult = comparator.compare(experiment);
    experiment.statisticalSignificance = statResult.confidence;

    const { confidence, improvementPct } = statResult;

    const meetsConfidence = confidence >= DEFAULT_CONFIDENCE;
    const meetsImprovement = improvementPct >= MIN_IMPROVEMENT_PCT;

    if (meetsConfidence && meetsImprovement) {
      const reason =
        `Treatment outperforms control with ${(confidence * 100).toFixed(1)}% confidence ` +
        `and ${improvementPct.toFixed(2)}% improvement (thresholds: ` +
        `confidence≥${DEFAULT_CONFIDENCE * 100}%, improvement≥${MIN_IMPROVEMENT_PCT}%)`;

      log.info(`Promotion recommended for experiment ${experiment.id}`, { reason });

      return {
        promoted: true,
        reason,
        experimentsValidated: experimentStore.size,
      };
    }

    const reasons: string[] = [];
    if (!meetsConfidence) reasons.push(`confidence=${(confidence * 100).toFixed(1)}% < ${DEFAULT_CONFIDENCE * 100}%`);
    if (!meetsImprovement) reasons.push(`improvement=${improvementPct.toFixed(2)}% < ${MIN_IMPROVEMENT_PCT}%`);

    const rejectReason = `Thresholds not met (${reasons.join(', ')})`;
    experiment.status = 'rejected';

    log.info(`Experiment ${experiment.id} rejected`, { reason: rejectReason });

    return {
      promoted: false,
      reason: rejectReason,
      experimentsValidated: experimentStore.size,
    };
  },

  /**
   * Promote the treatment skill of a given experiment: write it to
   * ~/.openclaw/skills/<skillName>.json so OpenClaw picks it up on restart.
   *
   * Idempotent: safe to call multiple times.
   */
  async promote(experimentId: string): Promise<void> {
    const experiment = experimentStore.get(experimentId);

    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    // If already promoted, log and exit cleanly
    if (experiment.promotedAt) {
      log.info(`Experiment ${experimentId} already promoted — skipping file write`);
      return;
    }

    const decision = promoter.evaluate(experiment);
    if (!decision.promoted) {
      throw new Error(
        `Cannot promote experiment ${experimentId}: ${decision.reason}`,
      );
    }

    // Fetch the treatment skill from the gateway (or load from store)
    const skill = await loadTreatmentSkill(experiment.treatmentSkillId);

    const skillFileName = `${skill.name.toLowerCase().replace(/\s+/g, '-')}.json`;
    const destPath = join(SKILLS_DIR, skillFileName);

    mkdirSync(dirname(destPath), { recursive: true });

    const payload = JSON.stringify(skill, null, 2);
    writeFileSync(destPath, payload, 'utf-8');

    experiment.status = 'promoted';
    experiment.promotedAt = new Date();

    // Update in-memory record
    experimentStore.set(experimentId, experiment);

    // Append to promotion log
    appendPromotionLog({
      experimentId,
      skillId: skill.id,
      skillName: skill.name,
      promotedAt: experiment.promotedAt.toISOString(),
      improvementPct: experiment.improvementPct,
      confidence: experiment.statisticalSignificance,
    });

    log.info(`✅ Promoted skill "${skill.name}" → ${destPath}`, {
      experimentId,
      skillId: skill.id,
      improvementPct: experiment.improvementPct,
    });
  },
};

// ── Internal helpers ───────────────────────────────────────────────────────────

function resolveExperiment(experimentOrId: Experiment | string): Experiment | undefined {
  if (typeof experimentOrId === 'object') return experimentOrId;
  return experimentStore.get(experimentOrId);
}

/**
 * Load a GeneratedSkill by ID.
 *
 * Strategy:
 *  1. Try the in-memory experiment store (treatment skill may have been stored there)
 *  2. Try reading from ~/.openclaw/skills/*.json
 *  3. Try fetching from the OpenClaw gateway API
 */
async function loadTreatmentSkill(skillId: string): Promise<GeneratedSkill> {
  // 1. Check experiment store
  for (const exp of experimentStore.values()) {
    if (exp.treatmentSkillId === skillId) {
      log.debug(`Found skill ${skillId} in experiment store`);
      // Reconstruct a GeneratedSkill from experiment data
      return {
        id: skillId,
        name: exp.name.replace('A/B: ', ''),
        description: exp.description,
        triggerPhrases: [],
        implementation: '',
        examples: [],
        confidence: 1,
        status: 'testing',
        generatedAt: exp.startedAt,
      };
    }
  }

  // 2. Try the gateway API
  try {
    const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789';
    const res = await fetch(`${GATEWAY_URL}/api/skills/${skillId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const skill = (await res.json()) as GeneratedSkill;
      log.debug(`Loaded skill ${skillId} from gateway`);
      return skill;
    }
  } catch (err) {
    log.warn(`Could not reach gateway for skill ${skillId}`, { err });
  }

  // 3. Scan skills directory
  try {
    const entries = readdirSync(SKILLS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
      const fullPath = join(SKILLS_DIR, entry);
      if (statSync(fullPath).isDirectory()) continue;
      const content = readFileSync(fullPath, 'utf-8');
      const skill = JSON.parse(content) as GeneratedSkill;
      if (skill.id === skillId) return skill;
    }
  } catch {
    // Skills dir may not exist yet — that's fine
  }

  throw new Error(`Treatment skill not found: ${skillId}`);
}

function appendPromotionLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(PROMOTION_LOG), { recursive: true });
    writeFileSync(PROMOTION_LOG, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch (err) {
    log.warn('Failed to append to promotion log', { err });
  }
}
