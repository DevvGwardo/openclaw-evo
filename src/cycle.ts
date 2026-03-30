/**
 * OpenClaw Evo — Evolution Cycle Orchestrator
 *
 * Implements the 5-phase evolution loop:
 *   Monitor → Evaluate → Build → Experiment → Integrate
 *
 * Each phase is a self-contained async function that reads from the
 * shared cycle context and writes its results back. This separation
 * makes each phase independently testable.
 */

import chalk from 'chalk';

import type {
  EvoConfig,
  EvolutionCycle,
  Experiment,
  EvaluationReport,
  GeneratedSkill,
  SessionMetrics,
} from './types.js';

import { fetchAllSessionMetrics } from './gateway.js';
import { scoreSessions } from './evaluator/scorer.js';
import { detectPatterns } from './evaluator/patternDetector.js';
import { scorePerTool } from './evaluator/reportGenerator.js';
import { analyze } from './evaluator/reportGenerator.js';
import { generateFromFailure } from './builder/skillGenerator.js';
import { validate } from './builder/skillValidator.js';
import { experimentRunner } from './experiment/runner.js';
import { comparator } from './experiment/comparator.js';
import { promoter } from './experiment/promoter.js';
import { failureCorpus } from './memory/failureCorpus.js';
import { improvementLog } from './memory/improvementLog.js';


// ── Shared context threaded through all phases ─────────────────────────────────

