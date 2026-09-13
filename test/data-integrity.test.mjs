import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRuntimeObserver, sidecarPath, responseIdentity } from "../runtime.js";
import { RequestTracker, promptEvidence, requestModel } from "../request-tracker.js";
import { buildReport, scopeReport } from "../core.js";
import { buildDiagnosticData, diagnosticMarkdown } from "../diagnostic-export.js";
import { buildAiBrief, buildPublicJson } from "../export.js";
import { verifyReplay, sampleCalls, closeParentRefs, priceRateGroups } from "../evidence-package.js";
import { verifyExport } from "../verify-export.js";
import { sealMarkdown, verifyMarkdown, sealJson } from "../report-contract.js";
import { evalStatusFacts, workpoolIdentity } from "../semantic.js";
import { header, user, assistant, advisorCard, writeJsonl, tempDir, removeDir } from "./helpers.mjs";
const epoch = Date.parse("2026-09-13T00:00:00Z"), ts = n => new Date(epoch + n * 1000).toISOString();
const call = (id, parent, n, extra = {}) => assistant(id, "fixture", "primary", { parentId: parent, timestamp: ts(n), ...extra });
const init = (task, n = 2) => ({ type: "session_init", id: "init", timestamp: ts(n), parentId: null, agent: "backend-engineer", task });
const frame = (file, kind, id, n, fields = {}) => ({ schema: 1, runId: "run", id, kind, timestamp: epoch + n * 1000, monotonicMs: n * 1000, targetSessionFile: file, observerSource: "local-extension", ...fields });
async function fixture(fn) { const dir = await tempDir(); try { await fn(dir, path.join(dir, "root.jsonl")); } finally { await removeDir(dir); } }
async function base(root) { await writeJsonl(root, [header("root", ts(0)), user("u", "真实名称任务", { timestamp: ts(1) }), call("a", "u", 8)]); }
function observer(root) {
  const hooks = new Map(), frames = []; let tick = 0;
  const pi = { on: (k, fn) => hooks.set(k, fn) };
  const obs = createRuntimeObserver(pi, { now: () => epoch + tick, clock: () => tick, configurationFiles: async () => [], append: async (_file, line) => frames.push(JSON.parse(line)) });
  const ctx = { model: { provider: "fixture", id: "primary" }, sessionManager: { getSessionFile: () => root, getLeafId: () => "u" } };
  return { frames, obs, ctx, emit: async (type, event = {}, context = ctx) => { tick += 100; await hooks.get(type)(event, context); } };
}

test("0.9 regression: dangling different-model side request cannot overwrite main request", async () => fixture(async (_dir, root) => {
  const o = observer(root); await o.emit("session_start"); await o.emit("before_agent_start", { systemPrompt: "PRIMARY ONLY" });
  await o.emit("before_provider_request", { payload: { model: "primary", instructions: "main prompt" } });
  await o.emit("before_provider_request", { payload: { model: "advisor" } }, { ...o.ctx, model: { provider: "fixture", id: "advisor" } });
  await o.emit("after_provider_response", { status: 200 }, { ...o.ctx, model: { provider: "fixture", id: "advisor" } });
  const a = call("a", "u", 8); a.message.responseId = "main-response";
  await o.emit("message_end", { message: a.message }); await o.obs.flush();
  const starts = o.frames.filter(f => f.kind === "request-start"), end = o.frames.find(f => f.kind === "request-end");
  assert.equal(end.requestId, starts[0].requestId); assert.equal(end.ambiguous, false);
  assert.equal(starts[1].promptHash, null, "primary prompt must never be assigned to an unobserved side prompt");
  await writeJsonl(root, [header("root", ts(0)), user("u", "主控任务", { timestamp: ts(1) }), a]); await writeJsonl(sidecarPath(root), o.frames);
  const r = await buildReport(root); assert.equal(r.telemetry.requests.length, 1); assert.equal(r.calls[0].requestDurationMs, 300);
  assert.equal(r.telemetry.requests[0].responseHeadersMs, null, "advisor headers must not become main headers");
  assert.equal(r.telemetry.requestObservations.filter(x => x.status !== "usage-linked").length, 1);
}));

test("request lanes retain ambiguity for same model and unknown model", () => {
  const t = new RequestTracker(); t.start("one", { provider: "p", model: "m" }); t.start("two", { provider: "p", model: "m" });
  assert.equal(t.select({ provider: "p", model: "m" }).request, null);
  assert.equal(t.select({}).request, null);
  assert.equal(t.select({ provider: "p", model: "m" }, "one").request.id, "one");
  assert.equal(t.select({ provider: "wrong", model: "m" }, "one").request, null);
});

