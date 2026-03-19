# Self-Improvement System

_How OpenClaw Evo learns from failure and grows its own capabilities_

---

## Overview

OpenClaw Evo's self-improvement system is a closed-loop feedback mechanism that watches your agent's behavior, identifies failure patterns, synthesizes new skills to address those failures, validates them through rigorous experiment, and deploys the winners — all without human intervention.

The loop runs continuously in the background (or on-demand via CLI). Each cycle produces measurable improvement in your agent's reliability, accuracy, and coverage.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EVOLUTION CYCLE (loop)                        │
│                                                                      │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌─────────────┐ │
│   │ MONITOR   │───▶│ EVALUATE │───▶│  BUILD   │───▶│  EXPERIMENT │ │
│   │           │    │          │    │          │    │             │ │
│   │ Capture   │    │ Score    │    │ Generate │    │ A/B test    │ │
│   │ sessions  │    │ sessions │    │ skills   │    │ skills      │ │
│   │ & failures│    │ & detect │    │ from     │    │ vs. control │ │
│   │           │    │ patterns │    │ failures │    │             │ │
│   └──────────┘    └──────────┘    └──────────┘    └──────┬──────┘ │
│                                                          │        │
│                                                   ┌──────▼──────┐ │
│                                                   │  INTEGRATE  │ │
│                                                   │             │ │
│   ┌───────────────────────────────────────────────│ Promote    │ │
│   │                                                │ winning    │ │
│   │                                                │ skills     │ │
│   └───────────────────────────────────────────────│ to deploy  │ │
│                                                     └────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Four Phases

### Phase 1 — Introspection (Monitor + Evaluate)

**What happens:** The harness intercepts every session and tool call your agent makes. Metrics are accumulated in memory and fed to the evaluator.

**Components involved:**
- `harness/monitor.ts` — polls the OpenClaw Gateway for new sessions
- `harness/sessionTracker.ts` — tracks per-session tool call lifecycles
- `evaluator/scorer.ts` — computes `PerformanceScore` across sessions
- `evaluator/patternDetector.ts` — clusters tool failures into `FailurePattern` objects

**Scoring dimensions:**

| Dimension | What it measures | Signal source |
|---|---|---|
| **Accuracy** | Task correctness | Session success flag |
| **Efficiency** | Tool calls vs. optimal | Tool call count per session |
| **Speed** | Wall-clock time vs. baseline | Session start/end timestamps |
| **Reliability** | Error-free rate | Error count per session |
| **Coverage** | % of task types handled | Task type labels on sessions |

```typescript
// PerformanceScore — output of the evaluator
interface PerformanceScore {
  accuracy: number;    // 0-100
  efficiency: number;  // 0-100
  speed: number;       // 0-100
  reliability: number; // 0-100
  coverage: number;   // 0-100
  overall: number;     // weighted average (40/20/15/15/10)
}
```

**Failure pattern detection:** The `PatternDetector` groups errors by:
- `toolName` — which tool failed
- `errorType` — classified via keyword matching (timeout, not_found, permission, rate_limit, network, syntax_error, unknown)
- `errorMessage` hash — normalized by replacing digits and whitespace, then base64-truncated to group near-duplicate messages

```typescript
// FailurePattern — persisted to the failure corpus
interface FailurePattern {
  id: string;
  toolName: string;
  errorType: string;
  errorMessage: string;       // normalized, max 200 chars
  frequency: number;           // occurrences seen
  severity: 'low' | 'medium' | 'high' | 'critical';
  exampleContexts: FailureContext[]; // last 5 contexts
  firstSeen: Date;
  lastSeen: Date;
  autoFixAvailable: boolean;
  suggestedFix?: string;
}
```

---

### Phase 2 — Tool Synthesis (Build)

**What happens:** The `SkillGenerator` takes each failure pattern that exceeds `FAILURE_THRESHOLD` occurrences and generates a new `GeneratedSkill` targeting that specific failure.

**Generation pipeline:**

```
FailurePattern
    │
    ▼
selectTemplateType(pattern)     // picks template best suited to error type
    │
    ▼
fillTemplate(template, pattern)  // substitutes placeholders
    │
    ▼
computeConfidence(pattern)       // scores 0-1 based on pattern severity & frequency
    │
    ▼
validate(skill)                  // schema-check; skip if invalid
    │
    ▼
GeneratedSkill (status: 'proposed')
```

**Template selection logic:**

| Error type | Template chosen |
|---|---|
| `timeout` | `api_call` (adds retries + backoff) |
| `not_found` | `file_manipulation` (adds path validation) |
| `permission` | `file_manipulation` (adds permission checks) |
| `rate_limit` | `api_call` (adds backoff + concurrency limits) |
| `network` | `api_call` (adds timeout + retry) |
| `syntax_error` | `code_review` or `data_processing` |
| `unknown` | `debugging` (generic diagnosis + fix) |

**Confidence scoring:**

