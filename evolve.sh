#!/bin/bash
# OpenClaw Evo — Cron driver
# Runs one evolution cycle, saves checkpoint, exits cleanly.
# Safe to run overlapping with a daemon (daemon uses --once, this uses --cron).
export AUTO_APPROVE_CONFIDENCE=${AUTO_APPROVE_CONFIDENCE:-95}
cd "$(dirname "$0")" && npx tsx src/cli.ts --cron
