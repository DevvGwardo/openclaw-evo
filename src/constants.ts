import type { EvoConfig } from './types.js';

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
