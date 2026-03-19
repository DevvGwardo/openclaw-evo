/**
 * OpenClaw Evo Skill
 *
 * Handles /evo commands by calling the hub's HTTP API on port 5174.
 *
 * Exported functions:
 *   getEvoStatus()           => formats hub status for chat
 *   getEvoStats()            => formats performance metrics
 *   getEvoCycles()           => formats recent cycles
 *   getEvoSkills()           => formats skills list
 *   getEvoExperiments()      => formats experiment results
 *   getEvoConfig()           => formats current hub config
 *   triggerEvolutionCycle()  => POST to hub
 *   approveSkill(id)         => POST to hub
 *   rejectSkill(id)          => POST to hub
 *   restartHub()             => POST /api/restart
 *   getEvoLogs()             => formats recent log entries
 *
 * The main handler parses an /evo command string and returns a formatted response.
 */

const HUB_BASE = "http://localhost:5174";
const HUB_TIMEOUT = 5000; // ms

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const white = (s: string) => `\x1b[37m${s}\x1b[0m`;

const ok = (s: string) => green(`✔ ${s}`);
const err = (s: string) => red(`✘ ${s}`);
const info = (s: string) => cyan(`ℹ ${s}`);
const warn = (s: string) => yellow(`⚠ ${s}`);

