import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildReport, scopeReport } from "../core.js";
import { buildAiBrief, buildPublicJson } from "../export.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { verifyExport } from "../verify-export.js";
import { createRuntimeObserver, sidecarPath } from "../runtime.js";
import { taskResultFacts } from "../semantic.js";
import { header, user, assistant, writeJsonl, tempDir, removeDir } from "./helpers.mjs";
const epoch = Date.parse("2026-09-13T00:00:00Z"), ts = n => new Date(epoch + n * 1000).toISOString();
const call = (id, parent, n, extra = {}) => assistant(id, "fixture", "primary", { parentId: parent, timestamp: ts(n), ...extra });
const init = task => ({ type: "session_init", id: "init", parentId: null, timestamp: ts(2), agent: "frontend-qa-fast", task: `Complete assignment thoroughly:\n\n${task}` });
const frame = (file, kind, id, n, fields = {}) => ({ schema: 1, runId: "run", id, kind, timestamp: epoch + n * 1000, monotonicMs: n * 1000, targetSessionFile: file, observerSource: "local-extension", ...fields });
const result = (details, n = 5) => ({ type: "message", id: "result", parentId: "spawn", timestamp: ts(n), message: { role: "toolResult", toolName: "task", toolCallId: "task-1", content: [{ type: "text", text: "done" }], details } });
const spawn = () => call("spawn", "u", 2, { content: [{ type: "toolCall", name: "task", id: "task-1", arguments: { name: "Visualqa", agent: "frontend-qa-fast", task: "编辑弹窗验收" } }] });
async function fixture(fn) { const dir = await tempDir(); try { await fn(dir, path.join(dir, "root.jsonl")); } finally { await removeDir(dir); } }
async function base(root, entries = []) { await writeJsonl(root, [header("root", ts(0)), user("u", "六类弹窗", { timestamp: ts(1) }), spawn(), ...entries]); }

// These scenarios use supported 0.9.0 public entry points, so the same file is a red/green contract.
test("0.9.1: unmetered failed child remains visible with its real parent and unknown usage", async () => fixture(async (dir, root) => {
  await base(root);
  const failed = call("failed", "init", 4, { failed: true }); delete failed.message.usage;
  await writeJsonl(path.join(dir, "root", "Visualqa.jsonl"), [header("qa", ts(2)), init("编辑弹窗验收"), failed]);
  const report = await buildReport(root), instance = report.ledger.instances.find(i => i.id === "qa");
  assert.ok(instance, "unmetered instances must not disappear");
  assert.equal(instance.calls, 0); assert.equal(instance.usageStatus, "not-recorded");
  assert.equal(instance.parentAgent, "main"); assert.equal(instance.title, "编辑弹窗验收");
  assert.equal(report.total.calls, 1); assert.equal(report.ledger.reconciliation.ok, true);
  assert.match(buildAiBrief(report), /无选定用量记录/);
}));

test("0.9.1: an unmetered parent can anchor an observed nested dispatch", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "六类弹窗", { timestamp: ts(1) })]);
  await writeJsonl(path.join(dir, "root", "Visualqa.jsonl"), [header("qa", ts(2)), init("编辑弹窗验收"), call("a", "init", 4)]);
  await writeJsonl(sidecarPath(root), [frame(root, "tool-dispatch", "dispatch", 2, { toolCallId: "task-1", parentEntryId: "u", name: "task", delegations: [{ toolCallId: "task-1", index: 0, name: "Visualqa", role: "frontend-qa-fast" }] })]);
  const report = await buildReport(root), instance = report.ledger.instances.find(i => i.id === "qa");
  assert.equal(instance.parentAgent, "main"); assert.equal(instance.taskName, "六类弹窗");
  assert.ok(instance.assignmentEvidence.includes("dispatch"));
}));

test("0.9.1: entirely unclosed tool intervals are unknown, not zero milliseconds", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "tool-start", "start", 3, { toolCallId: "wait", name: "hub", operation: "wait" })]);
  const wait = (await buildReport(root)).telemetry.waits[0];
  assert.equal(wait.unionMs, null); assert.equal(wait.measuredSpans, 0); assert.equal(wait.incompleteSpans, 1);
  assert.equal(wait.categories.find(c => c.category === "native-wait").unionMs, null);
}));

test("0.9.1: standalone structured acceptance is retained without inventing a review round", async () => fixture(async (_dir, root) => {
  const observation = { kind: "acceptance", id: "editor-check", taskId: "u", name: "编辑弹窗可操作", status: "blocked", baseline: "revision-1", evidenceIds: ["browser-log"], acceptanceChecks: ["编辑并保存"] };
  await base(root, [{ type: "custom", customType: "omp-session-cost:observation", id: "accepted", parentId: "spawn", timestamp: ts(4), data: observation }]);
  const report = await buildReport(root);
  assert.equal(report.telemetry.execution.acceptances.length, 1); assert.equal(report.telemetry.reviews.length, 0);
  assert.equal(report.telemetry.execution.acceptances[0].status, "blocked");
  assert.equal(report.telemetry.execution.acceptances[0].baseline, "revision-1");
  const md = buildAiBrief(report); assert.match(md, /执行交付与独立验收证据/); assert.match(md, /editor-check/); assert.equal(verifyExport(md).ok, true);
}));

