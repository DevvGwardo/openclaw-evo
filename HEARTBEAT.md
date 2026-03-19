# HEARTBEAT.md — OpenClaw Evo Heartbeat

## Purpose

This file serves as the heartbeat trigger for OpenClaw Evo's evolution system.

## How It Works

The hub monitors this file's modification time. When the file is updated (e.g., by an external cron or another process), the hub detects the change and triggers an evolution cycle.

## Setting Up the Heartbeat (Cron)

To set up a 5-minute heartbeat cron that triggers evolution cycles, add this to your system:

```bash
# macOS/Linux cron (runs every 5 minutes)
*/5 * * * * touch /Users/devgwardo/openclaw-evo/HEARTBEAT.md

# Or use launchd on macOS:
# Create ~/Library/LaunchAgents/ai.openclaw.evo-heartbeat.plist
```

## Alternative: OpenClaw Gateway Cron

The OpenClaw gateway can also trigger evolution cycles directly:

```bash
# Set up via openclaw CLI (when gateway is running):
openclaw cron add --name "Evo Heartbeat" --every 5m --message "Run evolution cycle"
```

## Manual Trigger

To manually trigger an evolution cycle without waiting for the heartbeat:

```bash
cd ~/openclaw-evo && npm run evolve:once
```

## Heartbeat Check (Hub-Side)

The hub checks the heartbeat file modification time on each cycle. If more than `CYCLE_INTERVAL_MS` has passed since the last heartbeat, the hub logs a warning but continues running.

## Configuration

In `~/.openclaw/evo-memory/`, the hub stores:
- `heartbeat-last-check.json` — timestamp of last heartbeat check
- `evolution-state.json` — full hub state for checkpoint/resume
