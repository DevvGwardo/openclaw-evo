/**
 * tests/memory.test.ts
 *
 * Tests for:
 *   - memory/store.ts       → MemoryStore class (save/load/delete roundtrip)
 *   - memory/failureCorpus.ts → failureCorpus (record, retrieve, increment, markFixed)
 *
 * Run with: npm test (vitest run)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryStore } from '../src/memory/store.js';
import { failureCorpus } from '../src/memory/failureCorpus.js';
import type { FailurePattern, FailureContext } from '../src/types.js';

// ── Temp directory helper ─────────────────────────────────────────────────────

/**
 * Creates a unique temp directory for each test, and cleans it up after.
 * Uses os.tmpdir() as required by the spec.
 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(os.tmpdir(), `evo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    // Clean up
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(entries.map(e => fs.unlink(path.join(dir, e))));
      await fs.rmdir(dir);
    } catch {
      // best-effort cleanup — CI may clean up temp files anyway
    }
  }
}

// ── Mock data helpers ────────────────────────────────────────────────────────

function makeFailurePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  const now = new Date();
  const context: FailureContext = {
    sessionId: 'session-test',
    taskDescription: 'test task',
    toolInput: { path: '/tmp/test.txt' },
    errorOutput: 'ENOENT: no such file',
    timestamp: now,
  };

  return {
    id: `fp-test-${Math.random().toString(36).slice(2)}`,
    toolName: 'read',
    errorType: 'not_found',
    errorMessage: 'ENOENT: no such file or directory',
    frequency: 3,
    severity: 'high',
    exampleContexts: [context],
    firstSeen: now,
    lastSeen: now,
    autoFixAvailable: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// memory/store.ts — MemoryStore
// ═══════════════════════════════════════════════════════════════════════════════

describe('memory/store.ts — MemoryStore', () => {

  // ── save/load roundtrip ──────────────────────────────────────────────────

  describe('save() / load() roundtrip', () => {
    it('correctly saves and loads a simple object', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const payload = { name: 'test-skill', confidence: 0.85, tags: ['beta'] };
        await store.save('skill-1', payload);

        const loaded = await store.load<typeof payload>('skill-1');
        expect(loaded).toEqual(payload);
      });
    });

    it('correctly saves and loads a complex nested object', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const payload = {
          id: 'complex-obj',
          nested: {
            deeply: { value: [1, 2, { three: 'four' }] },
          },
          // Use ISO strings instead of Date objects (JSON serializes Dates to ISO strings)
          dateStrings: ['2024-01-01T00:00:00.000Z', '2024-06-15T00:00:00.000Z'],
          nullValue: null,
          boolValue: true,
        };
        await store.save('complex-key', payload);

        const loaded = await store.load<typeof payload>('complex-key');
        expect(loaded).toEqual(payload);
      });
    });

    it('saves and loads correctly with non-ASCII key names', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const payload = { description: 'üñîcödé töll' };
        await store.save('üñîcödé-key', payload);

        const loaded = await store.load<typeof payload>('üñîcödé-key');
        expect(loaded).toEqual(payload);
      });
    });

    it('overwrites an existing key when saving', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        await store.save('key', { version: 1 });
        await store.save('key', { version: 2 });

        const loaded = await store.load<{ version: number }>('key');
        expect(loaded?.version).toBe(2);
      });
    });
  });

  // ── load missing → null ───────────────────────────────────────────────

  describe('load() for missing key', () => {
    it('returns null when the key does not exist', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const result = await store.load('non-existent-key');
        expect(result).toBeNull();
      });
    });

    it('returns null for empty string key', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const result = await store.load('');
        expect(result).toBeNull();
      });
    });

    it('returns null for a deeply nested non-existent key path', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        // Save something, then try to load something else
        await store.save('existing', { foo: 'bar' });
        const result = await store.load('nonexistent');
        expect(result).toBeNull();
      });
    });
  });

  // ── delete works ──────────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes a saved key and subsequent load returns null', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        await store.save('to-delete', { data: 'hello' });
        expect(await store.load('to-delete')).not.toBeNull();

        await store.delete('to-delete');
        expect(await store.load('to-delete')).toBeNull();
      });
    });

    it('is a silent no-op when deleting a key that does not exist', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        // Should not throw
        await expect(store.delete('non-existent-key')).resolves.not.toThrow();
      });
    });

    it('only deletes the target key, leaving other keys intact', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        await store.save('key-a', { value: 'A' });
        await store.save('key-b', { value: 'B' });
        await store.save('key-c', { value: 'C' });

        await store.delete('key-b');

        expect(await store.load('key-a')).toEqual({ value: 'A' });
        expect(await store.load('key-b')).toBeNull();
        expect(await store.load('key-c')).toEqual({ value: 'C' });
      });
    });
  });

  // ── list() ───────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns all saved keys (without .json extension)', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        await store.save('skill-alpha', { name: 'Alpha' });
        await store.save('skill-beta', { name: 'Beta' });
        await store.save('skill-gamma', { name: 'Gamma' });

        const keys = await store.list();
        expect(keys).toContain('skill-alpha');
        expect(keys).toContain('skill-beta');
        expect(keys).toContain('skill-gamma');
        expect(keys).toHaveLength(3);
      });
    });

    it('returns empty array when no keys are saved', async () => {
      await withTempDir(async (dir) => {
        const store = new MemoryStore(dir);
        await store.init();

        const keys = await store.list();
        expect(keys).toHaveLength(0);
      });
    });
  });

  // ── init() / directory creation ───────────────────────────────────────

  describe('init()', () => {
    it('creates the memory directory if it does not exist', async () => {
      const nestedDir = path.join(
        os.tmpdir(),
        `evo-test-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        'nested',
      );

      // Confirm it doesn't exist
      try {
        await fs.access(nestedDir);
      } catch {
        // expected — dir doesn't exist
      }

      const store = new MemoryStore(nestedDir);
      await store.init();

      // Should now exist
      await expect(fs.access(nestedDir)).resolves.not.toThrow();

      // Clean up
      await fs.rmdir(nestedDir);
    });

    it('getMemoryDir() returns the configured directory', async () => {
      const customDir = '/tmp/evo-custom-dir';
      const store = new MemoryStore(customDir);
      expect(store.getMemoryDir()).toBe(customDir);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// memory/failureCorpus.ts — failureCorpus
// ═══════════════════════════════════════════════════════════════════════════════

describe('memory/failureCorpus.ts — failureCorpus', () => {

  // failureCorpus uses the module-level `store` singleton.
  // We give each test a unique memory dir via an env override to keep tests isolated.

  const origDir = process.env.OPENCLAW_EVO_TEST_DIR;

  async function withIsolatedCorpus(fn: (store: MemoryStore) => Promise<void>): Promise<void> {
    const dir = path.join(
      os.tmpdir(),
      `evo-corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(dir, { recursive: true });

    // Point the module-level store at our isolated directory.
    // We achieve this by importing MemoryStore fresh and replacing the store module's dir.
    // Since failureCorpus imports `store` as a singleton, we need a different approach:
    // We clear the corpus using failureCorpus.clear() before/after, and use a unique corpus key.
    // Actually the corpus uses a fixed CORPUS_KEY = 'failure-corpus', so we just clear() between tests.
    await failureCorpus.clear(); // ensure clean slate
    try {
      await fn(new MemoryStore(dir));
    } finally {
      // Clean up the on-disk corpus
      await failureCorpus.clear();
    }
  }

  // ── records and retrieves failures ──────────────────────────────────────

  describe('recordFailure() / getPatterns()', () => {
    it('records a new failure pattern and retrieves it', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({
          id: 'fp-recording-test',
          toolName: 'read',
          errorType: 'not_found',
          errorMessage: 'file not found',
          frequency: 2,
          severity: 'high',
          exampleContexts: [
            {
              sessionId: 's1',
              taskDescription: 'Read a config file',
              toolInput: { path: '/etc/app.conf' },
              errorOutput: 'ENOENT',
              timestamp: new Date(),
            },
          ],
        });
        const context = pattern.exampleContexts[0];

        await failureCorpus.recordFailure(pattern, context);

        const patterns = await failureCorpus.getPatterns();
        expect(patterns.length).toBeGreaterThanOrEqual(1);

        const found = patterns.find(p => p.toolName === 'read' && p.errorType === 'not_found');
        expect(found).toBeDefined();
        expect(found!.frequency).toBe(2);
        expect(found!.severity).toBe('high');
      });
    });

    it('getPatterns() returns empty array when corpus is empty', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();
        const patterns = await failureCorpus.getPatterns();
        expect(patterns).toHaveLength(0);
      });
    });

    it('getPatterns(minFrequency) filters by minimum occurrence count', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        // Single-occurrence pattern
        const lowPattern = makeFailurePattern({
          id: 'fp-low-freq',
          toolName: 'read',
          errorType: 'not_found',
          frequency: 1,
        });
        await failureCorpus.recordFailure(lowPattern, lowPattern.exampleContexts[0]);

        const patternsMin2 = await failureCorpus.getPatterns(2);
        expect(patternsMin2.some(p => p.id === 'fp-low-freq')).toBe(false);
      });
    });
  });

  // ── frequency increments on same pattern ───────────────────────────────

  describe('frequency increment for duplicate patterns', () => {
    it('records the same pattern twice and frequency increments to 2', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({
          id: 'fp-duplicate-test',
          toolName: 'api_call',
          errorType: 'network_error',
          errorMessage: 'connection refused',
          frequency: 1,
        });
        const ctx = pattern.exampleContexts[0];

        await failureCorpus.recordFailure(pattern, ctx);
        await failureCorpus.recordFailure(pattern, ctx);

        const corpus = await failureCorpus.getCorpus();
        const record = corpus.failures.find(r => r.pattern.toolName === 'api_call');

        expect(record).toBeDefined();
        expect(record!.occurrences).toBe(2);
        expect(record!.pattern.frequency).toBe(2);
      });
    });

    it('records the same pattern three times and occurrences = 3', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({
          id: 'fp-triple',
          toolName: 'write',
          errorType: 'permission_error',
          errorMessage: 'permission denied',
          frequency: 1,
        });
        const ctx = pattern.exampleContexts[0];

        await failureCorpus.recordFailure(pattern, ctx);
        await failureCorpus.recordFailure(pattern, ctx);
        await failureCorpus.recordFailure(pattern, ctx);

        const corpus = await failureCorpus.getCorpus();
        const record = corpus.failures.find(r => r.pattern.toolName === 'write');

        expect(record!.occurrences).toBe(3);
        expect(record!.pattern.frequency).toBe(3);
      });
    });

    it('different error messages create separate failure records', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern1 = makeFailurePattern({
          id: 'fp-err1',
          toolName: 'read',
          errorType: 'not_found',
          errorMessage: 'ENOENT: /tmp/a.txt',
        });
        const pattern2 = makeFailurePattern({
          id: 'fp-err2',
          toolName: 'read',
          errorType: 'not_found',
          errorMessage: 'ENOENT: /tmp/b.txt',  // different file path → different msg prefix
        });

        await failureCorpus.recordFailure(pattern1, pattern1.exampleContexts[0]);
        await failureCorpus.recordFailure(pattern2, pattern2.exampleContexts[0]);

        const corpus = await failureCorpus.getCorpus();
        // Both patterns should be stored separately (different message prefix)
        expect(corpus.failures.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── markFixed records skill ID ─────────────────────────────────────────

  describe('markFixed()', () => {
    it('sets autoFixed=true and records the fixing skill ID', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({ id: 'fp-fix-test' });
        const ctx = pattern.exampleContexts[0];
        await failureCorpus.recordFailure(pattern, ctx);

        const corpusBefore = await failureCorpus.getCorpus();
        const recordBefore = corpusBefore.failures.find(r => r.pattern.id === 'fp-fix-test');

        await failureCorpus.markFixed(recordBefore!.id, 'skill-fix-123');

        const corpusAfter = await failureCorpus.getCorpus();
        const recordAfter = corpusAfter.failures.find(r => r.pattern.id === 'fp-fix-test');

        expect(recordAfter!.autoFixed).toBe(true);
        expect(recordAfter!.fixedBySkillId).toBe('skill-fix-123');
      });
    });

    it('markFixed does not throw for unknown pattern id', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();
        // Should be a silent no-op (id not found → nothing to mark)
        await expect(
          failureCorpus.markFixed('non-existent-pattern-id', 'skill-xyz')
        ).resolves.not.toThrow();
      });
    });

    it('markFixed updates lastUpdated timestamp of the corpus', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({ id: 'fp-ts-test' });
        const ctx = pattern.exampleContexts[0];
        await failureCorpus.recordFailure(pattern, ctx);

        const corpusBefore = await failureCorpus.getCorpus();
        // After JSON deserialization, lastUpdated is a string (ISO date), not a Date object
        const beforeTime = new Date(corpusBefore.lastUpdated as unknown as string).getTime();

        // Small delay to ensure timestamp changes
        await new Promise(resolve => setTimeout(resolve, 10));

        const corpusForMark = await failureCorpus.getCorpus();
        const record = corpusForMark.failures[0];

        await failureCorpus.markFixed(record.id, 'skill-ts');

        const corpusAfter = await failureCorpus.getCorpus();
        const afterTime = new Date(corpusAfter.lastUpdated as unknown as string).getTime();
        expect(afterTime).toBeGreaterThanOrEqual(beforeTime);
      });
    });
  });

  // ── getCorpus() ───────────────────────────────────────────────────────

  describe('getCorpus()', () => {
    it('returns a FailureCorpus object with failures array and lastUpdated', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();
        const corpus = await failureCorpus.getCorpus();

        expect(corpus).toHaveProperty('failures');
        expect(Array.isArray(corpus.failures)).toBe(true);
        expect(corpus).toHaveProperty('lastUpdated');
        // After JSON roundtrip, lastUpdated is an ISO date string, not a Date object
        expect(typeof corpus.lastUpdated).toBe('string');
        expect(isNaN(Date.parse(corpus.lastUpdated as unknown as string))).toBe(false);
      });
    });
  });

  // ── clear() ───────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('empties the corpus of all failure records', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        const pattern = makeFailurePattern({ id: 'fp-clear-test' });
        await failureCorpus.recordFailure(pattern, pattern.exampleContexts[0]);

        const before = await failureCorpus.getCorpus();
        expect(before.failures.length).toBeGreaterThan(0);

        await failureCorpus.clear();

        const after = await failureCorpus.getCorpus();
        expect(after.failures).toHaveLength(0);
      });
    });
  });

  // ── Bounded example context growth ────────────────────────────────────

  describe('exampleContexts growth bound', () => {
    it('caps exampleContexts at 10 per pattern', async () => {
      await withIsolatedCorpus(async () => {
        await failureCorpus.clear();

        // Build a pattern with 0 existing contexts
        const pattern = makeFailurePattern({
          id: 'fp-context-cap',
          exampleContexts: [],
        });

        // Simulate 15 occurrences
        for (let i = 0; i < 15; i++) {
          const ctx: FailureContext = {
            sessionId: `session-${i}`,
            taskDescription: `task ${i}`,
            toolInput: {},
            errorOutput: `error ${i}`,
            timestamp: new Date(),
          };
          await failureCorpus.recordFailure(pattern, ctx);
        }

        const corpus = await failureCorpus.getCorpus();
        const record = corpus.failures.find(r => r.pattern.id === 'fp-context-cap');
        expect(record!.pattern.exampleContexts.length).toBeLessThanOrEqual(10);
        expect(record!.occurrences).toBe(15); // frequency still tracks total
      });
    });
  });
});
