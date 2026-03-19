# Architecture

_How the pieces fit together_

---

## System Overview

OpenClaw Evo is a self-contained Node.js service (TypeScript) that integrates with the OpenClaw Gateway. It observes agent behavior, generates improvements, and deploys them — operating as a background loop that never requires a restart or redeploy of the main agent.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Evo (this project)                        │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           EvoHub                                      │   │
│  │                    (orchestration loop)                               │   │
│  │                                                                       │   │
│  │   scheduleNextCycle() ──▶ runEvolutionCycle() ──▶ scheduleNextCycle │   │
│  └────────────────────┬────────────────────────────────────────────────┘   │
│                       │                                                        │
│       ┌───────────────┼───────────────────────┬──────────────────┐        │
│       │               │                       │                  │        │
│       ▼               ▼                       ▼                  ▼        │
│  ┌─────────┐   ┌─────────────┐   ┌─────────────────┐  ┌──────────────┐    │
│  │ Monitor  │   │  Evaluator  │   │     Builder      │  │  Experiment  │    │
│  │(harness)│   │ (scorer +   │   │ (generator +     │  │  (runner +   │    │
│  │         │   │  detector)   │   │  validator +     │  │  comparator +│    │
│  │         │   │             │   │  template lib)    │  │  promoter)   │    │
│  └────┬────┘   └──────┬──────┘   └────────┬────────┘  └──────┬───────┘    │
│       │               │                   │                   │            │
│       └───────────────┴───────────────────┴───────────────────┘            │
│                               │                                             │
│                               ▼                                             │
│                    ┌─────────────────────┐                                  │
│                    │       Memory        │                                  │
│                    │ (store + corpus +   │                                  │
│                    │  improvement log)   │                                  │
│                    └─────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                │ ▲
                    poll / session events
                                │ │
                    ┌───────────┴─┴───────────┐
                    │    OpenClaw Gateway     │
                    │   (http://localhost:     │
                    │    18789)               │
                    │                         │
                    │  /api/sessions          │
                    │  /api/sessions/:id       │
                    │  /api/dashboard/metrics  │
                    └─────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Dashboard (port 5174)                              │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │   Vite React app (dashboard/)  ──▶  /api/*  ──▶  EvoHub API server  │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### EvoHub (`src/hub.ts`)

The central orchestrator. Holds references to all subsystems and drives the evolution loop.

**Responsibilities:**
- Owns the `running` state and schedules cycles via `setTimeout`
- Initializes all other components at construction
- Runs the five-phase evolution cycle in `runEvolutionCycle()`
- Exposes `getStatus()`, `getProposedSkills()`, `getActiveExperiments()` for the API server

**Key fields:**
```typescript
private monitor: Monitor;
private evaluator: Evaluator;
private patternDetector: PatternDetector;
private reportGenerator: ReportGenerator;
private skillGenerator: SkillGenerator;
private skillValidator: SkillValidator;
private templateLibrary: TemplateLibrary;
private experimentRunner: ExperimentRunner;
private comparator: Comparator;
private promoter: Promoter;
private store: MemoryStore;
private failureCorpus: FailureCorpus;
private improvementLog: ImprovementLog;
private gateway: Gateway;
private sessionManager: SessionManager;
private skillManager: SkillManager;
```

---

### Monitor — Harness (`src/harness/`)

Observes the OpenClaw Gateway and streams session data into the system.

**`monitor.ts`**
- Polls the gateway on `OPENCLAW_POLL_INTERVAL_MS`
- Emits two event types:
  - `onSessionMetrics` → receives completed `SessionMetrics`
  - `onToolFailure` → receives `(toolName, error, context)` for each tool call that errored

**`sessionTracker.ts`**
- Tracks open sessions and their active tool calls
- Builds `SessionLifecycle` records from gateway events

**`toolAnalyzer.ts`**
- Analyzes individual tool call patterns
- Provides latency histograms and error classification

**Events flow:**

```
Gateway /api/sessions/:id
         │
         ▼
  sessionTracker.track()
         │
         ├── onSessionMetrics ──────────────▶ EvoHub.recentMetrics[]
         │
         └── onToolFailure ─────────────────▶ failureCorpus.recordFailure()
                                              │
                                              ▼
                                         FailurePattern stored
```

---

### Evaluator (`src/evaluator/`)

Turns raw session data into scored metrics and pattern analysis.

**`scorer.ts`**
- Scores an array of `SessionMetrics` across five dimensions
- Weights: accuracy 40%, efficiency 20%, speed 15%, reliability 15%, coverage 10%
- Returns `PerformanceScore`

**`patternDetector.ts`**
- Groups tool failures into `FailurePattern` objects
- Uses normalized error hashes (digits → `X`, whitespace collapsed) to cluster similar errors
- Applies `FAILURE_THRESHOLD` filter before surfacing patterns

**`reportGenerator.ts`**
- Combines scorer + pattern detector output into a full `EvaluationReport`
- Period-aware (uses `periodStart` / `periodEnd` from cycle interval)

---

### Builder (`src/builder/`)

Synthesizes new skills from failure patterns.

**`templateLibrary.ts`**
- Exports `TEMPLATE_LIBRARY: Record<string, SkillTemplate>`
- Six built-in templates: `data_processing`, `web_search`, `file_manipulation`, `code_review`, `debugging`, `api_call`
- Functions: `getTemplate()`, `getTemplateTypes()`, `listTemplates()`
- Templates contain `{{PLACEHOLDER}}` markers substituted at generation time

**`skillGenerator.ts`**
- `generateFromFailure(pattern)`: picks template, fills placeholders, computes confidence
- `generateBatch(patterns)`: runs generation for multiple patterns in parallel
- `computeConfidence(pattern)`: weighted score from severity + frequency + recency

**`skillValidator.ts`**
- Schema validation before a skill enters the experiment pipeline
- Checks: name format, description length, trigger phrase count, implementation presence, confidence range
- `validateBatch()` runs all checks and returns an array of results

---

### Experiment (`src/experiment/`)

Runs A/B experiments to determine whether a new skill is better than the baseline.

**`runner.ts`**
- `createExperiment(treatmentSkill, controlSkillId?)` → `Experiment`
- `run(experiment)` → runs control arm then treatment arm, returns updated experiment
- Spawns sessions via `POST /api/sessions` on the gateway
- Polls `GET /api/sessions/:id` until status is `completed`/`failed`/`done`
- Falls back to deterministic mock results when gateway is unreachable
- Parallelism controlled by `EXPERIMENT_CONCURRENCY` env var (default: 4)

**`comparator.ts`**
- `compare(experiment)` → `StatisticalResult`
- Two-proportion z-test (see [Self-Improvement → Statistical Testing][])
- Returns `confidence`, `pValue`, `improvementPct`, `zScore`, raw success rates
- `isSignificant(result, threshold)` helper

**`promoter.ts`**
- `evaluate(experiment)` → `PromotionDecision`
- Checks: `statisticalSignificance ≥ STATISTICAL_CONFIDENCE` (default 0.95) AND `improvementPct ≥ MIN_IMPROVEMENT_PCT` (default 10)
- `promote(experimentId)` → writes skill to `SKILL_OUTPUT_DIR`, logs to `ImprovementLog`, updates skill status

**`index.ts`**
- Re-exports `ExperimentRunner`, `Comparator`, `Promoter`

---

### Memory (`src/memory/`)

Persistent JSON-file storage for all learned knowledge.

**`store.ts` — `MemoryStore`**
- JSON file-per-key persistence under `MEMORY_DIR` (default `~/.openclaw/evo-memory/`)
- `save(key, data)` / `load<T>(key)` / `delete(key)` / `list()`
- Auto-creates directory on first `save()` or `load()`
- Module-level singleton: `export const store`

**`failureCorpus.ts` — `FailureCorpus`**
- Wraps `MemoryStore` with failure-specific semantics
- `recordFailure(pattern, context)` — upserts a `FailureRecord` keyed by `pattern.id`
- `getPatterns(threshold?)` — returns all patterns, optionally filtered by frequency

**`improvementLog.ts` — `ImprovementLog`**
- Append-only log of all evolution events
- `record(entry)` — adds `ImprovementEntry` with auto-generated UUID
- `getStats()` — returns total count and summary by type
- Backed by `MemoryStore` under the key `improvement-log`

**`index.ts`**
- Re-exports all three classes

---

## Data Flow

### Session → Failure → Skill → Deploy (full path)

```
  OpenClaw Agent
        │
        │ tool call
        ▼
  OpenClaw Gateway
        │
        │ session completed / tool error events
        ▼
  Monitor (harness/monitor.ts)
        │
        ├── onSessionMetrics ──────────────────────┐
        │                                          │
        └── onToolFailure ──▶ FailureCorpus ──▶ FailurePattern
                               (memory/store.ts)       │
                                                          │
  Evolution Cycle fires (CYCLE_INTERVAL_MS) ──────────────┘
        │
        ▼
  Evaluator.evaluatePerformance()
  Returns: PerformanceScore + FailurePattern[]
        │
        ▼
  For each pattern with frequency ≥ FAILURE_THRESHOLD:
        │
        ▼
  SkillGenerator.generateFromFailure(pattern)
        │
        ├── TemplateLibrary.selectTemplateType()
        ├── fillTemplate() → GeneratedSkill
        ├── computeConfidence()
        └── SkillValidator.validate()
             │
             ▼
        GeneratedSkill { status: 'proposed' }
             │
             ▼
  ExperimentRunner.runNewSkillExperiment(skill)
        │
        ├── Create experiment (control vs. treatment)
        ├── Spawn control sessions ──▶ ExperimentResult[]
        ├── Spawn treatment sessions ──▶ ExperimentResult[]
        └── comparator.compare()
             │
             ▼
        StatisticalResult { confidence, improvementPct, pValue }
             │
             ▼
        Promoter.evaluate()
        ┌─────────────────────────────────┐
        │ if confidence ≥ 0.95 AND         │
        │    improvementPct ≥ 10%:          │
        │    → Promoter.promote()          │
        │    → write SKILL.md              │
        │    → log experiment_won          │
        │    → skill.status = 'deployed'   │
        │ else:                            │
        │    → skill.status = 'testing'   │
        └─────────────────────────────────┘
```

---

## File Structure

```
openclaw-evo/
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── src/
│   ├── hub.ts                    # EvoHub class + CLI lifecycle
│   ├── server.ts                 # HTTP API server (port 5174)
│   ├── cli.ts                    # openclaw-evo CLI entry point
│   ├── types.ts                  # All shared TypeScript interfaces
│   ├── constants.ts              # DEFAULT_CONFIG
│   └── utils.ts
│
│   ├── harness/                  # Session monitoring
│   │   ├── monitor.ts            # Gateway polling + event emitters
│   │   ├── sessionTracker.ts     # Per-session lifecycle tracking
│   │   └── toolAnalyzer.ts       # Per-tool pattern analysis
│
│   ├── evaluator/                # Scoring + pattern detection
│   │   ├── scorer.ts             # PerformanceScore computation
│   │   ├── patternDetector.ts    # FailurePattern clustering
│   │   └── reportGenerator.ts    # EvaluationReport assembly
│
│   ├── builder/                   # Skill synthesis
│   │   ├── templateLibrary.ts    # SKILL.md template registry
│   │   ├── skillGenerator.ts    # Generate skill from failure
│   │   └── skillValidator.ts     # Pre-experiment validation
│
│   ├── experiment/               # A/B testing
│   │   ├── runner.ts             # Session spawning + polling
│   │   ├── comparator.ts         # Two-proportion z-test
│   │   ├── promoter.ts           # Promotion decision logic
│   │   └── index.ts              # Re-exports
│
│   └── memory/                   # Persistence
│       ├── store.ts              # JSON file store (MemoryStore)
│       ├── failureCorpus.ts      # FailurePattern persistence
│       ├── improvementLog.ts      # Append-only event log
│       └── index.ts              # Re-exports
│
├── dashboard/                    # Vite + React dashboard
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx               # Dashboard UI
│       ├── api/
│       │   └── evoClient.ts      # Fetches /api/* endpoints
│       └── types.ts              # Shared with src/types.ts
│
└── docs/                        # This documentation
    ├── ARCHITECTURE.md
    ├── SELF_IMPROVEMENT.md
    ├── ADDING_TEMPLATES.md
    └── API.md
```

---

## Key Type Relationships

```
SessionMetrics (per session from gateway)
    └─ ToolCall[] (each tool invocation)
            └─ success, error, latency

FailurePattern (grouped from ToolCall errors)
    └─ FailureContext[] (session context snapshots)

GeneratedSkill (produced from FailurePattern)
    ├─ SkillExample[]
    ├─ confidence: number (0-1)
    └─ status: 'proposed' | 'testing' | 'deployed' | 'rejected' | 'superseded'

Experiment (A/B test container)
    ├─ ExperimentTask[]
    ├─ controlResults: ExperimentResult[]
    └─ treatmentResults: ExperimentResult[]

StatisticalResult (output of comparator)
    ├─ confidence: number (0-1)
    ├─ improvementPct: number
    ├─ pValue: number
    └─ statisticallySignificant: boolean

PromotionDecision (output of promoter)
    ├─ promoted: boolean
    ├─ reason: string
    └─ experimentsValidated: number
```

---

## Gateway Integration

OpenClaw Evo communicates with the OpenClaw Gateway over HTTP:

| Direction | Method | Path | Purpose |
|---|---|---|---|
| Evo → Gateway | `GET` | `/api/sessions` | List sessions (for monitoring) |
| Evo → Gateway | `POST` | `/api/sessions` | Spawn experiment session |
| Evo → Gateway | `GET` | `/api/sessions/:id` | Poll session completion |
| Evo → Gateway | `GET` | `/api/dashboard/metrics` | Fetch gateway metrics for dashboard |
| Evo → Gateway | `GET` | `/api/health` | Health check |

The gateway URL is configured via `OPENCLAW_GATEWAY_URL` (default `http://localhost:18789`).

---

## Environment Variables

| Variable | Default | Affects |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | `http://localhost:18789` | Gateway connection |
| `OPENCLAW_POLL_INTERVAL_MS` | `10000` | Monitor polling frequency |
| `EXPERIMENT_SESSIONS` | `5` | Sessions per experiment arm |
| `EXPERIMENT_CONCURRENCY` | `4` | Parallel sessions within an arm |
| `SESSION_TIMEOUT_MS` | `120000` | Per-session timeout |
| `DEBUG` | (unset) | Enable debug logging when set |