test("request overflow is bounded and cannot resurrect a discarded request as unique", () => {
  const t = new RequestTracker(2);
  t.start("side1", { model: "side" }); t.start("side2", { model: "side" });
  t.start("main", { model: "main" });
  assert.equal(t.pending.size, 2); assert.equal(t.omitted, 1);
  assert.equal(t.select({ model: "side" }).request, null);
  assert.equal(t.select({ model: "main" }).request.id, "main");
});

test("already ambiguous side-channel requests do not produce quadratic collision events", () => {
  const t = new RequestTracker(); let notices = 0;
  for (let i = 0; i < 600; i++) notices += t.start(String(i), { model: "side" }).overlaps.length;
  assert.equal(notices, 1);
});

test("request payload metadata is immutable and re-observed after a resume without before_agent_start", async () => fixture(async (_dir, root) => {
  const o = observer(root), payload = Object.freeze({ model: "primary", instructions: "sensitive prompt not exported", tools: Object.freeze([{ name: "read", parameters: {} }]) });
  await o.emit("before_provider_request", { payload }); await o.obs.flush();
  const f = o.frames.find(f => f.kind === "request-start"); assert.equal(f.promptHash, promptEvidence(payload).promptHash);
  assert.ok(f.toolSchemaHash); assert.match(f.promptHashSource, /provider-hook/);
  assert.equal(JSON.stringify(o.frames).includes(payload.instructions), false);
}));

test("a payload model mismatch never inherits the primary provider identity", () => {
  assert.deepEqual(requestModel({ model: "side" }, { provider: "p", id: "primary" }), { provider: null, model: "side" });
});

test("0.9 regression: observed nested js task joins the parent entry, not result-time task", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "任务一", { timestamp: ts(1) }), call("outer", "u", 2, { content: [{ type: "toolCall", id: "outer-tool", name: "eval", arguments: { code: "dynamic_program()" } }] }), user("later", "任务二", { parentId: "outer", timestamp: ts(4) }), call("later-call", "later", 5)]);
  const child = path.join(dir, "root", "backend-real-name.jsonl");
  await writeJsonl(child, [header("child", ts(3)), init("actual assignment"), call("child-call", "init", 6)]);
  await writeJsonl(sidecarPath(root), [frame(root, "tool-dispatch", "nested", 3, { toolCallId: "js-task-UUID", name: "task", parentEntryId: "u", delegations: [] }), frame(root, "subagent-lifecycle", "lifecycle", 5, { childFile: child, name: "backend-real-name", parentToolCallId: "js-task-UUID", role: "backend-engineer", status: "started" })]);
  const r = await buildReport(root), c = r.calls.find(c => c.entryId === "child-call");
  assert.equal(c.taskName, "任务一"); assert.ok(c.assignmentEvidence.includes("nested"));
}));

function poolResult(id, parent, n, toolId, pool) { return { type: "message", id, parentId: parent, timestamp: ts(n), message: { role: "toolResult", toolName: "eval", toolCallId: toolId, content: [], details: { statusEvents: [{ op: "workpool", action: "push", pool, count: 2 }] } } }; }
const outer = (id, parent, n) => call(id, parent, n, { content: [{ type: "toolCall", id: `tool-${id}`, name: "eval", arguments: { code: "dynamic code never evaluated by plugin" } }] });

test("0.9 regression: structured workpool pushes resolve original pool scope without worker prefix guessing", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "池任务", { timestamp: ts(1) }), outer("spawn", "u", 2), poolResult("return", "spawn", 3, "tool-spawn", "中文池")]);
  await writeJsonl(path.join(dir, "root", "Unrelated-allocated-name.jsonl"), [header("worker", ts(2)), init('<workpool pool="中文池" batch="original-batch-id">'), call("worker-call", "init", 5)]);
  const r = await buildReport(root), c = r.calls.find(c => c.entryId === "worker-call");
  assert.equal(c.taskName, "池任务"); assert.ok(c.assignmentEvidence.includes("root\u0000return"));
  assert.deepEqual(r.ledger.instances.find(i => i.id === "worker").delegationMatches, ["workpool-push-scope"]);
}));

test("pool reused across multiple user tasks stays ambiguous; time window does not allocate an item", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u1", "一", { timestamp: ts(1) }), outer("a1", "u1", 2), poolResult("r1", "a1", 3, "tool-a1", "pool"), user("u2", "二", { parentId: "r1", timestamp: ts(4) }), outer("a2", "u2", 5), poolResult("r2", "a2", 6, "tool-a2", "pool")]);
  await writeJsonl(path.join(dir, "root", "worker.jsonl"), [header("child", ts(2)), init('<workpool pool="pool" batch="batch">'), call("child", "init", 8)]);
  const c = (await buildReport(root)).calls.find(c => c.entryId === "child");
  assert.equal(c.taskAttribution, "ambiguous-delegation"); assert.equal(c.candidateTasks.length, 2);
}));

