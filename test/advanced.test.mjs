import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReport, scopeReport, selectionFilter } from "../core.js";
import { displayName, noteFacts, taskFacts, workflowFact } from "../semantic.js";
import { SHARED_TASK } from "../ledger.js";
import { createRuntimeObserver, sidecarPath, wireNotes, responseIdentity } from "../runtime.js";
import { intervalUnion } from "../telemetry.js";
import { makeBaseline, saveBaseline, loadBaseline, listBaselines, compareBaseline, saveProfile, loadProfile } from "../baseline.js";
import { header, user, assistant, writeJsonl, tempDir, removeDir, advisorCard } from "./helpers.mjs";
const epoch = Date.parse("2026-09-11T01:00:00Z");
const ts = n => new Date(epoch + n * 1000).toISOString();
const call = (id, parent, n, extra = {}) => assistant(id, "fixture", "model", { parentId: parent, timestamp: ts(n), ...extra });
const init = (role, title = "独立审查") => ({ type: "session_init", id: "init", parentId: null, timestamp: ts(1), agent: role, task: title, modelRole: "@designer", resolvedModel: "fixture/model", readOnly: true, systemPrompt: "not exported prompt" });
const observation = (id, parent, n, data) => ({ type: "custom", customType: "omp-session-cost:observation", id, parentId: parent, timestamp: ts(n), data });
const spawn = (id, parent, n, name, agent = "grok-reviewer") => call(id, parent, n, { content: [{ type: "toolCall", id: `spawn-${id}`, name: "task", arguments: { name, agent, task: `审查 ${name}\n正文不作为标题` } }] });
async function fixture(fn) { const dir = await tempDir(); try { await fn(dir, path.join(dir, "root.jsonl")); } finally { await removeDir(dir); } }
const frame = (root, kind, id, n, extra = {}) => ({ schema: 1, runId: "test-run", id, kind, timestamp: epoch + n * 1000, monotonicMs: n * 1000, targetSessionFile: root, observerSource: "local-extension", ...extra });

test("semantic names preserve meaningful hosts and original labels; only terminal controls are removed", () => {
  const n = "SYS-01-prod.private.internal_复验";
  assert.equal(displayName(n), n); assert.equal(displayName(`\x1b[31m${n}\x1b[0m`), n);
  assert.equal(taskFacts("task", { name: n, agent: "integration-reviewer", task: "原始标题\n正文" }, "t")[0].title, "原始标题");
  assert.deepEqual(taskFacts("eval", { code: "throw Error('never run')" }, "t"), []);
});

test("nested delegated work stays with its originating task across new user messages", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u1", "修复 Xirang", { timestamp: ts(1) }), spawn("a1", "u1", 2, "BE-原名"), user("u2", "审查 Houfeng", { parentId: "a1", timestamp: ts(3) }), call("a2", "u2", 4)]);
  await writeJsonl(path.join(dir, "root", "BE-原名.jsonl"), [header("backend", ts(2)), init("backend-engineer"), spawn("child", "init", 5, "复验", "integration-reviewer")]);
  await writeJsonl(path.join(dir, "root", "BE-原名", "复验.jsonl"), [header("review", ts(5)), init("integration-reviewer"), call("nested", "init", 6)]);
  const r = await buildReport(root), nested = r.calls.find(c => c.entryId === "nested");
  assert.equal(r.total.calls, 4); assert.equal(nested.taskName, "修复 Xirang"); assert.equal(nested.role, "integration-reviewer");
  assert.equal(nested.agent, "BE-原名 > 复验");
  assert.equal(r.ledger.tasks.find(t => t.name === "修复 Xirang").calls, 3);
  assert.equal(r.ledger.timeWindows.find(t => t.name === "审查 Houfeng").calls, 3);
  assert.equal(r.ledger.reconciliation.taskRows, 4); assert.equal(r.ledger.reconciliation.windowRows, 4);
  const filtered = scopeReport(r, { taskKey: "修复 Xirang" }); assert.equal(filtered.total.calls, 3); assert.ok(!filtered.events.some(e => e.entryId === "u2"));
}));

