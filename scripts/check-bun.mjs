import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { enrichCosts } from "../pricing.js";
import extension from "../index.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cost-bun-"));
try {
  const session = path.join(dir, "sessions", "project", "main.jsonl");
  await fs.mkdir(path.dirname(session), { recursive: true }); await fs.writeFile(session, "");
  const dbPath = path.join(dir, "stats.db");
  const db = new Database(dbPath);
  // The old schema intentionally omits premium_requests: verify fallback SELECT.
  db.run("CREATE TABLE messages(session_file TEXT, entry_id TEXT, timestamp INTEGER, cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL, cost_total REAL)");
  db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(session, "a", 1, .2, .3, .25, 0, .75); db.close();
  const hash = async () => createHash("sha256").update(await fs.readFile(dbPath)).digest("hex");
  const before = await hash();
  const calls = [{ sessionFile: session, entryId: "a", statsTimestamp: 1, measuredTokens: 100,
    transcriptCost: { total: .25 }, selectedCost: { total: .25 }, cost: { total: .25 }, costSource: "transcript" }];
  let refreshed = false;
  const pricing = await enrichCosts(calls, session, { exec: async () => { refreshed = true; return { code: 0 }; } }, { cwd: dir }, false);
  assert.equal(pricing.dbMatched, 1); assert.equal(calls[0].costSource, "stats.db");
  assert.equal(calls[0].cost.total, .75); assert.equal(calls[0].transcriptCost.total, .25);
  assert.equal(refreshed, false); assert.equal(await hash(), before, "read-only enrichment must not mutate database bytes");
  const commands = new Map(); extension({ registerCommand: (name, value) => commands.set(name, value) });
  assert.equal(typeof commands.get("cost").handler, "function");
  console.log("Bun integration: readonly SQLite, legacy schema fallback, preserved provenance and extension registration passed.");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
