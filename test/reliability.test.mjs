import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { buildReport, scopeReport } from "../core.js";
import { assignmentTitle, assignmentHash, noteFacts } from "../semantic.js";
import { SHARED_TASK } from "../ledger.js";
import { buildAiBrief, buildCopyPayload, buildPublicJson } from "../export.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { copyText } from "../clipboard.js";
import { createRuntimeObserver, sidecarPath } from "../runtime.js";
import { ANALYSIS_POLICY, sealMarkdown, verifyMarkdown, sealJson, verifyJson, collectionCoverage } from "../report-contract.js";
import { saveReportFile } from "../command.js";
import { header, user, assistant, advisorCard, writeJsonl, tempDir, removeDir } from "./helpers.mjs";
const epoch = Date.parse("2026-09-12T00:00:00Z"), ts = n => new Date(epoch + n * 1000).toISOString();
const call = (id, parent, n, extra = {}) => assistant(id, "fixture", "model", { parentId: parent, timestamp: ts(n), ...extra });
const init = (assignment, role = "backend-engineer") => ({ type: "session_init", id: "init", parentId: null, timestamp: ts(2), task: `Complete assignment thoroughly:\n\n${assignment}\n`, agent: role });
const spawn = (id, parent, n, items) => call(id, parent, n, { content: [{ type: "toolCall", name: "task", id: `tool-${id}`, arguments: { context: "test", tasks: items } }] });
const result = (id, parent, n, toolId, results) => ({ type: "message", id, parentId: parent, timestamp: ts(n), message: { role: "toolResult", toolName: "task", toolCallId: toolId, content: [{ type: "text", text: "done" }], details: { results } } });
const frame = (file, kind, id, n, fields = {}) => ({ schema: 1, runId: "test", id, kind, timestamp: epoch + n * 1000, monotonicMs: n * 1000, targetSessionFile: file, observerSource: "local-extension", ...fields });
async function fixture(fn) { const dir = await tempDir(); try { await fn(dir, path.join(dir, "root.jsonl")); } finally { await removeDir(dir); } }
async function base(root) { await writeJsonl(root, [header("root", ts(0)), user("u", "测试任务", { timestamp: ts(1) }), call("a", "u", 5)]); }

test("strip only the known OMP task wrapper and retain the meaningful title", () => {
  const text = "修复 SYS-01\n保留 prod.private.internal 的状态";
  assert.equal(assignmentTitle(`Complete assignment thoroughly:\r\n\r\n${text}`), "修复 SYS-01");
  assert.equal(assignmentHash(text), assignmentHash(`Complete assignment thoroughly:\n\n${text}\n`));
  assert.equal(assignmentTitle("Complete assignment thoroughly: a literal user sentence"), "Complete assignment thoroughly: a literal user sentence");
});

test("wrapped assignment joins an allocated filename without guessing case-normalized names", async () => fixture(async (dir, root) => {
  const task = "修复配置编辑弹窗\n保留用户配置";
  await writeJsonl(root, [header("root", ts(0)), user("u", "重设计", { timestamp: ts(1) }), spawn("spawn", "u", 2, [{ name: "config-editor", agent: "backend-engineer", task }])]);
  await writeJsonl(path.join(dir, "root", "Configeditor.jsonl"), [header("child", ts(2)), init(task), call("child-call", "init", 3)]);
  const r = await buildReport(root), c = r.calls.find(c => c.entryId === "child-call"), i = r.ledger.instances.find(i => i.id === "child");
  assert.equal(c.taskName, "重设计"); assert.equal(c.title, "修复配置编辑弹窗"); assert.equal(i.parentAgent, "main");
  assert.equal(i.parentToolCallId, "tool-spawn"); assert.deepEqual(i.delegationMatches, ["normalized-assignment-hash"]);
  assert.equal(r.ledger.reconciliation.ok, true);
}));

test("allocated result ID links batch members to the original spawn, not the result-time user task", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u1", "任务一", { timestamp: ts(1) }), spawn("spawn", "u1", 2, [{ agent: "backend-engineer", task: "shared instructions" }, { agent: "backend-engineer", task: "shared instructions" }]), user("u2", "任务二", { timestamp: ts(3), parentId: "spawn" }),
    result("result", "u2", 4, "tool-spawn", [{ index: 0, id: "AllocatedOne", agent: "backend-engineer", assignment: "first exact assignment" }, { index: 1, id: "AllocatedTwo", agent: "backend-engineer", task: "second exact assignment" }])]);
  for (const name of ["AllocatedOne", "AllocatedTwo"]) await writeJsonl(path.join(dir, "root", `${name}.jsonl`), [header(name, ts(2)), init("wrapped/revised by upstream"), call(name, "init", 5)]);
  const r = await buildReport(root);
  for (const i of r.ledger.instances.filter(i => i.actorType === "subagent")) {
    assert.equal(i.taskName, "任务一"); assert.equal(i.parentAgent, "main"); assert.deepEqual(i.delegationMatches, ["task-result-allocated-id"]);
    assert.ok(i.assignmentEvidence.includes("root\u0000result"));
  }
}));