test("reused agent is shared unless an explicit per-call task assignment exists; parent memo is immutable", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u1", "任务一", { timestamp: ts(1) }), spawn("a1", "u1", 2, "Same"), user("u2", "任务二", { parentId: "a1", timestamp: ts(3) }), spawn("a2", "u2", 4, "Same")]);
  await writeJsonl(path.join(dir, "root", "Same.jsonl"), [header("same", ts(2)), init("grok-reviewer"), call("before", "init", 5), observation("assign", "before", 6, { kind: "task-assignment", taskId: "u1", phase: "定向复验" }), call("explicit", "assign", 7), call("other-branch", "init", 8)]);
  const r = await buildReport(root);
  assert.equal(r.calls.find(c => c.entryId === "before").taskKey, SHARED_TASK);
  assert.equal(r.calls.find(c => c.entryId === "explicit").taskName, "任务一");
  assert.equal(r.calls.find(c => c.entryId === "other-branch").taskKey, SHARED_TASK);
  assert.equal(scopeReport(r, { phase: "定向复验" }).total.calls, 1);
}));

test("model_usage includes compaction/helper usage once and keeps explicit role", async () => fixture(async (_dir, root) => {
  const a = call("a", "u", 2);
  await writeJsonl(root, [header("root", ts(0)), user("u", "任务", { timestamp: ts(1) }), a,
    { type: "model_usage", id: "helper", parentId: "a", timestamp: ts(3), purpose: "compaction", role: "smol", provider: "fixture", model: "small", usage: a.message.usage, stopReason: "stop" }]);
  const r = await buildReport(root); assert.equal(r.total.calls, 2); assert.equal(r.total.costTotal, .5);
  const h = r.calls.find(c => c.entryId === "helper"); assert.equal(h.purpose, "compaction"); assert.equal(h.role, "smol"); assert.equal(h.taskName, "任务");
  assert.equal(scopeReport(r, { role: "smol" }).total.calls, 1); assert.equal(r.telemetry.helperUsage[0].calls, 1);
}));

test("unknown roles never inferred from model; advisors are separate from ordinary subagents", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 2)]);
  await writeJsonl(path.join(dir, "root", "GrokWorker.jsonl"), [header("sub"), assistant("s", "xai", "grok", { timestamp: ts(3) })]);
  await writeJsonl(path.join(dir, "root", "__advisor.jsonl"), [header("advisor"), assistant("ad", "xai", "grok", { timestamp: ts(3) })]);
  const r = await buildReport(root); assert.equal(r.calls.find(c => c.entryId === "s").role, null);
  assert.equal(r.calls.find(c => c.entryId === "ad").taskKey, SHARED_TASK);
  assert.equal(r.ledger.roleModels.length, 3);
  const row = r.ledger.roleModels.find(x => x.actorType === "subagent"); assert.equal(scopeReport(r, selectionFilter({ kind: "Role model", row })).total.calls, 1);
}));

test("explicit task labels are retained without hiding meaningful host names", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0), { title: "阶段验收" }), user("u", "原始用户任务", { timestamp: ts(1) }), { type: "label", id: "label", parentId: "u", targetId: "u", label: "检查-prod.private.internal", timestamp: ts(2) }, call("a", "label", 3)]);
  const r = await buildReport(root); assert.equal(r.sessionTitle, "阶段验收"); assert.equal(r.calls[0].taskName, "检查-prod.private.internal");
}));

test("request timings attach only by a unique response identity and use monotonic spans", async () => fixture(async (_dir, root) => {
  const a = call("a", "u", 5); a.message.responseId = "response";
  await writeJsonl(root, [header("root", ts(0)), user("u", "请求", { timestamp: ts(1) }), a]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "start", 2, { requestId: "r", effort: { value: "medium", source: "payload.reasoning.effort" }, promptHash: "p" }), frame(root, "response-headers", "head", 3, { requestId: "r" }), frame(root, "first-output", "first", 4, { requestId: "r" }), frame(root, "request-end", "end", 5, { requestId: "r", ...responseIdentity(a.message) })]);
  const r = await buildReport(root); assert.equal(r.telemetry.requests.length, 1); assert.equal(r.telemetry.requestDuration.p50, 3000); assert.equal(r.telemetry.firstOutput.p50, 2000);
  assert.equal(r.calls[0].requestEffort.value, "medium"); assert.equal(r.calls[0].promptHash, "p");
  const later = scopeReport(r, { from: ts(4) }); assert.equal(later.telemetry.requests[0].startOutsideRange, true); assert.equal(later.telemetry.requestDuration.p50, 3000);
}));

