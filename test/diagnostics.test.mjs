import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { buildReport, scopeReport } from "../core.js";
import { buildAiBrief, buildPublicJson, buildSelectionMarkdown } from "../export.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { classifyTool, cleanText, usageFacts, distribution, observedCost } from "../diagnostics.js";
import { applyStatsRows } from "../pricing.js";
import { assistant, header, user, advisorCard, tempDir, removeDir, writeJsonl } from "./helpers.mjs";

const epoch = Date.parse("2026-08-01T00:00:00Z");
const time = n => new Date(epoch + n * 1000).toISOString();
const pi = { exec: async () => ({ code: 0 }), getThinkingLevel: () => "xhigh" };
function chain(entries) {
  let parent = null;
  return entries.map((e, i) => {
    const result = { ...e, parentId: Object.hasOwn(e, "branchParent") ? e.branchParent : parent, timestamp: e.timestamp || time(i) };
    if (e.message) result.message = { ...e.message, timestamp: Date.parse(result.timestamp) };
    delete result.branchParent; parent = result.id; return result;
  });
}
async function scan(entries, context = {}, children = []) {
  const dir = await tempDir(), root = path.join(dir, "root.jsonl");
  try {
    await writeJsonl(root, [header("diagnostic-root", time(0)), ...entries]);
    for (const [name, data] of children) await writeJsonl(path.join(dir, "root", name), data);
    return await buildReport(root, pi, { cwd: dir, model: { provider: "openai-codex", id: "gpt-6-astra" }, ...context });
  } finally { await removeDir(dir); }
}
function status(id, second, options = {}) {
  const entry = assistant(id, "openai-codex", "gpt-6-astra", { timestamp: time(second), input: 25, output: 5, cacheRead: 500,
    content: [{ type: "toolCall", id: `tool-${id}`, name: "eval", arguments: { language: "js", code: 'await Bun.sleep(50); display((await tool.hub({op:"inbox"})).text); display((await tool.hub({op:"list"})).text);' } }], ...options });
  entry.message.responseId = `response-${id}`;
  return entry;
}
function result(id, second, { text = "Inbox empty.\nWorker running; heartbeat age: 5s", error = false, truncated = false } = {}) {
  return { type: "message", id: `result-${id}`, timestamp: time(second), message: { role: "toolResult", toolCallId: `tool-${id}`, toolName: "eval", content: [{ type: "text", text }], isError: error, details: { meta: { truncated } } } };
}
const history = [ { type: "model_change", id: "setting-model", timestamp: time(0), model: "openai-codex/gpt-6-astra" }, { type: "thinking_level_change", id: "setting-effort", timestamp: time(1), thinkingLevel: "medium" } ];

test("530 usage records retain 528 nonzero responses and two zero interruptions; current xhigh never backfills medium history", async () => {
  const records = [...history, user("U", "A private project task", { timestamp: time(2) })];
  for (let i = 0; i < 530; i++) {
    const a = assistant(`c${i}`, "openai-codex", "gpt-6-astra", { timestamp: time(i + 3), ...(i >= 528 ? { input: 0, output: 0, cacheRead: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}) });
    if (i < 528) a.message.responseId = `r${i}`; else a.message.stopReason = "aborted";
    if (i < 493) a.message.usage.reasoningTokens = 5;
    records.push(a);
  }
  const report = await scan(chain(records));
  const data = buildDiagnosticData(report, { question: "Only main efficiency", protectedScopes: "Advisor, subagents and three reviews" });
  assert.equal(data.measurement.usageRecords, 530);
  assert.equal(data.measurement.nonzeroUsageRecords, 528);
  assert.equal(data.measurement.zeroUsageRecords, 2);
  assert.equal(data.measurement.responseIdRecords, 528);
  assert.equal(data.measurement.statusCounts.interrupted, 2);
  assert.equal(data.measurement.reasoningRecords, 493);
  assert.equal(data.measurement.reasoningTokens, 2465);
  assert.equal(data.total.output, 528 * 20, "reasoning is not added twice");
  assert.equal(data.measurement.historicalThinkingRecords, 530);
  assert.equal(data.measurement.historicalSettings[0].value, "medium");
  assert.equal(data.measurement.requestEffortRecords, 0);
  assert.equal(data.currentContext.thinkingLevel, "xhigh");
  assert.equal(data.calls.every(c => c.requestEffort === null), true);
  assert.equal(data.calls.length, 530);
  assert.equal(data.snapshot.atomic, false);
  assert.equal(data.scope.selectedCalls, report.total.calls);
  assert.match(buildAiBrief(report), /Historical setting medium/);
});