test("ambiguous repeated assignments stay unassigned rather than inventing shared work", async () => fixture(async (dir, root) => {
  const item = { agent: "backend-engineer", task: "相同正文" };
  await writeJsonl(root, [header("root", ts(0)), user("u1", "任务一", { timestamp: ts(1) }), spawn("one", "u1", 2, [item]), user("u2", "任务二", { parentId: "one", timestamp: ts(3) }), spawn("two", "u2", 4, [item])]);
  await writeJsonl(path.join(dir, "root", "Worker.jsonl"), [header("worker", ts(2)), init(item.task), call("worker", "init", 5)]);
  const r = await buildReport(root), c = r.calls.find(c => c.entryId === "worker");
  assert.equal(c.taskKey, SHARED_TASK); assert.equal(c.taskAttribution, "ambiguous-delegation"); assert.equal(c.candidateTasks.length, 2);
}));

test("the main instance describes multiple task buckets, and an orphan never displays itself as parent", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u1", "任务一", { timestamp: ts(1) }), call("one", "u1", 2), user("u2", "任务二", { timestamp: ts(3) }), call("two", "u2", 4)]);
  await writeJsonl(path.join(dir, "root", "Orphan.jsonl"), [header("orphan", ts(2)), call("orphan", null, 5)]);
  const r = await buildReport(root), main = r.ledger.instances.find(i => i.actorType === "main");
  assert.equal(main.taskKey, null); assert.equal(main.taskAssignments.length, 2); assert.equal(main.parentAgent, null);
  assert.equal(r.ledger.instances.find(i => i.id === "orphan").parentAgent, "main");
  assert.doesNotMatch(buildAiBrief(r), /父代理：Orphan/);
}));

test("time-filtered exports retain out-of-range delegation evidence and multi-metric conservation", async () => fixture(async (dir, root) => {
  const task = "验证任务";
  await writeJsonl(root, [header("root", ts(0)), user("u", "完整任务", { timestamp: ts(1) }), spawn("spawn", "u", 2, [{ name: "worker", agent: "backend-engineer", task }])]);
  await writeJsonl(path.join(dir, "root", "Worker.jsonl"), [header("child", ts(2)), init(task), call("worker", "init", 9)]);
  const selected = scopeReport(await buildReport(root), { from: ts(8) }), d = buildDiagnosticData(selected);
  assert.equal(selected.total.calls, 1); assert.ok(d.events.some(e => e.key === "root\u0000spawn" && e.outsideSelectedRange));
  assert.equal(d.dataQuality.conservation.length, 80); assert.ok(d.dataQuality.conservation.every(c => c.ok));
  assert.equal(d.ledger.tasks.find(t => t.name === "完整任务").calls, 1);
}));

test("context-only Advisor evidence remains distinct from request observation and disposition", async () => fixture(async (_dir, root) => {
  const note = { id: "note", advisor: "Architecture", severity: "blocker", note: "核验 /src/store.ts 和 prod.private.internal；password=secretvalue" };
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card", [note], { timestamp: ts(2) }), call("a", "card", 5)]);
  await writeJsonl(sidecarPath(root), [frame(root, "context-notes", "context", 3, { notes: noteFacts([note]) })]);
  const r = await buildReport(root), a = r.telemetry.advisor;
  assert.equal(a.contextObserved, 1); assert.equal(a.requestObserved, 0); assert.equal(a.dispositionUnknown, 1); assert.equal(a.open, 0); assert.equal(a.blockerOpen, 0);
  assert.equal(r.telemetry.notes[0].contextAt, epoch + 3000);
  const text = buildAiBrief(r); assert.match(text, /prod.private.internal/); assert.match(text, /\/src\/store.ts/); assert.doesNotMatch(text, /secretvalue/);
}));

