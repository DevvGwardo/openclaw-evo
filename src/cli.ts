/**
 * CLI entry point for OpenClaw Evo.
 *
 * Usage:
 *   npm run cli          — Interactive REPL mode
 *   npm run start:hub    — Start the hub (long-running server mode)
 *   npm run start:hub -- --watch — Start hub with auto-restart on file changes
 *   npm run evolve:once  — Run one evolution cycle and exit
 *
 * Flags:
 *   --once  Run a single evolution cycle then exit cleanly
 *   --watch Auto-restart on file changes in src/ (only with start:hub)
 *
 * Signals:
 *   SIGINT / SIGTERM → hub.stop() then process.exit(0)
 */

import { EvoHub } from './hub.js';
import { DEFAULT_CONFIG } from './constants.js';
import { startServer } from './server.js';
import { improvementLog } from './memory/improvementLog.js';
import { failureCorpus } from './memory/failureCorpus.js';
import chalk from 'chalk';
import * as readline from 'readline/promises';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isOnceMode = process.argv.includes('--once');
const isWatchMode = process.argv.includes('--watch');

// ── Helpers ──────────────────────────────────────────────────────────────────

function divider(label?: string): void {
  if (label) {
    console.log(chalk.gray(`\n── ${label} ─────────────────────────────────`));
  } else {
    console.log(chalk.gray('─'.repeat(42)));
  }
}

function printStatus(hub: EvoHub): void {
  const status = hub.getStatus();
  const { running, totalCyclesRun, lastCycleAt, activeExperiments, deployedSkills } = status;

  divider('Hub Status');

  if (running) {
    console.log(`  ${chalk.green('●')} Hub is running`);
  } else {
    console.log(`  ${chalk.red('○')} Hub is stopped`);
  }

  console.log(`  Cycles run:     ${chalk.cyan(totalCyclesRun)}`);
  if (lastCycleAt) {
    const ago = Math.round((Date.now() - lastCycleAt.getTime()) / 1000);
    console.log(`  Last cycle:     ${chalk.cyan(ago)}s ago`);
  }
  console.log(`  Active exp:     ${chalk.cyan(activeExperiments)}`);
  console.log(`  Deployed skills:${chalk.cyan(deployedSkills)}`);
}

async function printStats(): Promise<void> {
  divider('Performance Stats');

  const [stats, patterns] = await Promise.all([
    improvementLog.getStats(),
    failureCorpus.getPatterns(0),
  ]);

  console.log(`  Total improvements:  ${chalk.cyan(stats.totalImprovements)}`);
  console.log(`  Failure patterns:     ${chalk.cyan(patterns.length)}`);
  console.log(`  Skills deployed:      ${chalk.cyan(stats.skillsDeployed)}`);
  console.log(`  Experiments won:      ${chalk.green(stats.experimentsWon)}`);
  console.log(`  Experiments lost:      ${chalk.red(stats.experimentsLost)}`);
}

function printSkills(hub: EvoHub): void {
  const skills = hub.getProposedSkills();
  divider('Skills');

  if (skills.length === 0) {
    console.log(`  ${chalk.gray('No skills yet. Run a cycle to generate skills.')}`);
    return;
  }

  const statusColor = (s: string) => {
    if (s === 'deployed') return chalk.green(s);
    if (s === 'approved') return chalk.cyan(s);
    if (s === 'proposed') return chalk.yellow(s);
    if (s === 'rejected') return chalk.red(s);
    return chalk.gray(s);
  };

  for (const skill of skills) {
    console.log(`  ${chalk.bold(skill.name)}  ${statusColor(skill.status)}`);
    if (skill.description) {
      console.log(`    ${chalk.gray(skill.description)}`);
    }
  }
}

async function printLogs(hub: EvoHub): Promise<void> {
  divider('Recent Logs');
  const cycles = hub.getCycleHistory().slice(-5).reverse();
  if (cycles.length === 0) {
    console.log(`  ${chalk.gray('No cycles logged yet.')}`);
    return;
  }
  for (const cycle of cycles) {
    const ts = cycle.startedAt.toISOString().replace('T', ' ').slice(0, 19);
    const phases = cycle.phases;
    const built = phases.build.skillsProposed;
    const ran = phases.experiment.experimentsRun;
    const deployed = phases.integrate.improvementsDeployed;
    const status =
      cycle.status === 'completed'
        ? chalk.green('✓')
        : cycle.status === 'failed'
        ? chalk.red('✗')
        : chalk.yellow('○');
    console.log(
      `  ${status} ${chalk.gray(ts)}  cycle #${cycle.cycleNumber}  ` +
      `${chalk.cyan(`+${built} built`)} ${chalk.cyan(`${ran} exp`)} ${deployed > 0 ? chalk.green(`+${deployed} dep`) : chalk.gray('0 dep')}`,
    );
  }
}