test("actual effort is separate from history; request parameter evidence is not a model response inference", async () => {
  const a = assistant("a", "openai-codex", "gpt-6-astra", { timestamp: time(2) });
  a.message.requestParameters = { reasoning: { effort: "high" } };
  const data = buildDiagnosticData(await scan(chain([...history, a])));
  assert.equal(data.calls[0].requestEffort.value, "high");
  assert.equal(data.calls[0].historicalThinking.value, "medium");
});

test("unknown usage/categories and missing prices remain unknown, not zero/free", async () => {
  const a = assistant("a", "unknown", "unknown", { timestamp: time(1) });
  a.message.usage = {};
  const b = assistant("b", "p", "m", { timestamp: time(2) }); delete b.message.usage;
  const c = assistant("c", "p", "m", { timestamp: time(3) }); delete c.message.usage.cost;
  const data = buildDiagnosticData(await scan(chain([a, b, c])));
  assert.equal(data.measurement.usageRecords, 2);
  assert.equal(data.measurement.unmeteredResponses, 1);
  assert.equal(data.measurement.zeroUsageRecords, 0);
  assert.equal(data.measurement.unknownZeroUsageRecords, 1);
  assert.equal(data.measurement.missingPriceRecords, 2);
  assert.equal(data.calls[0].usage.fields.input, null);
  assert.equal(data.calls[0].price.adopted, null);
  assert.equal(data.measurement.reasoningTokens, null);
  assert.equal(data.measurement.selectedCost.knownSubtotal, null);
});

test("strict repeated status candidates compare results, ignore only heartbeat age, and charge each model call once", async () => {
  const report = await scan(chain([...history, status("a", 2), result("a", 3), status("b", 4), result("b", 5, { text: "Inbox empty.\nWorker running; heartbeat age: 9s" }), status("c", 6), result("c", 7)]));
  assert.equal(report.diagnostics.statusCallCount, 3);
  assert.equal(report.diagnostics.repeatedStatus.length, 2);
  assert.deepEqual(report.diagnostics.repeatedStatus.map(r => r.recordSet.length), [1, 1]);
  assert.equal(report.diagnostics.repeatedStatus.reduce((n, r) => n + r.historicalGrossCost, 0), 0.5);
  assert.match(report.diagnostics.repeatedStatus[0].caveat, /Not guaranteed net savings/);
  assert.equal(report.diagnostics.toolCount, 3, "nested static operations do not become extra model/tool costs");
});

for (const variant of ["incoming", "state", "write", "dynamic", "truncated", "error", "nonempty", "custom-notification", "unmetered-assistant"]) {
  test(`strict repeat excludes intervening ${variant}`, async () => {
    const entries = [status("a", 2), result("a", 3)];
    if (variant === "incoming") entries.push({ type: "custom_message", id: "notice", timestamp: time(3.5), customType: "irc:incoming", content: "blocker", details: { severity: "blocker" } });
    if (variant === "custom-notification") entries.push({ type: "custom_message", id: "notice", timestamp: time(3.5), customType: "extension:new-fact", content: "new fact" });
    if (variant === "unmetered-assistant") { const a = assistant("side", "p", "m", { timestamp: time(3.5) }); delete a.message.usage; entries.push(a); }
    const b = status("b", 4);
    if (variant === "write") b.message.content.push({ type: "toolCall", name: "write", arguments: { path: "x", content: "y" } });
    if (variant === "dynamic") b.message.content[0].arguments.code = "display(await tool.hub(options));";
    entries.push(b, result("b", 5, { text: variant === "state" ? "Inbox empty.\nWorker complete; heartbeat age: 5s" : variant === "nonempty" ? "message from worker: done" : "Inbox empty.\nWorker running; heartbeat age: 5s", truncated: variant === "truncated", error: variant === "error" }));
    assert.equal((await scan(chain(entries))).diagnostics.repeatedStatus.length, 0);
  });
}

test("literal status grammar is narrow and never evaluates transcript code", () => {
  assert.equal(classifyTool("eval", { code: 'display((await tool.hub({op:"wait",timeoutMs:300000})).text);' }).behavior, "status-only");
  for (const code of ['display(await tool.hub(JSON.parse(payload)));', 'globalThis.EXECUTED=true; display((await tool.hub({op:"inbox"})).text);', 'display((await tool.hub({op:"send",to:"x",message:"y"})).text);', 'await tool.bash({command:"sleep 60; rm -rf x"});']) {
    assert.equal(classifyTool("eval", { code }).behavior, "mixed/unknown");
  }
  assert.equal(globalThis.EXECUTED, undefined);
  assert.equal(classifyTool("hub", { op: "wait", name: "server" }).behavior, "mixed/unknown");
  assert.equal(classifyTool("hub", { op: "wait", ids: "bad" }).behavior, "mixed/unknown");
});

