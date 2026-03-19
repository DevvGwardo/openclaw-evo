# Usage Examples

Step-by-step walkthroughs for common OpenClaw Evolution workflows.

---

## Example 1: Add a Custom Skill Template

Skill templates define the initial population for evolution. Each template is a directory under `templates/` containing at minimum a `SKILL.md` and a `run.sh` (or `run.js`).

### Step 1 — Create the template directory

```bash
mkdir -p templates/my-custom-skill
```

### Step 2 — Write `SKILL.md`

```markdown
# My Custom Skill

## Description
A skill that does X, Y, and Z.

## Triggers
- "do something custom"

## Actions
- Action 1: ...
- Action 2: ...
```

### Step 3 — Write the runner (`run.sh` or `run.js`)

**`templates/my-custom-skill/run.sh`:**
```bash
#!/usr/bin/env bash
# $1 = skill name
# $2 = input payload (JSON)
# stdout = result JSON
echo '{"status":"ok","output":"done"}'
```

Or as a JS runner (**`run.js`**):
```js
// templates/my-custom-skill/run.js
const [, , skillName, input] = process.argv;
const payload = JSON.parse(input || '{}');
console.log(JSON.stringify({ status: 'ok', skillName, payload }));
```

### Step 4 — Register it in `templates/index.json`

```json
{
  "templates": [
    { "name": "my-custom-skill", "path": "templates/my-custom-skill", "enabled": true }
  ]
}
```

### Step 5 — Verify the template is loadable

```bash
node -e "
  const idx = require('./templates/index.json');
  const t = idx.templates.find(t => t.name === 'my-custom-skill');
  console.log('Template found:', t ? 'yes' : 'no');
"
```

The next evolution cycle will include this skill in its initial population automatically.

---

## Example 2: Run One Evolution Cycle Manually

You can trigger a single evaluation/evolution cycle without running the full loop.

### Option A — Run via CLI script

```bash
node scripts/run-cycle.js --template my-custom-skill --population-size 5
```

### Option B — Step through programmatically

```bash
node -e "
  const { EvoRunner } = require('./src/evoloop');
  const runner = new EvoRunner({ maxIterations: 1, dryRun: false });
  runner
    .init()
    .then(() => runner.runCycle())
    .then(report => {
      console.log('Cycle complete. Score:', report.compositeScore);
      console.log(JSON.stringify(report, null, 2));
    })
    .catch(err => { console.error(err); process.exit(1); });
"
```

### Output

A successful cycle prints a summary like:
```
[info] Cycle 1/1 started — population: 5
[info] Evaluating skill: skill-abc123 ... score: 0.82
[info] Evaluating skill: skill-def456 ... score: 0.71
[info] Top performer: skill-abc123 (0.82)
[info] Cycle complete — 1 approved, 0 archived
```

---

## Example 3: Interpret the Evaluation Report

After each cycle the evolver writes a JSON report to `reports/eval-<timestamp>.json`.

### Structure

```json
{
  "cycle": 3,
  "timestamp": "2026-03-19T13:00:00Z",
  "population": [
    {
      "skillId": "skill-abc123",
      "template": "my-custom-skill",
      "scores": {
        "accuracy": 0.91,
        "relevance": 0.78,
        "novelty": 0.65,
        "stability": 0.88
      },
      "compositeScore": 0.82,
      "verdict": "approved",
      "flags": []
    }
  ],
  "summary": {
    "total": 5,
    "approved": 1,
    "archived": 0,
    "avgScore": 0.74
  },
  "topPerformer": "skill-abc123"
}
```

### Key Fields

| Field | Meaning |
|---|---|
| `scores.accuracy` | How correctly the skill executes its defined actions |
| `scores.relevance` | Alignment with the target use-case prompt |
| `scores.novelty` | Structural or behavioral difference from existing approved skills |
| `scores.stability` | Consistency across multiple evaluation runs |
| `compositeScore` | Weighted average of the four scores |
| `verdict` | One of: `approved`, `archived`, `retained` |
| `flags` | Warnings such as `low-novelty`, `score-borderline`, `timeout` |

### Thresholds

- **`compositeScore >= 0.75`** (default) → skill is approved and deployed
- **`compositeScore < 0.75` but > 0.4** → skill is retained for next cycle
- **`compositeScore < 0.4`** → skill is archived (superseded)

---

## Example 4: Approve a Skill via API

You can approve a skill directly through the OpenClaw Gateway API without waiting for an evolution cycle.

### Prerequisites

- `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` set in your environment
- The skill must already exist in the evolver's working directory

### Approve by skill ID

```bash
curl -X POST \
  "${OPENCLAW_GATEWAY_URL}/api/v1/skills/approve" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"skillId": "skill-abc123", "reason": "manual-approval"}'
```

### Approve by skill ID (Node.js)

```js
const resp = await fetch(
  `${process.env.OPENCLAW_GATEWAY_URL}/api/v1/skills/approve`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ skillId: 'skill-abc123', reason: 'manual-approval' }),
  }
);
const result = await resp.json();
console.log('Approved:', result);
```

### Response

```json
{
  "success": true,
  "skillId": "skill-abc123",
  "deployedAt": "2026-03-19T13:05:00Z",
  "path": "~/.openclaw/skills/my-custom-skill/"
}
```

### List all approved skills

```bash
curl -s \
  "${OPENCLAW_GATEWAY_URL}/api/v1/skills" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}"
```

### Reject / Revoke a skill

```bash
curl -X POST \
  "${OPENCLAW_GATEWAY_URL}/api/v1/skills/revoke" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"skillId": "skill-abc123", "reason": "regression-detected"}'
```