test("ambiguous response IDs are not assigned a fabricated duration", async () => fixture(async (_dir, root) => {
  const a = call("a", null, 5), b = call("b", "a", 6); a.message.responseId = "same"; b.message.responseId = "same";
  await writeJsonl(root, [header("root", ts(0)), a, b]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "start", 2, { requestId: "r" }), frame(root, "request-end", "end", 5, { requestId: "r", ...responseIdentity(a.message) })]);
  const r = await buildReport(root); assert.equal(r.total.calls, 2); assert.equal(r.telemetry.requests.length, 0);
}));

test("parallel tools use interval union and an open wait is not zero-duration", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 1, { content: ["one", "two", "open"].map(id => ({ type: "toolCall", id, name: "hub", arguments: { op: "wait" } })) })]);
  await writeJsonl(sidecarPath(root), [frame(root, "tool-start", "s1", 2, { toolCallId: "one", name: "hub", operation: "wait" }), frame(root, "tool-start", "s2", 3, { toolCallId: "two", name: "hub", operation: "wait" }), frame(root, "tool-end", "e1", 5, { toolCallId: "one" }), frame(root, "tool-end", "e2", 6, { toolCallId: "two" }), frame(root, "tool-start", "so", 7, { toolCallId: "open", name: "hub", operation: "wait" })]);
  const r = await buildReport(root); assert.equal(r.telemetry.waits[0].unionMs, 4000); assert.equal(r.telemetry.spans.find(s => s.toolCallId === "open").durationMs, null);
  assert.equal(intervalUnion([[0, 4], [2, 5], [9, 12]]), 8);
}));

test("advisor delivery, request inclusion and explicit decisions are separate and time-scoped", async () => fixture(async (_dir, root) => {
  const note = { id: "原始建议ID", advisor: "Architecture", severity: "blocker", note: "修复事务提交" };
  const a = call("a", "card", 5); a.message.responseId = "r";
  await writeJsonl(root, [header("root", ts(0)), user("u", "任务", { timestamp: ts(1) }), advisorCard("card", [note], { parentId: "u", timestamp: ts(2) }), a, observation("decision", "a", 8, { kind: "advisor-decision", noteId: note.id, status: "accepted", actionId: "repair-task" })]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "start", 3, { requestId: "request", notes: noteFacts([note]) }), frame(root, "request-end", "end", 5, { requestId: "request", ...responseIdentity(a.message) })]);
  const r = await buildReport(root); assert.equal(r.telemetry.advisor.disposed, 1); assert.equal(r.telemetry.notes[0].deliveryToRequestMs, 1000); assert.equal(r.telemetry.notes[0].deliveryToDecisionMs, 6000);
  const early = scopeReport(r, { to: ts(6) }); assert.equal(early.telemetry.advisor.disposed, 0); assert.equal(early.telemetry.advisor.blockerOpen, 1);
  assert.equal(early.telemetry.notes[0].actionId, null);
}));

test("repeated identical advice has no invented occurrence linkage", async () => fixture(async (_dir, root) => {
  const note = { severity: "blocker", note: "same" };
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card1", [note], { timestamp: ts(1) }), advisorCard("card2", [note], { timestamp: ts(2) }), call("a", "card2", 5)]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "start", 3, { requestId: "request", notes: noteFacts([note]) })]);
  const r = await buildReport(root); assert.equal(r.telemetry.advisor.requestObserved, 0); assert.equal(r.telemetry.advisor.open, 2);
}));

