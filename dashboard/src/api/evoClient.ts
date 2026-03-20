// evoClient.ts — fetches evolution data from the Evo hub API server
// Polls /api/* endpoints and maps responses to dashboard types

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

// ---------- API client ----------

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------- Data mappers ----------
// The hub API returns data in src/types.ts format. We map it to dashboard types.

async function getHubStatus(): Promise<HubStatus> {
  const raw = await fetchJson<Record<string, unknown>>('/api/status');
  if (raw) {
    const cycle = raw.currentCycle as Record<string, unknown> | undefined;
    return {
      running: raw.running === true,
      phase: (cycle?.status as HubStatus['phase']) ?? (raw.running ? 'idle' : 'idle'),
      cycleCount: (raw.totalCyclesRun as number) ?? 0,
      lastCycleAt: raw.lastCycleAt ? String(raw.lastCycleAt) : null,
      uptimeSeconds: 0,
    };
  }
  return { running: false, phase: 'idle', cycleCount: 0, lastCycleAt: null, uptimeSeconds: 0 };
}

async function getCycles(): Promise<EvolutionCycle[]> {
  const raw = await fetchJson<unknown[]>('/api/cycles');
  if (!Array.isArray(raw)) return [];

  return raw.map((c: unknown, i: number) => {
    const cycle = c as Record<string, unknown>;
    const phases = cycle.phases as Record<string, unknown> | undefined;
    const evalPhase = phases?.evaluate as Record<string, unknown> | undefined;

    return {
      id: String(cycle.id ?? `cycle-${i}`),
      cycleIndex: (cycle.cycleNumber as number) ?? i + 1,
      startedAt: String(cycle.startedAt ?? new Date().toISOString()),
      completedAt: cycle.completedAt ? String(cycle.completedAt) : null,
      phase: String(cycle.status ?? 'completed'),
      status: (cycle.status as EvolutionCycle['status']) ?? 'completed',
      score: evalPhase?.overallScore != null ? Number(evalPhase.overallScore) / 100 : null,
      summary: `Cycle ${(cycle.cycleNumber as number) ?? i + 1}`,
    };
  });
}

async function getSkills(): Promise<ProposedSkill[]> {
  const raw = await fetchJson<unknown[]>('/api/skills');
  if (!Array.isArray(raw)) return [];

  return raw.map((s: unknown) => {
    const skill = s as Record<string, unknown>;
    return {
      id: String(skill.id ?? ''),
      name: String(skill.name ?? ''),
      description: String(skill.description ?? ''),
      confidence: Math.round(((skill.confidence as number) ?? 0) * 100),
      targetFailure: String(skill.targetFailurePattern ?? ''),
      targetFailureId: String(skill.targetFailurePattern ?? ''),
      status: (skill.status as ProposedSkill['status']) ?? 'pending',
      createdAt: String(skill.createdAt ?? new Date().toISOString()),
      filePath: (skill.filePath as string) ?? null,
    };
  });
}

async function getExperiments(): Promise<Experiment[]> {
  const raw = await fetchJson<unknown[]>('/api/experiments');
  if (!Array.isArray(raw)) return [];

  return raw.map((e: unknown) => {
    const exp = e as Record<string, unknown>;
    const control = exp.controlResults as unknown[] | undefined;
    const treatment = exp.treatmentResults as unknown[] | undefined;

    const controlRate = control?.length
      ? control.filter((r: unknown) => (r as Record<string, unknown>).success).length / control.length * 100
      : 0;
    const treatmentRate = treatment?.length
      ? treatment.filter((r: unknown) => (r as Record<string, unknown>).success).length / treatment.length * 100
      : 0;
    const improvement = controlRate > 0 ? ((treatmentRate - controlRate) / controlRate) * 100 : 0;

    return {
      id: String(exp.id ?? ''),
      name: String(exp.name ?? exp.id ?? ''),
      type: 'A/B' as const,
      status: (exp.status as Experiment['status']) ?? 'running',
      startedAt: String(exp.startedAt ?? new Date().toISOString()),
      metrics: {
        control: Math.round(controlRate),
        variant: Math.round(treatmentRate),
        improvement: Math.round(improvement * 10) / 10,
        sampleSize: (control?.length ?? 0) + (treatment?.length ?? 0),
        significance: (exp.confidence as number) ?? 0,
      },
      proposedSkillId: (exp.treatmentSkillId as string) ?? null,
    };
  });
}

async function getFailurePatterns(): Promise<FailurePattern[]> {
  const raw = await fetchJson<unknown[]>('/api/failures');
  if (!Array.isArray(raw)) return [];

  return raw.map((p: unknown) => {
    const pat = p as Record<string, unknown>;
    return {
      id: String(pat.id ?? ''),
      toolName: String(pat.toolName ?? ''),
      errorType: String(pat.errorType ?? ''),
      message: String(pat.errorMessage ?? ''),
      frequency: (pat.frequency as number) ?? 0,
      severity: (pat.severity as FailurePattern['severity']) ?? 'low',
      firstSeen: String(pat.firstSeen ?? ''),
      lastSeen: String(pat.lastSeen ?? ''),
      occurrences: (pat.frequency as number) ?? 0,
    };
  });
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

async function getMetrics(): Promise<DashboardMetrics> {
  const [hub, cycles, skills, experiments, failures] = await Promise.all([
    getHubStatus(),
    getCycles(),
    getSkills(),
    getExperiments(),
    getFailurePatterns(),
  ]);

  const completedCycles = cycles.filter(c => c.status === 'completed' && c.score !== null);
  const overallScore = completedCycles.length > 0
    ? Math.round(completedCycles.reduce((s, c) => s + ((c.score ?? 0) * 100), 0) / completedCycles.length)
    : 0;

  return {
    totalCycles: hub.cycleCount,
    deployedSkills: skills.filter(s => s.status === 'deployed').length,
    activeExperiments: experiments.filter(e => e.status === 'running').length,
    failurePatterns: failures.length,
    overallScore,
    scoreHistory: buildScoreHistory(cycles),
    uptimeSeconds: hub.uptimeSeconds,
  };
}

async function getDashboardData(): Promise<DashboardData> {
  const [hub, metrics, failurePatterns, cycles, proposedSkills, experiments] =
    await Promise.all([
      getHubStatus(),
      getMetrics(),
      getFailurePatterns(),
      getCycles(),
      getSkills(),
      getExperiments(),
    ]);

  return { hub, metrics, failurePatterns, cycles, proposedSkills, experiments };
}

// ---------- Polling wrapper ----------

type Listener = (data: DashboardData) => void;

function createPollingClient() {
  let listeners: Listener[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const interval = POLL_INTERVAL_MS;

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
  getProposedSkills: getSkills,
  getExperiments,
  approveSkill: async (id: string): Promise<void> => {
    await fetch(`/api/approvals/${id}/approve`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  },
  rejectSkill: async (id: string): Promise<void> => {
    await fetch(`/api/approvals/${id}/reject`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  },
  triggerEvolve: async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/evolve', { method: 'POST', signal: AbortSignal.timeout(60000) });
      return res.ok;
    } catch {
      return false;
    }
  },
  polling: createPollingClient(),
};
