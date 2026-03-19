# API Reference

_HTTP endpoints exposed by the OpenClaw Evo API server (port 5174)_

---

## Base URL

```
http://localhost:5174
```

All endpoints return `Content-Type: application/json`. All responses include `Cache-Control: no-cache` and `Access-Control-Allow-Origin: *`.

---

## `GET /api/health`

Lightweight liveness check. Use to verify the server is running.

**Response `200 OK`**

```json
{
  "ok": true,
  "ts": "2026-03-19T12:59:00.000Z"
}
```

---

## `GET /api/status`

Returns the current runtime state of the EvoHub.

**Response `200 OK`**

```json
{
  "running": true,
  "currentCycle": {
    "id": "cycle-42-1742398740000",
    "cycleNumber": 42,
    "startedAt": "2026-03-19T12:54:00.000Z",
    "phases": {
      "monitor":    { "durationMs": 0,    "eventsProcessed": 0 },
      "evaluate":   { "durationMs": 312, "patternsFound": 5 },
      "build":      { "durationMs": 88,  "skillsProposed": 2 },
      "experiment":{ "durationMs": 1204, "experimentsRun": 2 },
      "integrate": { "durationMs": 45,  "improvementsDeployed": 1 }
    },
    "status": "completed",
    "completedAt": "2026-03-19T12:54:01.849Z"
  },
  "totalCyclesRun": 42,
  "lastCycleAt": "2026-03-19T12:54:01.849Z",
  "activeExperiments": 1,
  "deployedSkills": 11,
  "knownFailurePatterns": 24,
  "memorySize": 184320
}
```

**Fields**

| Field | Type | Description |
|---|---|---|
| `running` | `boolean` | Whether the hub's evolution loop is active |
| `currentCycle` | `EvolutionCycle \| undefined` | The most recently executed (or in-progress) cycle |
| `totalCyclesRun` | `number` | Cumulative count of completed cycles since start |
| `lastCycleAt` | `Date \| undefined` | ISO timestamp of last completed cycle |
| `activeExperiments` | `number` | Experiments currently in `pending` or `running` status |
| `deployedSkills` | `number` | Skills with status `deployed` |
| `knownFailurePatterns` | `number` | Total distinct failure patterns in the corpus |
| `memorySize` | `number` | Estimated size of the memory store directory in bytes |

**`EvolutionCycle.phases`**

| Phase | `durationMs` | Phase-specific field |
|---|---|---|
| `monitor` | ms spent monitoring | `eventsProcessed` |
| `evaluate` | ms spent evaluating | `patternsFound` |
| `build` | ms spent building skills | `skillsProposed` |
| `experiment` | ms spent running experiments | `experimentsRun` |
| `integrate` | ms spent integrating | `improvementsDeployed` |

**`EvolutionCycle.status`**

| Value | Meaning |
|---|---|
| `"running"` | Cycle is currently executing |
| `"completed"` | Cycle finished successfully |
| `"failed"` | Cycle threw an unhandled exception |

---

## `GET /api/skills`

Returns all skills proposed by the evolution system, including their current deployment status.

**Response `200 OK`**

```json
[
  {
    "id": "skill-evoDataProcessor-1742398000000",
    "name": "EvoDataProcessor",
    "description": "Handles structured data transformation, parsing, and aggregation tasks. Targets json_parse failures.",
    "triggerPhrases": [
      "process data",
      "transform data",
      "parse and format",
      "aggregate results"
    ],
    "implementation": "# EvoDataProcessor — Skill Implementation\n\n...",
    "examples": [
      {
        "input": "Parse and transform a list of user records from CSV to JSON",
        "expectedOutput": "Structured JSON array with parsed and validated records",
        "explanation": "The skill accepts raw CSV text, detects headers..."
      }
    ],
    "confidence": 0.73,
    "targetFailurePattern": "json-parse-failure",
    "generatedAt": "2026-03-19T10:00:00.000Z",
    "status": "deployed"
  },
  {
    "id": "skill-evoSlackNotifier-1742398740000",
    "name": "EvoSlackNotifier",
    "description": "Sends Slack messages with rate-limit backoff...",
    "triggerPhrases": [
      "send a slack message",
      "notify on slack"
    ],
    "implementation": "# EvoSlackNotifier — Skill Implementation\n\n...",
    "examples": [...],
    "confidence": 0.61,
    "targetFailurePattern": "slack-rate-limit",
    "generatedAt": "2026-03-19T12:54:00.000Z",
    "status": "testing"
  }
]
```

**`GeneratedSkill.status`**

| Value | Meaning |
|---|---|
| `"proposed"` | Generated; awaiting experiment |
| `"testing"` | Experiment in progress |
| `"deployed"` | Passed experiment; written to skills directory |
| `"rejected"` | Failed to pass experiment thresholds |
| `"superseded"` | Deployed but later replaced by a better experiment winner |

---

## `GET /api/experiments`

Returns all experiments tracked by the hub, including completed ones with statistical results.

**Response `200 OK`**