const START_HINT = dim("Start with: cd ~/openclaw-evo && npm run start:hub");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Detect connection-level errors so we can show the start hint. */
function isHubNotRunning(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up")
  );
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_TIMEOUT);

  try {
    const res = await fetch(`${HUB_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_TIMEOUT);

  try {
    const res = await fetch(`${HUB_BASE}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const respBody = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${respBody}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Inline type definitions
// ---------------------------------------------------------------------------

interface HubStatus {
  running: boolean;
  totalCycles: number;
  deployedSkills: number;
  activeExperiments: number;
  version?: string;
  uptime?: number; // seconds
}

interface PerformanceStats {
  overallScore: number; // 0–100
  totalEvaluations: number;
  topTools: Array<{ name: string; successRate: number; calls: number }>;
  failurePatterns: Array<{ pattern: string; count: number }>;
}

interface EvolutionCycle {
  id: string;
  timestamp: string; // ISO
  durationMs: number;
  skillsEvaluated: number;
  skillsProposed: number;
  skillsDeployed: number;
  status: "success" | "partial" | "failed";
}

interface SkillEntry {
  id: string;
  name: string;
  status: "proposed" | "approved" | "rejected" | "deployed" | "archived";
  confidence: number; // 0–1
  source?: string;
  createdAt?: string;
}

interface Experiment {
  id: string;
  name: string;
  status: "running" | "completed" | "cancelled";
  variantA: string;
  variantB: string;
  winner?: string;
  significance?: number; // p-value-ish
  startedAt: string;
  completedAt?: string;
}

interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: Record<string, unknown>;
}

interface HubConfig {
  CYCLE_INTERVAL_MS: number;
  FAILURE_THRESHOLD: number;
  MAX_SKILLS_PER_CYCLE: number;
  EXPERIMENT_SESSIONS: number;
  MIN_IMPROVEMENT_PCT: number;
  STATISTICAL_CONFIDENCE: number;
  OPENCLAW_GATEWAY_URL: string;
  OPENCLAW_POLL_INTERVAL_MS: number;
  SKILL_OUTPUT_DIR: string;
  SKILL_TEMPLATE_DIR: string;
  MEMORY_DIR: string;
  DASHBOARD_PORT: number;
}

interface RestartResult {
  ok: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Hub-not-running scaffold shown when connection fails
// ---------------------------------------------------------------------------

function hubNotRunningHint(attempt: string): string {
  return [
    `${err("Cannot reach Evo hub on port 5174.")}`,
    `${warn("The hub may not be running.")}`,
    START_HINT,
    "",
    `${dim(`Tried to ${attempt}.`)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// API call wrappers
// ---------------------------------------------------------------------------

export async function getEvoStatus(): Promise<string> {
  try {
    const status = await apiGet<HubStatus>("/api/status");
    const lines: string[] = [];

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " OpenClaw Evo Hub Status".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));
    lines.push(`  ${dim("running:")}            ${status.running ? ok("running") : err("stopped")}`);
    lines.push(`  ${dim("total cycles:")}      ${white(String(status.totalCycles))}`);
    lines.push(`  ${dim("deployed skills:")}   ${white(String(status.deployedSkills))}`);
    lines.push(`  ${dim("active experiments:")} ${white(String(status.activeExperiments))}`);
    if (status.version) lines.push(`  ${dim("version:")}          ${cyan(status.version)}`);
    if (status.uptime !== undefined) {
      const mins = Math.floor(status.uptime / 60);
      const secs = status.uptime % 60;
      lines.push(`  ${dim("uptime:")}           ${white(`${mins}m ${secs}s`)}`);
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch hub status");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to reach Evo hub")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoStats(): Promise<string> {
  try {
    const stats = await apiGet<PerformanceStats>("/api/stats");
    const lines: string[] = [];

    const scoreColor =
      stats.overallScore >= 80 ? green : stats.overallScore >= 60 ? yellow : red;
    const scoreBar = makeScoreBar(stats.overallScore);

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " Evo Performance Stats".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));
    lines.push(
      `  ${dim("overall score:")}    ${scoreColor(`${stats.overallScore.toFixed(1)}`)} ${scoreBar}`
    );
    lines.push(`  ${dim("total evaluations:")} ${white(String(stats.totalEvaluations))}`);
    lines.push("");
    lines.push(`  ${bold("Top Tools by Success Rate")}`);

    if (stats.topTools.length === 0) {
      lines.push(`  ${dim("(no tool data yet)")}`);
    } else {
      for (const tool of stats.topTools.slice(0, 8)) {
        const rate = tool.successRate;
        const rateColor = rate >= 0.9 ? green : rate >= 0.7 ? yellow : red;
        const bar = makeRateBar(rate);
        lines.push(
          `   ${white(tool.name.padEnd(24))} ${rateColor((rate * 100).toFixed(0).padStart(3) + "%")} ${bar} ${dim(`(${tool.calls} calls)`)}`
        );
      }
    }

    if (stats.failurePatterns.length > 0) {
      lines.push("");
      lines.push(`  ${bold("Failure Patterns")}`);
      for (const fp of stats.failurePatterns.slice(0, 6)) {
        lines.push(`   ${err("◆")} ${dim(fp.pattern)} ${dim(`(${fp.count})`)}`);
      }
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch performance stats");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to load stats")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoCycles(): Promise<string> {
  try {
    const cycles = await apiGet<EvolutionCycle[]>("/api/cycles");
    const lines: string[] = [];

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " Recent Evolution Cycles".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));
    lines.push(
      `  ${dim("ID").padEnd(12)} ${dim("When").padEnd(26)} ${dim("Eval").padEnd(6)} ${dim("Prop").padEnd(6)} ${dim("Dep").padEnd(6)} ${dim("Status")}`
    );
    lines.push(dim("  " + "─".repeat(72)));

    if (cycles.length === 0) {
      lines.push(`  ${dim("(no cycles yet)")}`);
    } else {
      const recent = cycles.slice(-10).reverse();
      for (const c of recent) {
        const when = timeAgo(c.timestamp);
        const statusIcon = c.status === "success" ? green("●") : c.status === "partial" ? yellow("◐") : red("○");
        const statusLabel = c.status === "success"
          ? green(c.status)
          : c.status === "partial"
            ? yellow(c.status)
            : red(c.status);

        lines.push(
          `  ${cyan(c.id.padEnd(12))} ${dim(when.padEnd(26))} ${white(String(c.skillsEvaluated).padEnd(6))} ${white(String(c.skillsProposed).padEnd(6))} ${white(String(c.skillsDeployed).padEnd(6))} ${statusIcon} ${statusLabel}`
        );
      }
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch cycles");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to load cycles")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoSkills(): Promise<string> {
  try {
    const skills = await apiGet<SkillEntry[]>("/api/skills");
    const lines: string[] = [];

    const groups: Record<string, SkillEntry[]> = {};
    for (const s of skills) {
      (groups[s.status] ??= []).push(s);
    }

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " Evo Skills".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));
    const order: SkillEntry["status"][] = ["deployed", "approved", "proposed", "rejected", "archived"];
    const statusColor: Record<string, (s: string) => string> = {
      deployed: (s) => green(s),
      approved: (s) => cyan(s),
      proposed: (s) => yellow(s),
      rejected: (s) => red(s),
      archived: (s) => dim(s),
    };

    for (const status of order) {
      const group = groups[status];
      if (!group || group.length === 0) continue;

      lines.push(`  ${bold(statusColor[status](status.toUpperCase()))} (${group.length})`);

      for (const skill of group.slice(0, 12)) {
        const confPct = Math.round(skill.confidence * 100);
        const confColor =
          confPct >= 80 ? green : confPct >= 60 ? yellow : red;
        const confBar = makeRateBar(skill.confidence);
        lines.push(
          `   ${magenta(skill.id.padEnd(14))} ${white(skill.name.padEnd(24))} ${confColor(confPct.toString().padStart(3) + "%")} ${confBar}`
        );
      }
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch skills");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to load skills")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoExperiments(): Promise<string> {
  try {
    const experiments = await apiGet<Experiment[]>("/api/experiments");
    const lines: string[] = [];

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " A/B Experiments".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));

    if (experiments.length === 0) {
      lines.push(`  ${dim("(no experiments yet)")}`);
    } else {
      for (const exp of experiments.slice(-8).reverse()) {
        const statusColor =
          exp.status === "running" ? yellow : exp.status === "completed" ? green : red;
        const statusBadge =
          exp.status === "running"
            ? `${statusColor("◉ running")}`
            : exp.status === "completed"
              ? `${statusColor("✓ done")}`
              : `${statusColor("✗ cancelled")}`;

        lines.push(
          `  ${cyan(exp.id.padEnd(10))} ${white(exp.name).substring(0, 28).padEnd(28)} ${statusBadge}`
        );
        lines.push(
          `   ${dim("A:")} ${white(exp.variantA)} ${dim("vs")} ${dim("B:")} ${white(exp.variantB)}`
        );

        if (exp.winner) {
          const winnerLabel = exp.winner === "A" ? exp.variantA : exp.variantB;
          lines.push(
            `   ${green("→ winner:")} ${white(winnerLabel)} ${exp.significance !== undefined ? dim(`p=${exp.significance.toFixed(4)})`) : ""}`
          );
        }

        lines.push(dim("  " + "─".repeat(66)));
      }
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch experiments");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to load experiments")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoConfig(): Promise<string> {
  try {
    const cfg = await apiGet<HubConfig>("/api/config");
    const lines: string[] = [];

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " Evo Hub Configuration".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));

    const rows: Array<[string, string]> = [
      ["Cycle interval",       `${(cfg.CYCLE_INTERVAL_MS / 1000).toFixed(0)}s`],
      ["Failure threshold",    `${cfg.FAILURE_THRESHOLD} failures`],
      ["Max skills / cycle",   `${cfg.MAX_SKILLS_PER_CYCLE}`],
      ["Experiment sessions",   `${cfg.EXPERIMENT_SESSIONS}`],
      ["Min improvement",       `${cfg.MIN_IMPROVEMENT_PCT}%`],
      ["Statistical confidence", `${(cfg.STATISTICAL_CONFIDENCE * 100).toFixed(0)}%`],
      ["Poll interval",         `${(cfg.OPENCLAW_POLL_INTERVAL_MS / 1000).toFixed(0)}s`],
      ["Gateway URL",           cfg.OPENCLAW_GATEWAY_URL || dim("(not set)")],
      ["Skill output dir",      cfg.SKILL_OUTPUT_DIR || dim("(not set)")],
      ["Skill template dir",    cfg.SKILL_TEMPLATE_DIR || dim("(not set)")],
      ["Memory dir",            cfg.MEMORY_DIR || dim("(not set)")],
      ["Dashboard port",        `${cfg.DASHBOARD_PORT}`],
    ];

    for (const [k, v] of rows) {
      lines.push(`  ${dim(k.padEnd(24))} ${white(v)}`);
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch config");
    const msg = e instanceof Error ? e.message : String(e);
    // Hub may not expose /api/config yet — show a friendly note
    if (msg.includes("404")) {
      return [
        `${warn("Config endpoint not available on this hub version.")}`,
        `${dim("The hub may need to be updated to support /api/config.")}`,
        START_HINT,
      ].join("\n");
    }
    return `${err("Failed to load config")}\n${dim(`(${msg})`)}`;
  }
}

export async function triggerEvolutionCycle(): Promise<string> {
  try {
    const result = await apiPost<{ cycleId: string; triggeredAt: string }>("/api/cycles/trigger");
    return [
      ok("Evolution cycle triggered"),
      `${dim("cycle ID:")} ${cyan(result.cycleId)}`,
      `${dim("at:")} ${dim(result.triggeredAt)}`,
    ].join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("trigger a cycle");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to trigger evolution cycle")}\n${dim(`(${msg})`)}`;
  }
}

export async function approveSkill(id: string): Promise<string> {
  if (!id) return `${err("Usage: /evo approve <skill-id>")}`;
  try {
    const result = await apiPost<{ skillId: string; status: string }>("/api/skills/approve", {
      skillId: id,
    });
    return ok(`Skill ${magenta(result.skillId)} approved for experimentation`);
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("approve a skill");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err(`Failed to approve skill "${id}"`)}\n${dim(`(${msg})`)}`;
  }
}

export async function rejectSkill(id: string): Promise<string> {
  if (!id) return `${err("Usage: /evo reject <skill-id>")}`;
  try {
    const result = await apiPost<{ skillId: string; status: string }>("/api/skills/reject", {
      skillId: id,
    });
    return ok(`Skill ${magenta(result.skillId)} rejected`);
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("reject a skill");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err(`Failed to reject skill "${id}"`)}\n${dim(`(${msg})`)}`;
  }
}

export async function restartHub(): Promise<string> {
  try {
    const result = await apiPost<RestartResult>("/api/restart");
    return ok(`Hub restart initiated — ${result.message ?? "shutting down for a clean restart"}`);
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("restart hub");
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) {
      return [
        `${warn("Restart endpoint not available on this hub version.")}`,
        `${dim("The hub may need to be updated to support /api/restart.")}`,
        START_HINT,
      ].join("\n");
    }
    return `${err("Failed to restart hub")}\n${dim(`(${msg})`)}`;
  }
}

