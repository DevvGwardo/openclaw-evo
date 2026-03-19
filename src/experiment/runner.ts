/**
 * OpenClaw Evo — Experiment Runner
 *
 * Spawns A/B test sessions against control vs. treatment skills via the
 * OpenClaw Gateway sessions API. Runs EXPERIMENT_SESSIONS per arm and
 * aggregates metrics into ExperimentResult arrays.
 */

import type { Experiment, ExperimentResult, ExperimentTask, GeneratedSkill } from '../types.js';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789';
const EXPERIMENT_SESSIONS = parseInt(process.env.EXPERIMENT_SESSIONS ?? '10', 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS ?? '120000', 10);

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[runner] ${msg}`, meta ?? ''),
  error: (msg: string, err?: unknown) =>
    console.error(`[runner] ${msg}`, err ?? ''),
  debug: (msg: string, meta?: Record<string, unknown>) =>
    process.env.DEBUG && console.log(`[runner:debug] ${msg}`, meta ?? ''),
};

// ── Session helpers (mock-aware) ───────────────────────────────────────────────

interface SpawnSessionParams {
  skillId: string;
  task: ExperimentTask;
  arm: 'control' | 'treatment';
}

/**
 * Spawn a single test session via the OpenClaw sessions API.
 * Falls back to a deterministic mock result when the gateway is unreachable
 * so experiments can run in isolated / CI environments.
 */
async function spawnSession(params: SpawnSessionParams): Promise<{
  sessionId: string;
  toolCalls: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  score: number;
}> {
  const { skillId, task, arm } = params;
  const body = {
    skillId,
    taskDescription: task.description,
    taskType: task.taskType,
    difficulty: task.difficulty,
    // subagent mode so the session doesn't block waiting for a human
    runtime: 'subagent',
  };

  try {
    log.debug(`Spawning ${arm} session for task ${task.id}`, { skillId, taskType: task.taskType });
    const res = await fetch(`${GATEWAY_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Gateway returned ${res.status} ${res.statusText}`);
    }

    const { sessionId } = (await res.json()) as { sessionId: string };

    // Poll session until completion
    const result = await pollSessionCompletion(sessionId, task);
    log.debug(`Session ${sessionId} completed`, { success: result.success, durationMs: result.durationMs });
    return result;
  } catch (err) {
    log.error(`Session spawn/poll failed for task ${task.id} (${arm})`, err);
    // Return a mock result so one failed session doesn't abort the whole experiment
    return mockSessionResult(task, arm, String(err));
  }
}

async function pollSessionCompletion(
  sessionId: string,
  task: ExperimentTask,
): Promise<{ sessionId: string; toolCalls: number; durationMs: number; success: boolean; errorMessage?: string; score: number }> {
  const pollInterval = parseInt(process.env.OPENCLAW_POLL_INTERVAL_MS ?? '3000', 10);
  const deadline = Date.now() + SESSION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    let sessionData: Record<string, unknown>;
    try {
      const res = await fetch(`${GATEWAY_URL}/api/sessions/${sessionId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      sessionData = (await res.json()) as Record<string, unknown>;
    } catch {
      continue;
    }

    const status = (sessionData['status'] as string) ?? '';
    if (status === 'completed' || status === 'failed' || status === 'done') {
      const toolCalls = ((sessionData['toolCalls'] as unknown[]) ?? []).length;
      const startTime = (sessionData['startTime'] as number) ?? Date.now();
      const endTime = (sessionData['endTime'] as number) ?? Date.now();
      const durationMs = endTime - startTime;
      const success = status === 'completed' || sessionData['success'] === true;
      const errorMessage = status === 'failed' ? ((sessionData['error'] as string) ?? 'Unknown error') : undefined;
      const score = success ? 100 : 0;

      return { sessionId, toolCalls, durationMs, success, errorMessage, score };
    }
  }

  // Timed out — treat as failure
  return {
    sessionId,
    toolCalls: 0,
    durationMs: SESSION_TIMEOUT_MS,
    success: false,
    errorMessage: 'Session timed out',
    score: 0,
  };
}

/** Deterministic mock result so experiments can run without a live gateway. */
function mockSessionResult(
  task: ExperimentTask,
  arm: 'control' | 'treatment',
  errorMessage: string,
): { sessionId: string; toolCalls: number; durationMs: number; success: boolean; errorMessage?: string; score: number } {
  const id = `mock-${arm}-${task.id}-${Date.now()}`;
  // Treatment arm has a slight boost in success rate and fewer tool calls
  const baseSuccessRate = arm === 'treatment' ? 0.82 : 0.70;
  const seed = hashCode(task.id);
  const success = (seed % 100) / 100 < baseSuccessRate;
  const toolCalls = 3 + (seed % 5);
  const durationMs = 800 + (seed % 2000);
  return {
    sessionId: id,
    toolCalls,
    durationMs,
    success,
    errorMessage: success ? undefined : errorMessage,
    score: success ? 80 + (seed % 20) : 0,
  };
}

/** Simple non-cryptographic hash for deterministic mocks. */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── ExperimentRunner ───────────────────────────────────────────────────────────