test("review rounds and finding state transitions require IDs; future closure cannot leak backwards", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "审查任务", { timestamp: ts(1) }), observation("round", "u", 2, { kind: "review-round", roundId: "R1", roundName: "首轮独立审查", phase: "discovery", baseline: "v1" }), call("a", "round", 3), observation("found", "a", 4, { kind: "finding", roundId: "R1", findingId: "SYS-01", findingName: "事务竞态", status: "open" }), observation("closed", "found", 5, { kind: "finding", roundId: "R1", findingId: "SYS-01", findingName: "事务竞态", status: "closed" })]);
  const r = await buildReport(root); assert.equal(r.telemetry.reviews[0].calls, 1); assert.equal(r.telemetry.reviews[0].findings[0].status, "closed");
  const early = scopeReport(r, { to: ts(5) }); assert.equal(early.telemetry.reviews[0].findings[0].status, "open");
  assert.equal(workflowFact({ kind: "arbitrary", findingId: "X" }), null);
}));

test("compaction windows are clipped at adjacent compactions and keep helper usage distinct", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 1), { type: "compaction", id: "c1", parentId: "a", timestamp: ts(2), tokensBefore: 900 }, call("b", "c1", 3), { type: "compaction", id: "c2", parentId: "b", timestamp: ts(4), tokensBefore: 700 }, call("c", "c2", 5)]);
  const r = await buildReport(root); assert.equal(r.telemetry.compactions.length, 2);
  assert.equal(r.telemetry.compactions[1].before.calls, 1); assert.equal(r.telemetry.compactions[0].after.calls, 1);
  assert.equal(r.telemetry.compactions[0].ownUsage, null); assert.equal(r.telemetry.compactions[0].netSavings, null);
}));

test("baselines persist, preserve old prices, and select new record identities across restart", async () => fixture(async (_dir, root) => {
  const rows = [header("root", ts(0)), user("u", "原任务", { timestamp: ts(1) }), call("a", "u", 2)];
  await writeJsonl(root, rows); const first = await buildReport(root); const mark = makeBaseline(first, "等待规则调整前");
  await saveBaseline(root, mark); const loaded = await loadBaseline(root, "等待规则调整前", "root");
  assert.equal(loaded.callKeys.size, 1); assert.equal((await listBaselines(root))[0].name, "等待规则调整前");
  rows.push(call("b", "a", 3)); await writeJsonl(root, rows); const later = await buildReport(root);
  const newOnly = scopeReport(later, { sinceKeys: loaded.callKeys, sinceEventKeys: loaded.eventKeys, sinceRuntimeKeys: loaded.runtimeKeys });
  assert.equal(newOnly.total.calls, 1);
  const c = compareBaseline(newOnly, loaded.baseline); assert.equal(c.before.calls, 1); assert.equal(c.after.calls, 1); assert.equal(c.before.costTotal, .25);
  await saveProfile(root, { question: "检查 SYS-01", protectedScopes: "Advisor / 三审", annotation: "用户标记" });
  assert.equal((await loadProfile(root)).protectedScopes, "Advisor / 三审");
  await assert.rejects(loadBaseline(root, "等待规则调整前", "another-session"), /不匹配/);
}));