test("0.9.1: native task result preserves failure, schema state and final-output evidence", async () => fixture(async (dir, root) => {
  const item = { id: "Visualqa", index: 0, agent: "frontend-qa-fast", task: "编辑弹窗验收", exitCode: 1, durationMs: 1200, truncated: false, output: "VPS 编辑权限受限；证据 /tmp/browser.log；password=privatevalue", stderr: "preview is read-only", structuredOutput: { status: "invalid", mode: "strict", source: "agent", error: "required evidence missing" } };
  await base(root, [result({ results: [item] })]);
  await writeJsonl(path.join(dir, "root", "Visualqa.jsonl"), [header("qa", ts(2)), init(item.task), call("a", "init", 4)]);
  const report = await buildReport(root), execution = report.telemetry.execution;
  assert.equal(execution.deliveries.length, 1); assert.equal(execution.acceptances.length, 0);
  const delivery = execution.deliveries[0]; assert.equal(delivery.instanceId, "qa"); assert.equal(delivery.exitCode, 1);
  assert.equal(delivery.structuredOutput.status, "invalid"); assert.equal(delivery.output.text.includes("/tmp/browser.log"), true);
  assert.equal(delivery.output.text.includes("privatevalue"), false); assert.equal(delivery.acceptance, "not-established-by-task-result");
  assert.equal(report.measurement.statusCounts.success, 2);
  const md = buildAiBrief(report); assert.match(md, /preview is read-only/); assert.equal(verifyExport(md).ok, true);
}));

test("0.9.1: task progress never masquerades as a final delivery", async () => fixture(async (_dir, root) => {
  await base(root, [result({ progress: [{ id: "Visualqa", agent: "frontend-qa-fast", task: "编辑弹窗验收", status: "running", output: "PASS" }] })]);
  const execution = (await buildReport(root)).telemetry.execution;
  assert.equal(execution.deliveries.length, 0); assert.equal(execution.acceptances.length, 0);
}));

test("0.9.1: nested dispatch results retain explicit acceptance observations", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "tool-dispatch-result", "nested-result", 4, { toolCallId: "nested", name: "task", observations: [{ kind: "acceptance", id: "nested-check", taskId: "u", status: "blocked" }] })]);
  const report = await buildReport(root);
  assert.equal(report.telemetry.execution.acceptances[0].id, "nested-check");
  assert.ok(report.telemetry.execution.acceptances[0].evidence.includes("nested-result"));
}));

test("0.9.1: task result mirrors are deduplicated without merging separate invocations", async () => fixture(async (_dir, root) => {
  const item = { id: "Visualqa", index: 0, agent: "frontend-qa-fast", task: "编辑弹窗验收", exitCode: 0, output: "报告称通过；不是独立验收", truncated: false };
  await base(root, [result({ results: [item] })]);
  const taskResults = taskResultFacts({ results: [item] });
  await writeJsonl(sidecarPath(root), [frame(root, "tool-end", "mirror", 5, { name: "task", toolCallId: "task-1", taskResults }), frame(root, "tool-dispatch-result", "separate", 6, { name: "task", toolCallId: "task-2", taskResults })]);
  const report = await buildReport(root), deliveries = report.telemetry.execution.deliveries;
  assert.equal(deliveries.length, 2); assert.ok(deliveries[0].evidence.includes("root\u0000result")); assert.ok(deliveries[0].evidence.includes("mirror"));
  assert.equal(report.telemetry.execution.acceptances.length, 0);
}));

test("0.9.1: scoped history cannot borrow a later lifecycle outcome or latest instruction", async () => fixture(async (dir, root) => {
  await base(root); const child = path.join(dir, "root", "Visualqa.jsonl");
  await writeJsonl(child, [header("qa", ts(2)), init("编辑弹窗验收"), call("a", "init", 4)]);
  await writeJsonl(sidecarPath(root), [frame(root, "subagent-lifecycle", "start", 3, { childFile: child, status: "started", title: "执行验收" }), frame(root, "subagent-lifecycle", "done", 8, { childFile: child, status: "completed", title: "收尾清理" })]);
  const report = scopeReport(await buildReport(root), { to: ts(6) }), instance = report.ledger.instances.find(i => i.id === "qa");
  assert.equal(instance.status, "started"); assert.equal(instance.latestInstruction, "执行验收");
  assert.doesNotMatch(buildAiBrief(report), /收尾清理/);
}));

test("0.9.1: result output clipping is explicit and no raw transcript is required", () => {
  const [item] = taskResultFacts({ results: [{ id: "qa", agent: "qa", task: "任务", output: "中".repeat(20000), truncated: true, exitCode: 0 }] });
  assert.ok(item.output.text.length > 0 && item.output.text.length < 20000);
  assert.equal(item.output.truncated, true); assert.equal(item.output.sourceTruncated, true);
  assert.equal(item.output.originalChars, 20000);
});

