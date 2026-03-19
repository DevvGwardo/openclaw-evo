# 🧬 OpenClaw Evo — Self-Evolving AI Assistant

[![CI](https://github.com/DevvGwardo/openclaw-evo/actions/workflows/ci.yml/badge.svg)](https://github.com/DevvGwardo/openclaw-evo/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://www.typescriptlang.org)

## ⚡ Quick Start

```bash
# Clone & install
git clone https://github.com/DevvGwardo/openclaw-evo.git && cd openclaw-evo && npm install

# Run everything (hub + dashboard)
npm run dev

# Run just the dashboard
npm run dev:dashboard

# Start the evolution hub
npm run start:hub

# Run one evolution cycle
npm run evolve:once

# Tests
npm run test
```

## 📊 Project Stats

| Metric | Value |
|--------|-------|
| **TypeScript** | 7,452 lines |
| **Components** | 7 core modules |
| **Phases** | 4 self-evolution phases |

---

> OpenClaw that monitors, evaluates, and improves itself — recursively.

**OpenClaw Evo** is a self-evolution system for OpenClaw. It watches how your AI assistant works, identifies failures and bottlenecks, builds new tools and skills to fix them, runs experiments to validate improvements, and integrates winning changes back into the system — continuously, without human intervention.

---

## Core Concept

Inspired by MiniMax M2.7's recursive self-improvement loop, OpenClaw Evo creates a **closed feedback loop**:

```
Monitor → Evaluate → Plan → Build → Experiment → Integrate → (repeat)
```

OpenClaw Evo acts as a meta-agent — it doesn't just help you with tasks, it helps **improve itself**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Evo Hub                      │
│         (orchestrates all components)                    │
└──────┬──────┬──────┬──────┬──────┬──────────┬──────────┘
       │      │      │      │      │          │
   ┌───┴───┐┌┴┐┌──┴──┐┌──┴──┐┌──┴──┐   ┌──┴───┐
   │Harness││E││Tool ││Expr ││Memo │   │Web   │
   │Monitor││v││Build││Runner││ry   │   │UI    │
   │       ││al││     ││     ││     │   │      │
   └───────┘└──┘└─────┘└─────┘└─────┘   └──────┘
       │             │         │             │
   ┌───┴─────────────┴─────────┴─────────────┴───┐
   │              OpenClaw Gateway                 │
   │   (sessions, history, skills, tools)          │
   └─────────────────────────────────────────────┘
```

### Components

| Component | Role |
|-----------|------|
| **Hub** | Orchestrates the evolution loop, schedules cycles |
| **Harness** | Wraps OpenClaw agents with self-monitoring hooks |
| **Evaluator** | Scores performance, identifies failure patterns |
| **Tool Builder** | Generates new skills/tools from failure analysis |
| **Experiment Runner** | A/B tests improvements against baselines |
| **Memory** | Persistent knowledge across evolution cycles |
| **Dashboard** | Real-time web UI for monitoring evolution |

---

## How It Works

### The Self-Evolution Loop

1. **Monitor** — The harness observes every tool call, session, and error
2. **Evaluate** — The evaluator scores performance and identifies patterns
3. **Plan** — Identifies which failures are worth fixing
4. **Build** — Tool builder generates new skills or fixes existing ones
5. **Experiment** — Runs new tools against baseline in parallel sessions
6. **Integrate** — Winning improvements are promoted to production
7. **Repeat** — Continuous iteration

### Harness Monitor

The harness intercepts every OpenClaw event:
- Tool calls and their success/failure
- Session creation and closure
- Error rates and latency
- User satisfaction signals
- Tool usage frequency and patterns

### Evaluator

Scoring dimensions:
- **Accuracy** — Did the agent succeed?
- **Efficiency** — How many tool calls vs. optimal?
- **Speed** — Time to complete vs. baseline
- **Reliability** — Error rate over time
- **Coverage** — What % of task types are handled?

### Tool Builder

When a failure pattern is identified:
1. Analyzes the failure in context (what was the task? what went wrong?)
2. Generates a new skill (SKILL.md + implementation)
3. Validates syntax and structure
4. Proposes it to the experiment runner

### Experiment Runner

- Spawns parallel test sessions
- New tool vs. old tool on same task
- Measures: success rate, time, tool call count
- Statistical significance testing
- Only promotes if improvement is significant

---

## Self-Evolving Capabilities

### Phase 1: Introspection
- Monitor own performance continuously
- Build failure/success corpus
- Identify top failure patterns

### Phase 2: Tool Synthesis
- Generate new skills from failure analysis
- Auto-fix broken or suboptimal tools
- Optimize existing tool chains

### Phase 3: Recursive Improvement
- Improve the harness itself
- Optimize evaluation algorithms
- Self-tune experiment parameters

### Phase 4: Autonomous Evolution
- Full recursive loop with minimal human oversight
- Auto-deploy winning improvements
- Continuous learning from production

---

## Repository Structure

```
openclaw-evo/
├── src/
│   ├── hub.ts                    # Main orchestration
│   ├── harness/
│   │   ├── monitor.ts            # Event interception
│   │   ├── sessionTracker.ts     # Session lifecycle tracking
│   │   └── toolAnalyzer.ts       # Tool call analysis
│   ├── evaluator/
│   │   ├── scorer.ts             # Performance scoring
│   │   ├── patternDetector.ts     # Failure pattern detection
│   │   └── reportGenerator.ts    # Evaluation reports
│   ├── builder/
│   │   ├── skillGenerator.ts     # Generate new skills
│   │   ├── skillValidator.ts      # Validate skill structure
│   │   └── templateLibrary.ts     # Skill templates
│   ├── experiment/
│   │   ├── runner.ts             # A/B experiment runner
│   │   ├── comparator.ts          # Compare results statistically
│   │   └── promoter.ts            # Promote winning improvements
│   ├── memory/
│   │   ├── store.ts               # Persistent memory store
│   │   ├── failureCorpus.ts       # Known failures database
│   │   └── improvementLog.ts      # Evolution history
│   ├── openclaw/
│   │   ├── gateway.ts             # OpenClaw gateway client
│   │   ├── sessionManager.ts       # Session CRUD
│   │   └── skillManager.ts         # Skill installation
│   ├── types.ts                   # Shared TypeScript types
│   └── constants.ts               # Configuration constants
├── dashboard/
│   ├── index.html
│   ├── src/
│   │   ├── App.tsx               # Dashboard React app
│   │   ├── components/
│   │   │   ├── EvolutionDashboard.tsx
│   │   │   ├── PerformanceChart.tsx
│   │   │   ├── FailurePatterns.tsx
│   │   │   ├── ExperimentMonitor.tsx
│   │   │   └── SkillBuilder.tsx
│   │   └── api/
│   │       └── evoClient.ts
│   └── vite.config.ts
├── tests/
│   ├── harness.test.ts
│   ├── evaluator.test.ts
│   ├── builder.test.ts
│   └── experiment.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

---

## Getting Started

### Prerequisites
- Node.js 20+
- OpenClaw gateway running (`openclaw gateway start`)

### Installation

```bash
git clone https://github.com/DevvGwardo/openclaw-evo.git
cd openclaw-evo
npm install
```

### Running the Dashboard

```bash
npm run dev:dashboard
# → Open http://localhost:5174
```

### Starting the Evolution Hub

```bash
npm run start:hub
# Starts the self-evolution loop
```

### Quick Test

```bash
npm run test          # Run all tests
npm run build         # Build TypeScript
npm run evolve:once   # Run one evolution cycle
```

---

## Dashboard Features

- **Real-time performance metrics** — Tool success rates, latency, error trends
- **Failure pattern analysis** — Top failure categories ranked by frequency
- **Evolution progress** — Current cycle, experiments running, improvements deployed
- **Tool Builder** — See proposed new skills, approve/reject
- **Memory viewer** — Browse the failure corpus and improvement history
- **Experiment monitor** — Live A/B test results

---

## Configuration

```typescript
// src/config.ts
export const EVOLUTION_CONFIG = {
  // How often to run evolution cycles (ms)
  CYCLE_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // Minimum failures before triggering tool generation
  FAILURE_THRESHOLD: 5,

  // Experiment: how many test sessions to run
  EXPERIMENT_SESSIONS: 5,

  // Minimum improvement to promote (%)
  MIN_IMPROVEMENT_PCT: 10,

  // Max new skills per cycle
  MAX_SKILLS_PER_CYCLE: 3,

  // Confidence threshold for statistical significance
  STATISTICAL_CONFIDENCE: 0.95,
};
```

---

## Roadmap

### v0.1 — Foundation
- [x] Repository setup
- [x] Type system and interfaces
- [x] OpenClaw gateway client
- [x] Basic harness monitor
- [x] Dashboard skeleton

### v0.2 — Evaluation
- [x] Performance scoring
- [x] Failure pattern detection
- [x] Evaluation reports

### v0.3 — Tool Synthesis
- [x] Skill template library
- [x] Skill generator (rule-based)
- [x] Skill validator

### v0.4 — Experimentation
- [x] A/B experiment runner
- [x] Statistical comparator
- [x] Improvement promoter

### v0.5 — Recursive Loop
- [x] Full evolution loop orchestration
- [x] Memory persistence
- [x] Auto-deployment

### v1.0 — Autonomous
- [x] Self-tuning evaluation algorithms
- [x] Self-improving harness
- [x] Minimal human oversight

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

Key areas for contribution:
- Tool builder: better skill generation algorithms
- Evaluator: more sophisticated scoring models
- Experiment runner: better statistical methods
- Dashboard: better visualizations

---

## License

MIT — see [LICENSE](LICENSE)
