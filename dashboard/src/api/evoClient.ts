// evoClient.ts - fetches evolution data from OpenClaw gateway
// Uses setInterval to poll for session data; calculates metrics client-side

import type {
  DashboardData,
  HubStatus,
  DashboardMetrics,
  FailurePattern,
  EvolutionCycle,
  ProposedSkill,
  Experiment,
  ScorePoint,
} from '../types';

const POLL_INTERVAL_MS = 5000;

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 1000);
}

function calcScoreFromCycles(cycles: EvolutionCycle[]): number {
  if (!cycles.length) return 0;
  const completed = cycles.filter((c) => c.status === 'completed' && c.score !== null);
  if (!completed.length) return 0;
  return Math.round((completed.reduce((s, c) => s + (c.score ?? 0), 0) / completed.length) * 100);
}

function buildScoreHistory(cycles: EvolutionCycle[]): ScorePoint[] {
  return cycles
    .filter((c) => c.status === 'completed' && c.score !== null)
    .map((c) => ({
      timestamp: c.completedAt ?? c.startedAt,
      cycleIndex: c.cycleIndex,
      score: Math.round((c.score ?? 0) * 100),
      phase: c.phase,
    }));
}

// ---------- Mock data for demo / offline mode ----------

function mockFailurePatterns(): FailurePattern[] {
  return [
    {
      id: 'fp-1',
      toolName: 'exec',
      errorType: 'ENOENT',
      message: 'Command not found in PATH',
      frequency: 12,
      severity: 'medium',
      firstSeen: new Date(Date.now() - 86400000 * 3).toISOString(),
      lastSeen: new Date(Date.now() - 3600000).toISOString(),
      occurrences: 14,
    },
    {
      id: 'fp-2',
      toolName: 'read',
      errorType: 'EACCES',
      message: 'Permission denied reading file',
      frequency: 7,
      severity: 'high',
      firstSeen: new Date(Date.now() - 86400000 * 2).toISOString(),
      lastSeen: new Date(Date.now() - 7200000).toISOString(),
      occurrences: 9,
    },
    {
      id: 'fp-3',
      toolName: 'web_fetch',
      errorType: 'TIMEOUT',
      message: 'Request timed out after 30000ms',
      frequency: 5,
      severity: 'medium',
      firstSeen: new Date(Date.now() - 86400000).toISOString(),
      lastSeen: new Date(Date.now() - 1800000).toISOString(),
      occurrences: 6,
    },
    {
      id: 'fp-4',
      toolName: 'exec',
      errorType: 'EXIT_NON_ZERO',
      message: 'Process exited with code 1',
      frequency: 3,
      severity: 'low',
      firstSeen: new Date(Date.now() - 86400000 * 5).toISOString(),
      lastSeen: new Date(Date.now() - 86400000).toISOString(),
      occurrences: 4,
    },
  ];
}

function mockCycles(): EvolutionCycle[] {
  const phases = ['observing', 'analyzing', 'proposing', 'deploying', 'testing'];
  return Array.from({ length: 8 }, (_, i) => {
    const started = new Date(Date.now() - (8 - i) * 3600000).toISOString();
    const completed = i < 7 ? new Date(started).getTime() + 1800000 : null;
    return {
      id: `cycle-${i}`,
      cycleIndex: i + 1,
      startedAt: started,
      completedAt: completed ? new Date(completed).toISOString() : null,
      phase: phases[i % phases.length],
      status: i < 7 ? 'completed' : 'running',
      score: i < 7 ? 0.6 + Math.random() * 0.35 : null,
      summary: `Cycle ${i + 1}: ${phases[i % phases.length]} phase completed.`,
    };
  });
}

function mockProposedSkills(): ProposedSkill[] {
  return [
    {
      id: 'ps-1',
      name: 'retry-exec',
      description: 'Auto-retry failed exec calls up to 3 times with exponential backoff',
      confidence: 91,
      targetFailure: 'exec ENOENT/EXIT_NON_ZERO',
      targetFailureId: 'fp-1',
      status: 'pending',
      createdAt: new Date(Date.now() - 600000).toISOString(),
      filePath: null,
    },
    {
      id: 'ps-2',
      name: 'file-permission-guard',
      description: 'Pre-check file permissions before read/write to surface clearer errors',
      confidence: 78,
      targetFailure: 'read EACCES',
      targetFailureId: 'fp-2',
      status: 'approved',
      createdAt: new Date(Date.now() - 1800000).toISOString(),
      filePath: '~/.openclaw/skills/retry-exec/SKILL.md',
    },
    {
      id: 'ps-3',
      name: 'web-fetch-timeout-resolve',
      description: 'Gracefully handle web_fetch timeouts with cached fallback',
      confidence: 65,
      targetFailure: 'web_fetch TIMEOUT',
      targetFailureId: 'fp-3',
      status: 'rejected',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      filePath: null,
    },
  ];
}

