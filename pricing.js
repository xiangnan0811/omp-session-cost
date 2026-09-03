import * as os from "node:os";
import * as path from "node:path";
import { finite } from "./format.js";
import { exists } from "./transcript.js";

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
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

async function findStatsDb(rootSessionFile) {
  for (const candidate of inferStatsDbCandidates(rootSessionFile)) if (await exists(candidate)) return candidate;
  return null;
}

async function readStatsRows(dbPath, sessionFiles) {
  const rows = new Map();
  if (!dbPath) return { rows, error: null };
  let db;
  try {
    const sqlite = await import("bun:sqlite");
    db = new sqlite.Database(dbPath, { readonly: true });
    try { db.run("PRAGMA busy_timeout = 5000"); } catch {}
    let statement;
    try {
      statement = db.prepare(`
        SELECT session_file, entry_id, timestamp, premium_requests,
               cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
        FROM messages WHERE session_file = ?
      `);
    } catch {
      statement = db.prepare(`
        SELECT session_file, entry_id, timestamp,
               cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
        FROM messages WHERE session_file = ?
      `);
    }
    for (const file of sessionFiles) {
      for (const row of statement.all(file)) rows.set(`${row.entry_id}\u0000${finite(row.timestamp)}`, row);
    }
    return { rows, error: null };
  } catch (error) {
    return { rows, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch {}
  }
}

function applyStatsRows(calls, rows) {
  let matched = 0;
  for (const call of calls) {
    const row = rows.get(`${call.entryId}\u0000${call.statsTimestamp}`);
    if (!row) continue;
    matched += 1;
    call.cost = {
      input: finite(row.cost_input),
      output: finite(row.cost_output),
      cacheRead: finite(row.cost_cache_read),
      cacheWrite: finite(row.cost_cache_write),
      total: finite(row.cost_total),
    };
    if (row.premium_requests !== undefined) call.premiumRequests = finite(row.premium_requests);
    call.costSource = "stats.db";
  }
  return matched;
}

async function syncOfficialStats(pi, ctx) {
  try {
    if (typeof pi?.exec !== "function") return { ok: false, error: "extension exec API is unavailable" };
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

export async function enrichCosts(calls, rootSessionFile, pi, ctx, forceRefresh) {
  const sessionFiles = [...new Set(calls.map(call => call.sessionFile))];
  let dbPath = await findStatsDb(rootSessionFile);
  let first = await readStatsRows(dbPath, sessionFiles);
  let dbError = first.error;
  let matched = applyStatsRows(calls, first.rows);
  const unresolved = calls.filter(call => call.measuredTokens > 0 && call.cost.total === 0);
  const sync = { attempted: false, ok: true, error: null };

  if (forceRefresh || unresolved.length > 0) {
    sync.attempted = true;
    const result = await syncOfficialStats(pi, ctx);
    sync.ok = result.ok;
    sync.error = result.error;
    if (result.ok) {
      dbPath = await findStatsDb(rootSessionFile);
      const second = await readStatsRows(dbPath, sessionFiles);
      if (second.error) dbError = second.error;
      matched = applyStatsRows(calls, second.rows);
    }
  }

  const sourceCounts = {};
  for (const call of calls) sourceCounts[call.costSource] = (sourceCounts[call.costSource] ?? 0) + 1;
  return { dbPath, dbError, dbMatched: matched, sync, sourceCounts };
}