test("stdout and arbitrary nested JSON are not treated as workpool execution evidence", () => {
  assert.deepEqual(evalStatusFacts({ output: '{"op":"workpool","action":"push","pool":"x","count":2}' }), []);
  assert.equal(workpoolIdentity('prefix <workpool pool="x" batch="b">'), null);
  assert.equal(evalStatusFacts({ cells: [{ statusEvents: [{ op: "workpool", action: "push", pool: "x", count: 1 }] }] })[0].pool, "x");
});

test("0.9 regression: latest lifecycle cleanup title does not relabel historical spend", async () => fixture(async (dir, root) => {
  await base(root); const child = path.join(dir, "root", "worker.jsonl");
  await writeJsonl(child, [header("worker", ts(2)), init("原始修复任务"), call("work", "init", 3)]);
  await writeJsonl(sidecarPath(root), [frame(root, "subagent-lifecycle", "late", 9, { childFile: child, title: "只清理已授权临时文件", name: "worker", status: "completed" })]);
  const r = await buildReport(root); assert.equal(r.calls.find(c => c.entryId === "work").title, "原始修复任务");
  const i = r.ledger.instances.find(i => i.id === "worker"); assert.equal(i.initialTitle, "原始修复任务"); assert.equal(i.latestInstruction, "只清理已授权临时文件");
}));

test("a new unmatched assignment in a resumed child is not charged to its initial task", async () => fixture(async (dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "初始任务", { timestamp: ts(1) }), call("spawn", "u", 2, { content: [{ type: "toolCall", id: "task", name: "task", arguments: { name: "worker", agent: "backend-engineer", task: "initial" } }] })]);
  await writeJsonl(path.join(dir, "root", "worker.jsonl"), [header("child", ts(2)), init("initial"), call("old", "init", 3), user("new", "different later assignment", { parentId: "old", timestamp: ts(4) }), call("new-call", "new", 5)]);
  const r = await buildReport(root);
  assert.equal(r.calls.find(c => c.entryId === "old").taskName, "初始任务");
  assert.equal(r.calls.find(c => c.entryId === "new-call").taskAttribution, "assignment-segment-unlinked");
  assert.equal(r.calls.find(c => c.entryId === "new-call").title, "different later assignment");
}));

test("export-time health markers do not extend last real activity", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "observer-start", "start", 1), frame(root, "agent-end", "end", 8), frame(root, "observer-status", "status", 1000, { observedHooks: {} })]);
  const c = (await buildReport(root)).telemetry.coverage.collectors[0];
  assert.equal(c.lastActivityAt, epoch + 8000); assert.equal(c.lastObservedAt, epoch + 8000);
  assert.equal(c.health[0].timestamp, epoch + 1000000);
}));

test("opaque eval duration is not reclassified as native wait or ordinary execution", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "tool-start", "s", 2, { name: "eval", toolCallId: "t" }), frame(root, "tool-end", "e", 302, { name: "eval", toolCallId: "t" })]);
  const r = await buildReport(root); assert.equal(r.telemetry.spans[0].category, "wrapped-tool-unobserved");
  assert.equal(r.telemetry.spans[0].durationMs, 300000);
}));

test("nested dispatch waits are observed with their true operation without double-counting hooks", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "tool-dispatch", "d", 2, { name: "hub", operation: "wait", toolCallId: "t" }), frame(root, "tool-start", "s", 2, { name: "hub", operation: "wait", toolCallId: "t" }), frame(root, "tool-end", "e", 4, { name: "hub", toolCallId: "t" }), frame(root, "tool-dispatch-result", "dr", 4, { name: "hub", toolCallId: "t" })]);
  const r = await buildReport(root); assert.equal(r.telemetry.spans.length, 1); assert.equal(r.telemetry.spans[0].category, "native-wait"); assert.equal(r.telemetry.waits[0].unionMs, 2000);
}));

test("missing auxiliary usage is explicit even when ordinary usage is fully measured", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", null, 2), { type: "compaction", id: "c", parentId: "a", timestamp: ts(4), method: "remote" }]);
  const d = buildDiagnosticData(await buildReport(root));
  assert.equal(d.measurement.unmeteredResponses, 0); assert.equal(d.telemetry.auxiliaryCoverage.usageUnknown, 1);
  assert.equal(d.telemetry.compactions[0].ownUsage, null); assert.ok(d.dataQuality.issues.some(x => x.code === "auxiliary-usage-unknown"));
}));