test("0.9.1: empty transcript inventory remains scoped and does not create usage records", async () => fixture(async (dir, root) => {
  await base(root); await writeJsonl(path.join(dir, "root", "Emptyworker.jsonl"), [header("empty", ts(2))]);
  const report = await buildReport(root), empty = report.ledger.instances.find(i => i.id === "empty");
  assert.equal(empty.usageStatus, "not-recorded"); assert.equal(empty.parentAgent, "main");
  assert.equal(scopeReport(report, { agent: "main" }).ledger.instances.some(i => i.id === "empty"), false);
  assert.equal(verifyExport(buildPublicJson(report)).ok, true);
}));

test("0.9.1: complete zero duration is distinct from an unclosed interval", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "tool-start", "start", 3, { name: "hub", operation: "wait", toolCallId: "w" }), frame(root, "tool-end", "end", 3, { name: "hub", toolCallId: "w" })]);
  const wait = (await buildReport(root)).telemetry.waits[0];
  assert.equal(wait.unionMs, 0); assert.equal(wait.measuredSpans, 1); assert.equal(wait.incompleteSpans, 0);
}));

test("0.9.1: acceptance and final delivery respect selected event-time boundaries", async () => fixture(async (_dir, root) => {
  await base(root, [result({ results: [{ id: "qa", agent: "qa", task: "验收", exitCode: 0, output: "later-only-final-output" }], costObservation: { kind: "acceptance", id: "later-only-claim", status: "passed" } }, 9)]);
  const report = scopeReport(await buildReport(root), { to: ts(6) });
  assert.equal(report.telemetry.execution.deliveries.length, 0); assert.equal(report.telemetry.execution.acceptances.length, 0);
  assert.doesNotMatch(buildAiBrief(report), /later-only/);
}));

test("0.9.1: direct structured acceptance payload is visible but not independently verified", async () => fixture(async (_dir, root) => {
  await base(root, [result({ results: [{ id: "qa", agent: "qa", task: "验收", exitCode: 0, structuredOutput: { mode: "strict", source: "agent", status: "valid", data: { kind: "acceptance", id: "check", status: "passed", baseline: "rev-2", evidenceIds: ["screenshot"] } } }] })]);
  const execution = (await buildReport(root)).telemetry.execution;
  assert.equal(execution.acceptances[0].id, "check"); assert.match(execution.acceptances[0].verification, /not independently verified/);
  assert.match(execution.deliveries[0].structuredOutput.data.text, /screenshot/);
}));

test("0.9.1: runtime mirror acceptance is counted once with both evidence sources", async () => fixture(async (_dir, root) => {
  const observation = { kind: "acceptance", id: "check", status: "blocked", source: "structured-metadata" };
  await base(root, [result({ observation })]);
  await writeJsonl(sidecarPath(root), [frame(root, "workflow", "mirror-check", 5, { toolCallId: "task-1", observation })]);
  const acceptance = (await buildReport(root)).telemetry.execution.acceptances;
  assert.equal(acceptance.length, 1); assert.deepEqual(new Set(acceptance[0].evidence), new Set(["root\u0000result", "mirror-check"]));
}));

test("0.9.1: live observer records native final result fields without altering the tool result", async () => fixture(async (_dir, root) => {
  const frames = [], hooks = new Map(), pi = { on: (name, fn) => hooks.set(name, fn) };
  const ctx = { sessionManager: { getSessionFile: () => root } };
  const observer = createRuntimeObserver(pi, { append: async (_file, line) => frames.push(JSON.parse(line)), configurationFiles: async () => [] });
  const event = { toolName: "task", toolCallId: "qa", result: { details: { results: [{ id: "qa", agent: "qa", task: "验收", exitCode: 1, output: "permission denied", truncated: false }] } } };
  const original = JSON.stringify(event);
  await hooks.get("tool_execution_end")(event, ctx); await observer.flush();
  assert.equal(JSON.stringify(event), original); assert.equal(frames.find(f => f.kind === "tool-end").taskResults[0].exitCode, 1);
  assert.equal(frames.find(f => f.kind === "tool-end").taskResults[0].output.text, "permission denied"); observer.dispose();
}));

test("0.9.1: text limit does not split an emoji surrogate pair", () => {
  const [r] = taskResultFacts({ results: [{ id: "qa", agent: "qa", task: "验收", output: "a".repeat(8191) + "🔎" + "z" }] });
  assert.equal(r.output.retainedChars, 8191); assert.equal(r.output.truncated, true); assert.equal(r.output.text.endsWith("a"), true);
});

test("0.9.1: missing session-init task does not mask a supported task-result title", async () => fixture(async (dir, root) => {
  await base(root, [result({ results: [{ id: "Visualqa", agent: "frontend-qa-fast", assignment: "编辑弹窗验收", exitCode: 1 }] })]);
  await writeJsonl(path.join(dir, "root", "Visualqa.jsonl"), [header("qa", ts(2)), { ...init(""), task: undefined }, call("qa", "init", 4)]);
  const instance = (await buildReport(root)).ledger.instances.find(i => i.id === "qa");
  assert.equal(instance.title, "编辑弹窗验收");
}));