function mockExperiments(): Experiment[] {
  return [
    {
      id: 'exp-1',
      name: 'exec-retry-v2',
      type: 'A/B',
      status: 'running',
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      metrics: { control: 72, variant: 84, improvement: 16.7, sampleSize: 120, significance: 0.94 },
      proposedSkillId: 'ps-1',
    },
    {
      id: 'exp-2',
      name: 'shadow-file-perms',
      type: 'shadow',
      status: 'running',
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      metrics: { control: 68, variant: 79, improvement: 16.2, sampleSize: 45, significance: 0.71 },
      proposedSkillId: 'ps-2',
    },
  ];
}

// ---------- API client ----------

async function fetchRaw(path: string): Promise<unknown> {
  try {
    const res = await fetch(`/api${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch {
    return null;
  }
}

async function getHubStatus(): Promise<HubStatus> {
  const raw = await fetchRaw('/session/status');
  if (raw && typeof raw === 'object') {
    const s = raw as Record<string, unknown>;
    return {
      running: s.running === true || s.active === true,
      phase: (s.phase as HubStatus['phase']) ?? 'idle',
      cycleCount: (s.cycleCount as number) ?? (s.cycle as number) ?? 0,
      lastCycleAt: (s.lastCycleAt as string) ?? (s.lastCycle as string) ?? null,
      uptimeSeconds: (s.uptimeSeconds as number) ?? (s.uptime as number) ?? 0,
    };
  }
  // Fallback mock
  return {
    running: true,
    phase: 'analyzing',
    cycleCount: 8,
    lastCycleAt: new Date(Date.now() - 600000).toISOString(),
    uptimeSeconds: 86400,
  };
}

async function getMetrics(): Promise<DashboardMetrics> {
  const [hub, cycles, patterns] = await Promise.all([
    getHubStatus(),
    fetchRaw('/session/cycles').catch(() => null),
    fetchRaw('/evo/failures').catch(() => null),
  ]);

  const cyclesData: EvolutionCycle[] = Array.isArray(cycles) ? cycles : mockCycles();
  const patternsData: FailurePattern[] = Array.isArray(patterns) ? patterns : mockFailurePatterns();

  return {
    totalCycles: hub.cycleCount,
    deployedSkills: 3,
    activeExperiments: mockExperiments().filter((e) => e.status === 'running').length,
    failurePatterns: patternsData.length,
    overallScore: calcScoreFromCycles(cyclesData),
    scoreHistory: buildScoreHistory(cyclesData),
    uptimeSeconds: hub.uptimeSeconds,
  };
}

async function getFailurePatterns(): Promise<FailurePattern[]> {
  const raw = await fetchRaw('/evo/failures');
  return Array.isArray(raw) ? raw : mockFailurePatterns();
}

async function getCycles(): Promise<EvolutionCycle[]> {
  const raw = await fetchRaw('/session/cycles');
  return Array.isArray(raw) ? raw : mockCycles();
}

async function getProposedSkills(): Promise<ProposedSkill[]> {
  const raw = await fetchRaw('/evo/proposed-skills');
  return Array.isArray(raw) ? raw : mockProposedSkills();
}

async function getExperiments(): Promise<Experiment[]> {
  const raw = await fetchRaw('/evo/experiments');
  return Array.isArray(raw) ? raw : mockExperiments();
}

async function getDashboardData(): Promise<DashboardData> {
  const [hub, metrics, failurePatterns, cycles, proposedSkills, experiments] =
    await Promise.all([
      getHubStatus(),
      getMetrics(),
      getFailurePatterns(),
      getCycles(),
      getProposedSkills(),
      getExperiments(),
    ]);

  return { hub, metrics, failurePatterns, cycles, proposedSkills, experiments };
}

// ---------- Polling wrapper ----------

type Listener = (data: DashboardData) => void;

function createPollingClient() {
  let listeners: Listener[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval = POLL_INTERVAL_MS;

  async function poll() {
    try {
      const data = await getDashboardData();
      listeners.forEach((l) => l(data));
    } catch {
      // silent – next poll will retry
    }
    timer = setTimeout(poll, jitter(interval));
  }

  return {
    start() {
      if (!timer) {
        poll();
      }
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    subscribe(listener: Listener): () => void {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    refresh() {
      return getDashboardData();
    },
  };
}

export const evoClient = {
  getHubStatus,
  getMetrics,
  getDashboardData,
  getFailurePatterns,
  getCycles,
  getProposedSkills,
  getExperiments,
  approveSkill: async (id: string): Promise<void> => {
    await fetch(`/api/evo/skills/${id}/approve`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  },
  rejectSkill: async (id: string): Promise<void> => {
    await fetch(`/api/evo/skills/${id}/reject`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  },
  polling: createPollingClient(),
};
