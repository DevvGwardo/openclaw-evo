# Adding Skill Templates

_Guide to extending OpenClaw Evo's skill synthesis capability_

---

## Overview

Skill templates are `SKILL.md`-flavored markdown documents stored in `src/builder/templateLibrary.ts`. Each template describes a category of skill (e.g., "API calls with retry logic") and provides a fill-in-the-blanks TypeScript implementation that gets instantiated when a matching `FailurePattern` is detected.

There are six built-in templates covering common failure types. You can add new ones by appending an entry to `TEMPLATE_LIBRARY` and, optionally, registering it in `selectTemplateType()` in `skillGenerator.ts`.

---

## The `SkillTemplate` Interface

```typescript
// src/types.ts

interface SkillTemplate {
  /** Human-readable name shown in logs and the dashboard */
  name: string;

  /** One-paragraph description of what this template produces */
  description: string;

  /** Phrases that should trigger this skill during session analysis */
  triggerPhrases: string[];

  /**
   * The skill implementation as a template string.
   * Supports the following placeholders (replaced at generation time):
   *
   *   {{TOOL_NAME}}          e.g. "EvoApiCaller"
   *   {{TOOL_NAME_CAMEL}}    e.g. "evoApiCaller"
   *   {{DESCRIPTION}}        from the GeneratedSkill description field
   *   {{TRIGGERS}}           bullet list of trigger phrases
   *   {{ERROR_TYPE}}         e.g. "timeout", "rate_limit", "network"
   *   {{EXAMPLE_IMPLEMENTATION}}  formatted from exampleTemplate
   */
  implementationTemplate: string;

  /** Used to populate {{EXAMPLE_IMPLEMENTATION}} */
  exampleTemplate: SkillExample;
}

interface SkillExample {
  input: string;          // what the user asks for
  expectedOutput: string;  // what the skill should produce
  explanation: string;     // why this is the right approach
}
```

---

## Template Library Structure

The library is a plain object at `src/builder/templateLibrary.ts`:

```typescript
// src/builder/templateLibrary.ts

import type { SkillTemplate } from '../types.js';

export const TEMPLATE_LIBRARY: Record<string, SkillTemplate> = {

  // ── Existing templates ─────────────────────────────────────────────────────
  data_processing: { ... },
  web_search:       { ... },
  file_manipulation:{ ... },
  code_review:      { ... },
  debugging:       { ... },
  api_call:        { ... },

  // ── Your new template ───────────────────────────────────────────────────────
  my_template_key: { /* SkillTemplate */ },
};
```

The **key** (`my_template_key`) is the template identifier passed to `getTemplate()` and matched against error types in `selectTemplateType()`.

---

## How to Add a New Template

### Step 1 — Choose a Template Key

Pick a lowercase `snake_case` identifier unique among existing keys. It should reflect the capability, not the error type (multiple error types can map to the same template).

### Step 2 — Design the Template

Ask yourself:
- What kind of failures am I solving?
- What input/output shape does the resulting tool have?
- What defensive behaviors (retry, validation, error wrapping) should it include?
- What placeholder values does it need?

### Step 3 — Add the Entry to `TEMPLATE_LIBRARY`

```typescript
// src/builder/templateLibrary.ts

import { TEMPLATE_LIBRARY } from './templateLibrary.js';
// Add the new entry:

export const TEMPLATE_LIBRARY: Record<string, SkillTemplate> = {

  // ... existing entries ...

  // ── Database Operations ─────────────────────────────────────────────────────
  database_query: {
    name: 'Database Query Skill',
    description:
      'Handles structured database queries with connection pooling, ' +
      'retry logic, and result set processing. Targets failures of type ' +
      '"connection_refused", "timeout", and "query_syntax".',

    triggerPhrases: [
      'query the database',
      'fetch from db',
      'run a query',
      'select from',
      'insert into database',
      'update records in',
      'delete from table',
    ],

    implementationTemplate: `# {{TOOL_NAME}} — Skill Implementation

{{DESCRIPTION}}