test("explicit Advisor occurrence IDs disambiguate repeated contents without fabricating adoption", async () => fixture(async (_dir, root) => {
  const n1 = { id: "first", note: "相同建议", severity: "concern" }, n2 = { ...n1, id: "second" };
  await writeJsonl(root, [header("root", ts(0)), advisorCard("first-card", [n1], { timestamp: ts(1) }), advisorCard("second-card", [n2], { timestamp: ts(2) }), call("a", "second-card", 5)]);
  await writeJsonl(sidecarPath(root), [frame(root, "context-notes", "context", 3, { notes: noteFacts([n2]) })]);
  const r = await buildReport(root);
  assert.equal(r.telemetry.notes.find(n => n.id === "first").contextAt, null);
  assert.equal(r.telemetry.notes.find(n => n.id === "second").contextAt, epoch + 3000);
  assert.equal(r.telemetry.advisor.disposed, 0);
}));

test("collection coverage partitions selected calls and never invents request timings", () => {
  const calls = [1, 2, 3, 4, 5].map(n => ({ recordKey: String(n), timestamp: n, sessionFile: "/x", transcriptId: "x", agent: "main" }));
  const coverage = collectionCoverage(calls, [{ sourceFile: "/x", id: "s", kind: "observer-start", timestamp: 3 }, { sourceFile: "/x", id: "e", kind: "assistant-message-start", timestamp: 4 }], []);
  assert.deepEqual(coverage[0].reasons, { measured: 0, beforeFirstObservation: 2, afterLastObservation: 1, noCollectorEvidence: 0, noRequestHookObserved: 2, unlinkedOrIncomplete: 0, missingTimestamp: 0 });
  assert.equal(Object.values(coverage[0].reasons).reduce((a, b) => a + b), 5);
});

test("observer first attaches at cost snapshot when loaded late; stable flushes do not grow sidecars", async () => fixture(async (_dir, root) => {
  const writes = [], pi = { on() {}, events: { on() {} } }, ctx = { sessionManager: { getSessionFile: () => root } };
  const o = createRuntimeObserver(pi, { now: () => epoch, append: async (_file, line) => writes.push(JSON.parse(line)) });
  await o.flush(ctx); const count = writes.length; await o.flush(ctx);
  assert.equal(writes.length, count); assert.equal(writes[0].kind, "observer-start"); assert.equal(writes[0].trigger, "cost-snapshot");
  assert.deepEqual(writes.find(w => w.kind === "observer-status").observedHooks, {});
  o.dispose();
}));

test("observer health persists write errors without storing prompts or treating registration as activity", async () => fixture(async (_dir, root) => {
  const writes = []; let fail = true;
  const o = createRuntimeObserver({ on() {} }, { append: async (_file, line) => { if (fail) { fail = false; throw Object.assign(new Error("disk"), { code: "ENOSPC" }); } writes.push(JSON.parse(line)); }, configurationFiles: async () => [] });
  const ctx = { sessionManager: { getSessionFile: () => root } };
  await o.handle({ type: "agent_start" }, ctx); await o.flush();
  const h = writes.find(w => w.kind === "observer-status"); assert.equal(h.observedHooks.agent_start, 1); assert.equal(h.errors[0].code, "ENOSPC");
  assert.equal(h.observedHooks.before_provider_request, undefined); o.dispose();
}));

test("large Unicode report envelopes detect missing tails, same-length edits and CRLF transport", () => {
  const body = "报告🙂".repeat(14000), report = sealMarkdown(body);
  assert.ok(Buffer.byteLength(report) > 80000); assert.equal(verifyMarkdown(report).ok, true);
  assert.equal(verifyMarkdown(report.replace("报告", "错误")).ok, false);
  assert.equal(verifyMarkdown(report.slice(0, -25)).ok, false);
  assert.equal(verifyMarkdown(report.replaceAll("\n", "\r\n")).ok, true);
  assert.equal(verifyMarkdown(body).ok, false);
});

test("JSON integrity is computed from the body and rejects edits or truncation", () => {
  const json = sealJson({ data: "完整🙂", calls: [1, 2, 3] }, true);
  assert.equal(verifyJson(json).ok, true); assert.equal(verifyJson(json.replace("完整", "删改")).ok, false);
  assert.equal(verifyJson(json.slice(0, -10)).ok, false);
});

test("all copy modes are self-contained; comprehensive policy survives an additional user focus", async () => fixture(async (_dir, root) => {
  await base(root); const r = await buildReport(root);
  for (const mode of ["brief", "selection", "tab", "markdown", "json"]) {
    const payload = buildCopyPayload(r, mode, { tabId: "runtime", question: "本次还关注重试", protectedScopes: "不动现有模型" });
    assert.equal((mode === "json" ? verifyJson(payload) : verifyMarkdown(payload)).ok, true);
    assert.ok(payload.includes("全面、开放式诊断")); assert.ok(payload.includes("本次还关注重试"));
  }
  const brief = buildAiBrief(r);
  assert.ok(brief.indexOf("## 数据质量") < brief.indexOf("## 主体类型"));
  assert.ok(brief.indexOf("## Advisor：") < brief.indexOf("## agent 运行实例"));
  assert.ok(ANALYSIS_POLICY.includes("不预设"));
}));

