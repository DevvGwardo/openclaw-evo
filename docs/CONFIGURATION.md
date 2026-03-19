# Configuration Reference

All environment variables and configuration options supported by the OpenClaw Evolution system.

---

## Environment Variables

### Gateway Connection

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENCLAW_GATEWAY_URL` | Yes (remote) | `http://localhost:18789` | Base URL of the OpenClaw Gateway |
| `OPENCLAW_GATEWAY_TOKEN` | Yes (remote) | — | Bearer token for Gateway API authentication |
| `OPENCLAW_GATEWAY_TIMEOUT` | No | `30000` | HTTP request timeout to gateway in milliseconds |

### Evolution Engine

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVO_MAX_ITERATIONS` | No | `50` | Maximum number of evolution cycles before the evolver halts |
| `EVO_POPULATION_SIZE` | No | `10` | Number of candidate skills maintained in each generation |
| `EVO_MUTATION_RATE` | No | `0.15` | Probability (0–1) that a gene mutates during crossover |
| `EVO_CROSSOVER_RATE` | No | `0.7` | Probability (0–1) of crossover occurring between two parents |
| `EVO_ELITE_COUNT` | No | `2` | Number of top performers carried directly into the next generation |
| `EVO_MEMORY_DIR` | No | `~/.openclaw/evo-memory/` | Directory for evolution state and cached memory |
| `EVO_LOG_LEVEL` | No | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

### Skill Evaluation

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVO_EVAL_BATCH_SIZE` | No | `5` | Number of skills evaluated in parallel per cycle |
| `EVO_MIN_SCORE_THRESHOLD` | No | `0.75` | Minimum composite score required for a skill to be approved |
| `EVO_EVAL_TIMEOUT` | No | `120000` | Per-skill evaluation timeout in milliseconds |

### Deploy & Output

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVO_SKILLS_OUTPUT_DIR` | No | `~/.openclaw/skills/` | Destination directory for approved skills |
| `EVO_ARCHIVE_DIR` | No | `./archive` | Directory where superseded skill versions are archived |
| `EVO_DRY_RUN` | No | `false` | If `true`, approved skills are logged but not actually deployed |

---

## Config File (`evo.config.js`)

The evolver also reads a local config file at the repo root. Create `evo.config.js` to override defaults:

```js
// evo.config.js
module.exports = {
  gateway: {
    url: process.env.OPENCLAW_GATEWAY_URL,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    timeout: parseInt(process.env.OPENCLAW_GATEWAY_TIMEOUT) || 30000,
  },
  evolution: {
    maxIterations: 50,
    populationSize: 10,
    mutationRate: 0.15,
    crossoverRate: 0.7,
    eliteCount: 2,
  },
  evaluation: {
    batchSize: 5,
    minScoreThreshold: 0.75,
    timeout: 120000,
  },
  deploy: {
    outputDir: process.env.EVO_SKILLS_OUTPUT_DIR || `${process.env.HOME}/.openclaw/skills/`,
    archiveDir: './archive',
    dryRun: false,
  },
}
```

---

## Logging

Set `EVO_LOG_LEVEL` to control output verbosity:

```
debug  → Everything including gene-level crossover/mutation traces
info   → Cycle summaries, evaluation results, approvals
warn   → Degraded mutations, low scores, near-threshold decisions
error  → Only fatal errors (gateway unreachable, uncaught exceptions)
```

Log output goes to `logs/evoloop.log` (rotated daily). On CI, logs are also uploaded as workflow artifacts.

---

## GitHub Actions Variables

For CI environments, set the following in **Settings → Secrets and variables → Actions**:

| Variable | Description |
|---|---|
| `OPENCLAW_GATEWAY_URL` | Gateway base URL |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway bearer token |
| `EVO_MAX_ITERATIONS` | Override iteration cap in CI (optional) |
| `EVO_DRY_RUN` | Set to `true` in pull request CI runs to avoid side effects |

In workflow YAML, reference them as:
```yaml
env:
  OPENCLAW_GATEWAY_URL: ${{ secrets.OPENCLAW_GATEWAY_URL }}
  OPENCLAW_GATEWAY_TOKEN: ${{ secrets.OPENCLAW_GATEWAY_TOKEN }}
```
