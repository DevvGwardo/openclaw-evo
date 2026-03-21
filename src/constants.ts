import type { EvoConfig } from './types.js';

// ── Environment helpers ───────────────────────────────────────────────────────

const env = (key: string, fallback: string) => process.env[key] ?? fallback;
const envInt = (key: string, fallback: number) => parseInt(process.env[key] ?? String(fallback));
const envFloat = (key: string, fallback: number) => parseFloat(process.env[key] ?? String(fallback));

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
  CYCLE_INTERVAL_MS:        envInt('CYCLE_INTERVAL_MS',        5 * 60 * 1000),
  FAILURE_THRESHOLD:        envInt('FAILURE_THRESHOLD',         1),
  MAX_SKILLS_PER_CYCLE:     envInt('MAX_SKILLS_PER_CYCLE',     3),
  EXPERIMENT_SESSIONS:      envInt('EXPERIMENT_SESSIONS',      5),
  MIN_IMPROVEMENT_PCT:       envInt('MIN_IMPROVEMENT_PCT',     10),
  STATISTICAL_CONFIDENCE:   envFloat('STATISTICAL_CONFIDENCE', 0.80),
  OPENCLAW_GATEWAY_URL:     env('OPENCLAW_GATEWAY_URL',       'http://localhost:18789'),
  OPENCLAW_POLL_INTERVAL_MS: envInt('OPENCLAW_POLL_INTERVAL_MS', 10000),
  SKILL_OUTPUT_DIR:         env('SKILL_OUTPUT_DIR',            '~/.openclaw/skills/'),
  SKILL_TEMPLATE_DIR:       env('SKILL_TEMPLATE_DIR',          './templates/'),
  MEMORY_DIR:               env('MEMORY_DIR',                  '~/.openclaw/evo-memory/'),
  DASHBOARD_PORT:           envInt('DASHBOARD_PORT',           5174),
};
