/**
 * OpenClaw Evo Hub - Main Orchestration
 *
 * Runs the self-evolution loop:
 * Monitor → Evaluate → Build → Experiment → Integrate → (repeat)
 */

import chalk from 'chalk';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { experimentRunner } from './experiment/runner.js';
import { comparator } from './experiment/comparator.js';
import { promoter } from './experiment/promoter.js';
import { experimentLog } from './experiment/experimentLog.js';
import { frontier } from './experiment/frontier.js';
import { gitTracker } from './experiment/gitTracker.js';
import { MemoryStore } from './memory/store.js';
import { failureCorpus } from './memory/failureCorpus.js';
import { improvementLog } from './memory/improvementLog.js';
import { GatewayWatchdog } from './watchdog.js';
import type {
  EvoConfig,
  EvolutionCycle,
  SessionMetrics,
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
  private deployedSkillsStore: MemoryStore;
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
  private _testFailuresInjected = false;

  constructor(config: Partial<EvoConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize memory store
    this.store = new MemoryStore(this.storeMemoryDir());
    this.deployedSkillsStore = new MemoryStore(this.storeMemoryDir());

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

    // Always resume from checkpoint on start — keeps server state in sync with disk
    await this.resume();

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
          this.log('error', chalk.red(`✗ Watchdog: gateway restart failed - ${event.error}`));
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
    // oneShot=true for --once mode (skip checkpoint to avoid stomping daemon state)
    // oneShot=false for --cron mode (save checkpoint between cron invocations)
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
      recentMetrics: this.recentMetrics.slice(-100),
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
      this.log('info', 'No checkpoint found - starting fresh');
      return;
    }
    this.cycleNumber = state.cycleNumber ?? 0;
    // Deduplicate proposed skills by name and drop duplicates
    const skillsByName = new Map<string, typeof this.proposedSkills[0]>();
    for (const s of state.proposedSkills ?? []) {
      const existing = skillsByName.get(s.name);
      // Keep the one with the most advanced status
      if (!existing || s.status === 'deployed' || s.status === 'pending_approval') {
        skillsByName.set(s.name, s);
      }
    }
    this.proposedSkills = Array.from(skillsByName.values());
    this.completedCycles = (state.completedCycles ?? []).map((c) => ({
      ...c,
      startedAt: new Date(c.startedAt),
      completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
    }));
    this.activeExperiments = new Map(
      (state.activeExperiments ?? []).map((e) => [e.id, e]),
    );
    if (state.recentMetrics && state.recentMetrics.length > 0) {
      // Merge: keep any pre-existing metrics (e.g. injected test data) and add checkpointed ones
      const existingIds = new Set(this.recentMetrics.map((m) => m.sessionId));
      for (const m of state.recentMetrics) {
        if (!existingIds.has(m.sessionId)) {
          this.recentMetrics.push(m);
        }
      }
    }
    // NOTE: don't touch this.running here - resume() fires from the constructor
    // as fire-and-forget, so it can race with start() which sets running = true.
    this.log('info', `✓ Resumed from checkpoint - cycle #${this.cycleNumber}, ${this.completedCycles.length} cycles completed`);

    // Also load separately-persisted deployed skills so they survive checkpoint gaps
    const persistedDeployed = await this.deployedSkillsStore.load<GeneratedSkill[]>('deployed-skills');
    if (persistedDeployed && Array.isArray(persistedDeployed)) {
      // Deduplicate by name — same skill generated with a different ID shouldn't be added twice
      const existingNames = new Set(this.proposedSkills.map((s) => s.name));
      let added = 0;
      for (const skill of persistedDeployed) {
        if (!existingNames.has(skill.name)) {
          skill.status = 'deployed';
          this.proposedSkills.push(skill);
          existingNames.add(skill.name);
          added++;
        }
      }
      this.log('info', `✓ Restored ${added} deployed skills from persistent store (${persistedDeployed.length} on disk)`);
    }
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
      // Skip scheduled cycles in one-shot/cron mode — only the CLI-triggered cycle should run
      if (this.oneShot) return;
      void this.runEvolutionCycle();
    }, intervalMs);
  }

  async runEvolutionCycle(): Promise<EvolutionCycle | void> {
    if (!this.running) return;
    if (this.cycleRunning) {
      this.log('warn', 'Skipping cycle - previous cycle still running');
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
      this.log('warn', `Monitor phase: could not fetch sessions - ${err}`);
      this.currentCycle.phases.monitor.eventsProcessed = this.recentMetrics.length;
    }
    this.currentCycle.phases.monitor.durationMs = Date.now() - monitorStart;

    // ── Phase 2: Evaluate ───────────────────────────────────────────────────
    const evaluateStart = Date.now();
    let report: EvaluationReport;

    try {
      // Decay stale failure patterns that haven't recurred recently
      const decayed = await failureCorpus.decay();
      if (decayed > 0) this.log('info', chalk.gray(`  🧹 Decayed ${decayed} stale failure pattern(s)`));

      const recentSessions = this.recentMetrics.slice(-100);
      const overallScore = scoreSessions(recentSessions);
      const toolScores = scorePerTool(recentSessions);

      // Detect patterns from live session data (not just the persisted corpus)
      const livePatterns = detectPatterns(recentSessions, this.config.FAILURE_THRESHOLD);

      // Persist newly detected patterns to the failure corpus for accumulation
      // (this is the only place that records in hub-only mode; cycle.ts does it for daemon mode)
      for (const pattern of livePatterns) {
        const ctx = pattern.exampleContexts[0] ?? {
          sessionId: recentSessions[0]?.sessionId ?? 'unknown',
          taskDescription: recentSessions[0]?.taskType ?? 'unknown',
          toolInput: {},
          errorOutput: pattern.errorMessage,
          timestamp: new Date(),
        };
        await failureCorpus.recordFailure(pattern, ctx);
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
    // Skip patterns whose (toolName, errorType) already has a proposed/deployed skill.
    // Key by "toolName/errorType" — stable across corpus rebuilds (unlike pattern ID).
    // Only block re-proposal of skills that are still active (not rejected).
    // Rejected skills can be re-proposed since their experiment failed.
    const activePatternKeys = new Set(
      this.proposedSkills
        .filter((s) => s.status !== 'rejected')
        .map((s) => {
          // Skill name format: "${toolName} — ${errorType} Skill"
          const parts = s.name.split('—').map((p) => p.trim());
          return parts.length >= 2
            ? `${parts[0].toLowerCase()}/${parts[1].replace(' Skill', '').toLowerCase()}`
            : s.name.toLowerCase();
        }),
    );

    // Deduplicate: skip patterns whose skill is already deployed
    const deployedSkillNames = getDeployedSkillNames(this.config.SKILL_OUTPUT_DIR);

    // Filter out already-skipped patterns BEFORE slicing to MAX_SKILLS_PER_CYCLE,
    // so they don't consume slots and block other actionable patterns.
    const actionablePatterns = failurePatterns.filter(
      (p) => !activePatternKeys.has(`${p.toolName.toLowerCase()}/${p.errorType.toLowerCase()}`),
    );
    // Deduplicate by toolName/errorType to prevent duplicate corpus entries
    // from consuming MAX_SKILLS_PER_CYCLE slots.
    const seenPatternKeys = new Set<string>();
    const uniquePatterns: typeof actionablePatterns = [];
    for (const p of actionablePatterns) {
      const key = `${p.toolName.toLowerCase()}/${p.errorType.toLowerCase()}`;
      if (!seenPatternKeys.has(key)) {
        seenPatternKeys.add(key);
        uniquePatterns.push(p);
      }
    }

    // Pre-filter: generate skill and skip if already deployed — BEFORE the slice.
    // This prevents already-deployed patterns from consuming MAX_SKILLS_PER_CYCLE slots
    // and starving new patterns that actually need a skill to be built.
    const candidatePatterns: { pattern: typeof uniquePatterns[number]; result: ReturnType<typeof generateFromFailure> }[] = [];
    for (const pattern of uniquePatterns) {
      const patternKey = `${pattern.toolName.toLowerCase()}/${pattern.errorType.toLowerCase()}`;
      if (activePatternKeys.has(patternKey)) continue;
      const result = generateFromFailure(pattern);
      if (!result.skill) continue;
      if (deployedSkillNames.has(result.skill.name)) continue; // already deployed — don't consume a slot
      candidatePatterns.push({ pattern, result });
    }

    for (const { pattern, result } of candidatePatterns.slice(0, this.config.MAX_SKILLS_PER_CYCLE)) {
      try {
        if (result.skill) {
          const validation = validate(result.skill);
          if (validation.valid) {
            result.skill.patternFrequency = pattern.frequency;
            result.skill.status = 'proposed';
            result.skill.proposedAtCycle = this.cycleNumber;
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
      // ── Git: create experiment branch ──────────────────────────────────
      let gitBranch: string | null = null;
      try {
        const experiment = experimentRunner.createExperiment(skill);
        gitBranch = gitTracker.createBranch(experiment.id);
        if (gitBranch) {
          gitTracker.commitSkill(gitBranch, skill, experiment);
        }

        const completed = await experimentRunner.run(experiment, this.recentMetrics);
        this.activeExperiments.set(completed.id, completed);
        experimentsRun++;

        const result = comparator.compare(completed);
        completed.statisticalSignificance = result.confidence;
        completed.improvementPct = result.improvementPct;

        // Compute success rates for TSV log
        const controlRate = completed.controlResults.length > 0
          ? completed.controlResults.filter((r) => r.success).length / completed.controlResults.length
          : 0;
        const treatmentRate = completed.treatmentResults.length > 0
          ? completed.treatmentResults.filter((r) => r.success).length / completed.treatmentResults.length
          : 0;

        promoter.register(completed);
        promoter.registerSkill(skill);
        const decision = promoter.evaluate(completed);
        if (decision.promoted) {
          const promoteResult = await promoter.promote(completed.id);
          if (promoteResult.promoted) {
            this.currentCycle.phases.integrate.improvementsDeployed++;
            // Sync status in hub's proposedSkills (promoter works on a separate skill copy)
            const hubSkill = this.proposedSkills.find((s) => s.id === skill.id);
            if (hubSkill) hubSkill.status = 'deployed';
            // Persist deployed skills separately so they survive checkpoint gaps / expiry
            const allDeployed = this.proposedSkills.filter((s) => s.status === 'deployed');
            await this.deployedSkillsStore.save('deployed-skills', allDeployed);
            this.log('info', chalk.greenBright(`  🚀 Promoted: ${skill.name} (+${result.improvementPct.toFixed(1)}%)`));

            // ── Log: kept ──────────────────────────────────────────────
            experimentLog.record({
              experimentId: completed.id,
              skillName: skill.name,
              status: 'kept',
              controlRate,
              treatmentRate,
              improvementPct: result.improvementPct,
              confidence: result.confidence,
              overallScore: report.overallScore.overall,
              description: `Promoted: ${skill.name} targeting ${skill.targetFailurePattern ?? 'unknown'}`,
            });

            // ── Git: merge promoted experiment ─────────────────────────
            if (gitBranch) gitTracker.keepExperiment(gitBranch);
            gitBranch = null; // consumed
          } else if (promoteResult.reason === 'requires_approval' && promoteResult.approvalId) {
            const hubSkill = this.proposedSkills.find((s) => s.id === skill.id);
            if (hubSkill) hubSkill.status = 'pending_approval';
            this.log('info', `🛑 Skill ${skill.name} promoted but requires human approval. Run /evo approve ${promoteResult.approvalId} to deploy.`);
            experimentLog.record({
              experimentId: completed.id,
              skillName: skill.name,
              status: 'kept',
              controlRate,
              treatmentRate,
              improvementPct: result.improvementPct,
              confidence: result.confidence,
              overallScore: report.overallScore.overall,
              description: `Pending approval: ${skill.name}`,
            });
          }
        } else {
          skill.status = 'rejected';
          this.log('info', chalk.yellow(`  ⏳ Not yet: ${skill.name} (${result.improvementPct.toFixed(1)}% improvement)`));

          // ── Log: discarded ───────────────────────────────────────────
          experimentLog.record({
            experimentId: completed.id,
            skillName: skill.name,
            status: 'discarded',
            controlRate,
            treatmentRate,
            improvementPct: result.improvementPct,
            confidence: result.confidence,
            overallScore: report.overallScore.overall,
            description: `Discarded: ${skill.name} (${result.improvementPct.toFixed(1)}% < ${this.config.MIN_IMPROVEMENT_PCT}% threshold)`,
          });

          // ── Git: discard experiment branch ───────────────────────────
          if (gitBranch) gitTracker.discardExperiment(gitBranch);
          gitBranch = null;
        }
      } catch (err) {
        this.log('error', `  ❌ Experiment failed for ${skill.name}: ${err}`);

        // ── Log: crashed ───────────────────────────────────────────────
        experimentLog.record({
          experimentId: `crash-${skill.id}-${Date.now()}`,
          skillName: skill.name,
          status: 'crashed',
          controlRate: 0,
          treatmentRate: 0,
          improvementPct: 0,
          confidence: 0,
          overallScore: report.overallScore.overall,
          description: `Crashed: ${err instanceof Error ? err.message : String(err)}`,
        });

        // ── Git: discard crashed experiment branch ─────────────────────
        if (gitBranch) gitTracker.discardExperiment(gitBranch);
      }
    }
    this.currentCycle.phases.experiment.durationMs = Date.now() - experimentStart;
    this.currentCycle.phases.experiment.experimentsRun = experimentsRun;

    // Clean up completed/rejected experiments to prevent unbounded growth
    for (const [id, exp] of this.activeExperiments) {
      if (exp.status === 'completed' || exp.status === 'rejected' || exp.status === 'promoted') {
        this.activeExperiments.delete(id);
      }
    }

    // Age out stale skills:
    // - Proposed skills expire after 5 cycles with no matching failures
    // - Rejected skills are purged after 10 cycles (keeps them around for dedup)
    const MAX_PROPOSED_CYCLES = 5;
    const MAX_REJECTED_CYCLES = 10;
    this.proposedSkills = this.proposedSkills.filter((s) => {
      // Skills without proposedAtCycle are from old checkpoints — treat as old enough to expire
      const age = this.cycleNumber - (s.proposedAtCycle ?? 0);
      if (s.status === 'proposed' && age >= MAX_PROPOSED_CYCLES) {
        s.status = 'rejected';
        this.log('info', chalk.gray(`  🗑️  Expired stale proposal: ${s.name} (${age} cycles old)`));
        return true; // keep as rejected for dedup
      }
      if (s.status === 'rejected' && age >= MAX_REJECTED_CYCLES) {
        return false; // purge old rejected skills
      }
      return true;
    });

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

    // ── Record progress frontier ────────────────────────────────────────
    try {
      const overallScore = this.currentCycle.phases.evaluate.overallScore ?? 0;
      const frontierPoint = await frontier.record({
        cycle: this.cycleNumber,
        score: overallScore,
        timestamp: new Date().toISOString(),
        skillsDeployed: this.currentCycle.phases.integrate.improvementsDeployed,
        experimentsRun,
      });
      if (frontierPoint.bestScore > frontierPoint.score) {
        this.log('info', chalk.gray(`   📈 Frontier: ${overallScore.toFixed(1)} (best: ${frontierPoint.bestScore.toFixed(1)})`));
      } else if (frontierPoint.bestScore === frontierPoint.score && frontierPoint.score > 0) {
        this.log('info', chalk.green(`   📈 New frontier best: ${frontierPoint.bestScore.toFixed(1)}`));
      }

      // Log experiment stats
      const expStats = experimentLog.stats();
      if (expStats.total > 0) {
        this.log('info', chalk.gray(`   📊 Experiments total: ${expStats.total} (kept: ${expStats.kept}, discarded: ${expStats.discarded}, crashed: ${expStats.crashed}, keep rate: ${(expStats.keepRate * 100).toFixed(0)}%)`));
      }
    } catch (err) {
      this.log('warn', `Failed to record frontier: ${err}`);
    }

    // Save checkpoint after cycle completes
    await this.checkpoint();

    // Clean up old experiments to prevent unbounded accumulation
    if (this.activeExperiments.size > 50) {
      const sorted = Array.from(this.activeExperiments.entries())
        .sort((a, b) => (new Date(a[1].completedAt ?? 0).getTime() ?? 0) - (new Date(b[1].completedAt ?? 0).getTime() ?? 0));
      const toRemove = sorted.slice(0, sorted.length - 50);
      for (const [id] of toRemove) this.activeExperiments.delete(id);
    }

    this.cycleRunning = false;

    if (this.running) {
      this.scheduleNextCycle(this.config.CYCLE_INTERVAL_MS);
    }

    return this.currentCycle;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus(): Promise<HubStatus> {
    const [, patterns] = await Promise.all([
      improvementLog.getStats(),
      failureCorpus.getPatterns(0),
    ]);
    return {
      running: this.running,
      currentCycle: this.currentCycle ?? undefined,
      totalCyclesRun: this.cycleNumber,
      lastCycleAt: this.currentCycle?.completedAt,
      activeExperiments: this.activeExperiments.size,
      deployedSkills: this.proposedSkills.filter((s) => s.status === 'deployed').length,
      knownFailurePatterns: patterns.length,
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

  getConfig(): EvoConfig {
    return { ...DEFAULT_CONFIG };
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /**
   * Inject synthetic sessions with tool failures for testing the full
   * Build → Experiment → Integrate pipeline.
   */
  /**
   * Inject synthetic tool failures to stress-test the pattern detector and skill builder.
   * Injects multiple failure types for Bash and Grep (the two stuck skills) so the
   * detector sees recurring patterns and can refine confidence scores.
   */
  injectTestFailures(): void {
    const now = Date.now();
    const failedToolCalls: import('./types.js').ToolCall[] = [
      // Read failures — "file not found" pattern
      {
        id: 'test-read-1', name: 'Read', input: { file_path: '/nonexistent/file.ts' },
        error: 'ENOENT: no such file or directory', startTime: now - 9000, endTime: now - 8500, success: false,
      },
      {
        id: 'test-read-2', name: 'Read', input: { file_path: '/tmp/missing.json' },
        error: 'ENOENT: no such file or directory', startTime: now - 8000, endTime: now - 7500, success: false,
      },
      // Bash failures — multiple distinct error patterns
      {
        id: 'test-bash-1', name: 'Bash', input: { command: 'curl http://unreachable:9999' },
        error: 'connect ECONNREFUSED 127.0.0.1:9999', startTime: now - 7000, endTime: now - 6500, success: false,
      },
      {
        id: 'test-bash-2', name: 'Bash', input: { command: 'tail /nonexistent/logfile.log' },
        error: 'tail: /nonexistent/logfile.log: No such file or directory\n(Command exited with code 1)',
        startTime: now - 6000, endTime: now - 5500, success: false,
      },
      {
        id: 'test-bash-3', name: 'Bash', input: { command: 'ssh nonexistent-host.example.com exit' },
        error: 'ssh: Could not resolve hostname nonexistent-host.example.com: nodename nor servname provided\n(Command exited with code 255)',
        startTime: now - 5000, endTime: now - 4500, success: false,
      },
      {
        id: 'test-bash-4', name: 'Bash', input: { command: 'ping -c 3 192.0.2.1' },
        error: 'ping: cannot resolve 192.0.2.1: Unknown host\n(Command exited with code 2)',
        startTime: now - 4000, endTime: now - 3500, success: false,
      },
      // Grep failures — timeout variants
      {
        id: 'test-grep-1', name: 'Grep', input: { pattern: '*.log' },
        error: 'timeout: operation timed out after 30000ms', startTime: now - 3000, endTime: now - 2500, success: false,
      },
      {
        id: 'test-grep-2', name: 'Grep', input: { pattern: 'ERROR' },
        error: 'timeout: operation timed out after 30000ms', startTime: now - 2000, endTime: now - 1500, success: false,
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

  async runOnce(opts: { saveCheckpoint?: boolean; injectFailures?: boolean } = {}): Promise<void> {
    // saveCheckpoint=true for cron jobs (one-shot but checkpoint between runs)
    // saveCheckpoint=false for interactive --once (avoids stomping daemon state)
    // injectFailures=true to inject synthetic Bash/Grep failures (called AFTER resume
    //   so injected sessions are at the tail of recentMetrics, not the head)
    this.oneShot = !opts.saveCheckpoint;

    // Wait for any in-progress resume() from constructor to finish
    // so we don't race on this.running = false
    await this.resume();
    await this.store.init();

    // Inject test failures AFTER resume completes — this ensures injected sessions
    // append to the tail of recentMetrics (after checkpoint sessions), so they
    // are always included in recentMetrics.slice(-100) passed to detectPatterns.
    if (opts.injectFailures && !this._testFailuresInjected) {
      this.injectTestFailures();
      this._testFailuresInjected = true;
    }

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

/**
 * Scan the deployed skills directory and return the set of already-deployed skill names.
 * This prevents re-deploying the same skill pattern multiple times.
 */
function getDeployedSkillNames(skillOutputDir: string): Set<string> {
  const names = new Set<string>();
  try {
    const skillDir = skillOutputDir.replace('~', process.env.HOME ?? '');
    const entries = readdirSync(skillDir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'clawbert' || entry === 'moltsland') continue;
      const skillMdPath = join(skillDir, entry, 'SKILL.md');
      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        // Skill name is on the first line as "# Skill Name"
        const match = content.match(/^#\s+(.+)/);
        if (match) names.add(match[1].trim());
      } catch { /* no SKILL.md in this dir */ }
    }
  } catch { /* skills dir doesn't exist yet */ }
  return names;
}
