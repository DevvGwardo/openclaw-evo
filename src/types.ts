/**
 * OpenClaw Evo — Shared TypeScript Types
 */

// ── Performance & Evaluation ────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startTime: number;
  endTime?: number;
  success: boolean;
}

export interface SessionMetrics {
  sessionId: string;
  toolCalls: ToolCall[];
  startTime: number;
  endTime?: number;
  success: boolean;
  errorCount: number;
  totalToolCalls: number;
  avgLatencyMs: number;
  taskType?: string;
}

export interface PerformanceScore {
  accuracy: number;       // 0-100
  efficiency: number;    // 0-100 (tool calls vs. optimal)
  speed: number;         // 0-100 (time vs. baseline)
  reliability: number;    // 0-100 (error rate)
  coverage: number;      // 0-100 (% of task types handled)
  overall: number;        // weighted average
}

export interface FailurePattern {
  id: string;
  toolName: string;
  errorType: string;
  errorMessage: string;
  frequency: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  exampleContexts: FailureContext[];
  firstSeen: Date;
  lastSeen: Date;
  autoFixAvailable: boolean;
  suggestedFix?: string;
}

export interface FailureContext {
  sessionId: string;
  taskDescription: string;
  toolInput: Record<string, unknown>;
  errorOutput: string;
  timestamp: Date;
}

export interface EvaluationReport {
  timestamp: Date;
  periodStart: Date;
  periodEnd: Date;
  totalSessions: number;
  successfulSessions: number;
  overallScore: PerformanceScore;
  toolScores: Record<string, PerformanceScore>;
  topFailurePatterns: FailurePattern[];
  recommendations: string[];
}

// ── Tool Building ─────────────────────────────────────────────────────────────

export interface GeneratedSkill {
  id: string;
  name: string;
  description: string;
  triggerPhrases: string[];
  implementation: string;
  examples: SkillExample[];
  confidence: number;       // 0-1
  targetFailurePattern?: string;
  generatedAt: Date;
  status: 'proposed' | 'testing' | 'deployed' | 'rejected' | 'superseded';
}

export interface SkillExample {
  input: string;
  expectedOutput: string;
  explanation: string;
}

export interface SkillTemplate {
  name: string;
  description: string;
  triggerPhrases: string[];
  implementationTemplate: string;
  exampleTemplate: SkillExample;
}

// ── Experiments ───────────────────────────────────────────────────────────────

export interface Experiment {
  id: string;
  name: string;
  description: string;
  controlSkillId?: string;
  treatmentSkillId: string;
  taskSet: ExperimentTask[];
  status: 'pending' | 'running' | 'completed' | 'promoted' | 'rejected';
  controlResults: ExperimentResult[];
  treatmentResults: ExperimentResult[];
  statisticalSignificance: number;  // 0-1
  improvementPct: number;
  startedAt: Date;
  completedAt?: Date;
  promotedAt?: Date;
}

export interface ExperimentTask {
  id: string;
  description: string;
  taskType: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface ExperimentResult {
  taskId: string;
  success: boolean;
  toolCalls: number;
  durationMs: number;
  errorMessage?: string;
  score: number;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface FailureCorpus {
  failures: FailureRecord[];
  lastUpdated: Date;
}

export interface FailureRecord {
  id: string;
  pattern: FailurePattern;
  occurrences: number;
  lastRecorded: Date;
  autoFixed: boolean;
  fixedBySkillId?: string;
}

export interface ImprovementLog {
  entries: ImprovementEntry[];
}

export interface ImprovementEntry {
  id: string;
  timestamp: Date;
  type: 'skill_created' | 'skill_improved' | 'experiment_won' | 'experiment_lost' | 'auto_fix';
  description: string;
  skillId?: string;
  experimentId?: string;
  metrics?: {
    beforeScore?: number;
    afterScore?: number;
    improvementPct?: number;
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

export interface HarnessEvent {
  type: 'session_start' | 'session_end' | 'tool_call' | 'tool_result' | 'error' | 'heartbeat';
  sessionId: string;
  timestamp: Date;
  data: unknown;
}

export interface ToolLifecycle {
  toolId: string;
  toolName: string;
  sessionId: string;
  startTime: number;
  endTime?: number;
  success: boolean;
  error?: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface SessionLifecycle {
  sessionId: string;
  sessionKey: string;
  startTime: Date;
  endTime?: Date;
  toolLifecycles: ToolLifecycle[];
  parentSessionId?: string;
  isSubagent: boolean;
  taskDescription?: string;
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export interface HubState {
  cycleNumber: number;
  completedCycles: EvolutionCycle[];
  proposedSkills: GeneratedSkill[];
  activeExperiments: Experiment[];
  lastCheckpoint: Date;
}

export interface EvolutionCycle {
  id: string;
  cycleNumber: number;
  startedAt: Date;
  phases: {
    monitor: { durationMs: number; eventsProcessed: number };
    evaluate: { durationMs: number; patternsFound: number };
    build: { durationMs: number; skillsProposed: number };
    experiment: { durationMs: number; experimentsRun: number };
    integrate: { durationMs: number; improvementsDeployed: number };
  };
  status: 'running' | 'completed' | 'failed';
  completedAt?: Date;
}

// ── Promotion ────────────────────────────────────────────────────────────────

export interface PromotionDecision {
  promoted: boolean;
  reason: string;
  experimentsValidated: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface EvoConfig {
  // Cycle scheduling
  CYCLE_INTERVAL_MS: number;       // How often to run evolution cycles
  FAILURE_THRESHOLD: number;       // Min failures before generating a fix
  MAX_SKILLS_PER_CYCLE: number;    // Max new skills per cycle

  // Experiment settings
  EXPERIMENT_SESSIONS: number;     // Sessions per experiment arm
  MIN_IMPROVEMENT_PCT: number;     // Min % improvement to promote
  STATISTICAL_CONFIDENCE: number;  // Confidence threshold (0-1)

  // OpenClaw integration
  OPENCLAW_GATEWAY_URL: string;
  OPENCLAW_POLL_INTERVAL_MS: number;

  // Tool builder
  SKILL_OUTPUT_DIR: string;
  SKILL_TEMPLATE_DIR: string;

  // Memory
  MEMORY_DIR: string;

  // Dashboard
  DASHBOARD_PORT: number;
}

export interface HubStatus {
  running: boolean;
  currentCycle?: EvolutionCycle;
  totalCyclesRun: number;
  lastCycleAt?: Date;
  activeExperiments: number;
  deployedSkills: number;
  knownFailurePatterns: number;
  memorySize: number;  // bytes
}
