import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const COMMAND = "cost";
const ADVISOR_PREFIX = "__advisor";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCost(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    input: number(v.input),
    output: number(v.output),
    cacheRead: number(v.cacheRead),
    cacheWrite: number(v.cacheWrite),
    total: number(v.total),
  };
}

function emptyTotals() {
  return {
    requests: 0,
    failed: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    orchestrationInput: 0,
    orchestrationOutput: 0,
    orchestrationCacheRead: 0,
    premiumRequests: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    zeroPricedRequests: 0,
  };
}

function addRequest(t, r) {
  t.requests += 1;
  t.failed += r.failed ? 1 : 0;
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.totalTokens += r.totalTokens;
  t.orchestrationInput += r.orchestrationInput;
  t.orchestrationOutput += r.orchestrationOutput;
  t.orchestrationCacheRead += r.orchestrationCacheRead;
  t.premiumRequests += r.premiumRequests;
  t.costInput += r.cost.input;
  t.costOutput += r.cost.output;
  t.costCacheRead += r.cost.cacheRead;
  t.costCacheWrite += r.cost.cacheWrite;
  t.costTotal += r.cost.total;
  if (r.measuredTokens > 0 && r.cost.total === 0) t.zeroPricedRequests += 1;
}

function allMeasuredTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.orchestrationInput + t.orchestrationOutput + t.orchestrationCacheRead;
}

function formatInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

function formatTokens(n) {
  const x = number(n);
  if (x >= 1_000_000_000) return `${(x / 1_000_000_000).toFixed(x >= 10_000_000_000 ? 1 : 2)}B`;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(x >= 10_000_000 ? 1 : 2)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(x >= 10_000 ? 1 : 2)}K`;
  return formatInt(x);
}

function formatCost(n) {
  const x = number(n);
  if (x === 0) return "$0.00";
  if (x < 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(2)}`;
}

function pct(part, total) {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";
}

function stripJsonl(file) {
  return file.toLowerCase().endsWith(".jsonl") ? file.slice(0, -6) : file;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveInteractiveRoot(sessionFile) {
  let current = path.resolve(sessionFile);
  while (true) {
    const parentCandidate = `${path.dirname(current)}.jsonl`;
    if (parentCandidate === current || !(await exists(parentCandidate))) return current;
    current = parentCandidate;
  }
}

async function collectJsonlRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsonlRecursive(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) out.push(full);
  }
  return out;
}

async function readHeader(file) {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? value : {};
      } catch {
        return {};
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return {};
}

function classifyAgentType(file, rootFile) {
  if (path.resolve(file) === path.resolve(rootFile)) return "main";
  const base = path.basename(file, ".jsonl");
  return base === ADVISOR_PREFIX || base.startsWith(`${ADVISOR_PREFIX}.`) ? "advisor" : "subagent";
}

function agentName(file, rootFile, type) {
  if (type === "main") return "main";
  const rootArtifacts = stripJsonl(rootFile);
  let rel = path.relative(rootArtifacts, file).replace(/\\/g, "/");
  rel = rel.replace(/\.jsonl$/i, "");
  if (!rel || rel.startsWith("..")) rel = path.basename(file, ".jsonl");
  const parts = rel.split("/");
  const leaf = parts.pop() || rel;
  if (leaf === ADVISOR_PREFIX || leaf.startsWith(`${ADVISOR_PREFIX}.`)) {
    const slug = leaf === ADVISOR_PREFIX ? "advisor" : `advisor:${leaf.slice(ADVISOR_PREFIX.length + 1)}`;
    parts.push(slug);
  } else {
    parts.push(leaf);
  }
  return parts.join(" > ");
}

