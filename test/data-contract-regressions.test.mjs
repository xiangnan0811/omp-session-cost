import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRuntimeObserver, sidecarPath } from "../runtime.js";
import { buildReport } from "../core.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { sealMarkdown } from "../report-contract.js";
import { header, user, assistant, writeJsonl, tempDir, removeDir } from "./helpers.mjs";
const t = n => new Date(Date.parse("2026-09-13T00:00:00Z") + 1000 * n).toISOString();
async function fixture(fn) { const dir = await tempDir(); try { await fn(dir, path.join(dir, "root.jsonl")); } finally { await removeDir(dir); } }
const call = (id, parent, n, content) => assistant(id, "fixture", "primary", { parentId: parent, timestamp: t(n), ...(content ? { content } : {}) });
async function observerFrames(root, steps) {
  const hooks = new Map(), frames = []; let clock = 0;
  const observer = createRuntimeObserver({ on: (type, fn) => hooks.set(type, fn) }, { now: () => Date.parse(t(0)) + clock, clock: () => clock, configurationFiles: async () => [], append: async (_f, line) => frames.push(JSON.parse(line)) });
  const context = model => ({ model: { provider: "fixture", id: model }, sessionManager: { getSessionFile: () => root, getLeafId: () => "u" } });
  for (const [type, event, model = "primary"] of steps) { clock += 100; await hooks.get(type)(event, context(model)); }
  await observer.flush(); return frames;
}

test("contract: main survives a different-model Advisor request lacking message_end", async () => fixture(async (_dir, root) => {
  const a = call("a", "u", 5);
  const frames = await observerFrames(root, [["turn_start", {}], ["before_provider_request", { payload: { model: "primary" } }], ["before_provider_request", { payload: { model: "side" } }, "side"], ["message_end", { message: a.message }]]);
  const start = frames.find(f => f.kind === "request-start" && f.payloadModel === "primary"), end = frames.find(f => f.kind === "request-end");
  assert.equal(end.requestId, start.requestId); assert.equal(end.ambiguous, false);
}));

test("contract: compaction helper cannot poison the next primary turn of the same model", async () => fixture(async (_dir, root) => {
  const a = call("a", "u", 5);
  const frames = await observerFrames(root, [["turn_start", {}], ["auto_compaction_start", {}], ["before_provider_request", { payload: { model: "primary" } }], ["auto_compaction_end", {}], ["turn_start", {}], ["before_provider_request", { payload: { model: "primary" } }], ["message_end", { message: a.message }]]);
  const starts = frames.filter(f => f.kind === "request-start"), end = frames.find(f => f.kind === "request-end");
  assert.equal(end.requestId, starts[1].requestId); assert.equal(end.ambiguous, false);
  assert.equal(starts[1].ambiguous, false);
}));

test("contract: workpool structured result is usable task ownership evidence", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", t(0)), user("u", "原始池任务", { timestamp: t(1) }), call("spawn", "u", 2, [{ type: "toolCall", id: "eval", name: "eval", arguments: { code: "dynamic workpool" } }]), { type: "message", id: "result", parentId: "spawn", timestamp: t(3), message: { role: "toolResult", toolName: "eval", toolCallId: "eval", details: { statusEvents: [{ op: "workpool", action: "push", pool: "pool", count: 1 }] }, content: [] } }]);
  await writeJsonl(path.join(dir, "root", "worker.jsonl"), [header("child", t(2)), { type: "session_init", id: "init", parentId: null, timestamp: t(2), agent: "backend-engineer", task: '<workpool pool="pool" batch="batch">' }, call("work", "init", 5)]);
  assert.equal((await buildReport(root)).calls.find(c => c.entryId === "work").taskName, "原始池任务");
}));

test("contract: lifecycle updates never rewrite the historical task title", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", t(0)), call("a", null, 2)]);
  const child = path.join(dir, "root", "worker.jsonl");
  await writeJsonl(child, [header("child", t(2)), { type: "session_init", id: "init", parentId: null, timestamp: t(2), agent: "backend-engineer", task: "修复原任务" }, call("work", "init", 4)]);
  await writeJsonl(sidecarPath(root), [{ schema: 1, runId: "r", id: "late", kind: "subagent-lifecycle", timestamp: Date.parse(t(8)), targetSessionFile: root, childFile: child, title: "最终清理指令", status: "completed" }]);
  assert.equal((await buildReport(root)).calls.find(c => c.entryId === "work").title, "修复原任务");
}));

test("contract: transport output never contains raw NUL bytes", () => assert.equal(sealMarkdown("note\u0000id").includes("\u0000"), false));

test("contract: copied report includes every normalized usage record for offline arithmetic", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", t(0)), call("a", null, 2)]);
  const data = buildDiagnosticData(await buildReport(root)); assert.equal(data.replay?.rows?.length, 1);
}));