export async function getEvoLogs(): Promise<string> {
  try {
    const logs = await apiGet<LogEntry[]>("/api/logs");
    const lines: string[] = [];

    lines.push(bold("╔" + "═".repeat(54) + "╗"));
    lines.push(bold("║" + " Improvement Logs".padEnd(55) + "║"));
    lines.push(bold("╚" + "═".repeat(54) + "╝"));

    if (logs.length === 0) {
      lines.push(`  ${dim("(no log entries yet)")}`);
    } else {
      const recent = logs.slice(-20).reverse();
      for (const entry of recent) {
        const ts = entry.timestamp
          ? dim(new Date(entry.timestamp).toLocaleTimeString())
          : dim("??:??:??");
        const levelTag =
          entry.level === "error"
            ? red("[ERR]")
            : entry.level === "warn"
              ? yellow("[WRN]")
              : entry.level === "debug"
                ? dim("[DBG]")
                : dim("[INF]");
        lines.push(`  ${ts} ${levelTag} ${entry.message}`);
      }
    }

    return lines.join("\n");
  } catch (e: unknown) {
    if (isHubNotRunning(e)) return hubNotRunningHint("fetch logs");
    const msg = e instanceof Error ? e.message : String(e);
    return `${err("Failed to load logs")}\n${dim(`(${msg})`)}`;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface EvoCommand {
  command: string;       // e.g. "status", "stats", "approve foo-bar"
  raw: string;           // original input
}

export type EvoHandler = (cmd: EvoCommand) => Promise<string>;

export async function handleEvoCommand(input: string): Promise<string> {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = (parts[1] ?? "help").toLowerCase();
  const arg = parts.slice(2).join(" ");

  switch (cmd) {
    case "status": {
      return getEvoStatus();
    }

    case "stats": {
      return getEvoStats();
    }

    case "cycles": {
      return getEvoCycles();
    }

    case "skills": {
      return getEvoSkills();
    }

    case "experiments": {
      return getEvoExperiments();
    }

    case "trigger": {
      return triggerEvolutionCycle();
    }

    case "approve": {
      return approveSkill(arg);
    }

    case "reject": {
      return rejectSkill(arg);
    }

    case "restart": {
      return restartHub();
    }

    case "config": {
      return getEvoConfig();
    }

    case "logs": {
      return getEvoLogs();
    }

    case "help": {
      return formatHelp();
    }

    default: {
      return [
        `${err(`Unknown /evo command: "${cmd}"`)}`,
        dim("Run /evo help for available commands."),
      ].join("\n");
    }
  }
}

function formatHelp(): string {
  const lines: string[] = [];
  lines.push(bold("╔" + "═".repeat(54) + "╗"));
  lines.push(bold("║" + " OpenClaw Evo Commands".padEnd(55) + "║"));
  lines.push(bold("╠" + "═".repeat(54) + "╣"));
  lines.push(`║  ${cyan("/evo status")}       ${dim("Hub running state, cycles, skills, experiments").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo stats")}        ${dim("Performance scores, top tools, failure patterns").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo cycles")}       ${dim("Recent evolution cycles with outcomes").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo skills")}       ${dim("Proposed & deployed skills with confidence").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo experiments")}  ${dim("Active and completed A/B experiments").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo config")}        ${dim("Current hub configuration").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo trigger")}      ${dim("Manually trigger an evolution cycle").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo approve")}       ${dim("<skill-id>  Approve a proposed skill").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo reject")}        ${dim("<skill-id>  Reject a proposed skill").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo restart")}       ${dim("Restart the hub (POST /api/restart)").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo logs")}         ${dim("Recent improvement log entries").padEnd(34)}║`);
  lines.push(`║  ${cyan("/evo help")}         ${dim("Show this message").padEnd(34)}║`);
  lines.push(bold("╠" + "═".repeat(54) + "╣"));
  lines.push(`${bold("║")}  ${dim("Hub API: http://localhost:5174").padEnd(51)} ${bold("║")}`);
  lines.push(`${bold("╚" + "═".repeat(54) + "╝")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Utility: ASCII bars
// ---------------------------------------------------------------------------

function makeScoreBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  return (
    green("[" + "█".repeat(filled)) +
    dim("░".repeat(empty) + "]")
  );
}

function makeRateBar(rate: number, width = 8): string {
  const filled = Math.round(rate * width);
  const empty = width - filled;
  const colorFn = rate >= 0.9 ? green : rate >= 0.7 ? yellow : red;
  return colorFn("[" + "█".repeat(filled)) + dim("░".repeat(empty) + "]");
}

function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// Default export for OpenClaw skill loader
export default handleEvoCommand;
