/**
 * OpenClaw Evo — Improvement Log
 * Append-only log of evolution events: skill creations, experiment outcomes,
 * and auto-fixes. Auto-saves after every entry.
 */

import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import type { ImprovementLog, ImprovementEntry } from '../types.js';

const LOG_KEY = 'improvement-log';

function emptyLog(): ImprovementLog {
  return { entries: [] };
}

export const improvementLog = {
  /**
   * Append a new entry with an auto-generated UUID and ISO timestamp.
   * `entry.type` must be one of the valid ImprovementEntry type strings.
   */
  async record(entry: Omit<ImprovementEntry, 'id'>): Promise<string> {
    const log = (await store.load<ImprovementLog>(LOG_KEY)) ?? emptyLog();

    const full: ImprovementEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date(),
    };

    log.entries.push(full);
    await store.save(LOG_KEY, log);

    return full.id;
  },

  /**
   * Return the most recent `limit` entries (newest first).
   * Defaults to all entries if no limit is given.
   */
  async getHistory(limit?: number): Promise<ImprovementEntry[]> {
    const log = (await store.load<ImprovementLog>(LOG_KEY)) ?? emptyLog();
    const sorted = [...log.entries].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return limit != null ? sorted.slice(0, limit) : sorted;
  },

  /**
   * Return the most recent entries filtered by `type`.
   */
  async getRecent(type: string, limit = 10): Promise<ImprovementEntry[]> {
    const log = (await store.load<ImprovementLog>(LOG_KEY)) ?? emptyLog();
    return [...log.entries]
      .filter((e) => e.type === type)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  },

  /**
   * Aggregate statistics across the full improvement log.
   */
  async getStats(): Promise<{
    totalImprovements: number;
    skillsDeployed: number;
    experimentsWon: number;
    experimentsLost: number;
  }> {
    const log = (await store.load<ImprovementLog>(LOG_KEY)) ?? emptyLog();

    const entries = log.entries;
    const totalImprovements = entries.length;
    const skillsDeployed = entries.filter(
      (e) => e.type === 'skill_created' || e.type === 'skill_improved'
    ).length;
    const experimentsWon = entries.filter((e) => e.type === 'experiment_won').length;
    const experimentsLost = entries.filter((e) => e.type === 'experiment_lost').length;

    return { totalImprovements, skillsDeployed, experimentsWon, experimentsLost };
  },
};