export interface CycleContext {
  cycle: EvolutionCycle;
  config: EvoConfig;
  recentMetrics: SessionMetrics[];
  proposedSkills: GeneratedSkill[];
  activeExperiments: Map<string, Experiment>;
  logger: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface CycleResult {
  cycle: EvolutionCycle;
  newSkills: GeneratedSkill[];
  updatedMetrics: SessionMetrics[];
}

// ── Phase 1: Monitor ──────────────────────────────────────────────────────────

/**
 * Phase 1 — Monitor.
 * Fetches fresh session data from the gateway and appends new SessionMetrics
 * to the shared context. Deduplication is handled by the gateway module.
 */
export async function phaseMonitor(ctx: CycleContext): Promise<void> {
  const { cycle, config, recentMetrics, logger } = ctx;
  const startMs = Date.now();

  const seenIds = new Set(recentMetrics.map((m) => m.sessionId));

  try {
    const fresh = await fetchAllSessionMetrics(config.HERMES_GATEWAY_URL, seenIds);

    for (const m of fresh) {
      logger('info', chalk.gray(
        `    \u001b[2m\u001b[37mSession ${m.sessionId}: ${m.totalToolCalls} tool calls, ` +
        `${m.errorCount} failures, type=${m.taskType}\u001b[0m`,
      ));
    }

    recentMetrics.push(...fresh);

    // Cap total metrics to avoid unbounded growth
    if (recentMetrics.length > 1000) {
      recentMetrics.splice(0, recentMetrics.length - 1000);
    }

    cycle.phases.monitor.eventsProcessed = recentMetrics.length;
    logger('info', chalk.gray(
      `  \u001b[2m\u001b[37mMonitor: ${fresh.length} new sessions, ${recentMetrics.length} total metrics\u001b[0m`,
    ));
  } catch (err) {
    logger('warn', `Monitor phase: could not fetch sessions - ${err}`);
    cycle.phases.monitor.eventsProcessed = recentMetrics.length;
  }

  cycle.phases.monitor.durationMs = Date.now() - startMs;
}

// ── Phase 2: Evaluate ─────────────────────────────────────────────────────────

/**
 * Phase 2 — Evaluate.
 * Scores recent sessions, detects failure patterns, and produces an
 * EvaluationReport. Patterns are persisted to the failure corpus.
 */
export async function phaseEvaluate(ctx: CycleContext): Promise<EvaluationReport> {
  const { cycle, config, recentMetrics, logger } = ctx;
  const startMs = Date.now();

  // Decay stale failure patterns that have not recurred recently
  const decayed = await failureCorpus.decay();
  if (decayed > 0) {
    logger('info', chalk.gray(`  \u001b[2m\u001b[37mDecayed ${decayed} stale pattern(s)\u001b[0m`));
  }

  const recent = recentMetrics.slice(-100);
  const overallScore = scoreSessions(recent);
  const toolScores = scorePerTool(recent);

  // Detect live patterns from recent session data
  const livePatterns = detectPatterns(recent, config.FAILURE_THRESHOLD);

  // Persist newly detected patterns for accumulation across cycles
  for (const pattern of livePatterns) {
    const ctx_0 = pattern.exampleContexts[0] ?? {
      sessionId: 'unknown',
      taskDescription: 'unknown',
      toolInput: {},
      errorOutput: pattern.errorMessage,
      timestamp: new Date(),
    };
    await failureCorpus.recordFailure(pattern, ctx_0);
  }

  // Merge persisted corpus patterns with live-detected ones
  const corpusPatterns = await failureCorpus.getPatterns(config.FAILURE_THRESHOLD);
  const report: EvaluationReport = analyze(
    recent,
    corpusPatterns.length > 0 ? corpusPatterns : undefined,
  );
  report.overallScore = overallScore;
  report.toolScores = toolScores;

  cycle.phases.evaluate.durationMs = Date.now() - startMs;
  cycle.phases.evaluate.patternsFound = report.topFailurePatterns.length;
  cycle.phases.evaluate.overallScore = report.overallScore.overall;

  logger('info', chalk.gray(
    `  \u001b[2m\u001b[37mEvaluation: ${report.overallScore.overall.toFixed(1)}/100 overall score\u001b[0m`,
  ));
  logger('info', chalk.gray(
    `  \u001b[2m\u001b[37mFound ${report.topFailurePatterns.length} failure pattern(s)\u001b[0m`,
  ));

  return report;
}

// ── Phase 3: Build ────────────────────────────────────────────────────────────

/**
 * Phase 3 — Build.
 * Generates new skill proposals from failure patterns that do not yet
 * have an active or deployed skill.
 *
 * Returns the list of newly proposed skills.
 */
export async function phaseBuild(ctx: CycleContext): Promise<GeneratedSkill[]> {
  const { cycle, config, proposedSkills, logger } = ctx;
  const startMs = Date.now();
  const newSkills: GeneratedSkill[] = [];

  const failurePatterns = await failureCorpus.getPatterns(config.FAILURE_THRESHOLD);

  // Skip patterns that already have a proposed skill
  const activeSkillPatterns = new Set(
    proposedSkills.map((s) => s.name.split('\u2014')[0].trim().toLowerCase()),
  );

  for (const pattern of failurePatterns.slice(0, config.MAX_SKILLS_PER_CYCLE)) {
    if (activeSkillPatterns.has(pattern.toolName.toLowerCase())) {
      logger('info', chalk.gray(
        `  \u001b[2m\u001b[37mSkipping ${pattern.toolName}/${pattern.errorType} \u2014 skill already proposed\u001b[0m`,
      ));
      continue;
    }

    try {
      const result = generateFromFailure(pattern);
      if (result.skill) {
        const validation = validate(result.skill);
        if (validation.valid) {
          result.skill.status = 'proposed';
          result.skill.proposedAtCycle = ctx.cycle.cycleNumber;
          newSkills.push(result.skill);
          proposedSkills.push(result.skill);

          await improvementLog.record({
            timestamp: new Date(),
            type: 'skill_created',
            description: `Proposed skill: ${result.skill.name} for ${pattern.toolName} failures`,
            skillId: result.skill.id,
            metrics: { afterScore: result.skill.confidence * 100 },
          });

          logger('info', chalk.green(
            `  \u001b[2m\u001b[32mProposed: ${result.skill.name} (confidence: ${(result.skill.confidence * 100).toFixed(0)}%)\u001b[0m`,
          ));
        } else {
          logger('warn', `  \u001b[2m\u001b[33mSkipped "${result.skill.name}": ${validation.errors.join(', ')}\u001b[0m`);
        }
      }
    } catch (err) {
      logger('error', `  \u001b[2m\u001b[31mFailed to generate skill for ${pattern.toolName}: ${err}\u001b[0m`);
    }
  }

  cycle.phases.build.durationMs = Date.now() - startMs;
  cycle.phases.build.skillsProposed = newSkills.length;

  return newSkills;
}

// ── Phase 4 & 5: Experiment + Integrate ────────────────────────────────────────

/**
 * Phase 4 — Experiment.
 * Runs A/B experiments for each newly proposed skill and registers results.
 *
 * Phase 5 — Integrate.
 * Evaluates experiment outcomes and promotes winning skills.
 *
 * These two phases are combined here because integrate must follow experiment
 * for each individual skill (no point promoting before the experiment completes).
 */
export async function phaseIntegrate(
  ctx: CycleContext,
  newSkills: GeneratedSkill[],
): Promise<void> {
  const { cycle, recentMetrics, activeExperiments, logger } = ctx;
  const experimentStart = Date.now();
  let experimentsRun = 0;

  for (const skill of newSkills) {
    try {
      const experiment = experimentRunner.createExperiment(skill);
      const completed = await experimentRunner.run(experiment, recentMetrics);
      activeExperiments.set(completed.id, completed);
      experimentsRun++;

      const result = comparator.compare(completed);
      completed.statisticalSignificance = result.confidence;
      completed.improvementPct = result.improvementPct;

      promoter.register(completed);
      const decision = promoter.evaluate(completed);

      if (decision.promoted) {
        const promoteResult = await promoter.promote(completed.id);
        if (promoteResult.promoted) {
          cycle.phases.integrate.improvementsDeployed++;
          logger('info', chalk.greenBright(
            `  \u001b[2m\u001b[32mPromoted: ${skill.name} (+${result.improvementPct.toFixed(1)}%)\u001b[0m`,
          ));
        } else if (promoteResult.reason === 'requires_approval' && promoteResult.approvalId) {
          logger('info', `\u001b[2m\u001b[37mSkill ${skill.name} promoted but requires human approval. ` +
            `Run /evo approve ${promoteResult.approvalId} to deploy.\u001b[0m`);
        }
      } else {
        skill.status = 'rejected';
        logger('info', chalk.yellow(
          `  \u001b[2m\u001b[33mNot yet: ${skill.name} (${result.improvementPct.toFixed(1)}% improvement)\u001b[0m`,
        ));
      }
    } catch (err) {
      logger('error', `  \u001b[2m\u001b[31mExperiment failed for ${skill.name}: ${err}\u001b[0m`);
    }
  }

  cycle.phases.experiment.durationMs = Date.now() - experimentStart;
  cycle.phases.experiment.experimentsRun = experimentsRun;
  cycle.phases.integrate.durationMs = 0; // Integrate phase is inline above
}

// ── Cleanup helpers ────────────────────────────────────────────────────────────

/**
 * Remove completed/rejected/promoted experiments to prevent unbounded growth.
 */
export function pruneStaleExperiments(experiments: Map<string, Experiment>): void {
  for (const [id, exp] of experiments) {
    if (exp.status === 'completed' || exp.status === 'rejected' || exp.status === 'promoted') {
      experiments.delete(id);
    }
  }
}

/**
 * Prune oldest completed experiments if total count exceeds maxExperiments.
 */
export function pruneOldExperiments(
  experiments: Map<string, Experiment>,
  maxExperiments = 50,
): void {
  if (experiments.size <= maxExperiments) return;

  const sorted = Array.from(experiments.entries()).sort(
    (a, b) =>
      (new Date(a[1].completedAt ?? 0).getTime() ?? 0) -
      (new Date(b[1].completedAt ?? 0).getTime() ?? 0),
  );

  const toRemove = sorted.slice(0, sorted.length - maxExperiments);
  for (const [id] of toRemove) experiments.delete(id);
}