test("incoming gap is timestamp-to-record only, with zero intervening metered calls and no invented adjudication", async () => {
  const entries = chain([status("a", 1), result("a", 2), { type: "custom_message", id: "incoming", timestamp: time(10), customType: "irc:incoming", content: "Details ready", details: { severity: "blocker" } }, assistant("next", "p", "m", { timestamp: time(6 * 3600 + 10) })]);
  const r = (await scan(entries)).diagnostics.incomingActivity[0];
  assert.equal(r.intervalMs, 6 * 3600 * 1000);
  assert.equal(r.measuredCallsBeforeNext, 0);
  assert.equal(r.adjudicationAt, null);
  assert.match(r.caveat, /not proof of handling/);
});

test("compaction shows observed comparable inputs without claiming free compression or quality-neutral savings", async () => {
  const entries = chain([assistant("before", "p", "m", { input: 100, cacheRead: 900, timestamp: time(1) }), { type: "compaction", id: "compact", timestamp: time(2), summary: "private body", tokensBefore: 1000 }, assistant("after", "p", "m", { input: 20, cacheRead: 80, timestamp: time(3) })]);
  const report = await scan(entries), c = report.diagnostics.compactions[0];
  assert.equal(c.beforeInput, 1000); assert.equal(c.afterInput, 100); assert.equal(c.sameModel, true);
  assert.equal(c.separateUsage, null); assert.equal(c.interveningEvents, 0);
  assert.doesNotMatch(buildPublicJson(report, { includeEvidence: true }), /private body/);
});

test("genuine user boundaries split task segments; synthetic updates do not create new user tasks", async () => {
  const report = await scan(chain([user("u", "Task A", { timestamp: time(1) }), assistant("a", "p", "m", { timestamp: time(2) }), user("synthetic", "update", { timestamp: time(3), synthetic: true }), assistant("b", "p", "m", { timestamp: time(4) }), user("u2", "Task B", { timestamp: time(5) }), assistant("c", "p", "m", { timestamp: time(6) })]));
  assert.deepEqual(report.diagnostics.phases.map(p => [p.label, p.calls]), [["U1", 2], ["U2", 1]]);
  assert.equal(report.diagnostics.phases.reduce((n, p) => n + p.cost, 0), report.total.costTotal);
});

test("timestamp/model/actor/selection filters share exact denominators and preserve historical provenance outside range", async () => {
  const report = await scan(chain([...history, status("a", 2), result("a", 3), status("b", 4), result("b", 5)]));
  const selected = scopeReport(report, { actorType: "main", from: time(4) });
  const data = buildDiagnosticData(selected);
  assert.equal(data.scope.selectedCalls, 1);
  assert.equal(data.total.costTotal, selected.total.costTotal);
  assert.equal(data.measurement.historicalSettings[0].value, "medium");
  assert.ok(data.events.find(e => e.kind === "thinking-setting").outsideSelectedRange);
  assert.equal(data.diagnostics.repeatedStatus.length, 0, "a preceding call outside range cannot be attributed as a repeat inside it");
  assert.match(buildSelectionMarkdown(selected, { row: selected.primaryAgents[0], kind: "Main agent" }), /Usage records: 1/);
  assert.throws(() => scopeReport(report, { from: "not a time" }), /Invalid time range/);
  assert.throws(() => scopeReport(report, { beforeEvent: "absent" }), /exactly one/);
});

test("active-main-path uses explicit leaf ancestry, retains all-spend separately and does not invent descendant linkage", async () => {
  const records = chain([...history, assistant("root", "p", "m", { timestamp: time(2) }), { ...assistant("abandoned", "p", "m", { timestamp: time(3) }), branchParent: "root" }, { ...assistant("retained", "p", "m", { timestamp: time(4) }), branchParent: "root" }]);
  const report = await scan(records, { sessionManager: { getLeafId: () => "retained" } }, [["child.jsonl", [header("child"), assistant("child-a", "p", "m")]]]);
  assert.equal(report.total.calls, 4);
  const active = scopeReport(report, { branch: "active-main-path" });
  assert.equal(active.total.calls, 2);
  assert.deepEqual(active.calls.map(c => c.entryId), ["root", "retained"]);
  const noLeaf = await scan(records);
  assert.throws(() => scopeReport(noLeaf, { branch: "active-main-path" }), /unavailable/);
});

test("different independent session namespaces and missing IDs do not collapse identical records", async () => {
  const identical = assistant("same", "p", "m", { timestamp: time(1) });
  const missing = assistant("missing", "p", "m", { timestamp: time(2) }); delete missing.id;
  const report = await scan([identical, missing, missing], {}, [["worker.jsonl", [header("independent"), identical]]]);
  assert.equal(report.total.calls, 4);
  assert.equal(report.metadata.duplicateCallsRemoved, 0);
  assert.equal(new Set(buildDiagnosticData(report).calls.map(c => c.ref)).size, 4);
});