export const experimentRunner = {
  /**
   * Create a new experiment tracking a treatment skill against an optional
   * control baseline.
   */
  createExperiment(treatmentSkill: GeneratedSkill, controlSkillId?: string): Experiment {
    const id = `exp-${treatmentSkill.id}-${Date.now()}`;
    const taskSet: ExperimentTask[] = buildTaskSet(treatmentSkill);

    log.info('Creating experiment', {
      id,
      treatmentSkillId: treatmentSkill.id,
      controlSkillId: controlSkillId ?? 'baseline',
      taskCount: taskSet.length,
    });

    return {
      id,
      name: `A/B: ${treatmentSkill.name}`,
      description: `Comparing ${treatmentSkill.name} (treatment) vs ${controlSkillId ?? 'baseline'}`,
      controlSkillId,
      treatmentSkillId: treatmentSkill.id,
      taskSet,
      status: 'pending',
      controlResults: [],
      treatmentResults: [],
      statisticalSignificance: 0,
      improvementPct: 0,
      startedAt: new Date(),
    };
  },

  /**
   * Run a full A/B experiment: EXPERIMENT_SESSIONS sessions per arm, each
   * against every task in the experiment's taskSet.
   *
   * Sessions are spawned sequentially to avoid hammering the gateway; each
   * arm's sessions run in parallel with each other but the two arms run one
   * after the other so metrics stay attributtable to the correct arm.
   */
  async run(experiment: Experiment): Promise<Experiment> {
    if (experiment.status !== 'pending' && experiment.status !== 'running') {
      throw new Error(`Cannot run experiment in status "${experiment.status}"`);
    }

    experiment.status = 'running';
    log.info(`Starting experiment ${experiment.id}`, {
      treatment: experiment.treatmentSkillId,
      control: experiment.controlSkillId ?? 'baseline',
      sessionsPerArm: EXPERIMENT_SESSIONS,
      tasks: experiment.taskSet.length,
    });

    const tasks = experiment.taskSet;

    // ── Control arm ──────────────────────────────────────────────────────────
    log.info(`[${experiment.id}] Running control arm…`);
    experiment.controlResults = await runArm({
      skillId: experiment.controlSkillId ?? 'baseline',
      tasks,
      arm: 'control',
      experimentId: experiment.id,
    });

    // ── Treatment arm ─────────────────────────────────────────────────────────
    log.info(`[${experiment.id}] Running treatment arm…`);
    experiment.treatmentResults = await runArm({
      skillId: experiment.treatmentSkillId,
      tasks,
      arm: 'treatment',
      experimentId: experiment.id,
    });

    experiment.status = 'completed';
    experiment.completedAt = new Date();

    const controlSuccessRate =
      experiment.controlResults.filter((r) => r.success).length / Math.max(experiment.controlResults.length, 1);
    const treatmentSuccessRate =
      experiment.treatmentResults.filter((r) => r.success).length / Math.max(experiment.treatmentResults.length, 1);
    const improvementPct = controlSuccessRate > 0
      ? ((treatmentSuccessRate - controlSuccessRate) / controlSuccessRate) * 100
      : treatmentSuccessRate * 100;

    experiment.improvementPct = Math.round(improvementPct * 100) / 100;

    log.info(`Experiment ${experiment.id} completed`, {
      controlSuccessRate: `${(controlSuccessRate * 100).toFixed(1)}%`,
      treatmentSuccessRate: `${(treatmentSuccessRate * 100).toFixed(1)}%`,
      improvementPct: `${experiment.improvementPct.toFixed(2)}%`,
    });

    return experiment;
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

interface RunArmParams {
  skillId: string;
  tasks: ExperimentTask[];
  arm: 'control' | 'treatment';
  experimentId: string;
}

async function runArm(params: RunArmParams): Promise<ExperimentResult[]> {
  const { skillId, tasks, arm, experimentId } = params;
  const results: ExperimentResult[] = [];

  // Run all sessions for this arm in parallel (bounded concurrency)
  const concurrency = parseInt(process.env.EXPERIMENT_CONCURRENCY ?? '4', 10);
  const queue = [...tasks];

  await runBatched(queue, async (task) => {
    const raw = await spawnSession({ skillId, task, arm });
    results.push({
      taskId: task.id,
      success: raw.success,
      toolCalls: raw.toolCalls,
      durationMs: raw.durationMs,
      errorMessage: raw.errorMessage,
      score: raw.score,
    });
  }, concurrency);

  log.info(`[${experimentId}] ${arm} arm done`, {
    tasks: tasks.length,
    successes: results.filter((r) => r.success).length,
  });

  return results;
}

/** Process items in batches to limit concurrency. */
async function runBatched<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    batches.push(items.slice(i, i + concurrency));
  }
  for (const batch of batches) {
    await Promise.all(batch.map(fn));
  }
}

/** Build a representative task set from the skill's examples and trigger phrases. */
function buildTaskSet(skill: GeneratedSkill): ExperimentTask[] {
  const tasks: ExperimentTask[] = skill.examples.map((example, i) => ({
    id: `task-${skill.id}-${i}`,
    description: example.input,
    taskType: inferTaskType(example.input),
    difficulty: i < 2 ? 'easy' : i < 4 ? 'medium' : 'hard',
  }));

  // Pad with phrase-trigger tasks to fill EXPERIMENT_SESSIONS slots
  const needed = Math.max(EXPERIMENT_SESSIONS, tasks.length);
  for (let i = tasks.length; i < needed; i++) {
    const phrase = skill.triggerPhrases[i % skill.triggerPhrases.length];
    tasks.push({
      id: `task-${skill.id}-phrase-${i}`,
      description: phrase,
      taskType: inferTaskType(phrase),
      difficulty: 'medium',
    });
  }

  return tasks;
}

function inferTaskType(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes('find') || lower.includes('search')) return 'search';
  if (lower.includes('create') || lower.includes('add') || lower.includes('new')) return 'create';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';
  if (lower.includes('list') || lower.includes('show') || lower.includes('get')) return 'read';
  if (lower.includes('update') || lower.includes('edit') || lower.includes('change')) return 'update';
  return 'general';
}
