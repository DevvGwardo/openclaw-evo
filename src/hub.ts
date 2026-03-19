/**
 * OpenClaw Evo Hub — Main Orchestration
 *
 * Runs the self-evolution loop:
 * Monitor → Evaluate → Build → Experiment → Integrate → (repeat)
 */

import chalk from 'chalk';
import { DEFAULT_CONFIG } from './constants.js';
import { HarnessMonitor } from './harness/monitor.js';
import { scoreSessions } from './evaluator/scorer.js';
import { scorePerTool } from './evaluator/reportGenerator.js';
import { analyze } from './evaluator/reportGenerator.js';
import { generateFromFailure } from './builder/skillGenerator.js';
import { validate } from './builder/skillValidator.js';
import { TEMPLATE_LIBRARY } from './builder/templateLibrary.js';
import { experimentRunner } from './experiment/runner.js';
import { comparator } from './experiment/comparator.js';
import { promoter } from './experiment/promoter.js';
import { MemoryStore } from './memory/store.js';
import { failureCorpus } from './memory/failureCorpus.js';
import { improvementLog } from './memory/improvementLog.js';
import { Gateway } from './openclaw/gateway.js';
import { SessionManager } from './openclaw/sessionManager.js';
import { SkillManager } from './openclaw/skillManager.js';
import type {
  EvoConfig,
  EvolutionCycle,
  SessionMetrics,
  FailurePattern,
  GeneratedSkill,
  Experiment,
  HubStatus,
  EvaluationReport,
  HubState,
} from './types.js';

export class EvoHub {
  private config: EvoConfig;
  private monitor: HarnessMonitor;
  private store: MemoryStore;
  private recentMetrics: SessionMetrics[] = [];
  private proposedSkills: GeneratedSkill[] = [];
  private activeExperiments: Map<string, Experiment> = new Map();
  private running = false;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentCycle: EvolutionCycle | null = null;
  private cycleNumber = 0;
  private completedCycles: EvolutionCycle[] = [];
  private cycleHistory: EvolutionCycle[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<EvoConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize memory store
    this.store = new MemoryStore(this.storeMemoryDir());

    // Initialize harness monitor
    this.monitor = new HarnessMonitor({
      gatewayUrl: this.config.OPENCLAW_GATEWAY_URL,
      pollIntervalMs: this.config.OPENCLAW_POLL_INTERVAL_MS,
    });

    this.log('info', `OpenClaw Evo Hub initialized`);
    this.log('info', `  Cycle interval: ${this.config.CYCLE_INTERVAL_MS / 1000}s`);
    this.log('info', `  Failure threshold: ${this.config.FAILURE_THRESHOLD}`);
    this.log('info', `  Min improvement: ${this.config.MIN_IMPROVEMENT_PCT}%`);
    this.log('info', `  Experiment sessions: ${this.config.EXPERIMENT_SESSIONS}`);

    // Attempt to resume from last checkpoint
    void this.resume();
  }

  private storeMemoryDir(): string {
    const home = process.env.HOME || '~';
    return this.config.MEMORY_DIR.replace('~', home);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) {
      this.log('warn', 'Hub already running');
      return;
    }

    this.running = true;
    this.log('info', chalk.green('🚀 Starting OpenClaw Evo Hub...'));

    // Initialize memory
    await this.store.init();
    this.log('info', '✓ Memory store initialized');

    // Start harness monitor
    this.monitor.addListener((event) => {
      if (event.type === 'session_end' || event.type === 'tool_result') {
        const metrics: SessionMetrics = {
          sessionId: event.sessionId,
          toolCalls: [],
          startTime: Date.now() - 60000,
          success: true,
          errorCount: 0,
          totalToolCalls: 0,
          avgLatencyMs: 0,
        };
        this.recentMetrics.push(metrics);
        if (this.recentMetrics.length > 1000) this.recentMetrics.shift();
      }
    });

    this.monitor.start();
    this.log('info', '✓ Harness monitor started');

    const stats = await improvementLog.getStats();
    this.log('info', `✓ Loaded ${stats.totalImprovements} improvement entries from history`);

    // Start heartbeat logging every minute
    this.heartbeatInterval = setInterval(() => {
      if (this.running) {
        this.log('info', chalk.gray(`💓 Heartbeat | Cycle #${this.cycleNumber} | Active experiments: ${this.activeExperiments.size} | Running: ${this.running}`));
      }
    }, 60_000);

    this.log('info', chalk.green('✅ OpenClaw Evo Hub running!'));