```typescript
function computeConfidence(pattern: FailurePattern): number {
  const severityScore =
    ({ critical: 0.4, high: 0.3, medium: 0.2, low: 0.1 })[pattern.severity] ?? 0;
  const frequencyScore = Math.min(pattern.frequency / 20, 0.4); // cap at 20 occurrences
  const recencyBonus = Date.now() - pattern.lastSeen.getTime() < 86400000 ? 0.2 : 0;
  return Math.min(severityScore + frequencyScore + recencyBonus, 1.0);
}
```

**Placeholder substitution in templates:**

| Placeholder | Value |
|---|---|
| `{{TOOL_NAME}}` | e.g. `EvoDataProcessor` |
| `{{TOOL_NAME_CAMEL}}` | e.g. `evoDataProcessor` |
| `{{DESCRIPTION}}` | From generated skill description |
| `{{TRIGGERS}}` | Bulleted list of trigger phrases |
| `{{ERROR_TYPE}}` | `pattern.errorType` |
| `{{EXAMPLE_IMPLEMENTATION}}` | Formatted from `exampleTemplate` |

**Validation gates:** Before a skill is proposed, `SkillValidator` checks:
- `name` is non-empty, ≤ 64 chars, no spaces or special chars
- `description` is non-empty, ≤ 500 chars
- `triggerPhrases` has at least 2 entries
- `implementation` is non-empty and contains the tool name
- `confidence` is between 0 and 1

---

### Phase 3 — Recursive Improvement (Experiment)

**What happens:** Each proposed skill is evaluated in an A/B experiment against a baseline (either the existing skill or "no skill" for net-new capabilities).

**Experiment structure:**

```
Experiment
  ├── controlResults: ExperimentResult[]   // baseline sessions
  └── treatmentResults: ExperimentResult[] // new skill sessions

ExperimentResult (per session)
  ├── taskId
  ├── success: boolean
  ├── toolCalls: number
  ├── durationMs: number
  ├── errorMessage?: string
  └── score: number
```

**Session spawning:**
- Sessions are spawned via the OpenClaw Gateway sessions API (`POST /api/sessions`)
- Each arm runs `EXPERIMENT_SESSIONS` (default: 5) sessions per task
- Sessions poll for completion status every `OPENCLAW_POLL_INTERVAL_MS` (default: 10s)
- If the gateway is unreachable, a deterministic mock generates plausible results so experiments still run in CI/isolated environments

**Task generation:** For each skill, a task set is built from:
1. The skill's `examples` (easy/medium difficulty)
2. Trigger phrase invocations (medium difficulty, padded to fill session slots)

**Statistical testing — Two-Proportion Z-Test:**

```typescript
// comparator.ts — two-proportion z-test
function twoProportionZTest(
  nControl: number,    xControl: number,    // n = sessions, x = successes
  nTreatment: number, xTreatment: number,
): { zScore: number; pValue: number; pooledP: number; standardError: number }
```

- **Null hypothesis (H₀):** `p_control = p_treatment` (no difference)
- **Alternative (H₁):** `p_treatment ≠ p_control` (two-tailed)
- **Test statistic:** `z = (p₂ − p₁) / √(p̂(1−p̂)(1/n₁ + 1/n₂))`
  where `p̂ = (x₁ + x₂)/(n₁ + n₂)` (pooled proportion)
- **p-value:** `2 × (1 − Φ(|z|))` where Φ is the standard normal CDF

**Statistical significance requirements for promotion:**

| Requirement | Value | Reason |
|---|---|---|
| **Confidence threshold** | `≥ 0.95` (p < 0.05) | Conventional statistical significance |
| **Minimum improvement** | `≥ 10%` relative improvement | Practical significance — must beat baseline by enough to matter |
| **Both must pass** | — | Either failing = experiment rejected |

```typescript
// promoter.ts — decision logic
interface PromotionDecision {
  promoted: boolean;
  reason: string;
  experimentsValidated: number;
}

// Minimum improvement and confidence thresholds from config
MIN_IMPROVEMENT_PCT  = 10   // percent
STATISTICAL_CONFIDENCE = 0.95
```

**A/B test diagram:**

```
              ┌──────────────────────────────────────┐
              │         Experiment Runner             │
              │                                      │
  Skill ──────▶  ┌─────────────┐   ┌──────────────┐ │
                 │   CONTROL   │   │   TREATMENT   │ │
                 │  (baseline) │   │  (new skill)  │ │
                 │             │   │              │ │
                 │ EXP_SESSIONS│   │ EXP_SESSIONS │ │
                 │  sessions   │   │   sessions   │ │
                 └──────┬──────┘   └──────┬───────┘ │
                 │       │                │          │
                 │       ▼                ▼          │
                 │  successRate_C    successRate_T    │
                 │       │                │          │
                 │       └────────┬───────┘          │
                 │                ▼                   │
                 │     Two-Proportion Z-Test          │
                 │                │                   │
                 │     confidence, pValue, zScore      │
                 │                │                   │
                 │      ┌────────▼────────┐           │
                 │      │ Promotion Check │           │
                 │      │  p < 0.05 AND    │           │
                 │      │  improvement ≥10% │           │
                 │      └────────┬────────┘           │
                 │               │                    │
                 │     ┌─────────▼─────────┐          │
                 │     │ PROMOTED or REJECTED│          │
                 │     └────────────────────┘          │
                 └──────────────────────────────────────┘
```