```json
[
  {
    "id": "exp-skill-evoDataProcessor-1742397600000",
    "name": "A/B: EvoDataProcessor",
    "description": "Comparing EvoDataProcessor (treatment) vs baseline",
    "controlSkillId": "baseline",
    "treatmentSkillId": "skill-evoDataProcessor-1742398000000",
    "taskSet": [
      {
        "id": "task-skill-evoDataProcessor-1742398000000-0",
        "description": "Parse and transform a list of user records from CSV to JSON",
        "taskType": "general",
        "difficulty": "easy"
      },
      {
        "id": "task-skill-evoDataProcessor-1742398000000-1",
        "description": "process data",
        "taskType": "general",
        "difficulty": "medium"
      }
    ],
    "status": "promoted",
    "controlResults": [
      {
        "taskId": "task-skill-evoDataProcessor-1742398000000-0",
        "success": true,
        "toolCalls": 4,
        "durationMs": 1823,
        "score": 85
      },
      {
        "taskId": "task-skill-evoDataProcessor-1742398000000-1",
        "success": false,
        "toolCalls": 2,
        "durationMs": 401,
        "errorMessage": "JSON parse error",
        "score": 0
      }
    ],
    "treatmentResults": [
      {
        "taskId": "task-skill-evoDataProcessor-1742398000000-0",
        "success": true,
        "toolCalls": 2,
        "durationMs": 945,
        "score": 92
      },
      {
        "taskId": "task-skill-evoDataProcessor-1742398000000-1",
        "success": true,
        "toolCalls": 2,
        "durationMs": 1102,
        "score": 88
      }
    ],
    "statisticalSignificance": 0.9721,
    "improvementPct": 42.86,
    "startedAt": "2026-03-19T09:55:00.000Z",
    "completedAt": "2026-03-19T09:56:30.000Z",
    "promotedAt": "2026-03-19T09:56:30.000Z"
  }
]
```

**`Experiment.status`**

| Value | Meaning |
|---|---|
| `"pending"` | Created but not yet started |
| `"running"` | Sessions are being executed |
| `"completed"` | All sessions done; awaiting promotion check |
| `"promoted"` | Passed statistical thresholds and deployed |
| `"rejected"` | Did not meet statistical thresholds |

**`ExperimentResult` (per-session result)**

| Field | Type | Description |
|---|---|---|
| `taskId` | `string` | Which task was run |
| `success` | `boolean` | Whether the session completed successfully |
| `toolCalls` | `number` | Number of tool invocations |
| `durationMs` | `number` | Wall-clock duration of the session |
| `errorMessage` | `string \| undefined` | Error reason if `success === false` |
| `score` | `number` | 0–100 quality score |

**Statistical fields**

| Field | Type | Description |
|---|---|---|
| `statisticalSignificance` | `number` (0–1) | `1 - pValue`; ≥ 0.95 means significant at p < 0.05 |
| `improvementPct` | `number` | Relative % improvement of treatment success rate over control |
| `completedAt` | `Date \| undefined` | When the experiment finished running |
| `promotedAt` | `Date \| undefined` | When the skill was deployed (only if `status === "promoted"`) |

---

## `GET /api/metrics`

Proxies the OpenClaw Gateway's dashboard metrics endpoint (`/api/dashboard/metrics`). This is the same data the OpenClaw dashboard displays — agent session counts, tool call volumes, error rates, etc.

The response shape depends on the Gateway version. In the default configuration the gateway returns a JSON object; if unreachable, the response is:

**Gateway reachable — `200 OK`** (shape depends on gateway version):

```json
{
  "totalSessions": 1284,
  "activeSessions": 3,
  "toolCallCount": 18432,
  "errorRate": 0.042,
  "avgSessionDurationMs": 34200,
  "sessionsByType": {
    "general": 900,
    "coding": 284,
    "research": 100
  }
}
```

**Gateway unreachable — `200 OK` (degraded):**

```json
{
  "error": "Gateway unreachable: Fetch failed"
}
```

> **Note:** This endpoint proxies without caching. It is designed for dashboard display; do not poll it faster than once per 10 seconds.

---

## Error Responses

All endpoints use standard HTTP status codes. On errors, the response body is:

```json
{
  "error": "Human-readable error message"
}
```

| Status | Meaning |
|---|---|
| `400` | Malformed request (should not occur for GET endpoints) |
| `404` | Route not found — check the URL path |
| `500` | Internal server error — check EvoHub logs |

---

## CORS

All endpoints set `Access-Control-Allow-Origin: *`, allowing browser-based dashboards and third-party consumers to fetch without restriction.

---

## Example: Fetching and Displaying with `curl`

```bash
# Health check
curl -s http://localhost:5174/api/health | jq

# Current hub status
curl -s http://localhost:5174/api/status | jq

# Deployed skills only
curl -s http://localhost:5174/api/skills \
  | jq '[.[] | select(.status == "deployed")]'

# Failed experiments
curl -s http://localhost:5174/api/experiments \
  | jq '[.[] | select(.status == "rejected")]'

# Metrics from the gateway (degraded if gateway is down)
curl -s http://localhost:5174/api/metrics | jq
```

---

## Example: JavaScript / TypeScript Client

```typescript
const BASE = 'http://localhost:5174';

async function getStatus() {
  const res = await fetch(`${BASE}/api/status`);
  if (!res.ok) throw new Error(`Status endpoint error: ${res.status}`);
  return res.json() as Promise<HubStatus>;
}

async function getDeployedSkills() {
  const skills = await fetch(`${BASE}/api/skills`).then(r => r.json() as Promise<GeneratedSkill[]>);
  return skills.filter(s => s.status === 'deployed');
}

async function getRecentExperiments(limit = 10) {
  const experiments = await fetch(`${BASE}/api/experiments`).then(
    r => r.json() as Promise<Experiment[]>
  );
  return experiments
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}
```

The dashboard at `dashboard/src/api/evoClient.ts` provides a ready-made client for all four endpoints.