## Overview

This skill performs database operations with robust error handling,
retry logic, and connection management.

## Trigger Phrases

{{TRIGGERS}}

## Implementation

\`\`\`typescript
// {{TOOL_NAME}} implementation
// Generated from failure pattern analysis

interface QueryOptions {
  sql: string;
  params?: unknown[];
  timeoutMs?: number;
  retries?: number;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES   = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function executeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    sql,
    params = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  if (!sql || sql.trim().length === 0) {
    throw new Error('{{TOOL_NAME}}: Empty SQL statement');
  }

  // Basic SQL injection guard for non-parameterized queries
  if (!sql.includes('?')) {
    throw new Error(
      '{{TOOL_NAME}}: Query must use parameterized placeholders (?)'
    );
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const startTime = Date.now();

      // NOTE: In the actual OpenClaw environment, replace this with
      // the platform database client (e.g., postgres client).
      const result = await db.query({ sql, params, timeout: timeoutMs });

      return {
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable =
        /timeout|connection|ECONNREFUSED|ECONNRESET/i.test(lastError.message);

      if (isRetryable && attempt < retries) {
        await sleep(500 * Math.pow(2, attempt)); // exponential backoff
        continue;
      }
      break;
    }
  }

  throw new Error(
    \`{{TOOL_NAME}}: Query failed after \${retries} retries — \${lastError?.message}\`
  );
}

// Tool registration
export const {{TOOL_NAME_CAMEL}}Tool = {
  name: '{{TOOL_NAME}}',
  description: '{{DESCRIPTION}}',
  parameters: {
    sql:      { type: 'string',   required: true,  description: 'SQL query with ? placeholders' },
    params:  { type: 'array',     required: false, default: [] },
    timeoutMs:{ type: 'number',   required: false, default: 30000 },
    retries: { type: 'number',   required: false, default: 3 },
  },
  handler: executeQuery,
};
\`\`\`

## Error Handling

- **Empty SQL**: Rejected before any DB call
- **Non-parameterized queries**: Rejected to prevent SQL injection
- **Connection errors**: Retried with exponential backoff
- **Timeout**: Configurable per-call; defaults to 30s
- **Query syntax errors**: Propagated immediately (not retryable)

## Examples

{{EXAMPLE_IMPLEMENTATION}}
`,

    exampleTemplate: {
      input: 'Query the users table to find all records where active = true',
      expectedOutput: 'Array of user record objects with rowCount and durationMs',
      explanation:
        'The skill executes a parameterized SQL query, handles connection ' +
        'retry logic, and returns a structured result with the rows and metadata.',
    },
  },
};
```

### Step 4 — Register the Mapping in `selectTemplateType()`

Open `src/builder/skillGenerator.ts` and find `selectTemplateType()`. Add your new template key to the mapping:

```typescript
// src/builder/skillGenerator.ts

function selectTemplateType(pattern: FailurePattern): string {
  // existing mappings ...
  switch (pattern.errorType) {
    case 'timeout':      return 'api_call';
    case 'not_found':    return 'file_manipulation';
    case 'permission':   return 'file_manipulation';
    case 'rate_limit':   return 'api_call';
    case 'network':      return 'api_call';
    case 'syntax_error': return 'code_review';
    case 'query_syntax': return 'database_query';  // ← add this
    case 'connection':   return 'database_query';  // ← add this (maps DB connection errors)
    default:             return 'debugging';
  }
}
```

> **Tip:** If your template covers a generic error type, map it to `debugging` instead and let the generated skill handle it generically. Reserve dedicated templates for failure categories with distinct input/output shapes.

### Step 5 — (Optional) Add Pattern Detection for New Error Types

If your template targets a new error type not yet classified by `Hub.classifyError()`, update the switch in `hub.ts`:

```typescript
// src/hub.ts — classifyError() method