function extractRequest(entry, file, rootFile, cutoffMs) {
  if (!entry || entry.type !== "message") return null;
  const message = entry.message;
  if (!message || message.role !== "assistant") return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;

  const provider = typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  if (provider === "unknown" && model === "unknown") return null;

  const timestamp = parseTime(message.timestamp) || parseTime(entry.timestamp);
  if (cutoffMs > 0 && timestamp > 0 && timestamp < cutoffMs) return { inherited: true };

  const orchestration = usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : {};
  const input = number(usage.input);
  const output = number(usage.output);
  const cacheRead = number(usage.cacheRead);
  const cacheWrite = number(usage.cacheWrite);
  const orchestrationInput = number(orchestration.input);
  const orchestrationOutput = number(orchestration.output);
  const orchestrationCacheRead = number(orchestration.cacheRead);
  const measuredTokens = input + output + cacheRead + cacheWrite + orchestrationInput + orchestrationOutput + orchestrationCacheRead;
  const type = classifyAgentType(file, rootFile);
  const entryId = typeof entry.id === "string" && entry.id ? entry.id : `${path.basename(file)}:${timestamp}:${model}`;

  return {
    inherited: false,
    sessionFile: path.resolve(file),
    entryId,
    timestamp,
    provider,
    model,
    api: typeof message.api === "string" ? message.api : "",
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "",
    failed: Boolean(message.errorMessage) || message.stopReason === "error",
    agentType: type,
    agent: agentName(file, rootFile, type),
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: number(usage.totalTokens, input + output + cacheRead + cacheWrite),
    orchestrationInput,
    orchestrationOutput,
    orchestrationCacheRead,
    measuredTokens,
    premiumRequests: number(usage.premiumRequests),
    cost: normalizeCost(usage.cost),
    costSource: "transcript",
  };
}

async function parseSessionRequests(file, rootFile, cutoffMs) {
  const requests = [];
  let inherited = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const request = extractRequest(entry, file, rootFile, cutoffMs);
      if (!request) continue;
      if (request.inherited) inherited += 1;
      else requests.push(request);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { requests, inherited };
}