test("identical config content is deduplicated while separate observation identities survive", async () => fixture(async (_dir, root) => {
  await base(root); await writeJsonl(sidecarPath(root), [frame(root, "configuration-files", "c1", 1, { fingerprint: "same", files: [{ name: "RULES.md", hash: "abc" }] }), frame(root, "configuration-files", "c2", 2, { fingerprint: "same", files: [{ name: "RULES.md", hash: "abc" }], runId: "resumed" })]);
  const c = (await buildReport(root)).telemetry.configuration;
  assert.equal(c.definitions.length, 1); assert.equal(c.events.length, 2); assert.equal(c.events[1].definitionRef, "same"); assert.equal(c.events[0].files, undefined);
}));

test("advisor card count and explicit supersession do not imply adoption or resolved findings", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), advisorCard("card", [{ id: "old", note: "old judgment", severity: "concern" }, { id: "new", supersedes: "old", note: "corrected judgment", severity: "concern" }], { timestamp: ts(2) }), call("a", "card", 5)]);
  const t = (await buildReport(root)).telemetry;
  assert.equal(t.advisor.delivered, 2); assert.equal(t.advisor.deliveredCards, 1); assert.equal(t.advisor.explicitCorrections.length, 1); assert.equal(t.advisor.disposed, 0);
  assert.equal(t.advisor.cards[0].oldestNoteAgeMs, null);
}));

test("0.9 regression: actual NUL separators are escaped reversibly before the transport hash", () => {
  const sealed = sealMarkdown("one\u0000two\u0007three"); assert.equal(sealed.includes("\u0000"), false);
  assert.equal(verifyMarkdown(sealed).body, "one\\u0000two\\u0007three"); assert.equal(verifyMarkdown(sealed).ok, true);
});

test("transitive evidence closure terminates on cycles and declares missing parents", () => {
  const c = closeParentRefs([{ ref: "a", key: "ka", parentRef: "b" }, { ref: "b", key: "kb", parentRef: "a" }], ["ka", "missing"]);
  assert.equal(c.events.length, 2); assert.deepEqual(c.missing, ["missing"]);
});

test("filtered export preserves necessary ancestor metadata outside the selection", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), user("u", "任务", { timestamp: ts(1) }), call("a", "u", 2), call("b", "a", 4), call("c", "b", 6)]);
  const d = buildDiagnosticData(scopeReport(await buildReport(root), { from: ts(5) }));
  assert.equal(d.calls.length, 1); assert.equal(d.evidenceManifest.unresolvedParents.length, 0);
  const a = d.events.find(e => e.eventId === "a"); assert.ok(a.outsideSelectedRange);
  assert.equal(verifyExport(diagnosticMarkdown(d)).ok, true);
}));

test("compact samples contain main, advisor, failed and low-cost calls despite expensive reviewers", () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ ref: String(i), actorType: "subagent", status: "success", model: "review", taskAttribution: "unlinked", price: { adopted: { total: 100 - i } } }));
  calls.push({ ref: "main", actorType: "main", model: "main", status: "success" }, { ref: "advisor", actorType: "advisor", model: "review", status: "success" }, { ref: "failed", actorType: "subagent", model: "failed-model", status: "error" });
  const refs = new Set(sampleCalls(calls).map(c => c.ref)); for (const key of ["main", "advisor", "failed"]) assert.ok(refs.has(key));
});

test("all records replay from compact Markdown and full JSON without original files", async () => fixture(async (_dir, root) => {
  await base(root); const r = await buildReport(root), md = buildAiBrief(r), json = buildPublicJson(r);
  await fs.unlink(root);
  for (const text of [md, json]) { const result = verifyExport(text); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.arithmetic.records, 1); }
}));

test("re-sealing a corrupt replay does not make the arithmetic verification pass", async () => fixture(async (_dir, root) => {
  await base(root); const d = buildDiagnosticData(await buildReport(root));
  d.replay.rows[0][d.replay.columns.indexOf("costTotal")] += 10;
  const result = verifyExport(sealJson(d)); assert.equal(result.transport.ok, true); assert.equal(result.ok, false); assert.equal(result.arithmetic.ok, false);
}));