test("request observer is passive, stores no prompts or payload bodies, and handles write failures", async () => fixture(async (_dir, root) => {
  const handlers = new Map(), bus = new Map(), writes = []; let time = 1;
  const pi = { on: (k, f) => handlers.set(k, f), events: { on: (k, f) => { bus.set(k, f); return () => bus.delete(k); } } };
  const ctx = { cwd: "/test", sessionManager: { getSessionFile: () => root } };
  const observer = createRuntimeObserver(pi, { now: () => epoch + time * 1000, clock: () => time * 1000, append: async (_file, line) => writes.push(JSON.parse(line)), configurationFiles: async () => [{ name: "RULES.md", hash: "v1" }] });
  await handlers.get("session_start")({}, ctx);
  await handlers.get("before_agent_start")({ systemPrompt: ["SYSTEM_PROMPT_NOT_EXPORTED"] }, ctx);
  const payload = { model: "fixture/model", reasoning: { effort: "high" }, messages: [{ content: "BODY_NOT_EXPORTED" }] };
  const copy = JSON.stringify(payload);
  assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
  assert.equal(JSON.stringify(payload), copy);
  time = 2; await handlers.get("message_update")({ assistantMessageEvent: { type: "thinking_delta", delta: "THINKING_NOT_EXPORTED" } }, ctx);
  time = 3; await handlers.get("message_end")({ message: call("a", null, 3).message }, ctx); await observer.flush();
  const encoded = JSON.stringify(writes); assert.doesNotMatch(encoded, /SYSTEM_PROMPT_NOT_EXPORTED|BODY_NOT_EXPORTED|THINKING_NOT_EXPORTED/);
  assert.equal(writes.filter(w => w.kind === "request-start").length, 1); assert.equal(writes.find(w => w.kind === "request-start").effort.value, "high");
  await handlers.get("session_shutdown")({}, ctx); assert.equal(bus.size, 0);
  const bad = createRuntimeObserver({}, { append: async () => { throw Object.assign(new Error("fail"), { code: "EACCES" }); }, configurationFiles: async () => [] });
  await bad.handle({ type: "session_start" }, ctx); await bad.flush(); assert.ok(bad.status().errors.length);
}));

test("wire advisor parser decodes exact XML and keeps names without persisting the body", () => {
  const text = '<advisory advisor="Architecture" severity="blocker" guidance="weigh">\nA &lt; B &amp; C\n</advisory>';
  const parsed = wireNotes({ input: [{ content: [{ type: "input_text", text }] }] });
  assert.equal(parsed[0].advisor, "Architecture"); assert.equal(parsed[0].fingerprint, noteFacts([{ advisor: "Architecture", severity: "blocker", note: "A < B & C" }])[0].fingerprint);
  assert.doesNotMatch(JSON.stringify(parsed), /A < B/);
});

test("invalid and partial runtime sidecars are reported, not fatal", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 1)]);
  await fs.writeFile(sidecarPath(root), '{"schema":999,"id":"bad"}\nnot-json\n{"partial":');
  const r = await buildReport(root); assert.equal(r.total.calls, 1); assert.equal(r.runtimeCoverage.invalidFrames, 2); assert.equal(r.runtimeCoverage.partialTails, 1);
}));

test("selected historical note does not acquire a future request or disposition", async () => fixture(async (_dir, root) => {
  const note = { id: "blocker-1", severity: "blocker", note: "修复一致性" };
  const a = call("a", "card", 9);
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card", [note], { timestamp: ts(2) }), a,
    observation("accepted", "a", 10, { kind: "advisor-decision", noteId: note.id, status: "accepted" })]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "s", 7, { requestId: "q", notes: noteFacts([note]) }), frame(root, "request-end", "e", 9, { requestId: "q", ...responseIdentity(a.message) })]);
  const report = await buildReport(root), early = scopeReport(report, { to: ts(5) });
  assert.equal(early.telemetry.notes.length, 1); assert.equal(early.telemetry.notes[0].requestObservedAt, null);
  assert.equal(report.telemetry.advisor.disposed, 1);
  assert.equal(report.telemetry.advisor.blockerAwaitingDisposition, 0);
  assert.equal(report.telemetry.advisor.blockerOpen, 1, "accepted is not proof that a blocker was fixed");
}));

test("exact advisor source matches its unique delivery without pretending transcript time is inference latency", async () => fixture(async (dir, root) => {
  const note = { advisor: "Architecture", severity: "blocker", note: "必须修复恢复链" };
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card", [note], { timestamp: ts(5) }), call("a", "card", 6)]);
  await writeJsonl(path.join(dir, "root", "__advisor.architecture.jsonl"), [header("adv", ts(0)), call("adv", null, 4, { content: [{ type: "toolCall", id: "suggest", name: "advise", arguments: { severity: note.severity, note: note.note } }] })]);
  const r = await buildReport(root), n = r.telemetry.notes[0];
  assert.equal(r.telemetry.advisor.generationLinked, 1); assert.equal(n.generationToDeliveryMs, 1000);
  assert.equal(n.generationTimestampSource, "assistant-transcript-timestamp");
  assert.equal(n.sourceToolCallId, "suggest");
}));

