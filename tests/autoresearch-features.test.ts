/**
 * tests/autoresearch-features.test.ts
 *
 * Tests for the three autoresearch-inspired features:
 *   - experiment/experimentLog.ts  → append-only TSV log
 *   - experiment/frontier.ts       → progress frontier tracker
 *   - experiment/gitTracker.ts     → git-based experiment isolation
 *
 * Run with: npm test (vitest run)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execSync } from 'node:child_process';

import { experimentLog, type ExperimentLogEntry } from '../src/experiment/experimentLog.js';
import { frontier } from '../src/experiment/frontier.js';
import { gitTracker } from '../src/experiment/gitTracker.js';
import type { GeneratedSkill, Experiment } from '../src/types.js';

// ── Temp directory helper ───────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `evo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cleanDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ── Mock data helpers ───────────────────────────────────────────────────────

function makeLogEntry(overrides: Partial<ExperimentLogEntry> = {}): ExperimentLogEntry {
  return {
    experimentId: `exp-${Math.random().toString(36).slice(2)}`,
    skillName: 'Read — Not Found Skill',
    status: 'kept',
    controlRate: 0.5,
    treatmentRate: 0.85,
    improvementPct: 70,
    confidence: 0.97,
    overallScore: 82.5,
    description: 'Promoted: Read — Not Found Skill targeting fp-read-not-found',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<GeneratedSkill> = {}): GeneratedSkill {
  return {
    id: `skill-${Math.random().toString(36).slice(2)}`,
    name: 'Test Skill',
    description: 'A test skill',
    triggerPhrases: ['test'],
    implementation: '# Test',
    examples: [{ input: 'test', expectedOutput: 'ok', explanation: 'test' }],
    confidence: 0.8,
    generatedAt: new Date(),
    status: 'proposed',
    ...overrides,
  };
}

function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: `exp-${Math.random().toString(36).slice(2)}`,
    name: 'A/B: Test Skill',
    description: 'Test experiment',
    treatmentSkillId: 'skill-1',
    taskSet: [],
    status: 'completed',
    controlResults: [],
    treatmentResults: [],
    statisticalSignificance: 0,
    improvementPct: 0,
    startedAt: new Date(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// experiment/experimentLog.ts — TSV experiment log
// ═══════════════════════════════════════════════════════════════════════════════

describe('experiment/experimentLog.ts — TSV experiment log', () => {
  let tempDir: string;
  let origMemoryDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir();
    origMemoryDir = process.env.MEMORY_DIR;
    process.env.MEMORY_DIR = tempDir + '/';
  });

  afterEach(async () => {
    if (origMemoryDir !== undefined) {
      process.env.MEMORY_DIR = origMemoryDir;
    } else {
      delete process.env.MEMORY_DIR;
    }
    await cleanDir(tempDir);
  });

  it('creates results.tsv with header on first record', () => {
    experimentLog.record(makeLogEntry());

    const tsvPath = path.join(tempDir, 'results.tsv');
    expect(fs.existsSync(tsvPath)).toBe(true);

    const content = fs.readFileSync(tsvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines[0]).toContain('timestamp');
    expect(lines[0]).toContain('experiment_id');
    expect(lines[0]).toContain('status');
    expect(lines.length).toBe(2); // header + 1 entry
  });

  it('appends multiple entries to the same file', () => {
    experimentLog.record(makeLogEntry({ status: 'kept' }));
    experimentLog.record(makeLogEntry({ status: 'discarded' }));
    experimentLog.record(makeLogEntry({ status: 'crashed' }));

    const tsvPath = path.join(tempDir, 'results.tsv');
    const lines = fs.readFileSync(tsvPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(4); // header + 3 entries
  });

  it('readAll() returns entries in newest-first order', () => {
    experimentLog.record(makeLogEntry({ experimentId: 'first', status: 'kept' }));
    experimentLog.record(makeLogEntry({ experimentId: 'second', status: 'discarded' }));
    experimentLog.record(makeLogEntry({ experimentId: 'third', status: 'crashed' }));

    const entries = experimentLog.readAll();
    expect(entries.length).toBe(3);
    expect(entries[0].experimentId).toBe('third');
    expect(entries[2].experimentId).toBe('first');
  });

  it('readAll() returns empty array when no log exists', () => {
    // Don't create the file
    const freshDir = makeTempDir();
    process.env.MEMORY_DIR = freshDir + '/';

    const entries = experimentLog.readAll();
    expect(entries).toEqual([]);

    void cleanDir(freshDir);
  });

  it('records correct TSV column values', () => {
    const entry = makeLogEntry({
      experimentId: 'exp-precise',
      skillName: 'Bash — Timeout Skill',
      status: 'kept',
      controlRate: 0.25,
      treatmentRate: 0.75,
      improvementPct: 200,
      confidence: 0.9545,
      overallScore: 91.3,
      description: 'Promoted',
    });

    experimentLog.record(entry);

    const parsed = experimentLog.readAll();
    expect(parsed.length).toBe(1);

    const row = parsed[0];
    expect(row.experimentId).toBe('exp-precise');
    expect(row.skillName).toBe('Bash — Timeout Skill');
    expect(row.status).toBe('kept');
    expect(row.controlRate).toBeCloseTo(0.25, 3);
    expect(row.treatmentRate).toBeCloseTo(0.75, 3);
    expect(row.improvementPct).toBeCloseTo(200, 1);
    expect(row.confidence).toBeCloseTo(0.9545, 3);
    expect(row.overallScore).toBeCloseTo(91.3, 0);
  });

  it('sanitizes tabs and newlines in description', () => {
    experimentLog.record(makeLogEntry({
      description: 'Has\ttabs\tand\nnewlines',
    }));

    const tsvPath = path.join(tempDir, 'results.tsv');
    const content = fs.readFileSync(tsvPath, 'utf-8');
    const dataLine = content.trim().split('\n')[1];

    // Tabs should be replaced with spaces, newlines too
    expect(dataLine.split('\t').length).toBe(10); // exactly 10 columns
  });

  describe('stats()', () => {
    it('returns correct aggregate counts', () => {
      experimentLog.record(makeLogEntry({ status: 'kept' }));
      experimentLog.record(makeLogEntry({ status: 'kept' }));
      experimentLog.record(makeLogEntry({ status: 'discarded' }));
      experimentLog.record(makeLogEntry({ status: 'crashed' }));

      const stats = experimentLog.stats();
      expect(stats.total).toBe(4);
      expect(stats.kept).toBe(2);
      expect(stats.discarded).toBe(1);
      expect(stats.crashed).toBe(1);
      expect(stats.keepRate).toBeCloseTo(0.5, 2);
    });

    it('returns zero stats when log is empty', () => {
      const stats = experimentLog.stats();
      expect(stats.total).toBe(0);
      expect(stats.kept).toBe(0);
      expect(stats.keepRate).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// experiment/frontier.ts — progress frontier
// ═══════════════════════════════════════════════════════════════════════════════

describe('experiment/frontier.ts — progress frontier', () => {
  // frontier uses the module-level memory store singleton.
  // We mock store.save/load to isolate tests.

  let mockData: { points: unknown[] } | null = null;

  beforeEach(async () => {
    mockData = null;
    // Mock the store used by frontier
    const { store } = await import('../src/memory/store.js');
    vi.spyOn(store, 'save').mockImplementation(async (_key: string, data: unknown) => {
      mockData = data as { points: unknown[] };
    });
    vi.spyOn(store, 'load').mockImplementation(async () => {
      return mockData;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a frontier point and computes bestScore', async () => {
    const point = await frontier.record({
      cycle: 1,
      score: 75.5,
      timestamp: new Date().toISOString(),
      skillsDeployed: 1,
      experimentsRun: 3,
    });

    expect(point.cycle).toBe(1);
    expect(point.score).toBe(75.5);
    expect(point.bestScore).toBe(75.5); // first point, best = current
  });

  it('bestScore is monotonically non-decreasing', async () => {
    await frontier.record({ cycle: 1, score: 60, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    await frontier.record({ cycle: 2, score: 80, timestamp: '', skillsDeployed: 1, experimentsRun: 2 });
    const p3 = await frontier.record({ cycle: 3, score: 70, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });

    // Score dropped but bestScore should stay at 80
    expect(p3.score).toBe(70);
    expect(p3.bestScore).toBe(80);
  });

  it('bestScore advances when a new high is set', async () => {
    await frontier.record({ cycle: 1, score: 50, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    await frontier.record({ cycle: 2, score: 70, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    const p3 = await frontier.record({ cycle: 3, score: 90, timestamp: '', skillsDeployed: 1, experimentsRun: 2 });

    expect(p3.bestScore).toBe(90);
  });

  it('get() returns summary with improvementFromBaseline', async () => {
    await frontier.record({ cycle: 1, score: 50, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    await frontier.record({ cycle: 2, score: 75, timestamp: '', skillsDeployed: 1, experimentsRun: 2 });

    const data = await frontier.get();
    expect(data.points.length).toBe(2);
    expect(data.currentBest).toBe(75);
    // (75 - 50) / 50 * 100 = 50%
    expect(data.improvementFromBaseline).toBeCloseTo(50, 0);
  });

  it('get() returns zeros when no data exists', async () => {
    const data = await frontier.get();
    expect(data.points).toEqual([]);
    expect(data.currentBest).toBe(0);
    expect(data.improvementFromBaseline).toBe(0);
  });

  it('recent() returns last N points', async () => {
    for (let i = 1; i <= 10; i++) {
      await frontier.record({ cycle: i, score: i * 10, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    }

    const recent = await frontier.recent(3);
    expect(recent.length).toBe(3);
    expect(recent[0].cycle).toBe(8);
    expect(recent[2].cycle).toBe(10);
  });

  it('caps stored points at 500', async () => {
    // Fill with 505 points
    for (let i = 1; i <= 505; i++) {
      await frontier.record({ cycle: i, score: i, timestamp: '', skillsDeployed: 0, experimentsRun: 1 });
    }

    const data = await frontier.load();
    expect(data.points.length).toBeLessThanOrEqual(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// experiment/gitTracker.ts — git experiment branches
// ═══════════════════════════════════════════════════════════════════════════════

describe('experiment/gitTracker.ts — git experiment tracker', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = makeTempDir();

    // Initialize a git repo
    execSync('git init', { cwd: tempRepo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempRepo, stdio: 'pipe' });

    // Create an initial commit so branches work
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# Test\n');
    execSync('git add . && git commit -m "init"', { cwd: tempRepo, stdio: 'pipe' });
  });

  afterEach(async () => {
    await cleanDir(tempRepo);
  });

  it('isAvailable() returns true inside a git repo', () => {
    expect(gitTracker.isAvailable(tempRepo)).toBe(true);
  });

  it('isAvailable() returns false outside a git repo', async () => {
    const nonGitDir = makeTempDir();
    expect(gitTracker.isAvailable(nonGitDir)).toBe(false);
    await cleanDir(nonGitDir);
  });

  it('createBranch() creates an experiment branch', () => {
    const branchName = gitTracker.createBranch('exp-test-123', tempRepo);
    expect(branchName).toBe('evo/exp/exp-test-123');

    // Verify branch exists
    const branches = execSync('git branch', { cwd: tempRepo, encoding: 'utf-8' });
    expect(branches).toContain('evo/exp/exp-test-123');
  });

  it('createBranch() returns existing branch name if already exists', () => {
    const first = gitTracker.createBranch('exp-dupe', tempRepo);
    const second = gitTracker.createBranch('exp-dupe', tempRepo);
    expect(first).toBe(second);
  });

  it('createBranch() sanitizes branch names', () => {
    const branchName = gitTracker.createBranch('exp with spaces & special!chars', tempRepo);
    expect(branchName).not.toBeNull();
    expect(branchName).not.toContain(' ');
    expect(branchName).not.toContain('!');
    expect(branchName).not.toContain('&');
  });

  it('createBranch() returns null outside a git repo', async () => {
    const nonGitDir = makeTempDir();
    const result = gitTracker.createBranch('exp-no-git', nonGitDir);
    expect(result).toBeNull();
    await cleanDir(nonGitDir);
  });

  it('commitSkill() writes skill file and commits on the experiment branch', () => {
    const branchName = gitTracker.createBranch('exp-commit-test', tempRepo);
    expect(branchName).not.toBeNull();

    const skill = makeSkill({ name: 'Read — Not Found Skill' });
    const experiment = makeExperiment({ id: 'exp-commit-test' });

    const committed = gitTracker.commitSkill(branchName!, skill, experiment, tempRepo);
    expect(committed).toBe(true);

    // Verify the commit exists on the experiment branch
    const gitLog = execSync(`git log ${branchName} --oneline`, {
      cwd: tempRepo,
      encoding: 'utf-8',
    });
    expect(gitLog).toContain('evo: experiment');
    expect(gitLog).toContain('Read — Not Found Skill');

    // Verify we're back on the original branch
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim();
    expect(currentBranch).not.toBe(branchName);
  });

  it('keepExperiment() merges the branch and cleans up', () => {
    const branchName = gitTracker.createBranch('exp-keep-test', tempRepo);
    const skill = makeSkill();
    const experiment = makeExperiment({ id: 'exp-keep-test' });
    gitTracker.commitSkill(branchName!, skill, experiment, tempRepo);

    const merged = gitTracker.keepExperiment(branchName!, tempRepo);
    expect(merged).toBe(true);

    // Branch should be gone
    const branches = execSync('git branch', { cwd: tempRepo, encoding: 'utf-8' });
    expect(branches).not.toContain('exp-keep-test');

    // But the merge commit should be in history
    const gitLog = execSync('git log --oneline', { cwd: tempRepo, encoding: 'utf-8' });
    expect(gitLog).toContain('evo: merge promoted experiment');
  });

  it('discardExperiment() deletes the branch', () => {
    const branchName = gitTracker.createBranch('exp-discard-test', tempRepo);
    const skill = makeSkill();
    const experiment = makeExperiment({ id: 'exp-discard-test' });
    gitTracker.commitSkill(branchName!, skill, experiment, tempRepo);

    const discarded = gitTracker.discardExperiment(branchName!, tempRepo);
    expect(discarded).toBe(true);

    const branches = execSync('git branch', { cwd: tempRepo, encoding: 'utf-8' });
    expect(branches).not.toContain('exp-discard-test');
  });

  it('listExperimentBranches() returns active experiment branches', () => {
    gitTracker.createBranch('exp-list-1', tempRepo);
    gitTracker.createBranch('exp-list-2', tempRepo);
    gitTracker.createBranch('exp-list-3', tempRepo);

    const branches = gitTracker.listExperimentBranches(tempRepo);
    expect(branches.length).toBe(3);
    expect(branches).toContain('evo/exp/exp-list-1');
    expect(branches).toContain('evo/exp/exp-list-2');
    expect(branches).toContain('evo/exp/exp-list-3');
  });

  it('listExperimentBranches() returns empty when no experiment branches exist', () => {
    const branches = gitTracker.listExperimentBranches(tempRepo);
    expect(branches.length).toBe(0);
  });

  it('full lifecycle: create → commit → keep (promoted)', () => {
    const expId = 'exp-full-keep';
    const branch = gitTracker.createBranch(expId, tempRepo);
    const skill = makeSkill({ name: 'Promoted Skill' });
    const experiment = makeExperiment({ id: expId });

    gitTracker.commitSkill(branch!, skill, experiment, tempRepo);
    gitTracker.keepExperiment(branch!, tempRepo);

    // experiments/ dir should exist with the skill file
    const expDir = path.join(tempRepo, 'experiments');
    expect(fs.existsSync(expDir)).toBe(true);

    const files = fs.readdirSync(expDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain(expId);

    // File should contain the skill data
    const content = JSON.parse(fs.readFileSync(path.join(expDir, files[0]), 'utf-8'));
    expect(content.skill.name).toBe('Promoted Skill');
  });

  it('full lifecycle: create → commit → discard (rejected)', () => {
    const expId = 'exp-full-discard';
    const branch = gitTracker.createBranch(expId, tempRepo);
    const skill = makeSkill({ name: 'Rejected Skill' });
    const experiment = makeExperiment({ id: expId });

    gitTracker.commitSkill(branch!, skill, experiment, tempRepo);
    gitTracker.discardExperiment(branch!, tempRepo);

    // The experiments/ dir should NOT have the skill file on main
    // (it was only committed on the now-deleted branch)
    const expDir = path.join(tempRepo, 'experiments');
    if (fs.existsSync(expDir)) {
      const files = fs.readdirSync(expDir);
      const hasRejected = files.some(f => f.includes(expId));
      expect(hasRejected).toBe(false);
    }
  });
});