test("price enrichment retains transcript and database values and uses file-scoped keys", () => {
  const calls = ["/session/a", "/session/b"].map(sessionFile => ({ sessionFile, entryId: "same", statsTimestamp: 1, transcriptCost: { total: 1 }, selectedCost: { total: 1 }, cost: { total: 1 } }));
  const rows = new Map();
  rows.set(["/session/a", "same", 1].join("\0"), { cost_input: 1, cost_output: 1, cost_cache_read: 0, cost_cache_write: 0, cost_total: 2 });
  assert.equal(applyStatsRows(calls, rows), 1);
  assert.equal(calls[0].transcriptCost.total, 1); assert.equal(calls[0].statsCost.total, 2); assert.equal(calls[0].selectedCost.total, 2);
  assert.equal(calls[1].cost.total, 1);
  assert.equal(observedCost({}), null);
});

test("metadata default drops text/names/paths/thinking; evidence is bounded, redacted, explicitly untrusted", async () => {
  const a = assistant("a", "p", "m", { timestamp: time(1), content: [{ type: "thinking", thinking: "NEVER_EXPORT_THINKING secret" }, { type: "text", text: "Evidence sk-secretvalue123 /home/alice/private/project.txt https://private.internal/api?token=hidden alice@example.com password=hunter123" }] });
  const report = await scan(chain([user("u", "SECRET_TASK_CONTENT", { timestamp: time(0) }), a]));
  const safe = buildPublicJson(report);
  assert.doesNotMatch(safe, /SECRET_TASK_CONTENT|NEVER_EXPORT_THINKING|sk-secretvalue|\/home\/alice|hunter123|private\.internal/);
  const detail = buildPublicJson(report, { includeEvidence: true });
  assert.match(detail, /SECRET_TASK_CONTENT/);
  assert.match(detail, /REDACTED/);
  assert.doesNotMatch(detail, /NEVER_EXPORT_THINKING|sk-secretvalue|\/home\/alice|hunter123|private\.internal|alice@example/);
  assert.match(detail, /untrusted transcript data/);
  assert.ok(JSON.parse(detail).events.filter(e => e.excerpt).every(e => e.excerpt.length <= 320));
});

test("percentiles ignore unknown values and keep output details as subsets", () => {
  assert.deepEqual(distribution([null, 10, 20, 30]), { samples: 3, p50: 20, p95: 29, max: 30 });
  assert.equal(usageFacts({ usage: { input: 1, output: 20, cacheRead: 99, cacheWrite: 0, reasoningTokens: 5 } }).inputSide, 100);
  assert.equal(usageFacts({ usage: { input_tokens: 100 } }).inputSide, null);
  assert.equal(usageFacts({ usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 2 } }).reasoningWithinOutput, false);
});

test("conflicting persisted IDs get distinct evidence refs; ambiguous branch leaf is rejected", async () => {
  const a = assistant("same", "p", "m", { timestamp: time(1), input: 1 });
  const b = assistant("same", "p", "m", { timestamp: time(2), input: 2 });
  const report = await scan([a, b], { sessionManager: { getLeafId: () => "same" } });
  const data = buildDiagnosticData(report);
  assert.equal(data.calls.length, 2);
  assert.equal(new Set(data.calls.map(c => c.ref)).size, 2);
  assert.equal(data.measurement.identityConflicts, 1);
  assert.equal(data.snapshot.activeBranchAvailable, false);
  assert.throws(() => scopeReport(report, { branch: "active-main-path" }), /ambiguous/);
});

test("event boundaries with identical timestamps use exclusive source order", async () => {
  const report = await scan(chain([assistant("a", "p", "m", { timestamp: time(1) }), user("boundary", "next", { timestamp: time(1) }), assistant("b", "p", "m", { timestamp: time(1) })]));
  assert.deepEqual(scopeReport(report, { afterEvent: "boundary" }).calls.map(c => c.entryId), ["b"]);
  assert.deepEqual(scopeReport(report, { beforeEvent: "boundary" }).calls.map(c => c.entryId), ["a"]);
});

test("malformed tool metadata fails closed without aborting the remainder of a transcript", async () => {
  const a = assistant("a", "p", "m", { timestamp: time(1), content: [{ type: "toolCall", id: { toString: null }, name: "eval", arguments: null }] });
  const malformed = { type: "custom_message", id: "x", timestamp: time(2), customType: "irc:incoming", details: { notes: "not an array" } };
  const report = await scan(chain([a, malformed, assistant("b", "p", "m", { timestamp: time(3) })]));
  assert.equal(report.total.calls, 2); assert.equal(report.metadata.unavailableFiles, 0);
  assert.equal(report.diagnostics.repeatedStatus.length, 0);
});
