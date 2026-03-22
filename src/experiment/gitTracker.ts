/**
 * OpenClaw Evo — Git Experiment Tracker
 *
 * Provides git-based experiment isolation inspired by autoresearch:
 *   - Creates a branch per experiment
 *   - Commits the generated skill file on the branch
 *   - On success (promoted): merges back, keeping full history
 *   - On failure (rejected): deletes the branch, keeping main clean
 *
 * This gives us:
 *   - Clean rollback on failed experiments
 *   - Full audit trail via git history (git log --all --oneline)
 *   - Ability to diff exactly what changed between skill versions
 *   - Cherry-pick old experiments that become relevant later
 *
 * All operations are non-destructive to the working branch. Skill files
 * are written to experiments/ within the repo, not to the working tree.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedSkill, Experiment } from '../types.js';

const EXPERIMENTS_DIR = 'experiments';
const BRANCH_PREFIX = 'evo/exp';

const log = {
  info: (msg: string) => console.log(`[git-tracker] ${msg}`),
  warn: (msg: string) => console.warn(`[git-tracker] ${msg}`),
  error: (msg: string) => console.error(`[git-tracker] ${msg}`),
};

function git(cmd: string, cwd?: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${cmd} failed: ${msg}`);
  }
}

function isGitRepo(cwd?: string): boolean {
  try {
    git('rev-parse --git-dir', cwd);
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(cwd?: string): string {
  return git('rev-parse --abbrev-ref HEAD', cwd);
}

function branchExists(name: string, cwd?: string): boolean {
  try {
    git(`rev-parse --verify ${name}`, cwd);
    return true;
  } catch {
    return false;
  }
}

function sanitizeBranchName(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 60);
}

export const gitTracker = {
  /**
   * Check if git tracking is available in the given (or current) directory.
   */
  isAvailable(cwd?: string): boolean {
    return isGitRepo(cwd);
  },

  /**
   * Create an experiment branch from the current HEAD.
   * Returns the branch name, or null if git is unavailable.
   */
  createBranch(experimentId: string, cwd?: string): string | null {
    if (!this.isAvailable(cwd)) return null;

    const branchName = `${BRANCH_PREFIX}/${sanitizeBranchName(experimentId)}`;
    if (branchExists(branchName, cwd)) {
      log.warn(`Branch ${branchName} already exists — reusing`);
      return branchName;
    }

    try {
      git(`branch ${branchName}`, cwd);
      log.info(`Created branch: ${branchName}`);
      return branchName;
    } catch (err) {
      log.error(`Failed to create branch: ${err}`);
      return null;
    }
  },

  /**
   * Write the skill file to experiments/ and commit it on the experiment branch.
   * Switches to the branch, commits, and switches back.
   */
  commitSkill(branchName: string, skill: GeneratedSkill, experiment: Experiment, cwd?: string): boolean {
    const repoDir = cwd ?? process.cwd();
    if (!this.isAvailable(repoDir)) return false;

    try {
      // Ensure experiments directory exists
      const expDir = join(repoDir, EXPERIMENTS_DIR);
      if (!existsSync(expDir)) {
        mkdirSync(expDir, { recursive: true });
      }

      // Write skill file
      const skillFileName = `${sanitizeBranchName(experiment.id)}.json`;
      const skillPath = join(expDir, skillFileName);

      const skillData = {
        experimentId: experiment.id,
        experimentName: experiment.name,
        skill: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          confidence: skill.confidence,
          targetFailurePattern: skill.targetFailurePattern,
          generatedAt: skill.generatedAt,
        },
        createdAt: new Date().toISOString(),
      };

      writeFileSync(skillPath, JSON.stringify(skillData, null, 2) + '\n', 'utf-8');

      // Stage and commit on the experiment branch
      const originalBranch = getCurrentBranch(repoDir);
      git(`checkout ${branchName}`, repoDir);
      git(`add ${EXPERIMENTS_DIR}/${skillFileName}`, repoDir);
      git(`commit -m "evo: experiment ${experiment.id} — ${skill.name}"`, repoDir);
      git(`checkout ${originalBranch}`, repoDir);

      log.info(`Committed skill "${skill.name}" on ${branchName}`);
      return true;
    } catch (err) {
      log.error(`Failed to commit skill: ${err}`);
      // Try to get back to original branch
      try { git(`checkout ${getCurrentBranch(repoDir)}`, repoDir); } catch { /* best effort */ }
      return false;
    }
  },

  /**
   * Merge a successful experiment branch back into the current branch.
   * The experiment's skill file becomes part of the permanent history.
   */
  keepExperiment(branchName: string, cwd?: string): boolean {
    if (!this.isAvailable(cwd)) return false;

    try {
      git(`merge ${branchName} --no-ff -m "evo: merge promoted experiment ${branchName}"`, cwd);
      git(`branch -d ${branchName}`, cwd);
      log.info(`Merged and cleaned up: ${branchName}`);
      return true;
    } catch (err) {
      log.error(`Failed to merge experiment: ${err}`);
      return false;
    }
  },

  /**
   * Discard a failed experiment branch.
   * The branch is deleted but its commits remain in reflog for forensics.
   */
  discardExperiment(branchName: string, cwd?: string): boolean {
    if (!this.isAvailable(cwd)) return false;

    try {
      git(`branch -D ${branchName}`, cwd);
      log.info(`Discarded experiment branch: ${branchName}`);
      return true;
    } catch (err) {
      log.error(`Failed to discard branch: ${err}`);
      return false;
    }
  },

  /**
   * List all active experiment branches.
   */
  listExperimentBranches(cwd?: string): string[] {
    if (!this.isAvailable(cwd)) return [];

    try {
      const output = git(`branch --list "${BRANCH_PREFIX}/*"`, cwd);
      return output
        .split('\n')
        .map((b) => b.trim().replace(/^\*\s*/, ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  },
};
