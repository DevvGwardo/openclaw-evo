/**
 * OpenClaw Evo Hub — Main Orchestration
 *
 * Runs the self-evolution loop:
 * Monitor → Evaluate → Build → Experiment → Integrate → (repeat)
 */

import chalk from 'chalk';
import { DEFAULT_CONFIG } from './constants.js';
import { HarnessMonitor } from './harness/monitor.js';
import { Gateway } from './openclaw/gateway.js';
import { SessionManager } from './openclaw/sessionManager.js';
import { extractToolCallsFromHistory, inferTaskType } from './utils.js';
import { scoreSessions } from './evaluator/scorer.js';
import { detectPatterns } from './evaluator/patternDetector.js';
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
import { SkillManager } from './openclaw/skillManager.js';
import { GatewayWatchdog } from './watchdog.js';
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
  private watchdog: GatewayWatchdog;
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
  private oneShot = false;
  private cycleRunning = false;

  constructor(config: Partial<EvoConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize memory store
    this.store = new MemoryStore(this.storeMemoryDir());

    // Initialize harness monitor
    this.monitor = new HarnessMonitor({
      gatewayUrl: this.config.OPENCLAW_GATEWAY_URL,
      pollIntervalMs: this.config.OPENCLAW_POLL_INTERVAL_MS,
    });

    // Initialize gateway watchdog
    this.watchdog = new GatewayWatchdog({
      gatewayUrl: this.config.OPENCLAW_GATEWAY_URL,
    });

    this.log('info', `OpenClaw Evo Hub initialized`);
    this.log('info', `  Cycle interval: ${this.config.CYCLE_INTERVAL_MS / 1000}s`);
    this.log('info', `  Failure threshold: ${this.config.FAILURE_THRESHOLD}`);
    this.log('info', `  Min improvement: ${this.config.MIN_IMPROVEMENT_PCT}%`);
    this.log('info', `  Experiment sessions: ${this.config.EXPERIMENT_SESSIONS}`);

    // Attempt to resume from last checkpoint (fire-and-forget in constructor)
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
      // Events are logged for observability; actual metrics are collected
      // in Phase 1 of the evolution cycle from gateway session history,
      // which provides full tool call data for proper pattern detection.
      if (event.type === 'session_end') {
        this.log('info', chalk.gray(`  📡 Monitor: session ${event.sessionId} ended`));
      }
    });

    this.monitor.start();
    this.log('info', '✓ Harness monitor started');

    // Start gateway watchdog
    this.watchdog.addListener((event) => {
      switch (event.type) {
        case 'health_fail':
          if (event.consecutiveFailures === 1) {
            this.log('warn', `Gateway health check failed`);
          }
          break;
        case 'restarting':
          this.log('warn', chalk.yellow(`🔄 Watchdog restarting gateway (attempt #${event.attempt})...`));
          break;
        case 'restart_success':
          this.log('info', chalk.green(`✓ Watchdog: gateway restarted successfully (attempt #${event.attempt})`));
          break;
        case 'restart_failed':
          this.log('error', chalk.red(`✗ Watchdog: gateway restart failed — ${event.error}`));
          break;
        case 'max_restarts':
          this.log('error', chalk.red(`🚨 Watchdog: max restarts reached (${event.total}). Manual intervention required.`));
          break;
      }
    });
    this.watchdog.start();
    this.log('info', '✓ Gateway watchdog started');

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
    this.watchdog.stop();
    this.monitor.stop();
    this.log('info', '🛑 OpenClaw Evo Hub stopped');
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Save current hub state to the memory store as a checkpoint.
   * Called after each evolution cycle completes.
   */
  async checkpoint(): Promise<void> {
    if (this.oneShot) {
      this.log('info', chalk.gray('  ⏭️  Skipping checkpoint (one-shot mode)'));
      return;
    }
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
    // NOTE: don't touch this.running here — resume() fires from the constructor
    // as fire-and-forget, so it can race with start() which sets running = true.
    this.log('info', `✓ Resumed from checkpoint — cycle #${this.cycleNumber}, ${this.completedCycles.length} cycles completed`);
  }

  getCompletedCycles(): EvolutionCycle[] {
    return [...this.completedCycles];
  }

  getCycleHistory(): EvolutionCycle[] {
    return [...this.cycleHistory];
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
    if (this.cycleRunning) {
      this.log('warn', 'Skipping cycle — previous cycle still running');
      if (this.running) this.scheduleNextCycle(this.config.CYCLE_INTERVAL_MS);
      return;
    }
    this.cycleRunning = true;

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

    // ── Phase 1: Monitor ────────────────────────────────────────────────────
    // Fetch live sessions from the gateway (the passive monitor doesn't poll)
    const monitorStart = Date.now();
    try {
      const gateway = new Gateway(this.config.OPENCLAW_GATEWAY_URL);
      const sessionManager = new SessionManager(gateway);
      const sessions = await sessionManager.getActiveSessions();
      const now = Date.now();

      for (const session of sessions) {
        // Skip sessions we've already seen
        if (this.recentMetrics.some((m) => m.sessionId === session.key)) continue;

        try {
          const messages = await gateway.getSessionHistory(session.key, 50, true);
          const sessionStart = session.updatedAt ?? now - 60000;
          const parsedToolCalls = extractToolCallsFromHistory(messages, sessionStart);
          const failedCalls = parsedToolCalls.filter((tc) => !tc.success).length;
          const completedCalls = parsedToolCalls.filter((tc) => tc.endTime != null);
          const totalLatencyMs = completedCalls.reduce((sum, tc) => sum + (tc.endTime! - tc.startTime), 0);
          const avgLatencyMs = completedCalls.length > 0 ? totalLatencyMs / completedCalls.length : 0;
          const taskType = inferTaskType(session, messages);

          this.log('info', chalk.gray(
            `    📝 Session ${session.key}: ${messages.length} msgs, ${parsedToolCalls.length} tool calls, ` +
            `${failedCalls} failures, type=${taskType}`,
          ));
          if (messages.length > 0 && parsedToolCalls.length === 0) {
            // Diagnostic: log first message shape to help debug format mismatches
            const sample = messages[0];
            const keys = Object.keys(sample).join(',');
            const contentType = Array.isArray(sample.content) ? 'array' : typeof sample.content;
            const hasToolCalls = 'tool_calls' in sample;
            this.log('info', chalk.gray(
              `    🔍 Msg format: keys=[${keys}] content=${contentType} tool_calls=${hasToolCalls}`,
            ));
          }

          this.recentMetrics.push({
            sessionId: session.key,
            toolCalls: parsedToolCalls,
            startTime: sessionStart,
            endTime: now,
            success: failedCalls === 0,
            errorCount: failedCalls,
            totalToolCalls: parsedToolCalls.length,
            avgLatencyMs,
            taskType,
          });
        } catch {
          // Skip sessions we can't read
        }
      }

      if (this.recentMetrics.length > 1000) {
        this.recentMetrics = this.recentMetrics.slice(-1000);
      }

      this.currentCycle.phases.monitor.eventsProcessed = this.recentMetrics.length;
      this.log('info', chalk.gray(`  📡 Monitor: ${sessions.length} sessions fetched, ${this.recentMetrics.length} total metrics`));
    } catch (err) {
      this.log('warn', `Monitor phase: could not fetch sessions — ${err}`);
      this.currentCycle.phases.monitor.eventsProcessed = this.recentMetrics.length;
    }
    this.currentCycle.phases.monitor.durationMs = Date.now() - monitorStart;

    // ── Phase 2: Evaluate ───────────────────────────────────────────────────
    const evaluateStart = Date.now();
    let report: EvaluationReport;

    try {
      const recentSessions = this.recentMetrics.slice(-100);
      const overallScore = scoreSessions(recentSessions);
      const toolScores = scorePerTool(recentSessions);

      // Detect patterns from live session data (not just the persisted corpus)
      const livePatterns = detectPatterns(recentSessions, this.config.FAILURE_THRESHOLD);

      // Record newly detected patterns into the failure corpus for accumulation
      for (const pattern of livePatterns) {
        const context = pattern.exampleContexts[0] ?? {
          sessionId: 'unknown', taskDescription: 'unknown',
          toolInput: {}, errorOutput: pattern.errorMessage, timestamp: new Date(),
        };
        await failureCorpus.recordFailure(pattern, context);
      }

      // Merge persisted corpus patterns with live-detected ones
      const corpusPatterns = await failureCorpus.getPatterns(this.config.FAILURE_THRESHOLD);
      report = analyze(recentSessions, corpusPatterns.length > 0 ? corpusPatterns : undefined);
      report.overallScore = overallScore;
      report.toolScores = toolScores;
    } catch (err) {
      this.log('error', `Evaluation failed: ${err}`);
      this.currentCycle.status = 'failed';
      this.currentCycle.completedAt = new Date();
      this.cycleHistory.push({ ...this.currentCycle });
      this.cycleRunning = false;
      if (this.running) this.scheduleNextCycle(this.config.CYCLE_INTERVAL_MS);
      return;
    }

    this.currentCycle.phases.evaluate.durationMs = Date.now() - evaluateStart;
    this.currentCycle.phases.evaluate.patternsFound = report.topFailurePatterns.length;
    this.currentCycle.phases.evaluate.overallScore = report.overallScore.overall;
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
            await improvementLog.record({
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
        const completed = await experimentRunner.run(experiment, this.recentMetrics);
        this.activeExperiments.set(completed.id, completed);
        experimentsRun++;

        const result = comparator.compare(completed);
        completed.statisticalSignificance = result.confidence;
        completed.improvementPct = result.improvementPct;

        promoter.register(completed);
        const decision = promoter.evaluate(completed);
        if (decision.promoted) {
          const promoteResult = await promoter.promote(completed.id);
          if (promoteResult.promoted) {
            this.currentCycle.phases.integrate.improvementsDeployed++;
            this.log('info', chalk.greenBright(`  🚀 Promoted: ${skill.name} (+${result.improvementPct.toFixed(1)}%)`));
          } else if (promoteResult.reason === 'requires_approval' && promoteResult.approvalId) {
            this.log('info', `🛑 Skill ${skill.name} promoted but requires human approval. Run /evo approve ${promoteResult.approvalId} to deploy.`);
          }
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

    // Persist completed cycle to history and checkpoint
    this.completedCycles.push(this.currentCycle);
    this.cycleHistory.push({ ...this.currentCycle });
    if (this.completedCycles.length > 50) {
      this.completedCycles = this.completedCycles.slice(-50);
    }

    const totalMs = Date.now() - cycleStart;
    this.log('info', chalk.green(`✅ Cycle #${this.cycleNumber} complete in ${(totalMs / 1000).toFixed(1)}s`));
    this.log('info', chalk.gray(`   Built: ${newSkills.length} skills | Experiments: ${experimentsRun} | Deployed: ${this.currentCycle.phases.integrate.improvementsDeployed}`));

    // Save checkpoint after cycle completes
    await this.checkpoint();

    // Clean up old experiments to prevent unbounded accumulation
    if (this.activeExperiments.size > 50) {
      const sorted = Array.from(this.activeExperiments.entries())
        .sort((a, b) => (a[1].completedAt?.getTime() ?? 0) - (b[1].completedAt?.getTime() ?? 0));
      const toRemove = sorted.slice(0, sorted.length - 50);
      for (const [id] of toRemove) this.activeExperiments.delete(id);
    }

    this.cycleRunning = false;

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
      gatewayWatchdog: this.watchdog.getState(),
    };
  }

  getProposedSkills(): GeneratedSkill[] {
    return [...this.proposedSkills];
  }

  getActiveExperiments(): Experiment[] {
    return Array.from(this.activeExperiments.values());
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /**
   * Inject synthetic sessions with tool failures for testing the full
   * Build → Experiment → Integrate pipeline.
   */
  injectTestFailures(): void {
    const now = Date.now();
    const failedToolCalls: import('./types.js').ToolCall[] = [
      {
        id: 'test-read-1', name: 'Read', input: { file_path: '/nonexistent/file.ts' },
        error: 'ENOENT: no such file or directory', startTime: now - 5000, endTime: now - 4500, success: false,
      },
      {
        id: 'test-read-2', name: 'Read', input: { file_path: '/tmp/missing.json' },
        error: 'ENOENT: no such file or directory', startTime: now - 4000, endTime: now - 3500, success: false,
      },
      {
        id: 'test-bash-1', name: 'Bash', input: { command: 'curl http://unreachable:9999' },
        error: 'connect ECONNREFUSED 127.0.0.1:9999', startTime: now - 3000, endTime: now - 2000, success: false,
      },
      {
        id: 'test-grep-1', name: 'Grep', input: { pattern: '*.log' },
        error: 'timeout: operation timed out after 30000ms', startTime: now - 2000, endTime: now - 500, success: false,
      },
    ];

    // Inject across multiple sessions so the pattern detector sees recurring failures
    for (let i = 0; i < 3; i++) {
      this.recentMetrics.push({
        sessionId: `test-failure-session-${i}`,
        toolCalls: failedToolCalls,
        startTime: now - 60000 + i * 10000,
        endTime: now - i * 5000,
        success: false,
        errorCount: failedToolCalls.length,
        totalToolCalls: failedToolCalls.length,
        avgLatencyMs: 750,
        taskType: 'debugging',
      });
    }

    this.log('info', chalk.yellow(`🧪 Injected 3 test sessions with ${failedToolCalls.length} tool failures each`));
  }

  // ── CLI trigger ────────────────────────────────────────────────────────────

  async runOnce(): Promise<void> {
    // One-shot mode: don't write checkpoints (avoids stomping the daemon's state)
    this.oneShot = true;

    // Wait for any in-progress resume() from constructor to finish
    // so we don't race on this.running = false
    await this.resume();
    await this.store.init();
    this.running = true;

    // Fetch live sessions from the gateway directly (monitor may not be started)
    try {
      const gateway = new Gateway(this.config.OPENCLAW_GATEWAY_URL);
      const sessionManager = new SessionManager(gateway);
      const sessions = await sessionManager.getActiveSessions();
      const now = Date.now();

      for (const session of sessions) {
        try {
          const messages = await gateway.getSessionHistory(session.key, 50, true);
          const sessionStart = session.updatedAt ?? now - 60000;
          const parsedToolCalls = extractToolCallsFromHistory(messages, sessionStart);
          const failedCalls = parsedToolCalls.filter((tc) => !tc.success).length;
          const completedCalls = parsedToolCalls.filter((tc) => tc.endTime != null);
          const totalLatencyMs = completedCalls.reduce((sum, tc) => sum + (tc.endTime! - tc.startTime), 0);
          const avgLatencyMs = completedCalls.length > 0 ? totalLatencyMs / completedCalls.length : 0;
          const taskType = inferTaskType(session, messages);

          this.recentMetrics.push({
            sessionId: session.key,
            toolCalls: parsedToolCalls,
            startTime: sessionStart,
            endTime: now,
            success: failedCalls === 0,
            errorCount: failedCalls,
            totalToolCalls: parsedToolCalls.length,
            avgLatencyMs,
            taskType,
          });
        } catch {
          // Skip sessions we can't read
        }
      }
      this.log('info', `✓ Fetched ${sessions.length} live session(s) from gateway`);
    } catch (err) {
      this.log('warn', `Could not fetch live sessions: ${err}`);
    }

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
