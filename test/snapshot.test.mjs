import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { freezeFiles, visitFrozen, MAX_LINE_BYTES } from "../snapshot.js";
import { buildReport } from "../core.js";
import { assistant, header, writeJsonl, tempDir, removeDir } from "./helpers.mjs";

async function frozen(content, callback, name = "snapshot.jsonl") {
  const dir = await tempDir(); const file = path.join(dir, name);
  try { await fs.writeFile(file, content); const snap = await freezeFiles([file]); return await callback(file, snap.descriptors[0]); }
  finally { await removeDir(dir); }
}

test("frozen byte prefixes exclude later appends and carry content digests", async () => {
  await frozen('{"id":"before"}\n', async (file, descriptor) => {
    await fs.appendFile(file, '{"id":"after"}\n');
    const entries = []; const meta = await visitFrozen(descriptor, e => entries.push(e));
    assert.deepEqual(entries.map(e => e.id), ["before"]);
    assert.equal(meta.records, 1); assert.equal(meta.changedDuringScan, false);
    assert.ok(meta.appendedBytesExcluded > 0); assert.match(meta.digest, /^[0-9a-f]{64}$/);
  });
});

test("valid but unterminated tail is excluded; invalid lines and nonobjects are counted", async () => {
  await frozen('{"id":"ok"}\nINVALID\n[]\n{"id":"tail"}', async (_file, d) => {
    const entries = []; const meta = await visitFrozen(d, e => entries.push(e));
    assert.equal(entries.length, 1); assert.equal(meta.invalidJson, 1); assert.equal(meta.nonObjects, 1); assert.equal(meta.partialTail, 1);
  });
});

test("oversized lines are bounded and skipped without dropping following records", async () => {
  await frozen('"' + 'x'.repeat(MAX_LINE_BYTES + 1) + '"\n{"id":"next"}\n', async (_file, d) => {
    const entries = []; const meta = await visitFrozen(d, e => entries.push(e));
    assert.equal(meta.oversizedLines, 1); assert.equal(entries[0].id, "next");
  });
});

test("gzip scans the frozen compressed prefix; trailing partial JSON remains partial", async () => {
  await frozen(gzipSync('{"id":"one"}\n{"id":"two"}\n{"unfinished":'), async (_file, d) => {
    const entries = []; const meta = await visitFrozen(d, e => entries.push(e));
    assert.equal(entries.length, 2); assert.equal(meta.partialTail, 1); assert.equal(meta.unavailable, null);
  }, "data.jsonl.gz");
});

test("in-place truncation is detected and unreadable frozen files are reported", async () => {
  await frozen('{"id":"one"}\n{"id":"two"}\n', async (file, d) => {
    await fs.truncate(file, 0);
    const meta = await visitFrozen(d, () => {});
    assert.equal(meta.changedDuringScan, true);
  });
  const snapshot = await freezeFiles(["/no/such/omp-cost-file.jsonl"]);
  assert.ok(snapshot.descriptors[0].unavailable);
  assert.ok((await visitFrozen(snapshot.descriptors[0], () => {})).unavailable);
});

test("running-session scan excludes incomplete records consistently across all aggregates", async () => {
  const dir = await tempDir(), file = path.join(dir, "session.jsonl");
  try {
    await writeJsonl(file, [header("snapshot"), assistant("a", "p", "m")]);
    await fs.appendFile(file, JSON.stringify(assistant("tail", "p", "m")));
    const report = await buildReport(file);
    assert.equal(report.total.calls, 1); assert.equal(report.metadata.partialTails, 1);
    assert.equal(report.calls.length, report.models[0].calls);
    assert.equal(report.snapshot.recordCount, 1);
    assert.equal(report.snapshot.files[0].records, 2);
  } finally { await removeDir(dir); }
});