test("replay rejects duplicate identities, invalid dictionary indices, and malformed numeric values", async () => fixture(async (_dir, root) => {
  await base(root); const d = buildDiagnosticData(await buildReport(root));
  for (const mutate of [r => r.rows.push([...r.rows[0]]), r => r.rows[0][1] = 999, r => r.rows[0][7] = -1]) {
    const r = structuredClone(d.replay); mutate(r); assert.equal(verifyReplay(r).ok, false);
  }
}));

test("one model can have distinct empirical price groups without inventing official price tiers", () => {
  const c = (ref, rate) => ({ ref, model: "same/model", usage: { fields: { input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0 } }, orchestration: {}, price: { source: "transcript", adopted: { input: rate / 1000, output: .001, cacheRead: .001, cacheWrite: 0, total: .003 } } });
  const rows = priceRateGroups([c("a", 2), c("b", 4)]); assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.ratesPerMillion.input), [2, 4]); assert.ok(rows.every(r => !r.officialPriceVerified && r.pricingRule === "not-recorded"));
});

test("source-missing parents are disclosed rather than invented as evidence", async () => fixture(async (_dir, root) => {
  await writeJsonl(root, [header("root", ts(0)), call("a", "missing-entry", 2)]);
  const d = buildDiagnosticData(await buildReport(root)); assert.equal(d.evidenceManifest.parentClosureComplete, false);
  assert.equal(d.evidenceManifest.unresolvedParents.length, 1);
  const result = verifyExport(diagnosticMarkdown(d)); assert.equal(result.ok, true); assert.equal(result.evidence.parentClosureComplete, false);
}));

test("failure samples preserve actionable provider errors while redacting credentials", async () => fixture(async (_dir, root) => {
  const a = call("error", null, 2, { failed: true }); a.message.errorMessage = "HTTP 429 quota exhausted password=private-value sk-supersecret";
  await writeJsonl(root, [header("root", ts(0)), a]);
  const d = buildDiagnosticData(await buildReport(root)); assert.match(d.calls[0].failure.message, /HTTP 429/);
  assert.equal(d.calls[0].failure.message.includes("private-value"), false); assert.equal(d.calls[0].failure.message.includes("sk-supersecret"), false);
  assert.ok(diagnosticMarkdown(d).includes("HTTP 429"));
}));

test("after native turn change old unlinked scopes do not create false primary overlap", () => {
  const t = new RequestTracker(); t.start("old", { model: "same", scope: "turn1" });
  assert.equal(t.retireExceptScope("turn2"), 1);
  t.start("new", { model: "same", scope: "turn2" });
  assert.equal(t.select({ model: "same", scope: "turn2" }).request.id, "new");
  assert.equal(t.select({ model: "same" }).request, null, "late unscoped headers cannot be relabeled as the new request");
});

test("price cross-check status is unavailable, not verified, when no independent source exists", async () => fixture(async (_dir, root) => {
  await base(root); const d = buildDiagnosticData(await buildReport(root));
  assert.match(d.pricing.crossCheck, /not-available/); assert.equal(d.dataQuality.fitness.independentPriceComparison, "not-available");
}));

test("format v5 cannot silently fall back to legacy transport-only validation", async () => fixture(async (_dir, root) => {
  await base(root); const data = buildDiagnosticData(await buildReport(root)); delete data.replay;
  const result = verifyExport(sealJson(data));
  assert.equal(result.ok, false); assert.ok(result.issues.includes("missing-or-repeated-replay-ledger"));
  const markdown = sealMarkdown('# OMP\n格式 5\nNo ledger.\n');
  assert.equal(verifyExport(markdown).ok, false);
}));

test("empty selected range still has independently verifiable zero-record replay", async () => fixture(async (_dir, root) => {
  await base(root); const r = scopeReport(await buildReport(root), { modelId: "no-such-model" });
  const result = verifyExport(buildPublicJson(r));
  assert.equal(result.ok, true); assert.equal(result.arithmetic.records, 0);
}));

test("missing expected arithmetic is invalid rather than silently skipped", async () => fixture(async (_dir, root) => {
  await base(root); const data = buildDiagnosticData(await buildReport(root));
  delete data.replay.expected[0].costTotal;
  assert.equal(verifyReplay(data.replay).ok, false);
}));

test("input-heavy samples retain adjacent calls even when not the most expensive", () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ ref: `R${i}`, agent: "original-agent", fileRef: "F1", actorType: "main", model: "m", status: "success", taskAttribution: "main-parent-chain", usage: { fields: { input: i === 30 ? 100000 : 1 } }, price: { adopted: { total: 40 - i } } }));
  const refs = new Set(sampleCalls(calls).map(c => c.ref));
  assert.ok(refs.has("R29")); assert.ok(refs.has("R30")); assert.ok(refs.has("R31"));
});