test("ambiguous child names do not route raw subagent events to an arbitrary file", async () => fixture(async (dir, root) => {
  const bus = new Map(), writes = [];
  const observer = createRuntimeObserver({ events: { on: (k, fn) => { bus.set(k, fn); return () => {}; } } }, { append: async (_p, data) => writes.push(JSON.parse(data)), configurationFiles: async () => [] });
  await observer.handle({ type: "session_start" }, { sessionManager: { getSessionFile: () => root } });
  const lifecycle = bus.get("task:subagent:lifecycle");
  lifecycle({ id: "Same", agent: "reviewer", status: "started", sessionFile: path.join(dir, "root", "one", "Same.jsonl") });
  lifecycle({ id: "Same", agent: "reviewer", status: "started", sessionFile: path.join(dir, "root", "two", "Same.jsonl") });
  bus.get("task:subagent:event")({ id: "Same", event: { type: "tool_execution_start", toolCallId: "ambiguous-tool", toolName: "read" } });
  await observer.flush(); assert.ok(observer.status().errors.some(e => e.code === "ambiguous-child-id"));
  assert.ok(!writes.some(e => e.toolCallId === "ambiguous-tool"));
}));

test("unchanged parsed snapshot is reused, prices are reread, and appends/force bypass the cache", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 1)]);
  const one = await buildReport(root), two = await buildReport(root);
  assert.match(one.metadata.parsedSnapshotCache, /miss/); assert.match(two.metadata.parsedSnapshotCache, /hit/);
  assert.equal(one.snapshot.frozenAt, two.snapshot.frozenAt, "cached data retains its original freeze time");
  await fs.appendFile(root, JSON.stringify(call("b", "a", 2)) + "\n");
  const three = await buildReport(root); assert.equal(three.total.calls, 2); assert.match(three.metadata.parsedSnapshotCache, /miss/);
  const four = await buildReport(root, {}, {}, true); assert.match(four.metadata.parsedSnapshotCache, /miss/);
  assert.equal(two.total.calls, 1, "old report remains frozen");
}));

test("referenced pre-window request evidence is included with outside-range labeling", async () => fixture(async (_dir, root) => {
  const a = call("a", null, 5);
  await writeJsonl(root, [header("root", ts(0)), a]);
  await writeJsonl(sidecarPath(root), [frame(root, "request-start", "s", 1, { requestId: "q" }), frame(root, "request-end", "e", 5, { requestId: "q", ...responseIdentity(a.message) })]);
  const report = scopeReport(await buildReport(root), { from: ts(4) });
  assert.equal(report.telemetry.requests[0].durationMs, 4000);
  assert.equal(report.telemetry.evidence.find(e => e.id === "s").outsideSelectedRange, true);
}));

test("parent-bus lifecycle resolves childFile, never relabels the main instance", async () => fixture(async (dir, root) => {
  const child = path.join(dir, "root", "SYS-09.jsonl");
  const spawnCall = call("spawn", "u", 2, { content: [{ type: "toolCall", id: "parent-eval", name: "eval", arguments: { code: "/* opaque spawn, never execute */" } }] });
  await writeJsonl(root, [header("root", ts(0)), user("u", "修复恢复链", { timestamp: ts(1) }), spawnCall]);
  await writeJsonl(child, [header("child", ts(2)), init("backend-engineer"), call("child-call", "init", 4)]);
  await writeJsonl(sidecarPath(root), [frame(root, "subagent-lifecycle", "life", 3, { childFile: child, name: "SYS-09", role: "backend-engineer", parentToolCallId: "parent-eval", status: "started" })]);
  const r = await buildReport(root), main = r.calls.find(c => c.entryId === "spawn"), c = r.calls.find(c => c.entryId === "child-call");
  assert.equal(main.role, "main"); assert.equal(main.instanceName, "main");
  assert.equal(c.role, "backend-engineer"); assert.equal(c.taskName, "修复恢复链");
  assert.equal(r.ledger.instances.find(i => i.name === "SYS-09").parentToolCallId, "parent-eval");
}));
