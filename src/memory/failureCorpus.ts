/**
 * OpenClaw Evo — Failure Corpus
 * Tracks recurring failure patterns across sessions, with frequency counting
 * and the ability to mark patterns as fixed once a skill resolves them.
 * Auto-saves to disk after every write.
 */

import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import type { FailurePattern, FailureContext, FailureCorpus, FailureRecord } from '../types.js';

const CORPUS_KEY = 'failure-corpus';

function emptyCorpus(): FailureCorpus {
  return { failures: [], lastUpdated: new Date() };
}

/** Normalize a string key for pattern de-duplication. */
function patternKey(pattern: Pick<FailurePattern, 'toolName' | 'errorType' | 'errorMessage'>): string {
  return [pattern.toolName, pattern.errorType, pattern.errorMessage]
    .join('|')
    .toLowerCase();
}

/** Find an existing record matching the given pattern, or null. */
function findRecord(
  corpus: FailureCorpus,
  pattern: Pick<FailurePattern, 'toolName' | 'errorType' | 'errorMessage'>
): FailureRecord | null {
  const key = patternKey(pattern);
  return (
    corpus.failures.find((r) => patternKey(r.pattern) === key) ?? null
  );
}

export const failureCorpus = {
  /**
   * Add a new failure occurrence to the corpus.
   * If an identical pattern already exists, increments its frequency and
   * appends the new context to `exampleContexts`. Otherwise creates a new record.
   */
  async recordFailure(pattern: FailurePattern, context: FailureContext): Promise<void> {
    let corpus = (await store.load<FailureCorpus>(CORPUS_KEY)) ?? emptyCorpus();

    const existing = findRecord(corpus, pattern);

    if (existing) {
      // Use the detected frequency if higher than a simple +1 increment
      existing.occurrences = Math.max(existing.occurrences + 1, pattern.frequency ?? 1);
      existing.lastRecorded = new Date();
      existing.pattern.frequency = existing.occurrences;
      existing.pattern.lastSeen = new Date();
      // Keep at most 10 example contexts per pattern to bound growth
      if (existing.pattern.exampleContexts.length < 10) {
        existing.pattern.exampleContexts.push(context);
      }
    } else {
      const newRecord: FailureRecord = {
        id: randomUUID(),
        pattern: { ...pattern },
        occurrences: pattern.frequency ?? 1,
        lastRecorded: new Date(),
        autoFixed: false,
      };
      corpus.failures.push(newRecord);
    }

    corpus.lastUpdated = new Date();
    await store.save(CORPUS_KEY, corpus);
  },

  /**
   * Return all failure records, optionally filtered by minimum occurrence frequency.
   */
  async getPatterns(minFrequency = 0): Promise<FailurePattern[]> {
    const corpus = (await store.load<FailureCorpus>(CORPUS_KEY)) ?? emptyCorpus();
    return corpus.failures
      .filter((r) => r.occurrences >= minFrequency)
      .map((r) => r.pattern);
  },

  /** Return the full raw corpus. */
  async getCorpus(): Promise<FailureCorpus> {
    return (await store.load<FailureCorpus>(CORPUS_KEY)) ?? emptyCorpus();
  },

  /** Wipe the entire corpus. */
  async clear(): Promise<void> {
    await store.save(CORPUS_KEY, emptyCorpus());
  },

  /**
   * Mark a failure pattern as resolved by a skill.
   * Sets `autoFixed: true` and records the fixing skill's ID.
   */
  async markFixed(patternId: string, skillId: string): Promise<void> {
    const corpus = (await store.load<FailureCorpus>(CORPUS_KEY)) ?? emptyCorpus();
    const record = corpus.failures.find((r) => r.id === patternId);
    if (record) {
      record.autoFixed = true;
      record.fixedBySkillId = skillId;
      corpus.lastUpdated = new Date();
      await store.save(CORPUS_KEY, corpus);
    }
  },
};