// ── REPL ─────────────────────────────────────────────────────────────────────

async function startRepl(): Promise<void> {
  const hub = new EvoHub(DEFAULT_CONFIG);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // We lazily initialise the hub so the repl starts instantly
  let hubReady = false;
  let hubInitError: string | null = null;

  let server: ReturnType<typeof startServer> | null = null;

  const initHub = async () => {
    if (hubReady) return;
    try {
      await hub.start();
      // Start the dashboard API server alongside the hub
      server = startServer(hub);
      hubReady = true;
    } catch (err) {
      hubInitError = String(err);
      hubReady = true; // mark ready so we don't keep trying
    }
  };

  // Kick off hub init in background
  void initHub();

  console.log(chalk.bold('\n🔮 OpenClaw Evo — Interactive REPL\n'));
  console.log(chalk.gray('  Type `help` for commands. `quit` to exit.\n'));

  const printHelp = () => {
    divider('Commands');
    const cmds = [
      ['status',       'Show hub status'],
      ['trigger',      'Trigger an evolution cycle now'],
      ['skills',       'List proposed and deployed skills'],
      ['approve <id>', 'Approve a proposed skill by id'],
      ['logs',         'Show recent evolution cycle logs'],
      ['stats',        'Show performance statistics'],
      ['watchdog',     'Show gateway watchdog status'],
      ['restart',      'Stop and restart the hub'],
      ['help',         'Show this help'],
      ['quit',         'Exit the REPL'],
    ];
    for (const [cmd, desc] of cmds) {
      console.log(`  ${chalk.cyan(cmd.padEnd(14))} ${desc}`);
    }
  };

  // Echo the prompt line
  process.stdout.write(chalk.bold('OpenClaw Evo > ') + chalk.gray(''));

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) {
      process.stdout.write(chalk.bold('OpenClaw Evo > '));
      return;
    }

    const parts = raw.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // ── status ──────────────────────────────────────────────────────────────
    if (cmd === 'status') {
      if (!hubReady) {
        console.log(chalk.yellow('  Hub is initialising…'));
      } else if (hubInitError) {
        console.log(chalk.red(`  Hub error: ${hubInitError}`));
      } else {
        printStatus(hub);
      }
    }

    // ── trigger ──────────────────────────────────────────────────────────────
    else if (cmd === 'trigger') {
      if (!hubReady || hubInitError) {
        console.log(chalk.red('  Hub not running — cannot trigger.'));
      } else {
        console.log(chalk.cyan('  Triggering evolution cycle…'));
        hub.runEvolutionCycle().catch((err) =>
          console.log(chalk.red(`  Cycle error: ${err}`)),
        );
      }
    }

    // ── skills ──────────────────────────────────────────────────────────────
    else if (cmd === 'skills') {
      if (!hubReady) {
        console.log(chalk.yellow('  Hub is initialising…'));
      } else {
        printSkills(hub);
      }
    }

    // ── approve ──────────────────────────────────────────────────────────────
    else if (cmd === 'approve') {
      const skillId = args[0];
      if (!skillId) {
        console.log(chalk.yellow('  Usage: approve <skill-id>'));
      } else if (!hubReady || hubInitError) {
        console.log(chalk.red('  Hub not running.'));
      } else {
        const skills = hub.getProposedSkills();
        const skill = skills.find((s) => s.id === skillId || s.name === skillId);
        if (!skill) {
          console.log(chalk.red(`  Skill not found: ${skillId}`));
        } else {
          skill.status = 'pending_approval';
          console.log(chalk.green(`  Approved: ${skill.name}`));
        }
      }
    }

    // ── logs ─────────────────────────────────────────────────────────────────
    else if (cmd === 'logs') {
      if (!hubReady) {
        console.log(chalk.yellow('  Hub is initialising…'));
      } else {
        await printLogs(hub);
      }
    }

    // ── stats ────────────────────────────────────────────────────────────────
    else if (cmd === 'stats') {
      if (!hubReady) {
        console.log(chalk.yellow('  Hub is initialising…'));
      } else {
        await printStats();
      }
    }

    // ── watchdog ──────────────────────────────────────────────────────────────
    else if (cmd === 'watchdog') {
      if (!hubReady) {
        console.log(chalk.yellow('  Hub is initialising…'));
      } else {
        const status = hub.getStatus();
        const wd = status.gatewayWatchdog;
        if (!wd) {
          console.log(chalk.gray('  Watchdog not available'));
        } else {
          divider('Gateway Watchdog');
          console.log(`  ${wd.running ? chalk.green('●') : chalk.red('○')} Watchdog ${wd.running ? 'active' : 'stopped'}`);
          console.log(`  Gateway:           ${wd.gatewayUp ? chalk.green('UP') : chalk.red('DOWN')}`);
          console.log(`  Consecutive fails: ${chalk.cyan(wd.consecutiveFailures)}`);
          console.log(`  Total restarts:    ${chalk.cyan(wd.totalRestarts)}`);
          if (wd.lastRestartAt) {
            const ago = Math.round((Date.now() - wd.lastRestartAt) / 1000);
            console.log(`  Last restart:      ${chalk.cyan(ago)}s ago`);
          }
          if (wd.inCooldown) {
            console.log(`  ${chalk.yellow('⏳ In cooldown — waiting before next restart attempt')}`);
          }
        }
      }
    }

    // ── restart ───────────────────────────────────────────────────────────────
    else if (cmd === 'restart') {
      console.log(chalk.cyan('  Restarting hub…'));
      server?.close();
      server = null;
      hub.stop();
      hubReady = false;
      hubInitError = null;
      void initHub();
    }

    // ── help ──────────────────────────────────────────────────────────────────
    else if (cmd === 'help') {
      printHelp();
    }

    // ── quit ──────────────────────────────────────────────────────────────────
    else if (cmd === 'quit' || cmd === 'exit') {
      console.log(chalk.gray('  Goodbye!'));
      server?.close();
      hub.stop();
      rl.close();
      return;
    }

    // ── unknown ──────────────────────────────────────────────────────────────
    else {
      console.log(chalk.yellow(`  Unknown command: ${cmd}. Run \`help\` for available commands.`));
    }

    process.stdout.write(chalk.bold('OpenClaw Evo > '));
  });

  rl.on('close', () => {
    hub.stop();
    process.exit(0);
  });
}