function dedupeRequests(requests) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const r of requests) {
    const key = `${r.entryId}\u0000${r.timestamp}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    out.push(r);
  }
  return { requests: out, duplicates };
}

function inferStatsDbCandidates(rootSessionFile) {
  const candidates = [];
  let cursor = path.dirname(path.resolve(rootSessionFile));
  while (true) {
    if (path.basename(cursor) === "sessions") {
      const owner = path.dirname(cursor);
      candidates.push(path.join(path.basename(owner) === "agent" ? path.dirname(owner) : owner, "stats.db"));
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (process.env.XDG_DATA_HOME) candidates.push(path.join(process.env.XDG_DATA_HOME, "omp", "stats.db"));
  candidates.push(path.join(os.homedir(), ".omp", "stats.db"));
  if (process.env.OMP_PROFILE) candidates.push(path.join(os.homedir(), ".omp", "profiles", process.env.OMP_PROFILE, "stats.db"));
  return [...new Set(candidates.map(p => path.resolve(p)))];
}

async function findStatsDb(rootSessionFile) {
  for (const candidate of inferStatsDbCandidates(rootSessionFile)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function readStatsRows(dbPath, sessionFiles) {
  const rows = new Map();
  if (!dbPath) return { rows, error: null };
  let db;
  try {
    const sqlite = await import("bun:sqlite");
    db = new sqlite.Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 5000");
    } catch {}

    let stmt;
    try {
      stmt = db.prepare(`
        SELECT session_file, entry_id, timestamp, premium_requests,
               cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
        FROM messages
        WHERE session_file = ?
      `);
    } catch {
      stmt = db.prepare(`
        SELECT session_file, entry_id, timestamp,
               cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
        FROM messages
        WHERE session_file = ?
      `);
    }

    for (const file of sessionFiles) {
      for (const row of stmt.all(file)) {
        const key = `${row.entry_id}\u0000${number(row.timestamp)}`;
        rows.set(key, row);
      }
    }
    return { rows, error: null };
  } catch (error) {
    return { rows, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function applyStatsRows(requests, rows) {
  let matched = 0;
  for (const r of requests) {
    const row = rows.get(`${r.entryId}\u0000${r.timestamp}`);
    if (!row) continue;
    matched += 1;
    r.cost = {
      input: number(row.cost_input),
      output: number(row.cost_output),
      cacheRead: number(row.cost_cache_read),
      cacheWrite: number(row.cost_cache_write),
      total: number(row.cost_total),
    };
    if (row.premium_requests !== undefined) r.premiumRequests = number(row.premium_requests);
    r.costSource = "stats.db";
  }
  return matched;
}

async function syncOfficialStats(pi, ctx) {
  try {
    const result = await pi.exec("omp", ["stats", "--json"], { cwd: ctx.cwd });
    const code = result?.code ?? result?.exitCode ?? 0;
    if (code !== 0) {
      const tail = String(result?.stderr || result?.stdout || "").trim().split("\n").slice(-4).join(" | ");
      return { ok: false, error: `omp stats --json exited ${code}${tail ? `: ${tail}` : ""}` };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function enrichCosts(requests, rootSessionFile, pi, ctx, forceRefresh) {
  const sessionFiles = [...new Set(requests.map(r => r.sessionFile))];
  let dbPath = await findStatsDb(rootSessionFile);
  let first = await readStatsRows(dbPath, sessionFiles);
  let dbError = first.error;
  let matched = applyStatsRows(requests, first.rows);

  const unresolved = requests.filter(r => r.measuredTokens > 0 && r.cost.total === 0);
  let sync = { attempted: false, ok: true, error: null };

  if (forceRefresh || unresolved.length > 0) {
    sync.attempted = true;
    const result = await syncOfficialStats(pi, ctx);
    sync.ok = result.ok;
    sync.error = result.error;
    if (result.ok) {
      dbPath = await findStatsDb(rootSessionFile);
      const second = await readStatsRows(dbPath, sessionFiles);
      if (second.error) dbError = second.error;
      matched = applyStatsRows(requests, second.rows);
    }
  }

  return { dbPath, dbError, dbMatched: matched, sync };
}

function groupRequests(requests, keyFn) {
  const map = new Map();
  for (const request of requests) {
    const name = keyFn(request);
    let row = map.get(name);
    if (!row) {
      row = { name, ...emptyTotals() };
      map.set(name, row);
    }
    addRequest(row, request);
  }
  return [...map.values()].sort((a, b) => b.costTotal - a.costTotal || allMeasuredTokens(b) - allMeasuredTokens(a) || a.name.localeCompare(b.name));
}

async function buildReport(sessionFile, pi, ctx, forceRefresh = false) {
  const rootSessionFile = await resolveInteractiveRoot(sessionFile);
  if (!(await exists(rootSessionFile))) throw new Error(`Session transcript is not on disk yet: ${rootSessionFile}`);

  const header = await readHeader(rootSessionFile);
  const forkAware = typeof header.parentSession === "string" && header.parentSession.length > 0;
  const cutoffMs = forkAware ? parseTime(header.timestamp) : 0;
  const descendants = await collectJsonlRecursive(stripJsonl(rootSessionFile));
  const files = [rootSessionFile, ...descendants].map(p => path.resolve(p));

  const collected = [];
  let excludedInheritedRequests = 0;
  for (const file of files) {
    const parsed = await parseSessionRequests(file, rootSessionFile, cutoffMs);
    collected.push(...parsed.requests);
    excludedInheritedRequests += parsed.inherited;
  }

  const deduped = dedupeRequests(collected);
  const requests = deduped.requests;
  const pricing = await enrichCosts(requests, rootSessionFile, pi, ctx, forceRefresh);

  const total = emptyTotals();
  for (const request of requests) addRequest(total, request);

  return {
    rootSessionFile,
    sessionId: typeof header.id === "string" && header.id ? header.id : path.basename(rootSessionFile, ".jsonl"),
    forkAware,
    excludedInheritedRequests,
    duplicateRequestsRemoved: deduped.duplicates,
    filesScanned: files.length,
    requests,
    total,
    byAgentType: groupRequests(requests, r => r.agentType),
    byModel: groupRequests(requests, r => `${r.provider}/${r.model}`),
    byAgent: groupRequests(requests, r => r.agent),
    byAgentModel: groupRequests(requests, r => `${r.agent} @ ${r.provider}/${r.model}`),
    pricing,
  };
}

function pushSection(lines, title, rows, totalCost, totalTokens, limit = 80) {
  lines.push("", title, "-".repeat(Math.min(78, Math.max(12, title.length))));
  if (rows.length === 0) {
    lines.push("(none)");
    return;
  }
  for (const row of rows.slice(0, limit)) {
    const tokens = allMeasuredTokens(row);
    const costShare = totalCost > 0 ? pct(row.costTotal, totalCost) : "";
    const tokenShare = totalTokens > 0 ? pct(tokens, totalTokens) : "";
    lines.push(row.name);
    lines.push(`  ${String(row.requests).padStart(4)} req  ${formatTokens(tokens).padStart(9)} tok ${tokenShare.padStart(7)}  ${formatCost(row.costTotal).padStart(10)} ${costShare.padStart(7)}${row.failed ? `  ${row.failed} failed` : ""}`);
  }
  if (rows.length > limit) lines.push(`... ${rows.length - limit} more`);
}

function reportLines(report) {
  const t = report.total;
  const measured = allMeasuredTokens(t);
  const lines = [];
  lines.push(`Session: ${report.sessionId}`);
  lines.push(`Root:    ${report.rootSessionFile}`);
  lines.push(`Files:   ${report.filesScanned}   Requests: ${t.requests}   Failed: ${t.failed}`);
  if (report.forkAware) lines.push(`Fork:    incremental view; excluded ${report.excludedInheritedRequests} inherited request(s)`);
  if (report.duplicateRequestsRemoved) lines.push(`Dedup:   removed ${report.duplicateRequestsRemoved} copied duplicate request(s)`);

  lines.push("", "SUMMARY", "-------");
  lines.push(`Measured tokens      ${formatTokens(measured).padStart(12)}`);
  lines.push(`API-equivalent cost  ${formatCost(t.costTotal).padStart(12)}`);
  lines.push(`Input                 ${formatTokens(t.input).padStart(12)}`);
  lines.push(`Output                ${formatTokens(t.output).padStart(12)}`);
  lines.push(`Cache read            ${formatTokens(t.cacheRead).padStart(12)}`);
  lines.push(`Cache write           ${formatTokens(t.cacheWrite).padStart(12)}`);
  if (t.orchestrationInput || t.orchestrationOutput || t.orchestrationCacheRead) {
    lines.push(`Orchestration in      ${formatTokens(t.orchestrationInput).padStart(12)}`);
    lines.push(`Orchestration out     ${formatTokens(t.orchestrationOutput).padStart(12)}`);
    lines.push(`Orch cache read       ${formatTokens(t.orchestrationCacheRead).padStart(12)}`);
  }
  if (t.premiumRequests) lines.push(`Premium requests      ${formatInt(t.premiumRequests).padStart(12)}`);
  if (t.zeroPricedRequests) lines.push(`Zero-priced requests  ${formatInt(t.zeroPricedRequests).padStart(12)}  (free, subscription, or unavailable pricing)`);

  lines.push("", "COST BREAKDOWN", "--------------");
  lines.push(`Input             ${formatCost(t.costInput).padStart(12)}`);
  lines.push(`Output            ${formatCost(t.costOutput).padStart(12)}`);
  lines.push(`Cache read        ${formatCost(t.costCacheRead).padStart(12)}`);
  lines.push(`Cache write       ${formatCost(t.costCacheWrite).padStart(12)}`);

  pushSection(lines, "BY AGENT TYPE", report.byAgentType, t.costTotal, measured);
  pushSection(lines, "BY MODEL", report.byModel, t.costTotal, measured);
  pushSection(lines, "BY AGENT", report.byAgent, t.costTotal, measured);
  pushSection(lines, "AGENT x MODEL", report.byAgentModel, t.costTotal, measured, 120);

  lines.push("", "PRICING SOURCE", "--------------");
  const sourceCounts = new Map();
  for (const r of report.requests) sourceCounts.set(r.costSource, (sourceCounts.get(r.costSource) || 0) + 1);
  for (const [source, count] of sourceCounts) lines.push(`${source.padEnd(12)} ${String(count).padStart(6)} request(s)`);
  if (report.pricing.dbPath) lines.push(`stats.db: ${report.pricing.dbPath}`);
  else lines.push("stats.db: not found; transcript costs used");
  if (report.pricing.sync.attempted) lines.push(`stats sync: ${report.pricing.sync.ok ? "ok" : `failed: ${report.pricing.sync.error}`}`);
  if (report.pricing.dbError) lines.push(`stats.db read warning: ${report.pricing.dbError}`);

  lines.push("", "Notes: cost is API-equivalent where OMP stats has pricing; subscription/OAuth billing can differ.");
  return lines;
}

function visibleChars(text) {
  return Array.from(String(text).replace(/\t/g, "    "));
}

function fit(text, width) {
  if (width <= 0) return "";
  const chars = visibleChars(text);
  if (chars.length <= width) return chars.join("").padEnd(width, " ");
  if (width <= 3) return chars.slice(0, width).join("");
  return `${chars.slice(0, width - 3).join("")}...`;
}

class CostReportView {
  constructor(tui, keybindings, lines, done) {
    this.tui = tui;
    this.keybindings = keybindings;
    this.lines = lines;
    this.done = done;
    this.offset = 0;
    this.lastRendered = null;
    this.lastWidth = -1;
  }

  pageSize() {
    const rows = number(this.tui?.terminal?.rows, 40);
    return Math.max(8, Math.min(34, rows - 8));
  }

  maxOffset() {
    return Math.max(0, this.lines.length - this.pageSize());
  }

  move(delta) {
    this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset + delta));
    this.invalidate();
    this.tui?.requestRender?.();
  }

  handleInput(data) {
    if (this.keybindings?.matches?.(data, "app.interrupt") || data === "q" || data === "Q" || data === "\u001b" || data === "\u0003") {
      this.done(undefined);
      return;
    }
    if (data === "j" || data === "\u001b[B") this.move(1);
    else if (data === "k" || data === "\u001b[A") this.move(-1);
    else if (data === "\u001b[6~") this.move(this.pageSize() - 2);
    else if (data === "\u001b[5~") this.move(-(this.pageSize() - 2));
    else if (data === "\u001b[H" || data === "\u001b[1~") this.move(-this.offset);
    else if (data === "\u001b[F" || data === "\u001b[4~") this.move(this.maxOffset() - this.offset);
  }

  invalidate() {
    this.lastRendered = null;
    this.lastWidth = -1;
  }

  render(width) {
    if (this.lastRendered && this.lastWidth === width) return this.lastRendered;
    const w = Math.max(10, width);
    const inner = Math.max(6, w - 4);
    const page = this.pageSize();
    this.offset = Math.min(this.offset, this.maxOffset());
    const visible = this.lines.slice(this.offset, this.offset + page);
    const out = [];
    out.push(`+${"-".repeat(Math.max(1, w - 2))}+`);
    out.push(`| ${fit("SESSION COST  main + recursive subagents + advisors", inner)} |`);
    out.push(`| ${fit("", inner)} |`);
    for (const line of visible) out.push(`| ${fit(line, inner)} |`);
    for (let i = visible.length; i < page; i += 1) out.push(`| ${" ".repeat(inner)} |`);
    const first = this.lines.length ? this.offset + 1 : 0;
    const last = Math.min(this.lines.length, this.offset + page);
    out.push(`| ${fit(`Up/Down j/k  PgUp/PgDn  Home/End  q/Esc close   ${first}-${last}/${this.lines.length}`, inner)} |`);
    out.push(`+${"-".repeat(Math.max(1, w - 2))}+`);
    this.lastWidth = width;
    this.lastRendered = out;
    return out;
  }
}

function compactSummary(report) {
  const t = report.total;
  return `${t.requests} req | ${formatTokens(allMeasuredTokens(t))} measured tokens | ${formatCost(t.costTotal)} API-equivalent`;
}

export default function costExtension(pi) {
  pi.registerCommand(COMMAND, {
    description: "Current session token/cost report including recursive subagents and advisors",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        ctx.ui.notify("/cost requires a persisted session.", "warning");
        return;
      }

      const forceRefresh = String(args || "").trim().toLowerCase() === "refresh";
      ctx.ui.setStatus?.("omp-cost", forceRefresh ? "Refreshing OMP stats and calculating cost..." : "Calculating session cost...");
      try {
        const report = await buildReport(sessionFile, pi, ctx, forceRefresh);
        if (report.total.requests === 0) {
          ctx.ui.notify("No persisted assistant usage found for this session yet.", "info");
          return;
        }
        if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
          ctx.ui.notify(compactSummary(report), "info");
          return;
        }
        const lines = reportLines(report);
        await ctx.ui.custom(
          (tui, _theme, keybindings, done) => new CostReportView(tui, keybindings, lines, done),
          { overlay: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { pi.logger?.error?.(`omp-cost: ${message}`); } catch {}
        ctx.ui.notify(`Unable to calculate session cost: ${message}`, "error");
      } finally {
        ctx.ui.setStatus?.("omp-cost", undefined);
      }
    },
  });
}
