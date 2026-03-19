/**
 * CLI entry point for OpenClaw Evo.
 *
 * Usage:
 *   npm run start:hub   — Start the hub (long-running server mode)
 *   npm run evolve:once — Run one evolution cycle and exit
 *
 * Flags:
 *   --once  Run a single evolution cycle then exit cleanly
 *
 * Signals:
 *   SIGINT / SIGTERM → hub.stop() then process.exit(0)
 */

import { EvoHub } from './hub.js';
import { DEFAULT_CONFIG } from './constants.js';

const isOnceMode = process.argv.includes('--once');

async function main(): Promise<void> {
  const hub = new EvoHub(DEFAULT_CONFIG);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — stopping hub…`);
    try {
      hub.stop();
    } catch (err) {
      console.error('Error during hub.stop():', err);
    }
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (isOnceMode) {
    try {
      await hub.runOnce();
      console.log('✅ Evolution cycle complete.');
      hub.stop();
      process.exit(0);
    } catch (err) {
      console.error('❌ Evolution cycle failed:', err);
      hub.stop();
      process.exit(1);
    }
  } else {
    try {
      await hub.start();
    } catch (err) {
      console.error('❌ Hub crashed:', err);
      try {
        hub.stop();
      } catch {
        // ignore
      }
      process.exit(1);
    }
  }
}

main();