---

### Phase 4 — Autonomous (Integrate)

**What happens:** Skills that pass the statistical gate are deployed to the OpenClaw skills directory, registered with the `SkillManager`, and logged to the `ImprovementLog`. The next evolution cycle will use the deployed skill as the new baseline.

**Deployment pipeline:**

```
Promoted experiment
      │
      ▼
write SKILL.md to SKILL_OUTPUT_DIR
      │
      ▼
register skill with SkillManager
      │
      ▼
log 'experiment_won' to ImprovementLog
      │
      ▼
skill.status → 'deployed'
      │
      ▼
Next cycle: this skill IS the new control arm
```

**ImprovementLog entries:**

```typescript
interface ImprovementEntry {
  id: string;
  timestamp: Date;
  type: 'skill_created' | 'skill_improved' | 'experiment_won' | 'experiment_lost' | 'auto_fix';
  description: string;
  skillId?: string;
  experimentId?: string;
  metrics?: {
    beforeScore?: number;
    afterScore?: number;
    improvementPct?: number;
  };
}
```

**Rejection paths:**
- Skill fails validation → skipped (not logged as failure)
- Experiment fails to run → logged as error, skill remains `proposed`
- Experiment runs but doesn't meet thresholds → logged, skill stays `testing`
- Skill is superseded by a better experiment winner → old skill marked `superseded`

---

## Failure-Pattern-to-Skill Pipeline (Complete)

```
Tool call fails in OpenClaw agent
         │
         ▼
  Monitor records failure
  (toolName, error, context)
         │
         ▼
  FailureCorpus.recordFailure()
  Groups by normalized error hash
  Increments frequency
         │
         ▼
  Next evolution cycle begins
         │
         ▼
  failureCorpus.getPatterns(FAILURE_THRESHOLD=3)
  Returns patterns with frequency ≥ 3
         │
         ┌──────────────────────────────────────┐
         │  For each qualifying pattern:         │
         │                                       │
         │  skillGenerator.generateFromFailure() │
         │       │                               │
         │       ├── selectTemplateType()        │
         │       ├── fillTemplate()              │
         │       ├── computeConfidence()         │
         │       └── validate()                  │
         │               │                      │
         │               ▼                      │
         │  GeneratedSkill { status: 'proposed' }│
         │               │                      │
         │               ▼                      │
         │  experimentRunner.runNewSkillExperiment()
         │       │                               │
         │       ├── run control arm             │
         │       ├── run treatment arm           │
         │       └── comparator.compare()        │
         │               │                      │
         │               ▼                      │
         │  StatisticalResult { confidence,     │
         │                     improvementPct }  │
         │               │                      │
         │               ▼                      │
         │  promoter.evaluate()                  │
         │    confidence ≥ 0.95 AND              │
         │    improvementPct ≥ 10%               │
         │               │                      │
         │      ┌────────┴────────┐             │
         │      │                 │              │
         │   PROMOTED         REJECTED          │
         │      │                 │              │
         │      ▼                 ▼              │
         │  deploy skill    log failure         │
         │  mark 'deployed' mark 'rejected'      │
         └──────────────────────────────────────┘
```

---

## Configuration Reference

| Config key | Default | Description |
|---|---|---|
| `CYCLE_INTERVAL_MS` | `300000` (5 min) | How often evolution cycles run |
| `FAILURE_THRESHOLD` | `3` | Min failure occurrences before generating a skill |
| `MAX_SKILLS_PER_CYCLE` | `3` | Max new skills proposed per cycle |
| `EXPERIMENT_SESSIONS` | `5` | Sessions per experiment arm |
| `MIN_IMPROVEMENT_PCT` | `10` | Min % improvement to promote |
| `STATISTICAL_CONFIDENCE` | `0.95` | Confidence threshold (p < 0.05) |
| `OPENCLAW_GATEWAY_URL` | `http://localhost:18789` | Gateway API URL |
| `OPENCLAW_POLL_INTERVAL_MS` | `10000` | Session poll interval |
| `SKILL_OUTPUT_DIR` | `~/.openclaw/skills/` | Where deployed skills are written |
| `MEMORY_DIR` | `~/.openclaw/evo-memory/` | Failure corpus + improvement log |

---

## CLI Usage

```bash
# Start the background hub (runs evolution cycles continuously)
openclaw-evo start

# Run a single evolution cycle on demand
openclaw-evo run-once

# Check hub status
openclaw-evo status

# Stop the background hub
openclaw-evo stop
```

---

## Monitoring

The built-in API server (port 5174) exposes real-time data:

```bash
# Hub status
curl http://localhost:5174/api/status

# All proposed skills and their statuses
curl http://localhost:5174/api/skills

# Active and completed experiments
curl http://localhost:5174/api/experiments

# Gateway metrics from OpenClaw
curl http://localhost:5174/api/metrics
```

The dashboard at `http://localhost:5174` visualizes all of the above.
