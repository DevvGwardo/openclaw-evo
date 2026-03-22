/**
 * OpenClaw Evo — Experiment Log (TSV)
 *
 * Append-only TSV log of every experiment outcome — kept, discarded, and crashed.
 * Inspired by Karpathy's autoresearch results.tsv pattern.
 *
 * File lives at ~/.openclaw/evo-memory/results.tsv and is human-readable,
 * grep-friendly, and easy to load into notebooks for analysis.
 *
 * Columns:
 *   timestamp | experiment_id | skill_name | status | control_rate | treatment_rate |
 *   improvement_pct | confidence | overall_score | description
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HEADER = [
  'timestamp',
  'experiment_id',
  'skill_name',
  'status',          // kept | discarded | crashed
  'control_rate',    // 0-1
  'treatment_rate',  // 0-1
  'improvement_pct',
  'confidence',      // 0-1
  'overall_score',   // 0-100
  'description',
].join('\t');

export interface ExperimentLogEntry {
  experimentId: string;
  skillName: string;
  status: 'kept' | 'discarded' | 'crashed';
  controlRate: number;
  treatmentRate: number;
  improvementPct: number;
  confidence: number;
  overallScore: number;
  description: string;
}

function resolveLogPath(): string {
  const home = process.env.HOME ?? '~';
  const memoryDir = (process.env.MEMORY_DIR ?? '~/.openclaw/evo-memory/').replace('~', home);
  return `${memoryDir}results.tsv`;
}

function ensureFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(path)) {
    appendFileSync(path, HEADER + '\n', 'utf-8');
  }
}

export const experimentLog = {
  /**
   * Append a single experiment result to the TSV log.
   */
  record(entry: ExperimentLogEntry): void {
    const logPath = resolveLogPath();
    ensureFile(logPath);

    const row = [
      new Date().toISOString(),
      entry.experimentId,
      entry.skillName,
      entry.status,
      entry.controlRate.toFixed(4),
      entry.treatmentRate.toFixed(4),
      entry.improvementPct.toFixed(2),
      entry.confidence.toFixed(4),
      entry.overallScore.toFixed(1),
      entry.description.replace(/\t/g, ' ').replace(/\n/g, ' '),
    ].join('\t');

    appendFileSync(logPath, row + '\n', 'utf-8');
  },

  /**
   * Read the full experiment log as parsed entries.
   * Returns newest-first.
   */
  readAll(): ExperimentLogEntry[] {
    const logPath = resolveLogPath();
    if (!existsSync(logPath)) return [];

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    if (lines.length <= 1) return []; // header only

    const entries: ExperimentLogEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 10) continue;
      entries.push({
        experimentId: cols[1],
        skillName: cols[2],
        status: cols[3] as 'kept' | 'discarded' | 'crashed',
        controlRate: parseFloat(cols[4]),
        treatmentRate: parseFloat(cols[5]),
        improvementPct: parseFloat(cols[6]),
        confidence: parseFloat(cols[7]),
        overallScore: parseFloat(cols[8]),
        description: cols[9],
      });
    }

    return entries.reverse();
  },

  /**
   * Return aggregate stats from the experiment log.
   */
  stats(): { total: number; kept: number; discarded: number; crashed: number; keepRate: number } {
    const entries = this.readAll();
    const kept = entries.filter((e) => e.status === 'kept').length;
    const discarded = entries.filter((e) => e.status === 'discarded').length;
    const crashed = entries.filter((e) => e.status === 'crashed').length;
    return {
      total: entries.length,
      kept,
      discarded,
      crashed,
      keepRate: entries.length > 0 ? kept / entries.length : 0,
    };
  },
};
