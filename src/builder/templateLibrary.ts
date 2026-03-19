/**
 * OpenClaw Evo — Skill Template Library
 *
 * Production-grade SKILL.md templates for common agent skill types.
 * Each template includes full markdown format with real, working code examples.
 */

export type TemplateCategory = 'web' | 'file' | 'shell' | 'api' | 'debug' | 'data';

export interface SkillExample {
  input: string;
  expectedOutput: string;
  explanation: string;
}

export interface SkillTemplate {
  name: string;
  description: string;
  category: TemplateCategory;
  triggerPhrases: string[];
  implementationTemplate: string;
  exampleTemplate: SkillExample;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Library
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATES: SkillTemplate[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Web Research
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Web Research',
    description: 'Perform web searches, parse results, and extract structured content from URLs.',
    category: 'web',
    triggerPhrases: [
      'search the web',
      'look up information about',
      'find current news on',
      'research',
      'check what the web says about',
    ],
    implementationTemplate: `# {SKILL_NAME} — Web Research Skill

## Overview

This skill enables OpenClaw agents to perform reliable web searches and extract
structured information from search results and web pages.

## When to Use

- Looking up current information, facts, or news
- Verifying external references or data points
- Researching topics across multiple web sources
- Fetching and summarizing content from specific URLs

## Trigger Phrases

- "search the web for [topic]"
- "look up information about [subject]"
- "find current news on [event]"
- "research [topic]"
- "check what the web says about [thing]"

## Setup

No API keys required — uses the built-in \`web_search\` and \`web_fetch\` tools
available in the OpenClaw environment.

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Web Research implementation

interface SearchOptions {
  query: string;
  maxResults?: number;        // 1-10, default 5
  language?: string;         // ISO 639-1, e.g. 'en'
  freshness?: 'day' | 'week' | 'month' | 'year';
  extractContent?: boolean;  // fetch full page text for each result
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;  // populated when extractContent=true
}

/**
 * Perform a web search and optionally extract full page content.
 */
export async function webResearch(options: SearchOptions): Promise<SearchResult[]> {
  const {
    query,
    maxResults = 5,
    language,
    freshness,
    extractContent = false,
  } = options;

  if (!query?.trim()) {
    throw new Error('webResearch: query cannot be empty');
  }
  if (query.length > 500) {
    throw new Error(\`webResearch: query too long (\${query.length}/500 chars)\`);
  }

  const results = await web_search({
    query: query.trim(),
    count: Math.min(maxResults, 10),
    language,
    freshness,
  });

  if (!results?.length) return [];

  if (!extractContent) {
    return results.map(r => ({
      title:   r.title   ?? '',
      url:     r.url     ?? '',
      snippet: r.snippet ?? '',
    }));
  }

  // Enrich with full page content — sequential to avoid rate limiting
  const enriched: SearchResult[] = [];
  for (const result of results) {
    try {
      const raw = await web_fetch({ url: result.url, maxChars: 8000 });
      enriched.push({
        title:   result.title   ?? '',
        url:     result.url     ?? '',
        snippet: result.snippet ?? '',
        content: typeof raw === 'string' ? stripAds(raw) : JSON.stringify(raw),
      });
    } catch {
      // One page failure shouldn't sink the whole search
      enriched.push({
        title:   result.title   ?? '',
        url:     result.url     ?? '',
        snippet: result.snippet ?? '',
      });
    }
  }
  return enriched;
}

/** Remove scripts, styles, comments, and HTML tags from fetched content. */
function stripAds(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format search results as a readable summary string.
 */
export function summarizeResults(results: SearchResult[], query: string): string {
  if (!results.length) return \`No results found for "\${query}".\`;
  const lines: string[] = [\`Search results for "\${query}":\\n\];
  results.forEach((r, i) => {
    lines.push(\`\${i + 1}. \${r.title}\`);
    lines.push(\`   URL: \${r.url}\`);
    lines.push(\`   \${r.snippet}\`);
    if (r.content) lines.push(\`   Preview: \${r.content.slice(0, 300)}...\`);
    lines.push('');
  });
  return lines.join('\\n');
}

export const WEB_RESEARCH_TOOL = {
  name: 'webResearch',
  description: 'Search the web and optionally extract full page content from results',
  parameters: {
    type: 'object',
    properties: {
      query:          { type: 'string',  description: 'Search query' },
      maxResults:     { type: 'number',  description: 'Max results (1-10)', default: 5 },
      language:       { type: 'string',  description: 'ISO 639-1 language code' },
      freshness:      { type: 'string',  enum: ['day', 'week', 'month', 'year'] },
      extractContent: { type: 'boolean', description: 'Fetch full page text per result', default: false },
    },
    required: ['query'],
  },
};
\`\`\`

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| Empty query | No search term | Return empty results |
| Query too long | >500 chars | Throw with clear limit message |
| Search API failure | Network/permission | Throw wrapped error |
| URL fetch failure | Page unavailable | Return result without content |

## Best Practices

- Set \`extractContent: false\` for quick lookups; \`true\` only when page body is needed
- Process results sequentially when fetching content to avoid rate limits
- Strip HTML tags from fetched content before using in downstream logic

## Examples

\`\`\`
Input:  webResearch({ query: "latest TypeScript release notes", maxResults: 5 })
Output: SearchResult[] with title, url, snippet for each result

Input:  webResearch({ query: "neural network quantization", extractContent: true })
Output: SearchResult[] with title, url, snippet, and stripped full-page content

Input:  summarizeResults(results, "EU AI regulation news")
Output: Formatted multi-line string summary of all results
\`\`\`
`,
    exampleTemplate: {
      input: 'search the web for "latest GPT-5 release announcements"',
      expectedOutput: 'Array of SearchResult objects with titles, URLs, snippets, and optional full content',
      explanation:
        'The skill accepts a natural-language query, calls web_search with appropriate parameters, ' +
        'and optionally enriches each result by fetching and cleaning the full page content. ' +
        'Results are returned as structured objects ready for summarization or further processing.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. File Manipulation
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'File Manipulation',
    description: 'Create, read, write, edit, and delete files with robust validation and safety guards.',
    category: 'file',
    triggerPhrases: [
      'read the file',
      'write to a file',
      'edit this file',
      'create a new file',
      'modify the file',
      'delete the file',
    ],
    implementationTemplate: `# {SKILL_NAME} — File Manipulation Skill

## Overview

This skill provides safe, validated file system operations for OpenClaw agents.
It wraps \`read\`, \`write\`, and \`edit\` with path validation, size limits,
and descriptive error handling.

## When to Use

- Reading source files, configs, or data files
- Writing generated code or structured output
- Editing existing files in-place (find-and-replace)
- Creating new files from templates or content
- Organizing workspace files

## Trigger Phrases

- "read the file at [path]"
- "write to a file [path] with [content]"
- "edit this file [path], replace [oldText] with [newText]"
- "create a new file [path]"
- "modify the file [path]"
- "delete the file [path]"

## Safety Limits

| Limit | Value | Reason |
|---|---|---|
| Max file size | 10 MB | Prevent memory exhaustion |
| Max path length | 4096 chars | OS limit |
| Dangerous patterns | Blocked | Prevent path traversal |

## Implementation

\`\`\`typescript
// {SKILL_NAME} — File Manipulation implementation

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_PATH_LEN  = 4096;

const DANGEROUS_PATTERNS: RegExp[] = [
  /\\.\\.(\\\/|$)/,           // path traversal
  /^\\/(etc|proc|sys|dev)/,  // system directories
  /^\\\\windows\\\\system32/i,
];

interface ReadOptions  { path: string; offset?: number; limit?: number; }
interface WriteOptions { path: string; content: string; }
interface EditOptions  { path: string; oldText: string; newText: string; }
interface DeleteOptions { path: string; trash?: boolean; }

function validatePath(path: string): void {
  if (!path?.trim()) throw new Error(\`{SKILL_NAME}: path is required\`);
  if (path.length > MAX_PATH_LEN) throw new Error(\`{SKILL_NAME}: path exceeds \${MAX_PATH_LEN} chars\`);
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(path)) throw new Error(\`{SKILL_NAME}: dangerous path rejected: \${path}\`);
  }
}

function validateContent(content: unknown): string {
  if (content === null || content === undefined)
    throw new Error(\`{SKILL_NAME}: cannot write null/undefined content\`);
  const str = String(content);
  if (str.length > MAX_FILE_SIZE)
    throw new Error(\`{SKILL_NAME}: content too large (\${str.length} bytes, max \${MAX_FILE_SIZE})\`);
  return str;
}

/** Read a file with optional byte offset and line limit. */
export async function readFile(opts: ReadOptions): Promise<string> {
  validatePath(opts.path);
  try {
    return await read({ path: opts.path, offset: opts.offset, limit: opts.limit });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`{SKILL_NAME}: read failed for "\${opts.path}" — \${msg}\`);
  }
}

/** Write content to a file, replacing existing content entirely. */
export async function writeFile(opts: WriteOptions): Promise<void> {
  validatePath(opts.path);
  const content = validateContent(opts.content);
  try {
    await write({ path: opts.path, content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`{SKILL_NAME}: write failed for "\${opts.path}" — \${msg}\`);
  }
}

/** Edit a file by replacing exact oldText with newText. */
export async function editFile(opts: EditOptions): Promise<void> {
  validatePath(opts.path);
  if (!opts.oldText?.length)
    throw new Error(\`{SKILL_NAME}: oldText is required — specify exact text to replace\`);
  try {
    await edit({ path: opts.path, oldText: opts.oldText, newText: opts.newText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`{SKILL_NAME}: edit failed for "\${opts.path}" — \${msg}\`);
  }
}

/** Delete a file. Set trash=true to move to system trash instead of permanent deletion. */
export async function deleteFile(opts: DeleteOptions): Promise<void> {
  validatePath(opts.path);
  const cmd = opts.trash ? \`mv "\${opts.path}" ~/.Trash/\` : \`rm "\${opts.path}"\`;
  try {
    await exec({ command: cmd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`{SKILL_NAME}: delete failed for "\${opts.path}" — \${msg}\`);
  }
}

/** List directory contents as an array of lines. */
export async function listDir(dirPath: string): Promise<string[]> {
  validatePath(dirPath);
  try {
    const result = await exec({ command: \`ls -la "\${dirPath}"\` });
    return String(result).split('\\n').filter(l => l.length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`{SKILL_NAME}: list failed for "\${dirPath}" — \${msg}\`);
  }
}

// Tool definitions
export const FILE_READ_TOOL = {
  name: 'readFile',
  description: 'Read file contents with optional line offset/limit',
  parameters: {
    type: 'object',
    properties: {
      path:   { type: 'string',  description: 'Absolute or relative file path' },
      offset: { type: 'number',  description: 'Line number to start from (1-indexed)' },
      limit:  { type: 'number',  description: 'Maximum number of lines to read' },
    },
    required: ['path'],
  },
};

export const FILE_WRITE_TOOL = {
  name: 'writeFile',
  description: 'Write or overwrite a file with string content',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'Target file path' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  },
};

export const FILE_EDIT_TOOL = {
  name: 'editFile',
  description: 'Replace exact oldText with newText in a file',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'Target file path' },
      oldText: { type: 'string', description: 'Exact text to find and replace' },
      newText: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'oldText'],
  },
};
\`\`\`

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| Empty path | Path not provided | Throw before I/O |
| Path too long | >4096 chars | Throw with limit info |
| Dangerous path | Contains \`../\` or system dir | Reject before I/O |
| Content too large | >10 MB | Reject with byte count |
| Edit not found | \`oldText\` doesn't match | Throw with exact oldText required |

## Security Notes

- Path traversal (\`../\`) and system directories are blocked unconditionally
- Prefer \`trash: true\` for deletions to enable recovery

## Examples

\`\`\`
Input:  readFile({ path: "src/utils.ts", offset: 10, limit: 50 })
Output: String — lines 10-60 of the file

Input:  writeFile({ path: "output.json", content: JSON.stringify(data, null, 2) })
Output: void — file written or overwritten

Input:  editFile({ path: "README.md", oldText: "# Old Title", newText: "# New Title" })
Output: void — in-place replacement of exact text
\`\`\`
`,
    exampleTemplate: {
      input: 'readFile({ path: "src/config.ts" }) then editFile to change port 3000 → 8080',
      expectedOutput: 'File read, targeted edit applied in-place without rewriting the whole file',
      explanation:
        'The skill reads the file, locates the exact text to replace, and applies a surgical edit. ' +
        'Only the targeted lines change; all other content is preserved exactly.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Bash Error Handler
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Bash Error Handler',
    description: 'Execute shell commands with robust error classification, timeout management, and optional retry.',
    category: 'shell',
    triggerPhrases: [
      'run the shell command',
      'execute this bash script',
      'run npm install',
      'run git status',
      'run a command in the shell',
    ],
    implementationTemplate: `# {SKILL_NAME} — Shell Command Execution Skill

## Overview

This skill wraps the \`exec\` tool with structured error classification, timeout
management, optional retry logic, and safe output parsing for shell commands.

## When to Use

- Running build scripts, linters, or or test suites
- Executing git commands, package manager operations
- Invoking any CLI tool from within an agent task
- Running multi-step shell pipelines

## Trigger Phrases

- "run the shell command [cmd]"
- "execute this bash script"
- "run [npm install, docker build, etc.]"
- "run git [subcommand]"
- "run a command in the shell"

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Shell Command Execution implementation

interface ExecOptions {
  command: string;
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  retryCount?: number;
  background?: boolean;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  command: string;
}

type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

interface ClassifiedError {
  severity: ErrorSeverity;
  category: string;
  diagnosis: string;
  hint: string;
  retryable: boolean;
}

const ERROR_SIGNATURES: Array<{
  pattern: RegExp;
  severity: ErrorSeverity;
  category: string;
  diagnosis: string;
  hint: string;
}> = [
  {
    pattern: /command not found|Command not found/,
    severity: 'high', category: 'not-found',
    diagnosis: 'Command executable not found in PATH',
    hint: 'Verify the command is installed and in PATH, or use the full absolute path',
  },
  {
    pattern: /permission denied|Permission denied|EACCES/,
    severity: 'high', category: 'permission',
    diagnosis: 'Insufficient file system permissions',
    hint: 'Check file permissions with ls -la; use chmod or run with elevated privileges',
  },
  {
    pattern: /No such file or directory|ENOENT|file not found/,
    severity: 'high', category: 'missing-file',
    diagnosis: 'A required file or directory does not exist',
    hint: 'Verify all file paths are correct and the working directory is as expected',
  },
  {
    pattern: /killed|TIME LIMIT|timeout|Signal: terminated/,
    severity: 'medium', category: 'timeout',
    diagnosis: 'Process exceeded its time limit',
    hint: 'Increase timeoutSec, simplify the command, or check for infinite loops',
  },
  {
    pattern: /heap out of memory|JavaScript heap|FATAL: kernel/i,
    severity: 'critical', category: 'memory',
    diagnosis: 'Process ran out of available memory',
    hint: 'Increase memory limits, reduce batch sizes, or use streaming',
  },
  {
    pattern: /ENOENT.*node_modules|npm err.*ENOENT/i,
    severity: 'high', category: 'missing-deps',
    diagnosis: 'Node module or dependency not found',
    hint: 'Run npm install or yarn install to populate node_modules',
  },
  {
    pattern: /ECONNREFUSED|Connection refused|ECONNRESET/,
    severity: 'high', category: 'network',
    diagnosis: 'Network connection could not be established',
    hint: 'Check network connectivity and that the target service is running',
  },
  {
    pattern: /merge conflict|CONFLICT/i,
    severity: 'low', category: 'git',
    diagnosis: 'Git operation blocked by unresolved merge conflicts',
    hint: 'Resolve conflicts manually, run git add + git commit to continue',
  },
];

function classifyError(stderr: string, stdout: string): ClassifiedError {
  const combined = stderr + '\\n' + stdout;
  for (const sig of ERROR_SIGNATURES) {
    if (sig.pattern.test(combined)) {
      return { ...sig, retryable: sig.category === 'network' || sig.category === 'timeout' };
    }
  }
  return {
    severity: 'medium', category: 'unknown',
    diagnosis: 'An unspecified error occurred',
    hint: 'Check stderr and stdout for details; retry may help for transient errors',
    retryable: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Execute a shell command with timeout, optional retry, and error classification.
 */
export async function runCommand(opts: ExecOptions): Promise<ExecResult> {
  const { command, cwd, timeoutSec = 120, env, retryCount = 0, background = false } = opts;

  if (!command?.trim()) throw new Error('{SKILL_NAME}: command cannot be empty');

  let lastError: ExecResult | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const startMs = Date.now();
    try {
      const raw = await exec({
        command, workdir: cwd, env,
        timeout: timeoutSec, background,
      });
      const output = typeof raw === 'string' ? raw : (raw?.output ?? JSON.stringify(raw));

      return {
        stdout:     output,
        stderr:     '',
        exitCode:   0,
        durationMs: Date.now() - startMs,
        timedOut:   false,
        command,
      };
    } catch (err) {
      const msg     = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|TIME LIMIT|signal|terminated/i.test(msg);
      const exitMatch = msg.match(/exit code[\\s:]+(\\d+)/i);
      const exitCode  = exitMatch ? parseInt(exitMatch[1]) : 1;

      const result: ExecResult = {
        stdout: '', stderr: msg, exitCode,
        durationMs: Date.now() - startMs,
        timedOut, command,
      };

      if (attempt < retryCount) {
        const delayMs = 1000 * Math.pow(2, attempt);
        console.warn(\`{SKILL_NAME}: attempt \${attempt + 1} failed, retrying in \${delayMs}ms\`);
        await sleep(delayMs);
        lastError = result;
        continue;
      }
      lastError = result;
    }
  }

  if (!lastError) throw new Error('{SKILL_NAME}: unexpected state after retries');
  const classified = classifyError(lastError.stderr, lastError.stdout);
  const error = new Error(
    \`{SKILL_NAME} [\${classified.category}/\${classified.severity}]: \${classified.diagnosis}\\n\${lastError.stderr}\\nHint: \${classified.hint}\`
  );
  (error as any).classified = classified;
  (error as any).result    = lastError;
  throw error;
}

/** Like runCommand but throws if exit code is non-zero. */
export async function runCommandStrict(opts: ExecOptions): Promise<ExecResult> {
  const result = await runCommand(opts);
  if (result.exitCode !== 0) {
    const classified = classifyError(result.stderr, result.stdout);
    throw new Error(
      \`{SKILL_NAME}: command exited with code \${result.exitCode}\\n\${result.stderr}\\n[\${classified.severity}] \${classified.hint}\`
    );
  }
  return result;
}

export const SHELL_COMMAND_TOOL = {
  name: 'runCommand',
  description: 'Execute a shell command with timeout, retry, and error classification',
  parameters: {
    type: 'object',
    properties: {
      command:    { type: 'string',  description: 'Shell command to execute' },
      cwd:        { type: 'string',  description: 'Working directory' },
      timeoutSec: { type: 'number',  default: 120,  description: 'Timeout in seconds' },
      retryCount: { type: 'number',  default: 0,    description: 'Retries on failure' },
      background: { type: 'boolean', default: false, description: 'Run in background' },
    },
    required: ['command'],
  },
};
\`\`\`

## Error Classification

| Category | Severity | Retryable | Examples |
|---|---|---|---|
| not-found | high | no | command not in PATH |
| permission | high | no | EACCES |
| missing-file | high | no | ENOENT |
| missing-deps | high | no | npm ENOENT |
| network | high | yes | ECONNREFUSED |
| timeout | medium | yes | process timed out |
| memory | critical | no | OOM |
| git | low | no | merge conflicts |

## Examples

\`\`\`
Input:  runCommand({ command: "git status", cwd: "/project" })
Output: ExecResult { stdout, stderr, exitCode: 0, durationMs, timedOut: false }

Input:  runCommand({ command: "npm install", timeoutSec: 300, retryCount: 2 })
Output: ExecResult on success; throws classified error on repeated failure

Input:  runCommandStrict({ command: "npx tsc --noEmit" })
Output: ExecResult; throws if tsc exits non-zero
\`\`\`
`,
    exampleTemplate: {
      input: 'runCommand({ command: "npm install --legacy-peer-deps", cwd: "/project", timeoutSec: 180, retryCount: 1 })',
      expectedOutput: 'ExecResult with stdout containing install log and exitCode 0 on success',
      explanation:
        'The skill executes npm install with a 180-second timeout, retries once on failure ' +
        '(useful for transient network issues), classifies any errors from stderr, and returns ' +
        'a structured result including duration and whether the process timed out.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. API Call
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'API Call',
    description: 'Make authenticated HTTP API requests with retry logic, rate limit handling, and response validation.',
    category: 'api',
    triggerPhrases: [
      'call the API',
      'make an HTTP request',
      'fetch data from',
      'POST to the API',
      'send a request to',
      'make a REST call',
    ],
    implementationTemplate: `# {SKILL_NAME} — API Call Skill

## Overview

This skill handles authenticated HTTP API requests with exponential backoff retry,
rate limit awareness, response validation, and structured error classification.

## When to Use

- Calling REST, GraphQL, or other HTTP APIs
- Making authenticated requests (Bearer tokens, API keys, basic auth)
- Fetching data that requires retry logic on transient failures
- Parsing JSON responses with graceful fallback

## Trigger Phrases

- "call the API at [url]"
- "make an HTTP [METHOD] request to [url]"
- "fetch data from [endpoint]"
- "POST to [endpoint] with [body]"
- "send a request to [url] with auth"

## Implementation

\`\`\`typescript
// {SKILL_NAME} — API Call implementation

interface ApiCallOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  expectedStatuses?: number[];
  auth?: AuthConfig;
}

interface AuthConfig {
  type: 'bearer' | 'basic' | 'api-key' | 'oauth2';
  token?: string;
  key?: string;
  header?: string;    // custom header name for api-key
  username?: string;
  password?: string;
}

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  durationMs: number;
  url: string;
}

class ApiCallError extends Error {
  constructor(
    public message: string,
    public url: string,
    public status?: number,
    public statusText?: string,
    public retryable: boolean = false,
    public responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

const DEFAULT_TIMEOUT           = 30_000;
const DEFAULT_RETRIES           = 3;
const DEFAULT_RETRY_DELAY_MS    = 1_000;
const DEFAULT_EXPECTED_STATUSES = [200, 201, 202, 204];

function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function isValidUrl(url: string): boolean {
  try { new URL(url); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function applyAuth(headers: Record<string, string>, auth?: AuthConfig): Record<string, string> {
  if (!auth) return headers;
  const h = { ...headers };
  switch (auth.type) {
    case 'bearer':
      if (auth.token) h['Authorization'] = \`Bearer \${auth.token}\`;
      break;
    case 'basic':
      if (auth.username && auth.password) {
        h['Authorization'] = \`Basic \${Buffer.from(\`\${auth.username}:\${auth.password}\`).toString('base64')}\`;
      }
      break;
    case 'api-key':
      h[auth.header ?? 'X-API-Key'] = auth.key ?? '';
      break;
    case 'oauth2':
      if (auth.token) h['Authorization'] = \`Bearer \${auth.token}\`;
      break;
  }
  return h;
}

async function parseBody<T>(response: Response): Promise<T> {
  const ct   = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!ct.includes('application/json') || !text.trim()) return text as unknown as T;
  try { return JSON.parse(text) as T; }
  catch { return text as unknown as T; }
}

/**
 * Make an HTTP API request with retry, auth, and timeout support.
 */
export async function apiCall<T = unknown>(options: ApiCallOptions): Promise<ApiResponse<T>> {
  const {
    url, method = 'GET', headers = {}, body,
    timeoutMs = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    expectedStatuses = DEFAULT_EXPECTED_STATUSES,
    auth,
  } = options;

  if (!isValidUrl(url)) throw new ApiCallError(\`Invalid URL: \${url}\`, url);

  const finalHeaders = applyAuth(headers, auth);
  let lastError: ApiCallError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const startMs = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions: RequestInit = { method, headers: finalHeaders, signal: controller.signal };
      if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startMs;

      if (!expectedStatuses.includes(response.status)) {
        const retryable = isRetryableStatus(response.status);
        const responseBody = await response.text().catch(() => '');
        const err = new ApiCallError(
          \`HTTP \${response.status} \${response.statusText}\${retryable ? ' (retryable)' : ''}\`,
          url, response.status, response.statusText, retryable, responseBody,
        );
        if (retryable && attempt < retries) {
          const delay = retryDelayMs * Math.pow(2, attempt);
          console.warn(\`{SKILL_NAME}: attempt \${attempt + 1} hit retryable status, waiting \${delay}ms\`);
          await sleep(delay);
          lastError = err;
          continue;
        }
        throw err;
      }

      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });

      return {
        ok: true, status: response.status, statusText: response.statusText,
        headers: respHeaders,
        body: await parseBody<T>(response),
        durationMs, url,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const apiErr = err instanceof ApiCallError ? err : new ApiCallError(
        isAbort ? \`Request timed out after \${timeoutMs}ms\` : (err instanceof Error ? err.message : String(err)),
        url, undefined, undefined, false,
      );
      if (apiErr.retryable && attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        console.warn(\`{SKILL_NAME}: attempt \${attempt + 1} failed (retryable), waiting \${delay}ms\`);
        await sleep(delay);
        lastError = apiErr;
        continue;
      }
      throw apiErr;
    }
  }
  throw lastError ?? new ApiCallError(\`{SKILL_NAME}: max retries (\${retries}) exceeded\`, url);
}

export const API_CALL_TOOL = {
  name: 'apiCall',
  description: 'Make authenticated HTTP requests with retry, timeout, and error classification',
  parameters: {
    type: 'object',
    properties: {
      url:        { type: 'string',  description: 'API endpoint URL' },
      method:     { type: 'string',  enum: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'], default: 'GET' },
      headers:    { type: 'object',  description: 'HTTP headers' },
      body:       { type: 'unknown', description: 'Request body (auto-stringified if object)' },
      timeoutMs:  { type: 'number',  default: 30000 },
      retries:    { type: 'number',  default: 3 },
      auth:       { type: 'object',  description: 'Authentication config' },
    },
    required: ['url'],
  },
};
\`\`\`

## Features

| Feature | Detail |
|---|---|
| Auth types | Bearer, Basic, API key (custom header), OAuth2 |
| Retry | Exponential backoff on 408/429/5xx |
| Timeout | Configurable AbortController timeout |
| Response parsing | JSON with text fallback |
| Error classification | Retryable vs. fatal errors distinguished |

## Examples

\`\`\`
Input:  apiCall({ url: "https://api.exampleTemplate.com/users", method: "GET", auth: { type: "bearer", token: "..." } })
Output: ApiResponse<User[]> — status, headers, parsed body

Input:  apiCall({ url: "https://api.exampleTemplate.com/posts", method: "POST", body: { title: "Hello" }, auth: { type: "api-key", key: "..." } })
Output: ApiResponse<CreatedPost>

Input:  apiCallInput:  apiCall({ url: "https://flaky-api.exampleTemplate.com/data", retries: 5, timeoutMs: 5000 })
Output: Retries up to 5 times with exponential backoff on 429/5xx, then throws ApiCallError
\`\`\`
`,
    exampleTemplate: {
      input: 'apiCall({ url: "https://api.github.com/users/octocat", method: "GET", auth: { type: "bearer", token: process.env.GH_TOKEN } })',
      expectedOutput: 'ApiResponse<GitHubUser> with status 200, headers, and parsed JSON body',
      explanation:
        'The skill makes an authenticated GET request, handles retry with exponential backoff ' +
        'for rate limit responses, parses the JSON body automatically, and returns a structured ' +
        'response including status, headers, and typed body data.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Code Debug
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Code Debug',
    description: 'Systematic error diagnosis, root cause analysis, and fix suggestion for code failures.',
    category: 'debug',
    triggerPhrases: [
      'debug this error',
      'what went wrong',
      'diagnose this failure',
      'find the root cause',
      'why did this crash',
      'fix this bug',
    ],
    implementationTemplate: `# {SKILL_NAME} — Code Debug Skill

## Overview

This skill performs systematic error diagnosis by matching error messages and stack
traces against a knowledge base of known failure patterns, then generates targeted
fixes or workarounds.

## When to Use

- When an operation fails and you need to understand why
- When debugging complex tool call failures or unhandled exceptions
- When analyzing error messages or stack traces from code
- When generating fixes for recurring error patterns

## Trigger Phrases

- "debug this error [error message]"
- "what went wrong here"
- "diagnose this failure [context]"
- "find the root cause of [issue]"
- "why did this crash [stack trace]"
- "fix this bug [description]"

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Code Debug implementation

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface DiagnosticResult {
  diagnosis: string;
  rootCause?: string;
  severity: Severity;
  category: string;
  fix?: string;
  workaround?: string;
  relatedPatterns: string[];
  confidence: number;  // 0.0 – 1.0
}

interface DebugOptions {
  error: string | Error;
  context?: Record<string, unknown>;
  includeFix?: boolean;
  includeWorkaround?: boolean;
}

const KNOWN_PATTERNS: Array<{
  signature: RegExp;
  diagnosis: string;
  rootCause: string;
  severity: Severity;
  category: string;
  fixTemplate: string;
  workaroundTemplate: string;
}> = [
  {
    signature: /ENOENT|no such file|file not found/i,
    diagnosis: 'File or directory not found',
    rootCause: 'The specified path does not exist, is misspelled, or lacks read permissions',
    severity: 'high', category: 'filesystem',
    fixTemplate: 'Verify: (1) path is correct and absolute/relative as needed, (2) file exists (ls), (3) spelling and case match exactly',
    workaroundTemplate: 'Use find to locate the file, or create it if it should exist',
  },
  {
    signature: /ECONNREFUSED|connection refused/i,
    diagnosis: 'Connection refused — target port is not accepting connections',
    rootCause: 'The service at the target host:port is not running or a firewall is blocking access',
    severity: 'critical', category: 'network',
    fixTemplate: 'Verify: (1) target service is running (curl or nc -zv host port), (2) correct host:port, (3) firewall rules',
    workaroundTemplate: 'Retry after confirming service is up; use cached data if available',
  },
  {
    signature: /timeout|timed out|ETIMEDOUT/i,
    diagnosis: 'Operation timed out',
    rootCause: 'The operation took longer than the configured or system timeout threshold',
    severity: 'medium', category: 'timeout',
    fixTemplate: 'Increase the timeout threshold if the operation is legitimate; otherwise optimize or paginate the operation',
    workaroundTemplate: 'Retry with exponential backoff, or split into smaller sequential operations',
  },
  {
    signature: /invalid (json|xml|yaml|input|argument|parameter)/i,
    diagnosis: 'Invalid input — data format or value is incorrect',
    rootCause: 'The provided input does not match the expected schema, format, or value constraints',
    severity: 'high', category: 'validation',
    fixTemplate: 'Review the format specification. Validate: (1) syntax correctness, (2) required fields present, (3) value types and ranges',
    workaroundTemplate: 'Provide default values or skip invalid input with a warning',
  },
  {
    signature: /permission denied|unauthorized|forbidden|403|EACCES/i,
    diagnosis: 'Permission denied — insufficient access rights',
    rootCause: 'The authenticated principal lacks required permissions for this operation',
    severity: 'high', category: 'auth',
    fixTemplate: 'Verify: (1) authentication token is valid, (2) principal has required roles, (3) resource IAM policies allow access',
    workaroundTemplate: 'Request elevated permissions or use a principal with correct roles',
  },
  {
    signature: /rate limit|429|too many requests/i,
    diagnosis: 'Rate limit exceeded',
    rootCause: 'API rate limit quota has been exhausted for this client/endpoint',
    severity: 'medium', category: 'rate-limit',
    fixTemplate: 'Implement backoff: (1) add delays between requests, (2) use Retry-After header value, (3) consider request batching',
    workaroundTemplate: 'Wait for rate limit window to reset, or use cached responses',
  },
  {
    signature: /null|null value|null reference|null pointer|Nil|NilClass|nil/i,
    diagnosis: 'Null/undefined value used where a non-null value was expected',
    rootCause: 'A null or undefined value was used in a context requiring a concrete value',
    severity: 'high', category: 'null',
    fixTemplate: 'Add null checks before use. Ensure values are initialized, null is handled explicitly, and APIs return expected data',
    workaroundTemplate: 'Provide default values or skip operations on null with appropriate logging',
  },
  {
    signature: /syntax error|SyntaxError|ParseError/i,
    diagnosis: 'Syntax error — code could not be parsed',
    rootCause: 'The code contains a syntactic error preventing it from being parsed or compiled',
    severity: 'critical', category: 'syntax',
    fixTemplate: 'Check the indicated line and surrounding context for mismatched brackets, quotes, or keyword typos',
    workaroundTemplate: 'Use a linter (ESLint, Prettier) to auto-format and identify syntax issues',
  },
  {
    signature: /type error|TypeError|cannot read property|cannot read.*undefined/i,
    diagnosis: 'Type error — accessing a property of null/undefined',
    rootCause: 'Code attempted to access a property or method on a null or undefined value',
    severity: 'high', category: 'type',
    fixTemplate: 'Add defensive null checks. Verify the value is initialized before access; check API response shapes',
    workaroundTemplate: 'Use optional chaining (?.) and nullish coalescing (??) operators',
  },
  {
    signature: /deadlock|circular dependency|circular import/i,
    diagnosis: 'Circular dependency detected',
    rootCause: 'Modules or dependencies form a circular import reference',
    severity: 'high', category: 'dependency',
    fixTemplate: 'Restructure imports to break the cycle; use lazy imports or dependency injection',
    workaroundTemplate: 'Delay import statements or move shared code to a third module',
  },
  {
    signature: /heap out of memory|JavaScript heap|FATAL:.*memory|OOM|OutOfMemory/i,
    diagnosis: 'Out of memory error',
    rootCause: 'Process exceeded available heap memory',
    severity: 'critical', category: 'memory',
    fixTemplate: 'Reduce memory usage: smaller batch sizes, streaming instead of loading all data, increase Node --max-old-space-size',
    workaroundTemplate: 'Process data in chunks, use streaming APIs, or increase system RAM',
  },
];

function classifySeverity(error: string, context?: Record<string, unknown>): Severity {
  if (context?.['severity']) return context['severity'] as Severity;
  if (/critical|fatal|emergency/i.test(error)) return 'critical';
  if (/error|exception/i.test(error)) return 'high';
  if (/warn/i.test(error)) return 'medium';
  return 'low';
}

/**
 * Diagnose an error and return structured diagnostic information.
 */
export function diagnoseError(options: DebugOptions): DiagnosticResult {
  const { error, context, includeFix = true, includeWorkaround = true } = options;
  const errorStr = error instanceof Error ? error.message : String(error);

  for (const pattern of KNOWN_PATTERNS) {
    if (pattern.signature.test(errorStr)) {
      return {
        diagnosis:    pattern.diagnosis,
        rootCause:     pattern.rootCause,
        severity:      classifySeverity(errorStr, context),
        category:      pattern.category,
        fix:           includeFix ? pattern.fixTemplate : undefined,
        workaround:    includeWorkaround ? pattern.workaroundTemplate : undefined,
        relatedPatterns: [pattern.signature.source],
        confidence:    0.9,
      };
    }
  }

  // Fuzzy match — lower confidence
  const keywords = errorStr.toLowerCase().split(/[\\s.,;:!?]+/).filter(w => w.length > 4);
  const matched = KNOWN_PATTERNS.filter(p =>
    keywords.some(k => p.signature.test(k))
  );

  return {
    diagnosis:    \`An error occurred: \${errorStr.slice(0, 200)}\`,
    rootCause:     'Unknown — no matching pattern in error knowledge base',
    severity:      classifySeverity(errorStr, context),
    category:      'unknown',
    fix:           includeFix ? 'Collect more context: verify inputs, check tool documentation, and examine the full error message' : undefined,
    workaround:    includeWorkaround ? 'Retry with additional error handling, or escalate to a human for unknown error patterns' : undefined,
    relatedPatterns: matched.map(p => p.signature.source),
    confidence:    matched.length > 0 ? 0.4 : 0.2,
  };
}

/**
 * Generate a human-readable diagnostic report.
 */
export function formatDiagnostic(d: DiagnosticResult): string {
  const lines = [
    \`Diagnosis:  \${d.diagnosis}\`,
    \`Severity:   \${d.severity.toUpperCase()} (\${d.category})\`,
    \`Confidence: \${Math.round(d.confidence * 100)}%\`,
    d.rootCause ? \`Root Cause: \${d.rootCause}\` : null,
    d.fix ? \`Fix:        \${d.fix}\` : null,
    d.workaround ? \`Workaround: \${d.workaround}\` : null,
  ].filter(Boolean);
  return lines.join('\\n');
}

export const CODE_DEBUG_TOOL = {
  name: 'diagnoseError',
  description: 'Diagnose code errors with root cause analysis, severity, and fix suggestions',
  parameters: {
    type: 'object',
    properties: {
      error:  { type: 'string',  description: 'Error message or Error object' },
      context: { type: 'object', description: 'Additional context (toolName, inputs, language, etc.)' },
      includeFix:      { type: 'boolean', default: true },
      includeWorkaround: { type: 'boolean', default: true },
    },
    required: ['error'],
  },
};
\`\`\`

## Error Coverage

| Category | Severity | Confidence |
|---|---|---|
| Filesystem (ENOENT) | high | 90% |
| Network (ECONNREFUSED) | critical | 90% |
| Timeout | medium | 90% |
| Validation errors | high | 90% |
| Auth/permission | high | 90% |
| Rate limit | medium | 90% |
| Null/undefined | high | 90% |
| Syntax errors | critical | 90% |
| Type errors | high | 90% |
| Circular dependencies | high | 90% |
| Out of memory | critical | 90% |
| Unknown | varies | 20-40% |

## Examples

\`\`\`
Input:  diagnoseError({ error: "ECONNREFUSED: Connection refused at port 8080" })
Output: DiagnosticResult { diagnosis, rootCause, severity: 'critical', category: 'network',
        fix, workaround, confidence: 0.9 }

Input:  formatDiagnostic(diagnoseError({ error: err }))
Output: Multi-line human-readable diagnostic report

Input:  diagnoseError({ error: "TypeError: Cannot read property 'id' of undefined", context: { language: 'typescript' } })
Output: DiagnosticResult { category: 'type', severity: 'high', fix with optional chaining suggestion }
\`\`\`
`,
    exampleTemplate: {
      input: 'diagnoseError({ error: new Error("ENOENT: no such file or directory, open \'/app/config.yml\'"), context: { cwd: "/app" } })',
      expectedOutput: 'DiagnosticResult with diagnosis "File or directory not found", rootCause, severity high, fix and workaround',
      explanation:
        'The skill matches the error against known patterns (ENOENT), identifies it as a filesystem ' +
        'issue, and returns a structured diagnostic with severity, root cause explanation, ' +
        'a concrete fix checklist, and a workaround.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Data Processing
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Data Processing',
    description: 'Transform, parse, and aggregate structured data (CSV, JSON, XML) with validation and error recovery.',
    category: 'data',
    triggerPhrases: [
      'process this data',
      'transform this data',
      'parse and format',
      'aggregate results',
      'convert data format',
    ],
    implementationTemplate: `# {SKILL_NAME} — Data Processing Skill

## Overview

This skill handles structured data transformation, parsing, and aggregation for
CSV, JSON, and XML formats with built-in validation and error recovery.

## When to Use

- Parsing and transforming structured data (JSON, CSV, XML)
- Reformatting data from one structure to another
- Aggregating results from multiple sources
- Validating data schemas
- Processing logs or semi-structured text

## Trigger Phrases

- "process this data [content]"
- "transform [data] from [format] to [format]"
- "parse and format [raw data]"
- "aggregate results from [sources]"
- "convert [data] to [target format]"

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Data Processing implementation

type DataFormat = 'json' | 'csv' | 'tsv' | 'xml' | 'text';

interface DataProcessorConfig {
  inputFormat:  DataFormat;
  outputFormat: DataFormat;
  delimiter?: string;    // for CSV/TSV, default ','
  headers?:    boolean;  // for CSV, default true
  strict?:     boolean;  // throw on parse errors, default false
}

interface ProcessingResult<T = unknown> {
  data: T;
  meta: {
    inputFormat:  DataFormat;
    outputFormat: DataFormat;
    recordCount?: number;
    durationMs:   number;
    errors:       string[];
  };
}

// ─── Parsers ────────────────────────────────────────────────────────────────

function parseCSV(input: string, opts: DataProcessorConfig): Record<string, string>[] {
  const delim = opts.delimiter ?? ',';
  const lines = input.trim().split(/\\r?\\n/);
  if (!lines.length) return [];

  const headers = opts.headers !== false
    ? lines[0].split(delim).map(h => h.trim().replace(/^["']|["']$/g, ''))
    : [];

  const data: Record<string, string>[] = [];
  const errors: string[] = [];

  const startIdx = opts.headers !== false ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(delim).map(v => v.trim().replace(/^["']|["']$/g, ''));
    if (headers.length) {
      const row: Record<string, string> = {};
      headers.forEach((h, j) => { row[h] = values[j] ?? ''; });
      data.push(row);
    } else {
      data.push({ _line: line, _index: String(i - startIdx) });
    }
  }
  return data;
}

function parseJSON(input: string, strict = false): unknown {
  try {
    return JSON.parse(input);
  } catch (err) {
    if (strict) throw err;
    return { _raw: input, _parseError: err instanceof Error ? err.message : String(err) };
  }
}

function parseXML(input: string): Record<string, unknown> {
  // Minimal XML parser — handles well-formed single-root XML
  const result: Record<string, unknown> = {};
  const tagRe = /<([a-zA-Z_][\\w.-]*)([^>]*)>([\\s\\S]*?)<\\/\\1>/g;
  const selfClosingRe = /<([a-zA-Z_][\\w.-]*)([^>]*)\\/>/g;
  let match;

  // Strip XML declaration
  const cleaned = input.replace(/<\\?xml[^>]*\\?>/, '').trim();

  while ((match = tagRe.exec(cleaned)) !== null) {
    const [, tag, attrs, content] = match;
    result[tag] = content.trim() || parseAttrs(attrs);
  }

  // Handle self-closing tags
  while ((match = selfClosingRe.exec(cleaned)) !== null) {
    const [, tag, attrs] = match;
    if (!result[tag]) result[tag] = parseAttrs(attrs);
  }

  return result;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\\w.-]*)\\s*=\\s*["']([^"']*)/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function toCSV(data: unknown, opts: DataProcessorConfig): string {
  if (!Array.isArray(data)) data = [data];
  if (!data.length) return '';
  const delim = opts.delimiter ?? ',';
  const headers = Object.keys(data[0] as Record<string, unknown>);
  const rows = data.map(row =>
    headers.map(h => {
      const val = String((row as Record<string, unknown>)[h] ?? '');
      return val.includes(delim) || val.includes('"') ? \`"\${val}"\` : val;
    }).join(delim)
  );
  return [headers.join(delim), ...rows].join('\\n');
}

function toJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ─── Main processor ─────────────────────────────────────────────────────────

/**
 * Process and transform data between supported formats.
 */
export function processData<T = unknown>(
  input: unknown,
  config: DataProcessorConfig,
): ProcessingResult<T> {
  const startMs = Date.now();
  const errors: string[] = [];

  if (input === null || input === undefined) {
    return { data: null as unknown as T, meta: { inputFormat: config.inputFormat, outputFormat: config.outputFormat, durationMs: 0, errors: ['Null input received'] } };
  }

  try {
    // Step 1: Normalize input to an intermediate object/array representation
    let intermediate: unknown;

    switch (config.inputFormat) {
      case 'json':
        intermediate = parseJSON(String(input), config.strict ?? false);
        break;
      case 'csv':
        intermediate = parseCSV(String(input), config);
        break;
      case 'tsv':
        intermediate = parseCSV(String(input), { ...config, delimiter: '\\t' });
        break;
      case 'xml':
        intermediate = parseXML(String(input));
        break;
      case 'text':
        intermediate = { raw: String(input), lines: String(input).split(/\\r?\\n/) };
        break;
      default:
        intermediate = input;
    }

    // Step 2: Format to output
    let output: unknown;
    switch (config.outputFormat) {
      case 'json': output = toJSON(intermediate); break;
      case 'csv':  output = toCSV(intermediate, config); break;
      case 'tsv':  output = toCSV(intermediate, { ...config, delimiter: '\\t' }); break;
      case 'xml':  output = \`<!-- converted from \${config.inputFormat} -->\${JSON.stringify(intermediate)}\`; break;
      default:     output = intermediate;
    }

    const recordCount = Array.isArray(intermediate) ? intermediate.length : 1;

    return {
      data: output as T,
      meta: {
        inputFormat:  config.inputFormat,
        outputFormat: config.outputFormat,
        recordCount,
        durationMs:   Date.now() - startMs,
        errors,
      },
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      data: null as unknown as T,
      meta: { inputFormat: config.inputFormat, outputFormat: config.outputFormat, durationMs: Date.now() - startMs, errors },
    };
  }
}

/**
 * Aggregate an array of objects by a key field, computing sum/count/avg.
 */
export function aggregateByKey(
  data: Record<string, unknown>[],
  groupBy: string,
  metrics: Array<{ field: string; op: 'sum' | 'count' | 'avg' | 'min' | 'max' }>,
): Record<string, Record<string, number>> {
  const groups: Record<string, Record<string, number[]>> = {};

  for (const row of data) {
    const key = String(row[groupBy] ?? '__null__');
    if (!groups[key]) groups[key] = {};
    for (const m of metrics) {
      if (!groups[key][m.field]) groups[key][m.field] = [];
      const val = row[m.field];
      if (m.op === 'count') {
        groups[key][m.field].push(val !== null && val !== undefined ? 1 : 0);
      } else {
        groups[key][m.field].push(Number(val) || 0);
      }
    }
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [key, fields] of Object.entries(groups)) {
    result[key] = {};
    for (const [field, vals] of Object.entries(fields)) {
      const metric = metrics.find(m => m.field === field)!;
      switch (metric.op) {
        case 'sum':   result[key][field] = vals.reduce((a, b) => a + b, 0); break;
        case 'count': result[key][field] = vals.reduce((a, b) => a + b, 0); break;
        case 'avg':   result[key][field] = vals.reduce((a, b) => a + b, 0) / vals.length; break;
        case 'min':   result[key][field] = Math.min(...vals); break;
        case 'max':   result[key][field] = Math.max(...vals); break;
      }
    }
  }
  return result;
}

export const DATA_PROCESSING_TOOL = {
  name: 'processData',
  description: 'Transform and convert structured data between JSON, CSV, TSV, XML, and text formats',
  parameters: {
    type: 'object',
    properties: {
      input:  { type: 'unknown', description: 'Data to process (string or object)' },
      config: {
        type: 'object',
        properties: {
          inputFormat:  { type: 'string', enum: ['json','csv','tsv','xml','text'] },
          outputFormat: { type: 'string', enum: ['json','csv','tsv','xml','text'] },
          delimiter:    { type: 'string',  default: ',' },
          headers:      { type: 'boolean', default: true },
          strict:       { type: 'boolean', default: false },
        },
        required: ['inputFormat', 'outputFormat'],
      },
    },
    required: ['input', 'config'],
  },
};
\`\`\`

## Supported Formats

| Format | Parse | Serialize |
|---|---|---|
| JSON | Yes (with fallback) | Yes (pretty-printed) |
| CSV | Yes (with header detection) | Yes |
| TSV | Yes | Yes |
| XML | Yes (basic) | Partial |
| Text | Yes (lines + raw) | N/A |

## Error Handling

- **Parse failures**: In non-strict mode, wraps raw input with \`_parseError\`
- **Strict mode**: Throws on first parse error
- **Null input**: Returns empty result with error message in meta
- **Non-array output**: Wrapped in array for CSV serialization

## Examples

\`\`\`
Input:  processData('{"name":"Alice","age":30}\\n{"name":"Bob","age":25}', { inputFormat: 'json', outputFormat: 'csv' })
Output: ProcessingResult { data: "name,age\\nAlice,30\\nBob,25", meta: { recordCount: 2 } }

Input:  aggregateByKey([{dept:"eng",salary:100},{dept:"eng",salary:120},{dept:"sales",salary:80}], 'dept', [{field:'salary',op:'avg'}])
Output: { eng: { salary: 110 }, sales: { salary: 80 } }
\`\`\`
`,
    exampleTemplate: {
      input: 'processData(csvRawString, { inputFormat: "csv", outputFormat: "json", headers: true })',
      expectedOutput: 'ProcessingResult with data as a JSON array of row objects, meta with recordCount and durationMs',
      explanation:
        'The skill parses CSV with header detection, normalizes to an intermediate object array, ' +
        'and serializes to formatted JSON. It handles parse errors gracefully, returns metadata ' +
        'about the processing, and can aggregate or transform as needed.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Git Workflow
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Git Workflow',
    description: 'Perform git operations including commits, branches, merges, and resolving conflicts.',
    category: 'shell',
    triggerPhrases: [
      'run git commit',
      'create a git branch',
      'merge branches',
      'resolve git conflicts',
      'check git status',
      'git push',
    ],
    implementationTemplate: `# {SKILL_NAME} — Git Workflow Skill

## Overview

This skill provides structured git operations with proper error handling, conflict
detection, and safe defaults for common workflows: commit, branch, merge, push, and pull.

## When to Use

- Making commits with descriptive messages
- Creating and switching branches
- Merging branches with conflict detection
- Resolving merge conflicts programmatically
- Checking repository status and history
- Pushing and pulling from remotes

## Trigger Phrases

- "run git commit [message]"
- "create a git branch [name]"
- "merge [source] into [target]"
- "resolve git conflicts in [files]"
- "check git status"
- "git push [remote] [branch]"

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Git Workflow implementation

// Reuses runCommand/runCommandStrict from the Bash Error Handler skill
async function gitRun(cmd: string, cwd?: string, timeoutSec = 60) {
  const { runCommandStrict } = await import('./bash-error.js');
  return runCommandStrict({ command: cmd, cwd, timeoutSec });
}

async function gitRunOutput(cmd: string, cwd?: string, timeoutSec = 30) {
  const { runCommand } = await import('./bash-error.js');
  return runCommand({ command: cmd, cwd, timeoutSec });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface GitBranchInfo {
  name: string;
  current: boolean;
  remote?: string;
}

// ─── Status ──────────────────────────────────────────────────────────────────

/** Get structured git status. */
export async function gitStatus(cwd?: string): Promise<GitStatusResult> {
  const result = await gitRunOutput('git status --porcelain=v1', cwd);

  const staged: string[] = [], modified: string[] = [], untracked: string[] = [], conflicted: string[] = [];

  for (const line of result.stdout.split('\\n')) {
    if (!line.trim()) continue;
    const [indexState, workTreeState, ...rest] = line;
    const filePath = rest.join('').replace(/^\\s+/, '').replace(/^["']|["']$/g, '');

    if (indexState === '?' && workTreeState === '?') { untracked.push(filePath); continue; }
    if (indexState === 'U' || workTreeState === 'U') { conflicted.push(filePath); continue; }
    if (indexState !== ' ' && indexState !== '?') staged.push(filePath);
    if (workTreeState !== ' ' && workTreeState !== '?' && workTreeState !== 'U') modified.push(filePath);
  }

  const branchResult = await gitRunOutput('git rev-parse --abbrev-ref HEAD', cwd);
  return {
    branch: branchResult.stdout.trim(),
    clean:  staged.length === 0 && modified.length === 0 && untracked.length === 0 && conflicted.length === 0,
    staged, modified, untracked, conflicted,
  };
}

// ─── Commit ──────────────────────────────────────────────────────────────────

/** Stage all changes and commit with a message. */
export async function gitCommit(message: string, cwd?: string, all = true): Promise<string> {
  if (!message?.trim()) throw new Error('{SKILL_NAME}: commit message is required');
  if (all) await gitRun('git add -A', cwd);

  const escaped = message.replace(/"/g, '\\\\"');
  const commitCmd = 'git commit -m "' + escaped + '"';
  const result = await gitRun(commitCmd, cwd);

  const hashMatch = result.stdout.match(/\\b([0-9a-f]{7,40})\\b/);
  return hashMatch ? hashMatch[1] : 'committed';
}

/** Amend the last commit (without changing its message). */
export async function gitCommitAmend(newMessage?: string, cwd?: string): Promise<string> {
  if (newMessage) {
    const escaped = newMessage.replace(/"/g, '\\\\"');
    const amendCmd = 'git commit --amend -m "' + escaped + '"';
    await gitRun(amendCmd, cwd);
  } else {
    await gitRun('git commit --amend --no-edit', cwd);
  }
  const result = await gitRunOutput('git rev-parse --short HEAD', cwd);
  return result.stdout.trim();
}

// ─── Branch ──────────────────────────────────────────────────────────────────

/** Create a new branch and optionally check it out. */
export async function gitCreateBranch(name: string, cwd?: string, checkout = false): Promise<void> {
  if (!name?.trim()) throw new Error('{SKILL_NAME}: branch name is required');
  if (!/^[a-zA-Z0-9_./-]+$/.test(name)) throw new Error(\`{SKILL_NAME}: invalid branch name "\${name}"\`);

  if (checkout) {
    await gitRun(\`git checkout -b "\${name}"\`, cwd);
  } else {
    await gitRun(\`git branch "\${name}"\`, cwd);
  }
}

/** List all local branches, optionally filtered. */
export async function gitListBranches(cwd?: string, all = false): Promise<GitBranchInfo[]> {
  const flag = all ? '-a' : '';
  const result = await gitRunOutput(\`git branch \${flag} --format="%(refname:short)|%(if:equals=HEAD)%(refname:short)%(then)*%(else)%(refname:short)%(end)|%(upstream:short)"\`, cwd);

  return result.stdout.split('\\n').filter(l => l.trim()).map(line => {
    const [nameAndCurrent, remote] = line.split('|');
    const [name, ...currentFlag] = nameAndCurrent.split('|');
    return {
      name: name.trim(),
      current: currentFlag.includes('*'),
      remote: remote?.trim() || undefined,
    };
  });
}

/** Switch to an existing branch. */
export async function gitCheckout(branchName: string, cwd?: string): Promise<void> {
  await gitRun(\`git checkout "\${branchName}"\`, cwd);
}

/** Delete a branch. */
export async function gitDeleteBranch(name: string, force = false, cwd?: string): Promise<void> {
  const flag = force ? '-D' : '-d';
  await gitRun(\`git branch \${flag} "\${name}"\`, cwd);
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/** Merge a branch into the current branch. */
export async function gitMerge(branch: string, cwd?: string, options?: { noFf?: boolean; abort?: boolean }): Promise<{ success: boolean; conflicts: string[] }> {
  const { noFf = false, abort = false } = options ?? {};

  if (abort) {
    await gitRun('git merge --abort', cwd);
    return { success: false, conflicts: [] };
  }

  const noFfFlag = noFf ? '--no-ff' : '';
  try {
    await gitRun(\`git merge \${noFfFlag} "\${branch}"\`, cwd, 120);
    return { success: true, conflicts: [] };
  } catch {
    const status = await gitStatus(cwd);
    return { success: false, conflicts: status.conflicted };
  }
}

// ─── Conflict Resolution ─────────────────────────────────────────────────────

/** Check for conflicted files. */
export async function getConflictedFiles(cwd?: string): Promise<string[]> {
  const status = await gitStatus(cwd);
  return status.conflicted;
}

/**
 * Resolve a conflict by accepting 'ours' version, 'theirs' version,
 * or a fully manual replacement string.
 */
export async function resolveConflict(
  filePath: string,
  resolution: 'ours' | 'theirs' | string,
  cwd?: string,
): Promise<void> {
  if (resolution === 'ours') {
    await gitRun(\`git checkout --ours "\${filePath}"\`, cwd);
  } else if (resolution === 'theirs') {
    await gitRun(\`git checkout --theirs "\${filePath}"\`, cwd);
  } else {
    // Write manual resolution — requires file write tool
    const { writeFile } = await import('./file-manipulation.js');
    await writeFile({ path: filePath, content: resolution });
  }
  await gitRun(\`git add "\${filePath}"\`, cwd);
}

/** Stage all resolved files and complete the merge with a commit. */
export async function completeMerge(message: string, cwd?: string): Promise<string> {
  await gitRun('git add -A', cwd);
  return gitCommit(message, cwd, false);
}

// ─── Push / Pull ─────────────────────────────────────────────────────────────

/** Push a branch to a remote. */
export async function gitPush(opts: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }, cwd?: string): Promise<void> {
  const { remote = 'origin', branch, force = false, setUpstream = false } = opts;

  const current = (await gitRunOutput('git rev-parse --abbrev-ref HEAD', cwd)).stdout.trim();
  const target = branch ?? current;
  const upstreamFlag = setUpstream ? '-u' : '';
  const forceFlag = force ? '--force' : '';

  await gitRun(\`git push \${forceFlag} \${upstreamFlag} "\${remote}" "\${target}"\`, cwd, 120);
}

/** Pull from a remote into the current branch. */
export async function gitPull(remote = 'origin', branch?: string, cwd?: string): Promise<void> {
  const target = branch ?? (await gitRunOutput('git rev-parse --abbrev-ref HEAD', cwd)).stdout.trim();
  await gitRun(\`git pull "\${remote}" "\${target}"\`, cwd, 120);
}

// ─── Log ─────────────────────────────────────────────────────────────────────

/** Get recent commit history as structured entries. */
export async function gitLog(count = 10, cwd?: string): Promise<GitLogEntry[]> {
  const format = '%H|%an|%ai|%s';
  const result = await gitRunOutput(\`git log --format="\${format}" -\${count}\`, cwd);

  return result.stdout
    .split('\\n')
    .filter(l => l.trim())
    .map(line => {
      const [hash, author, date, ...msgParts] = line.split('|');
      return { hash: hash?.trim() ?? '', author: author?.trim() ?? '', date: date?.trim() ?? '', message: msgParts.join('|').trim() };
    });
}

export const GIT_WORKFLOW_TOOL = {
  name: 'gitWorkflow',
  description: 'Perform git operations: status, commit, branch, merge, push, pull, and conflict resolution',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['status', 'commit', 'branch', 'checkout', 'merge', 'resolve', 'push', 'pull', 'log'],
        description: 'Git operation to perform',
      },
      args: { type: 'object', description: 'Operation-specific arguments' },
    },
    required: ['operation'],
  },
};
\`\`\`

## Error Handling

| Scenario | Behavior |
|---|---|
| Merge conflict | Returns \`{ success: false, conflicts: [...] }\` — does not throw |
| Invalid branch name | Validates against safe pattern before running git |
| Push rejected (non-fast-forward) | Throws — use \`force: true\` to override |
| No remote | Commands targeting remotes throw with helpful message |

## Examples

\`\`\`
Input:  gitStatus()
Output: GitStatusResult { branch, clean, staged[], modified[], untracked[], conflicted[] }

Input:  gitCommit("feat: add user authentication")
Output: Commit hash string

Input:  gitMerge("feature/login", { noFf: true })
Output: { success: true, conflicts: [] } or { success: false, conflicts: ['src/auth.ts'] }

Input:  resolveConflict('src/auth.ts', 'ours')
Output: void — ours version staged, conflict marked resolved

Input:  gitPush({ remote: 'origin', setUpstream: true })
Output: void — branch pushed and set as upstream
\`\`\`
`,
    exampleTemplate: {
      input: 'gitMerge("feature/new-feature", { noFf: true }) then resolveConflict("src/app.ts", "ours")',
      expectedOutput: 'Merge initiated, conflicts detected in src/app.ts, ours version accepted and staged',
      explanation:
        'The skill attempts a no-fast-forward merge, detects which files have conflicts, ' +
        'then resolves each by accepting the current branch version, stages the resolved files, ' +
        'and prepares for a merge commit.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Image Process
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Image Process',
    description: 'Analyze, transform, compress, and optimize images using the built-in image analysis tool.',
    category: 'data',
    triggerPhrases: [
      'analyze this image',
      'process the image',
      'optimize this image',
      'resize image',
      'compress image',
      'get image dimensions',
    ],
    implementationTemplate: `# {SKILL_NAME} — Image Process Skill

## Overview

This skill wraps the OpenClaw \`image\` tool for vision analysis and combines it
with metadata extraction and transformation utilities for common image tasks.

## When to Use

- Analyzing image content with AI vision models
- Extracting text from images (OCR-style via vision)
- Getting image dimensions, format, and file size
- Batch processing multiple images
- Validating image inputs before further processing

## Trigger Phrases

- "analyze this image [path/URL]"
- "process the image [description of what to look for]"
- "optimize this image [target format or size]"
- "resize image [dimensions]"
- "compress image [quality target]"
- "get image dimensions [path]"

## Setup

Uses the built-in \`image\` tool available in the OpenClaw environment.
No external dependencies required.

## Implementation

\`\`\`typescript
// {SKILL_NAME} — Image Process implementation

interface ImageAnalysisOptions {
  image: string;                       // file path or URL
  prompt: string;                      // vision prompt
  maxBytesMb?: number;                 // max image size in MB
}

interface ImageInfo {
  path: string;
  sizeBytes: number;
  format?: string;
}

interface BatchAnalysisResult {
  results: Array<{ image: string; analysis: string }>;
  errors: Array<{ image: string; error: string }>;
  totalMs: number;
}

// ─── Image Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze a single image with a natural-language prompt.
 * The OpenClaw image tool uses a vision model to describe or extract information from the image.
 */
export async function analyzeImage(opts: ImageAnalysisOptions): Promise<string> {
  const { image, prompt, maxBytesMb } = opts;

  if (!image?.trim()) throw new Error('{SKILL_NAME}: image path or URL is required');
  if (!prompt?.trim()) throw new Error('{SKILL_NAME}: analysis prompt is required');

  const options: { prompt: string; image?: string; maxBytesMb?: number } = { prompt };
  if (image.startsWith('http://') || image.startsWith('https://')) {
    options.image = image;
  } else {
    options.image = image;
  }
  if (maxBytesMb) options.maxBytesMb = maxBytesMb;

  const result = await image(options);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

// ─── Batch Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze multiple images sequentially (to avoid rate limits).
 */
export async function batchAnalyzeImages(
  images: string[],
  prompt: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<BatchAnalysisResult> {
  const results: Array<{ image: string; analysis: string }> = [];
  const errors: Array<{ image: string; error: string }> = [];
  const startMs = Date.now();

  for (let i = 0; i < images.length; i++) {
    try {
      const analysis = await analyzeImage({ image: images[i], prompt });
      results.push({ image: images[i], analysis });
    } catch (err) {
      errors.push({ image: images[i], error: err instanceof Error ? err.message : String(err) });
    }
    onProgress?.(i + 1, images.length);
  }

  return {
    results,
    errors,
    totalMs: Date.now() - startMs,
  };
}

// ─── Image Info (via file system) ─────────────────────────────────────────────

/** Get basic image info using file system stats and the image tool. */
export async function getImageInfo(imagePath: string): Promise<ImageInfo> {
  const fs = await import('fs/promises');
  const { stat } = fs;

  try {
    const s = await stat(imagePath);
    return {
      path: imagePath,
      sizeBytes: s.size,
      format: imagePath.split('.').pop()?.toLowerCase(),
    };
  } catch {
    return { path: imagePath, sizeBytes: 0, format: imagePath.split('.').pop()?.toLowerCase() };
  }
}

/**
 * Suggest optimal image format based on content type and size.
 */
export function suggestFormat(
  analysis: string,
  sizeBytes: number,
  currentFormat: string,
): { recommendedFormat: 'png' | 'jpeg' | 'webp' | 'gif'; reason: string } {
  const isPhoto = /photo|realistic|person|landscape|scene/i.test(analysis);
  const isDiagram = /chart|graph|diagram|plot|screenshot|ui|interface/i.test(analysis);
  const isAnimated = /animation|motion|gif|video/i.test(analysis);

  if (isAnimated) return { recommendedFormat: 'gif', reason: 'Animation or motion detected — GIF preserves animation' };
  if (isDiagram && sizeBytes > 500_000) return { recommendedFormat: 'png', reason: 'Diagram/screenshot with large file size — PNG offers lossless compression' };
  if (isPhoto && currentFormat !== 'png') return { recommendedFormat: 'jpeg', reason: 'Photo content detected — JPEG is optimal for photographic detail' };
  if (sizeBytes > 1_000_000 && currentFormat === 'png') return { recommendedFormat: 'webp', reason: 'Large PNG file — WebP offers superior compression with similar quality' };

  return { recommendedFormat: currentFormat as any, reason: 'Current format is appropriate for this content' };
}

/**
 * Extract a structured caption or description from an image analysis result.
 */
export function extractCaption(analysis: string): { caption: string; tags: string[]; hasText: boolean } {
  const hasText = /text|words|letters|writing|font/i.test(analysis);

  // Extract quoted strings as potential text content
  const quoted = analysis.match(/"([^"]{5,100})"/g)?.map(q => q.slice(1, -1)) ?? [];

  // Generate simple tags from key nouns/objects
  const nounRe = /\\b(?:person|dog|cat|car|building|tree|sky|water|mountain|computer|phone|table|chair)\\b/gi;
  const nouns = [...new Set(analysis.match(nounRe) ?? [])];

  return {
    caption: analysis.split('\\n')[0].slice(0, 200),
    tags: [...new Set([...nouns.map(n => n.toLowerCase()), ...(hasText ? ['text'] : [])])],
    hasText,
  };
}

export const IMAGE_PROCESS_TOOL = {
  name: 'analyzeImage',
  description: 'Analyze image content with AI vision model, or batch-process multiple images',
  parameters: {
    type: 'object',
    properties: {
      image:     { type: 'string',  description: 'Image file path or URL' },
      prompt:    { type: 'string',  description: 'What to look for or describe in the image' },
      maxBytesMb: { type: 'number',  description: 'Max image size in MB', default: 50 },
    },
    required: ['image', 'prompt'],
  },
};
\`\`\`

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| Image not found | Path doesn't exist | Return error info with path |
| Invalid format | Unsupported file type | Report supported formats |
| Vision timeout | Large image takes too long | Retry with maxBytesMb limit |
| Batch partial failure | One image fails | Continue others, report errors |

## Best Practices

- **Use specific prompts**: "Identify all faces and count people" is better than "describe this"
- **Set maxBytesMb** for large images to avoid timeout
- **Process batches sequentially** to avoid rate limits on vision API
- **Use \`extractCaption\`** to normalize unstructured vision output

## Examples

\`\`\`
Input:  analyzeImage({ image: "photo.jpg", prompt: "Describe the main subjects and setting" })
Output: String — AI-generated description of the image content

Input:  batchAnalyzeImages(["img1.png", "img2.jpg"], "Extract all text visible in this image")
Output: BatchAnalysisResult { results[], errors[], totalMs }

Input:  extractCaption(analysisResult)
Output: { caption: "...", tags: ["person","text"], hasText: true }
\`\`\`
`,
    exampleTemplate: {
      input: 'analyzeImage({ image: "/workspace/screenshots/dashboard.png", prompt: "List all UI elements visible, their positions, and any text content", maxBytesMb: 10 })',
      expectedOutput: 'AI-generated description of all UI components, positions, and readable text in the screenshot',
      explanation:
        'The skill calls the OpenClaw image tool with a structured prompt, the image path, and ' +
        'a size limit. The vision model returns a natural-language description which can then be ' +
        'parsed with extractCaption for structured tags or fed directly to downstream processing.',
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TemplateLibrary Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TemplateLibrary — query and browse the skill template collection.
 */
export class TemplateLibrary {
  private readonly templates: SkillTemplate[];

  constructor(templates: SkillTemplate[] = TEMPLATES) {
    this.templates = templates;
  }

  /** All registered templates. */
  getTemplates(): SkillTemplate[] {
    return [...this.templates];
  }

  /** Templates belonging to a specific category. */
  getByCategory(category: TemplateCategory): SkillTemplate[] {
    return this.templates.filter(t => t.category === category);
  }

  /**
   * Find templates matching a trigger phrase.
   * Matches on any trigger phrase containing the query (case-insensitive substring).
   */
  getByTrigger(query: string): SkillTemplate[] {
    if (!query?.trim()) return [];
    const q = query.toLowerCase();
    return this.templates.filter(t =>
      t.triggerPhrases.some(phrase => phrase.toLowerCase().includes(q))
    );
  }

  /** Get a single template by exact name match. */
  getByName(name: string): SkillTemplate | undefined {
    return this.templates.find(t => t.name.toLowerCase() === name.toLowerCase());
  }

  /** All unique categories present in the library. */
  getCategories(): TemplateCategory[] {
    return Array.from(new Set(this.templates.map(t => t.category)));
  }

  /** Summary list of all templates (name, category, description). */
  list(): Array<{ name: string; category: TemplateCategory; description: string; triggerCount: number }> {
    return this.templates.map(t => ({
      name: t.name,
      category: t.category,
      description: t.description,
      triggerCount: t.triggerPhrases.length,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export { TEMPLATES as defaultTemplates };

export const templateLibrary = new TemplateLibrary();

// ─────────────────────────────────────────────────────────────────────────────
// skillGenerator compatibility layer
// ─────────────────────────────────────────────────────────────────────────────

// TEMPLATE_LIBRARY: dict of name → template
export const TEMPLATE_LIBRARY: Record<string, SkillTemplate> =
  Object.fromEntries(TEMPLATES.map(t => [t.name, t]));

// getTemplate(name) → template or undefined
export function getTemplate(name: string): SkillTemplate | undefined {
  return TEMPLATE_LIBRARY[name];
}

// getTemplateTypes() → all template names
export function getTemplateTypes(): string[] {
  return TEMPLATES.map(t => t.name);
}

// listTemplates() → all templates
export function listTemplates(): SkillTemplate[] {
  return [...TEMPLATES];
}
