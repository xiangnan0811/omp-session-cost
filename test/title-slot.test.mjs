import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildReport } from "../core.js";
import { readHeader } from "../transcript.js";
import { assistant, header, removeDir, tempDir } from "./helpers.mjs";

function serializeTitleSlot(title = "Current session title", source = "auto") {
  const updatedAt = "2026-09-03T00:00:00.000Z";
  const base = { type: "title", v: 1, title, source, updatedAt, pad: "" };
  const unpadded = `${JSON.stringify(base)}\n`;
  const padBytes = 256 - Buffer.byteLength(unpadded, "utf8");
  assert.ok(padBytes >= 0, "fixture title metadata must fit the OMP title slot");
  const line = `${JSON.stringify({ ...base, pad: " ".repeat(padBytes) })}\n`;
  assert.equal(Buffer.byteLength(line, "utf8"), 256);
  return line;
}

function currentSessionBody(id, entries, title = "Current session title") {
  return `${serializeTitleSlot(title)}${[header(id), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

test("readHeader skips the OMP 18 fixed-width title slot and folds its current title", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "main.jsonl");
  try {
    await fs.writeFile(file, currentSessionBody("main", [], "Xirang review"));
    const parsed = await readHeader(file);
    assert.equal(parsed?.type, "session");
    assert.equal(parsed?.id, "main");
    assert.equal(parsed?.title, "Xirang review");
    assert.equal(parsed?.titleSource, "auto");
  } finally {
    await removeDir(dir);
  }
});

test("readHeader keeps accepting legacy files that start directly with the session header", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "legacy.jsonl");
  try {
    await fs.writeFile(file, `${JSON.stringify(header("legacy"))}\n`);
    const parsed = await readHeader(file);
    assert.equal(parsed?.id, "legacy");
    assert.equal(parsed?.type, "session");
  } finally {
    await removeDir(dir);
  }
});

test("readHeader supports a fixed-width title slot in gzip transcripts", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "compressed.jsonl.gz");
  try {
    await fs.writeFile(file, gzipSync(currentSessionBody("compressed", [], "Compressed title")));
    const parsed = await readHeader(file);
    assert.equal(parsed?.id, "compressed");
    assert.equal(parsed?.title, "Compressed title");
  } finally {
    await removeDir(dir);
  }
});

test("buildReport accepts current OMP physical layout for root and recursive transcripts", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "main.jsonl");
  const child = path.join(dir, "main", "Worker.jsonl");
  try {
    await fs.mkdir(path.dirname(child), { recursive: true });
    await fs.writeFile(root, currentSessionBody("main", [assistant("root-call", "openai-codex", "gpt-5.6-sol")]));
    await fs.writeFile(child, currentSessionBody("worker", [assistant("worker-call", "xai-oauth", "grok-4.6")]));

    const report = await buildReport(root, { exec: async () => ({ code: 0 }) }, { cwd: dir });
    assert.equal(report.total.calls, 2);
    assert.equal(report.metadata.filesScanned, 2);
    assert.equal(report.metadata.skippedInvalidFiles, 0);
    assert.ok(report.primaryAgents.some(row => row.agent === "Worker"));
  } finally {
    await removeDir(dir);
  }
});

test("readHeader rejects non-title objects before the logical session header", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "invalid.jsonl");
  try {
    await fs.writeFile(file, `${JSON.stringify({ type: "message", id: "bad" })}\n${JSON.stringify(header("late"))}\n`);
    assert.equal(await readHeader(file), null);
  } finally {
    await removeDir(dir);
  }
});
