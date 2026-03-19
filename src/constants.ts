import type { EvoConfig } from './types.js';

// ── Adaptive scoring weights ─────────────────────────────────────────────────

export const WEIGHT_CONFIG_KEY = 'evaluation-weights';

export const DEFAULT_WEIGHTS = {
  accuracy:    0.25,
  efficiency:  0.20,
  speed:       0.20,
  reliability: 0.25,
  coverage:    0.10,
} as const;

// ── Main config ───────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: EvoConfig = {
  CYCLE_INTERVAL_MS: 5 * 60 * 1000,
  FAILURE_THRESHOLD: 3,
  MAX_SKILLS_PER_CYCLE: 3,
  EXPERIMENT_SESSIONS: 5,
  MIN_IMPROVEMENT_PCT: 10,
  STATISTICAL_CONFIDENCE: 0.95,
  OPENCLAW_GATEWAY_URL: 'http://localhost:18789',
  OPENCLAW_POLL_INTERVAL_MS: 10000,
  SKILL_OUTPUT_DIR: '~/.openclaw/skills/',
  SKILL_TEMPLATE_DIR: './templates/',
  MEMORY_DIR: '~/.openclaw/evo-memory/',
  DASHBOARD_PORT: 5174,
};