    // Begin the evolution cycle loop
    this.scheduleNextCycle(this.config.CYCLE_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.monitor.stop();
    this.log('info', '🛑 OpenClaw Evo Hub stopped');
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Save current hub state to the memory store as a checkpoint.
   * Called after each evolution cycle completes.
   */
  async checkpoint(): Promise<void> {
    const state: HubState = {
      cycleNumber: this.cycleNumber,
      completedCycles: this.completedCycles.slice(-50),
      proposedSkills: this.proposedSkills,
      activeExperiments: Array.from(this.activeExperiments.values()),
      lastCheckpoint: new Date(),
    };
    await this.store.save('hub-state', state);
  }

  /**
   * Load hub state from the memory store and restore it.
   * Sets running=false so start() must be called explicitly.
   */
  async resume(): Promise<void> {
    const state = await this.store.load<HubState>('hub-state');
    if (!state) {
      this.log('info', 'No checkpoint found — starting fresh');
      return;
    }
    this.cycleNumber = state.cycleNumber ?? 0;
    this.proposedSkills = state.proposedSkills ?? [];
    this.completedCycles = (state.completedCycles ?? []).map((c) => ({
      ...c,
      startedAt: new Date(c.startedAt),
      completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
    }));
    this.activeExperiments = new Map(
      (state.activeExperiments ?? []).map((e) => [e.id, e]),
    );
    this.running = false;
    this.log('info', `✓ Resumed from checkpoint — cycle #${this.cycleNumber}, ${this.completedCycles.length} cycles completed`);
  }

  getCompletedCycles(): EvolutionCycle[] {
    return [...this.completedCycles];
  }

  // ── Evolution Loop ──────────────────────────────────────────────────────────

  scheduleNextCycle(intervalMs: number): void {
    if (!this.running) return;
    this.cycleTimer = setTimeout(() => {
      void this.runEvolutionCycle();
    }, intervalMs);
  }

  async runEvolutionCycle(): Promise<void> {
    if (!this.running) return;

    this.cycleNumber++;
    const cycleStart = Date.now();

    this.log('info', chalk.cyan(`\n🔄 Evolution cycle #${this.cycleNumber} starting...`));

    this.currentCycle = {
      id: `cycle-${this.cycleNumber}-${Date.now()}`,
      cycleNumber: this.cycleNumber,
      startedAt: new Date(),
      phases: {
        monitor: { durationMs: 0, eventsProcessed: this.recentMetrics.length },
        evaluate: { durationMs: 0, patternsFound: 0 },
        build: { durationMs: 0, skillsProposed: 0 },
        experiment: { durationMs: 0, experimentsRun: 0 },
        integrate: { durationMs: 0, improvementsDeployed: 0 },
      },
      status: 'running',
    };

    // ── Phase 1: Evaluate ───────────────────────────────────────────────────
    const evaluateStart = Date.now();
    let report: EvaluationReport;

    try {
      const recentSessions = this.recentMetrics.slice(-100);
      const overallScore = scoreSessions(recentSessions);
      const toolScores = scorePerTool(recentSessions);
      const patterns = await failureCorpus.getPatterns(this.config.FAILURE_THRESHOLD);
      report = analyze(recentSessions, patterns);
      report.overallScore = overallScore;
      report.toolScores = toolScores;
    } catch (err) {
      this.log('error', `Evaluation failed: ${err}`);
      this.currentCycle.status = 'failed';
      this.currentCycle.completedAt = new Date();
      return;
    }

    this.currentCycle.phases.evaluate.durationMs = Date.now() - evaluateStart;
    this.currentCycle.phases.evaluate.patternsFound = report.topFailurePatterns.length;
    this.log('info', chalk.gray(`  📊 Evaluation: ${report.overallScore.overall.toFixed(1)}/100 overall score`));
    this.log('info', chalk.gray(`  📊 Found ${report.topFailurePatterns.length} failure patterns`));

    // ── Phase 2: Build ──────────────────────────────────────────────────────
    const buildStart = Date.now();
    const newSkills: GeneratedSkill[] = [];
    const failurePatterns = await failureCorpus.getPatterns(this.config.FAILURE_THRESHOLD);

    for (const pattern of failurePatterns.slice(0, this.config.MAX_SKILLS_PER_CYCLE)) {
      try {
        const result = generateFromFailure(pattern);
        if (result.skill) {
          const validation = validate(result.skill);
          if (validation.valid) {
            result.skill.status = 'proposed';
            newSkills.push(result.skill);
            this.proposedSkills.push(result.skill);
            improvementLog.record({
              timestamp: new Date(),
              type: 'skill_created',
              description: `Proposed skill: ${result.skill.name} for ${pattern.toolName} failures`,
              skillId: result.skill.id,
              metrics: { afterScore: result.skill.confidence * 100 },
            });
            this.log('info', chalk.green(`  🛠️  Proposed: ${result.skill.name} (confidence: ${(result.skill.confidence * 100).toFixed(0)}%)`));
          } else {
            this.log('warn', `  ⚠️  Skipped "${result.skill.name}": ${validation.errors.join(', ')}`);
          }
        }
      } catch (err) {
        this.log('error', `  ❌ Failed to generate skill for ${pattern.toolName}: ${err}`);
      }
    }
    this.currentCycle.phases.build.durationMs = Date.now() - buildStart;
    this.currentCycle.phases.build.skillsProposed = newSkills.length;

    // ── Phase 3: Experiment ─────────────────────────────────────────────────
    const experimentStart = Date.now();
    let experimentsRun = 0;

    for (const skill of newSkills) {
      try {
        const experiment = experimentRunner.createExperiment(skill);
        const completed = await experimentRunner.run(experiment);
        this.activeExperiments.set(completed.id, completed);
        experimentsRun++;

        const result = comparator.compare(completed);
        completed.statisticalSignificance = result.confidence;
        completed.improvementPct = result.improvementPct;

        const decision = promoter.evaluate(completed);
        if (decision.promoted) {
          await promoter.promote(completed.id);
          this.currentCycle.phases.integrate.improvementsDeployed++;
          this.log('info', chalk.greenBright(`  🚀 Promoted: ${skill.name} (+${result.improvementPct.toFixed(1)}%)`));
        } else {
          this.log('info', chalk.yellow(`  ⏳ Not yet: ${skill.name} (${result.improvementPct.toFixed(1)}% improvement)`));
        }
      } catch (err) {
        this.log('error', `  ❌ Experiment failed for ${skill.name}: ${err}`);
      }
    }
    this.currentCycle.phases.experiment.durationMs = Date.now() - experimentStart;
    this.currentCycle.phases.experiment.experimentsRun = experimentsRun;

    // ── Complete ────────────────────────────────────────────────────────────
    this.currentCycle.status = 'completed';
    this.currentCycle.completedAt = new Date();

    // Persist completed cycle
    this.completedCycles.push(this.currentCycle);
    if (this.completedCycles.length > 50) {
      this.completedCycles = this.completedCycles.slice(-50);
    }

    const totalMs = Date.now() - cycleStart;
    this.log('info', chalk.green(`✅ Cycle #${this.cycleNumber} complete in ${(totalMs / 1000).toFixed(1)}s`));
    this.log('info', chalk.gray(`   Built: ${newSkills.length} skills | Experiments: ${experimentsRun} | Deployed: ${this.currentCycle.phases.integrate.improvementsDeployed}`));

    // Save checkpoint after cycle completes
    await this.checkpoint();

    if (this.running) {
      this.scheduleNextCycle(this.config.CYCLE_INTERVAL_MS);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(): HubStatus {
    const statsPromise = improvementLog.getStats();
    const patternsPromise = failureCorpus.getPatterns(0);
    return {
      running: this.running,
      currentCycle: this.currentCycle ?? undefined,
      totalCyclesRun: this.cycleNumber,
      lastCycleAt: this.currentCycle?.completedAt,
      activeExperiments: this.activeExperiments.size,
      deployedSkills: this.proposedSkills.filter((s) => s.status === 'deployed').length,
      knownFailurePatterns: 0, // resolved async, caller should await getStatusAsync
      memorySize: this.store.estimateSize(),
    };
  }

  getProposedSkills(): GeneratedSkill[] {
    return [...this.proposedSkills];
  }

  getActiveExperiments(): Experiment[] {
    return Array.from(this.activeExperiments.values());
  }

  // ── CLI trigger ────────────────────────────────────────────────────────────

  async runOnce(): Promise<void> {
    await this.store.init();
    await this.runEvolutionCycle();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = chalk.gray(`[${ts}]`);
    if (level === 'info') console.log(`${prefix} ${msg}`);
    else if (level === 'warn') console.warn(`${prefix} ${chalk.yellow('⚠')} ${msg}`);
    else console.error(`${prefix} ${chalk.red('❌')} ${msg}`);
  }
}
