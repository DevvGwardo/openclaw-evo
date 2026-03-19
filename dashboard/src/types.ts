// Dashboard-specific types

export interface HubStatus {
  running: boolean;
  phase: 'idle' | 'observing' | 'analyzing' | 'proposing' | 'deploying' | 'testing' | 'error';
  cycleCount: number;
  lastCycleAt: string | null;
  uptimeSeconds: number;
}

export interface FailurePattern {
  id: string;
  toolName: string;
  errorType: string;
  message: string;
  frequency: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
}

export interface ScorePoint {
  timestamp: string;
  cycleIndex: number;
  score: number;
  phase: string;
}

export interface EvolutionCycle {
  id: string;
  cycleIndex: number;
  startedAt: string;
  completedAt: string | null;
  phase: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  score: number | null;
  summary: string;
}

export interface ProposedSkill {
  id: string;
  name: string;
  description: string;
  confidence: number;
  targetFailure: string;
  targetFailureId: string;
  status: 'pending' | 'approved' | 'rejected' | 'deployed';
  createdAt: string;
  filePath: string | null;
}

export interface Experiment {
  id: string;
  name: string;
  type: 'A/B' | 'shadow' | 'canary';
  status: 'running' | 'completed' | 'paused' | 'cancelled';
  startedAt: string;
  metrics: {
    control: number;
    variant: number;
    improvement: number;
    sampleSize: number;
    significance: number;
  };
  proposedSkillId: string | null;
}

export interface DashboardMetrics {
  totalCycles: number;
  deployedSkills: number;
  activeExperiments: number;
  failurePatterns: number;
  overallScore: number;
  scoreHistory: ScorePoint[];
  uptimeSeconds: number;
}

export interface DashboardData {
  hub: HubStatus;
  metrics: DashboardMetrics;
  failurePatterns: FailurePattern[];
  cycles: EvolutionCycle[];
  proposedSkills: ProposedSkill[];
  experiments: Experiment[];
}
