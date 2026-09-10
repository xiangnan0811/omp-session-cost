import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildReport } from "../core.js";
import { buildAiBrief, buildPublicJson } from "../export.js";

const count = Number(process.argv[2] || 20000);
if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error("Count must be between 1 and 100000");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagnostic-large-"));
const file = path.join(dir, "large.jsonl"), epoch = Date.parse("2026-01-01T00:00:00Z");
const stamp = n => new Date(epoch + n * 1000).toISOString();
try {
  await fs.writeFile(file, JSON.stringify({ type: "session", version: 3, id: "synthetic-large", timestamp: stamp(0) }) + "\n");
  let parentId = null;
  for (let start = 0; start < count; start += 500) {
    const lines = [];
    for (let i = start; i < Math.min(count, start + 500); i++) {
      lines.push(JSON.stringify({ type: "message", id: `a${i}`, parentId, timestamp: stamp(i * 2), message: {
        role: "assistant", provider: "synthetic", model: "fixture", responseId: `response${i}`, stopReason: "toolUse",
        content: [{ type: "toolCall", id: `tool${i}`, name: "hub", arguments: { op: "inbox" } }],
        usage: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, cost: { input: .001, output: .002, cacheRead: .007, cacheWrite: 0, total: .01 } }
      } }));
      parentId = `a${i}`;
      lines.push(JSON.stringify({ type: "message", id: `r${i}`, parentId, timestamp: stamp(i * 2 + 1), message: {
        role: "toolResult", toolCallId: `tool${i}`, toolName: "hub", content: [{ type: "text", text: "Inbox empty." }]
      } }));
      parentId = `r${i}`;
    }
    await fs.appendFile(file, lines.join("\n") + "\n");
  }
  const start = performance.now();
  const report = await buildReport(file);
  const scanned = performance.now();
  assert.equal(report.total.calls, count);
  assert.equal(report.diagnostics.repeatedStatus.length, count - 1);
  assert.equal(report.calls.length, count);
  assert.ok(Math.abs(report.total.costTotal - count * .01) < .000001);
  const brief = buildAiBrief(report);
  const publicJson = buildPublicJson(report);
  const elapsed = performance.now() - start;
  assert.equal(JSON.parse(publicJson).calls.length, count);
  console.log(JSON.stringify({ synthetic: true, calls: count, sourceBytes: (await fs.stat(file)).size,
    scanMs: Math.round(scanned - start), scanAndExportMs: Math.round(elapsed), briefBytes: Buffer.byteLength(brief),
    fullJsonBytes: Buffer.byteLength(publicJson), maxRssKiB: process.resourceUsage().maxRSS,
    caveat: "Environment-specific measurement, not a latency or memory guarantee." }, null, 2));
} finally { await fs.rm(dir, { recursive: true, force: true }); }