private classifyError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('not found') || lower.includes('enoent'))  return 'not_found';
  if (lower.includes('permission') || lower.includes('denied')) return 'permission';
  if (lower.includes('rate limit') || lower.includes('429'))  return 'rate_limit';
  if (lower.includes('network') || lower.includes('fetch'))     return 'network';
  if (lower.includes('syntax') || lower.includes('parse'))      return 'syntax_error';
  // ↓ new classification
  if (lower.includes('sql') || lower.includes('database') ||
      lower.includes('relation') || lower.includes('psycopg2'))  return 'query_syntax';
  return 'unknown';
}
```

---

## Placeholder Reference

All placeholders are replaced via simple string substitution before the skill is validated and written to disk.

| Placeholder | Example output | Where to use |
|---|---|---|
| `{{TOOL_NAME}}` | `EvoDataProcessor` | Class names, tool `name` field, error prefixes |
| `{{TOOL_NAME_CAMEL}}` | `evoDataProcessor` | Variable/function names in camelCase |
| `{{DESCRIPTION}}` | `Handles data transformation...` | Tool `description` field |
| `{{TRIGGERS}}` | `- process data\n- transform data...` | Bulleted list in implementation |
| `{{ERROR_TYPE}}` | `timeout` | Error-wrapping messages, comments |
| `{{EXAMPLE_IMPLEMENTATION}}` | Full formatted example block | Appended at end of template |

---

## Template Quality Checklist

Before committing a new template, verify:

- [ ] `name` is ≤ 64 characters
- [ ] `description` is ≤ 500 characters
- [ ] `triggerPhrases` has at least **2** entries (required by `SkillValidator`)
- [ ] `implementationTemplate` contains `{{TOOL_NAME}}` at least once
- [ ] `implementationTemplate` contains a tool registration block with `name`, `description`, and `parameters`
- [ ] Error messages include the skill name as a prefix (e.g., `{{TOOL_NAME}}: ...`)
- [ ] The implementation has at least one retry or defensive guard
- [ ] `exampleTemplate` has all three fields (`input`, `expectedOutput`, `explanation`)
- [ ] The template key is registered in `selectTemplateType()` if you want it auto-selected
- [ ] Unit tests pass: `npm test`

---

## Template Utilities

The template library exposes helper functions for programmatic access:

```typescript
import {
  TEMPLATE_LIBRARY,
  getTemplate,
  getTemplateTypes,
  listTemplates,
} from './builder/templateLibrary.js';

// Get a specific template by key
const tmpl = getTemplate('web_search');
if (!tmpl) throw new Error('Template not found');

// List all available template keys
const keys = getTemplateTypes(); // ['data_processing', 'web_search', ...]

// Human-readable list of all templates
const all = listTemplates();
// [
//   { type: 'data_processing', name: 'Data Processing Skill', description: '...' },
//   { type: 'web_search',      name: 'Web Search Skill',      description: '...' },
//   ...
// ]
```

---

## Example: Adding a `slack_notification` Template

This example shows a complete end-to-end addition for a new failure category: Slack API errors.

### The failure pattern

Your agent uses the `slack` tool and you see recurring failures like:
- `slack: rate_limit (429) when posting message`
- `slack: channel_not_found`

### Step 1 — Add the template

```typescript
// src/builder/templateLibrary.ts