test("native clipboard read-back verifies a large payload without truncation", async () => {
  const text = sealMarkdown("源数据中文🙂".repeat(18000)); let received;
  const result = await copyText(text, { platform: "linux", env: { WAYLAND_DISPLAY: "test" }, write: async (_c, _a, s) => { received = s; }, read: async () => received });
  assert.equal(result.verification, "readback-matched"); assert.equal(result.bytes, Buffer.byteLength(text)); assert.equal(received, text);
});

test("clipboard truncation is an error, never a success notification", async () => {
  await assert.rejects(copyText("完整正文", { platform: "darwin", write: async () => {}, read: async () => "完整" }), /回读.*不一致/);
});

test("unavailable clipboard read-back and terminal transport remain explicitly unverified", async () => {
  const native = await copyText("text", { platform: "darwin", write: async () => {}, read: async () => { throw new Error("unavailable"); } });
  assert.equal(native.verification, "sent-unverified");
  const terminal = await copyText("text", { platform: "linux", env: {}, osc: () => true });
  assert.equal(terminal.verification, "sent-unverified");
  let used = false; await assert.rejects(copyText("x".repeat(75001), { platform: "linux", env: {}, osc: () => { used = true; return true; } }), /没有截断/);
  assert.equal(used, false);
});

test("saved large reports survive exact read-back and never overwrite an existing file", async () => fixture(async (dir, root) => {
  await base(root); const text = buildPublicJson(await buildReport(root), { pretty: true });
  const saved = await saveReportFile("report.json", text, dir);
  assert.equal(verifyJson(await fs.readFile(saved.path, "utf8")).ok, true);
  await assert.rejects(saveReportFile("report.json", "replacement", dir), { code: "EEXIST" });
}));

test("quality checks detect a display-total mismatch even when internal task groups reconcile", async () => fixture(async (_dir, root) => {
  await base(root); const r = await buildReport(root);
  r.total = { ...r.total, costTotal: r.total.costTotal + 1 };
  const d = buildDiagnosticData(r);
  assert.ok(d.dataQuality.issues.some(i => i.code === "conservation-failed"));
  assert.ok(d.dataQuality.conservation.some(c => c.dimension === "selected-total" && c.metric === "costTotal" && !c.ok));
}));

test("filtered Advisor reports retain the out-of-range generator evidence", async () => fixture(async (dir, root) => {
  const note = { advisor: "default", severity: "concern", note: "核验回滚路径" };
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card", [note], { timestamp: ts(5) }), call("a", "card", 7)]);
  await writeJsonl(path.join(dir, "root", "__advisor.jsonl"), [header("advisor", ts(0)), call("generation", null, 2, { content: [{ type: "toolCall", id: "advice", name: "advise", arguments: note }] })]);
  const d = buildDiagnosticData(scopeReport(await buildReport(root), { from: ts(4), actorType: "main" }));
  assert.equal(d.telemetry.notes[0].generationToDeliveryMs, 3000);
  assert.ok(d.events.some(e => e.key === "advisor\u0000generation" && e.outsideSelectedRange));
}));

test("an empty JSON body still receives a valid integrity envelope", () => {
  assert.equal(verifyJson(sealJson({})).ok, true);
});

test("collector health counts affected runs, not repeated process snapshots", async () => fixture(async (_dir, root) => {
  await base(root); const r = await buildReport(root);
  const health = { runId: "one-run", dropped: 3, errors: [{ code: "ENOSPC" }] };
  r.telemetry.coverage.collectors = [{ health: [health, { ...health }, { ...health }] }];
  r.observerStatus = { ...health };
  const issue = buildDiagnosticData(r).dataQuality.issues.find(i => i.code === "collector-unhealthy-runs");
  assert.equal(issue.count, 1);
}));


test("scoped copying retains current observer write errors even without durable health frames", async () => fixture(async (_dir, root) => {
  await base(root);
  const report = await buildReport(root);
  report.observerStatus = { runId: "failed-run", queued: 0, dropped: 1, errors: [{ code: "EACCES" }] };
  const scoped = scopeReport(report, { actorType: "main" });
  assert.deepEqual(scoped.observerStatus, report.observerStatus);
  assert.ok(buildDiagnosticData(scoped).dataQuality.issues.some(i => i.code === "collector-unhealthy-runs"));
}));