// ── Watch mode ────────────────────────────────────────────────────────────────

function startWatchMode(): void {
  const srcDir = path.resolve(__dirname, '..');
  let restarting = false;
  let currentPid: number | null = null;

  const log = (msg: string) =>
    console.log(`${chalk.gray(new Date().toISOString().slice(11, 19))} ${msg}`);

  const spawnHub = (): void => {
    if (currentPid !== null) {
      try {
        process.kill(currentPid, 'SIGTERM');
      } catch {
        // ignore
      }
    }

    log(chalk.cyan('🔁 Restarting hub…'));
    const child = spawn('bun', [path.join(__dirname, 'hub.js')], { stdio: 'inherit' });
    currentPid = child.pid ?? null;
  };

  // Initial start
  spawnHub();

  log(chalk.green('👀 Watch mode active — watching src/ for changes'));
  log(chalk.gray('   Press Ctrl+C to stop\n'));

  const watcher = fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (restarting) return;
    if (!filename) return;
    if (filename.includes('node_modules')) return;
    if (!filename.endsWith('.ts') && !filename.endsWith('.js')) return;

    restarting = true;
    log(chalk.yellow(`📝 Change detected: ${filename} (${eventType})`));
    spawnHub();
    // Debounce: allow next restart after 1s
    setTimeout(() => { restarting = false; }, 1000);
  });

  const stop = () => {
    watcher.close();
    if (currentPid !== null) {
      try { process.kill(currentPid, 'SIGTERM'); } catch { /* ignore */ }
    }
    log(chalk.gray('Watch mode stopped.'));
    process.exit(0);
  };

  process.on('SIGINT',  stop);
  process.on('SIGTERM', stop);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Determine mode
  if (isWatchMode) {
    startWatchMode();
    return;
  }

  if (isOnceMode) {
    const hub = new EvoHub(DEFAULT_CONFIG);
    try {
      await hub.runOnce();
      console.log(chalk.green('✅ Evolution cycle complete.'));
      hub.stop();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red('❌ Evolution cycle failed:'), err);
      hub.stop();
      process.exit(1);
    }
  }

  // Default: REPL mode
  await startRepl();
}

main();