export const TEMPLATE_LIBRARY: Record<string, SkillTemplate> = {

  // ... existing entries ...

  slack_notification: {
    name: 'Slack Notification Skill',
    description:
      'Sends Slack messages with rate-limit backoff, channel validation, ' +
      'and graceful degradation when Slack is unreachable.',

    triggerPhrases: [
      'send a slack message',
      'notify on slack',
      'post to slack channel',
      'slack alert',
      'message slack',
    ],

    implementationTemplate: `# {{TOOL_NAME}} — Skill Implementation

{{DESCRIPTION}}

## Overview

This skill sends Slack messages using the Slack API (web_fetch),
implementing rate-limit backoff and channel validation to prevent
\"{{ERROR_TYPE}}\" failures.

## Trigger Phrases

{{TRIGGERS}}

## Implementation

\`\`\`typescript
// {{TOOL_NAME}} implementation
// Generated from failure pattern analysis

interface SlackMessageOptions {
  channel: string;       // e.g. "#alerts" or "U123456"
  text: string;
  token?: string;         // Slack bot token; falls back to env SLACK_BOT_TOKEN
  retries?: number;
}

interface SlackResult {
  ok: boolean;
  ts?: string;           // message timestamp on success
  error?: string;        // Slack error code on failure
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableSlackError(error: string): boolean {
  return /rate_limited|service_unavailable|internal_error/i.test(error);
}

export async function sendSlackMessage(
  options: SlackMessageOptions,
): Promise<SlackResult> {
  const {
    channel,
    text,
    token = process.env.SLACK_BOT_TOKEN ?? '',
    retries = 3,
  } = options;

  if (!channel) throw new Error('{{TOOL_NAME}}: channel is required');
  if (!text)    throw new Error('{{TOOL_NAME}}: text is required');
  if (!token)   throw new Error('{{TOOL_NAME}}: SLACK_BOT_TOKEN is not set');

  const body = JSON.stringify({ channel, text });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await web_fetch({
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`,
          'Content-Type': 'application/json',
        },
        body,
      });

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;

      if (parsed['ok'] === true) {
        return { ok: true, ts: parsed['ts'] as string };
      }

      const slackError = parsed['error'] as string ?? 'unknown_error';

      if (isRetryableSlackError(slackError) && attempt < retries) {
        await sleep(1000 * Math.pow(2, attempt)); // exponential backoff
        continue;
      }

      // Non-retryable error (channel_not_found, etc.) — propagate immediately
      return { ok: false, error: slackError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRetryableSlackError(msg) && attempt < retries) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: 'max_retries_exceeded' };
}

// Tool registration
export const {{TOOL_NAME_CAMEL}}Tool = {
  name: '{{TOOL_NAME}}',
  description: '{{DESCRIPTION}}',
  parameters: {
    channel:  { type: 'string', required: true,  description: 'Slack channel ID or name' },
    text:     { type: 'string', required: true,  description: 'Message text (supports Slack markdown)' },
    token:    { type: 'string', required: false },
    retries:  { type: 'number', required: false, default: 3 },
  },
  handler: sendSlackMessage,
};
\`\`\`

## Error Handling

- **Missing token**: Throws before any API call
- **Rate limiting (429)**: Exponential backoff, up to `retries` attempts
- **Service unavailable (503)**: Treated as retryable
- **channel_not_found**: Propagated immediately — no point retrying
- **Network errors**: Retry with backoff

## Examples

{{EXAMPLE_IMPLEMENTATION}}
`,

    exampleTemplate: {
      input: 'Send a Slack message to #engineering saying "Deployment complete"',
      expectedOutput: '{ ok: true, ts: "1234567890.123456" }',
      explanation:
        'The skill calls the Slack web API with a bot token, applies ' +
        'exponential backoff on rate-limit responses, and returns the ' +
        'message timestamp on success or the Slack error code on failure.',
    },
  },
};
```

### Step 2 — Register the mapping

```typescript
// src/builder/skillGenerator.ts

function selectTemplateType(pattern: FailurePattern): string {
  switch (pattern.errorType) {
    case 'timeout':       return 'api_call';
    case 'not_found':     return 'file_manipulation';
    case 'permission':    return 'file_manipulation';
    case 'rate_limit':    return pattern.toolName === 'slack'
                              ? 'slack_notification'   // ← new mapping
                              : 'api_call';
    case 'network':       return 'api_call';
    case 'syntax_error':  return 'code_review';
    default:              return 'debugging';
  }
}
```

---

## Testing Your Template

```bash
# Run the unit test suite
npm test

# Run a specific test file
npx vitest run src/builder/templateLibrary.test.ts

# Manually list all templates registered in the library
node --input-type=module <<'EOF'
import { listTemplates } from './dist/builder/templateLibrary.js';
console.table(listTemplates());
EOF
```
