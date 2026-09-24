import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyTool } from "../diagnostics.js";
import { buildReport } from "../core.js";
import { createRuntimeObserver, sidecarPath } from "../runtime.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { assistant, header, tempDir, removeDir, writeJsonl } from "./helpers.mjs";

// Constructed fixtures, not a captured user session. Shapes checked against
// can1357/oh-my-pi v18.3.0: tools/wait.ts, async/job-control.ts,
// irc/messaging.ts and internal-urls/proc-protocol.ts. See docs/diagnostics.md.
const epoch = Date.parse("2026-09-24T03:00:00Z");
const emptyWait = { text: "No running background jobs to wait for.", details: { op: "wait", jobs: [] } };
const running = (durationMs = 1000, extra = {}) => ({ id: "BE-原名", type: "task", status: "running", label: "验证协议迁移", durationMs, agentUrlId: "BE-原名", ...extra });
const waiting = (durationMs = 1000, extra = {}) => ({ text: "## Still Running (1)\n- `BE-原名` [task] — 验证协议迁移", details: { op: "wait", jobs: [running(durationMs, extra)] } });
const proc = (durationMs = 1000, extra = {}) => ({ name: "read", args: { path: "proc://" }, text: `BE-原名 [task] running up ${durationMs / 1000}s — 验证协议迁移`, details: { proc: { jobs: [running(durationMs, extra)], agents: [], daemons: [] } } });
async function scan(cases, fn) {
  const dir = await tempDir(), root = path.join(dir, "root.jsonl");
  try {
    let parent = null;
    const entries = [header("protocol-fixture", new Date(epoch).toISOString())];
    for (const [i, item] of cases.entries()) {
      const id = `call-${i}`, toolId = `tool-${i}`, name = item.name || "wait";
      const entry = assistant(id, "fixture", "model", { parentId: parent, timestamp: new Date(epoch + (i * 3 + 1) * 1000).toISOString(), content: [{ type: "toolCall", id: toolId, name, arguments: item.args || {} }] });
      entries.push(entry, { type: "message", id: `result-${i}`, parentId: id, timestamp: new Date(epoch + (i * 3 + 2) * 1000).toISOString(), message: { role: "toolResult", toolName: name, toolCallId: toolId, content: [{ type: "text", text: item.text ?? "" }], details: item.details, isError: item.isError || false } });
      parent = `result-${i}`;
      if (item.barrier) { entries.push({ type: "custom_message", id: `notice-${i}`, parentId: parent, timestamp: new Date(epoch + (i * 3 + 2.5) * 1000).toISOString(), customType: item.barrier, content: "new message" }); parent = `notice-${i}`; }
    }
    await writeJsonl(root, entries);
    if (fn) return await fn(root, entries);
    return await buildReport(root);
  } finally { await removeDir(dir); }
}

for (const [name, args, behavior, operation] of [
  ["wait", {}, "status-only", "wait"],
  ["hub", { op: "wait" }, "status-only", "wait"],
  ["read", { path: "proc://" }, "status-only", "snapshot"],
  ["read", { path: "proc://BE-原名" }, "status-only", "snapshot"],
  ["read", { paths: ["proc://BE-原名", "proc://server/"] }, "status-only", "snapshot"],
  ["write", { path: "agent://BE-原名", content: "hello" }, "message", "send"],
  ["write", { path: "agent://all", content: "hello" }, "message", "broadcast"],
  ["write", { path: "proc://BE-原名/kill" }, "cancel", "cancel"],
  ["write", { path: "proc://server", content: "input" }, "service-input", "stdin"],
  ["write", { path: "proc://server/mode", content: "persist" }, "service-control", "mode"],
]) test(`18.3 classifies ${name} ${JSON.stringify(args)}`, () => {
  const fact = classifyTool(name, args);
  assert.equal(fact.behavior, behavior);
  assert.equal(fact.operation ?? fact.statusOps?.[0]?.op, operation);
});

test("18.3 keeps ordinary file IO and mixed file/proc reads out of status-only", () => {
  for (const path of ["README.md", "notes/proc://x", "agent://BE-原名"]) assert.equal(classifyTool("read", { path }).behavior, "read");
  assert.equal(classifyTool("write", { path: "README.md", content: "x" }).behavior, "write");
  assert.equal(classifyTool("edit", { path: "README.md" }).behavior, "write");
  for (const args of [{ paths: ["proc://", "README.md"] }, { path: "README.md", paths: ["proc://"] }, { paths: ["proc://", null] }, { path: "proc://x/kill" }, { path: "proc://x?other=1" }]) assert.notEqual(classifyTool("read", args).behavior, "status-only");
  for (const path of ["proc://", "proc://x/kill/extra", "agent://x/subfield"]) assert.equal(classifyTool("write", { path }).behavior, "mixed/unknown");
  assert.equal(classifyTool("wait", { timeoutMs: 300000 }).behavior, "mixed/unknown");
});

test("18.3 literal Eval wait wrappers are recognized without executing dynamic code", () => {
  for (const code of ['display(await tool.wait({}));', 'display((await tool.wait({})).text);', 'await tool.wait();', 'print((await tool.wait()).text)', 'display(await tool.read({path:"proc://"}));']) assert.equal(classifyTool("eval", { code }).behavior, "status-only", code);
  for (const code of ['await tool.wait(options);', 'globalThis.PROTOCOL_EXECUTED=true; await tool.wait({});', 'await tool.wait({}); await tool.write({path:"proc://x/kill"});', 'display(await tool.read({path:target}));']) assert.equal(classifyTool("eval", { code }).behavior, "mixed/unknown", code);
  assert.equal(globalThis.PROTOCOL_EXECUTED, undefined);
});

test("18.3 repeated empty native waits are candidates without claiming an empty inbox", async () => {
  const r = await scan([emptyWait, emptyWait, emptyWait]);
  assert.equal(r.diagnostics.statusCallCount, 3);
  assert.equal(r.diagnostics.unknownToolCallCount, 0);
  assert.equal(r.diagnostics.repeatedStatus.length, 2);
  assert.equal(r.diagnostics.repeatedStatus.reduce((n, x) => n + x.historicalGrossCost, 0), .5);
  assert.equal(r.calls[0].toolFacts[0].result.emptyInbox, false);
  assert.equal(r.calls[0].toolFacts[0].result.statusComparable, true);
});

test("18.3 safety-cap snapshots ignore only elapsed job time", async () => {
  assert.equal((await scan([waiting(1000), waiting(1801000)])).diagnostics.repeatedStatus.length, 1);
  assert.equal((await scan([waiting(1000), waiting(1801000, { label: "new work" })])).diagnostics.repeatedStatus.length, 0);
});

for (const [label, value] of [
  ["message", { text: "[msg1] BE-原名: completed", details: { op: "wait", from: "Main", waited: { id: "msg1", from: "BE-原名", body: "completed" } } }],
  ["completion", { text: "## Completed (1)", details: { op: "wait", jobs: [running(1000, { status: "completed", resultText: "ok" })] } }],
  ["failure", { text: "## Completed (1)", details: { op: "wait", jobs: [running(1000, { status: "failed", errorText: "failed" })] } }],
  ["interruption", { text: "Wait interrupted by message.", details: { op: "wait", jobs: [], interrupted: true } }],
  ["service completion", { text: "A service finished. Read proc:// for its status and output.", details: { op: "wait", jobs: [] } }],
  ["unknown empty shape", { text: "Something new happened", details: { op: "wait", jobs: [] } }],
  ["tool error", { ...emptyWait, isError: true }],
  ["truncated result", { ...emptyWait, details: { ...emptyWait.details, meta: { truncated: true } } }],
  ["output-meta truncation", { ...emptyWait, details: { ...emptyWait.details, meta: { truncation: { artifactId: "output", truncatedBy: "bytes" } } } }],
]) test(`18.3 repeated wait excludes ${label}`, async () => {
  assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 no-job safety cap is distinct from a service-completion wake", async () => {
  const value = { text: "Wait limit reached; background work may still be running. Read proc:// for status.", details: { op: "wait", jobs: [] } };
  assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 1);
  assert.equal((await scan([emptyWait, value])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 proc snapshots detect polling despite changing duration and agent age", async () => {
  const a = proc(1000), b = proc(5000);
  a.details.proc.agents = [{ id: "FE-原名", ageMs: 1000, live: true, activity: "working" }];
  b.details.proc.agents = [{ id: "FE-原名", ageMs: 5000, live: true, activity: "working" }];
  const r = await scan([a, b]);
  assert.equal(r.diagnostics.repeatedStatus.length, 1);
  const empty = { name: "read", args: { path: "proc://" }, text: "No background jobs or services.", details: { proc: { jobs: [], agents: [], daemons: [] } } };
  assert.equal((await scan([empty, empty])).diagnostics.repeatedStatus.length, 1);
});

test("18.3 proc job reads preserve output/progress and task-owned duration fields", async () => {
  const a = { name: "read", args: { path: "proc://BE-原名" }, text: "running\nlog A", details: { proc: { job: running(), log: "log A" } } };
  const b = structuredClone(a); b.details.proc.job.durationMs = 9000;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 1);
  b.details.proc.log = "log B";
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
  const c = proc(1000, { structured: { status: "valid", data: { durationMs: 3 } } });
  const d = proc(2000, { structured: { status: "valid", data: { durationMs: 4 } } });
  assert.equal((await scan([c, d])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 malformed, partial or unstructured proc output is not guessed into polling", async () => {
  for (const value of [
    { ...proc(), details: {} },
    { ...proc(), details: { proc: { jobs: "invalid", agents: [], daemons: [] } } },
    { ...proc(), details: { proc: { jobs: [], agents: [] } } },
    { ...proc(), args: { path: "proc://", limit: 1 } },
    { ...proc(), details: { ...proc().details, truncation: { truncated: true } } },
    { ...proc(), isError: true },
  ]) assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 0);
});

for (const barrier of ["irc:incoming", "hub:incoming", "extension:notice"]) test(`18.3 ${barrier} breaks a polling chain`, async () => {
  assert.equal((await scan([{ ...emptyWait, barrier }, emptyWait])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 runtime records native wait in dispatch and execution hooks without retaining bodies", async () => {
  const writes = [], ctx = { sessionManager: { getSessionFile: () => "/tmp/protocol-test.jsonl" } };
  const observer = createRuntimeObserver({}, { append: async (_file, line) => writes.push(JSON.parse(line)), configurationFiles: async () => [] });
  await observer.handle({ type: "session_start" }, ctx);
  for (const type of ["tool_call", "tool_execution_start"]) for (const [toolName, args, operation] of [["wait", {}, "wait"], ["write", { path: "agent://BE-原名", content: "DO_NOT_PERSIST_MESSAGE_BODY" }, "send"], ["write", { path: "proc://x/kill" }, "cancel"]]) {
    await observer.handle({ type, toolCallId: `${type}-${operation}`, toolName, input: args, args }, ctx);
  }
  await observer.flush();
  for (const f of writes.filter(f => ["tool-dispatch", "tool-start"].includes(f.kind))) assert.equal(f.operation, f.toolCallId.split("-").at(-1));
  assert.doesNotMatch(JSON.stringify(writes), /DO_NOT_PERSIST_MESSAGE_BODY/);
});

test("18.3 old native-wait sidecars with null operation are reclassified, not retimed", async () => {
  await scan([emptyWait], async root => {
    const base = { schema: 1, runId: "captured-run", targetSessionFile: root, observerSource: "local-extension", toolCallId: "tool-0", name: "wait", operation: null };
    await writeJsonl(sidecarPath(root), [
      { ...base, id: "start", kind: "tool-start", timestamp: epoch + 1100, monotonicMs: 10 },
      { ...base, id: "end", kind: "tool-end", timestamp: epoch + 2100, monotonicMs: 1010 },
    ]);
    const r = await buildReport(root), span = r.telemetry.spans[0];
    assert.equal(span.category, "native-wait"); assert.equal(span.durationMs, 1000); assert.equal(span.operation, "wait");
    assert.equal(r.telemetry.waits[0].categories.find(c => c.category === "native-wait").unionMs, 1000);
  });
});

test("18.3 missing wait end remains unknown and Eval outer span is not native wait", async () => {
  await scan([emptyWait, { name: "eval", args: { code: "await tool.wait({});" }, text: "" }], async root => {
    const base = { schema: 1, runId: "captured-run", targetSessionFile: root, observerSource: "local-extension" };
    await writeJsonl(sidecarPath(root), [
      { ...base, id: "start", kind: "tool-start", toolCallId: "tool-0", name: "wait", timestamp: epoch + 1100, monotonicMs: 10 },
      { ...base, id: "eval-start", kind: "tool-start", toolCallId: "tool-1", name: "eval", timestamp: epoch + 4100, monotonicMs: 3010 },
      { ...base, id: "eval-end", kind: "tool-end", toolCallId: "tool-1", name: "eval", timestamp: epoch + 5100, monotonicMs: 4010 },
    ]);
    const r = await buildReport(root);
    assert.equal(r.telemetry.spans[0].category, "native-wait"); assert.equal(r.telemetry.spans[0].durationMs, null);
    assert.equal(r.telemetry.spans[1].category, "wrapped-tool-unobserved");
  });
});

test("18.3 protocol exports preserve targets, operations, names and unchanged usage totals", async () => {
  const r = await scan([emptyWait, proc(), { name: "write", args: { path: "agent://BE-原名", content: "hello" } }, { name: "write", args: { path: "agent://all", content: "hello" } }, { name: "write", args: { path: "proc://BE-原名/kill" } }]);
  assert.equal(r.total.calls, 5); assert.equal(r.total.costTotal, 1.25); assert.equal(r.total.input, 500); assert.equal(r.total.output, 100); assert.equal(r.total.cacheRead, 1000);
  const d = buildDiagnosticData(r), sent = d.calls[2].tools[0], broadcast = d.calls[3].tools[0];
  assert.equal(sent.behavior, "message"); assert.equal(sent.target, "agent://BE-原名"); assert.equal(sent.operation, "send");
  assert.equal(broadcast.broadcast, true);
  assert.equal(d.calls[4].tools[0].behavior, "cancel");
  assert.equal(d.calls[0].tools[0].statusComparable, true);
});

test("18.3 documentation empty-wait wording is compatible but ordinary read text is not status", async () => {
  const value = { ...emptyWait, text: "Nothing to wait for" };
  assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 1);
  assert.equal((await scan([{ ...emptyWait, name: "read", args: { path: "README.md" } }, { ...emptyWait, name: "read", args: { path: "README.md" } }])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 completed proc durations and exit codes remain meaningful evidence", async () => {
  const a = proc(1000, { status: "completed", exitCode: 0 }), b = proc(2000, { status: "completed", exitCode: 0 });
  assert.equal((await scan([a, a])).diagnostics.repeatedStatus.length, 1);
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
  b.details.proc.jobs[0].durationMs = 1000; b.details.proc.jobs[0].exitCode = 1;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 service snapshots preserve logs, terminal rows, readiness and lifecycle", async () => {
  const a = { name: "read", args: { path: "proc://dev-server" }, text: "ready\nlog A", details: { proc: { daemon: { name: "dev-server", state: "ready", readyAt: epoch }, log: "log A", terminalRows: ["log A"] } } };
  assert.equal((await scan([a, a])).diagnostics.repeatedStatus.length, 1);
  for (const modify of [p => { p.log = "log B"; }, p => { p.terminalRows = ["log B"]; }, p => { p.daemon.state = "exited"; }, p => { p.daemon.readyAt += 1000; }]) {
    const b = structuredClone(a); modify(b.details.proc);
    assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
  }
});

test("18.3 fingerprint ignores object insertion order, not nested heartbeat/age data", async () => {
  const a = proc(), b = proc(3000);
  b.details.proc = { daemons: [], agents: [], jobs: [{ ...Object.fromEntries(Object.entries(b.details.proc.jobs[0]).reverse()) }] };
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 1);
  for (const field of ["durationMs", "ageMs", "heartbeatAgeMs"]) {
    const c = proc(1000, { structured: { data: { [field]: 1 } } });
    const d = proc(2000, { structured: { data: { [field]: 2 } } });
    assert.equal((await scan([c, d])).diagnostics.repeatedStatus.length, 0);
  }
});

test("18.3 missing logs, unexpected shapes, batch results and unknown read modifiers stay uncomparable", async () => {
  for (const value of [
    { ...proc(), args: { paths: ["proc://a", "proc://b"] } },
    { ...proc(), args: { path: "proc://", unknownSelector: "tail" } },
    { ...proc(), details: { proc: { job: running() } } },
    { ...proc(), details: { proc: { ...proc().details.proc, unexpectedMessage: "hello" } } },
    { ...proc(), details: { proc: { job: running(), log: "", jobs: "invalid" } } },
    { ...proc(), details: { proc: { daemon: { name: "svc", state: "ready" } } } },
    { ...proc(), details: { proc: { job: { ...running(), truncation: { truncated: true } }, log: "cut" } } },
  ]) assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 Eval static recognition never proves selectively displayed results are all empty", async () => {
  for (const code of ["await tool.wait({});", "display((await tool.wait({})).text);", "await tool.wait({}); display((await tool.wait({})).text);"]) {
    const value = { name: "eval", args: { code }, text: emptyWait.text, details: { cells: [{ status: "complete" }] } };
    const r = await scan([value, value]);
    assert.equal(r.diagnostics.statusCallCount, 2);
    assert.equal(r.diagnostics.repeatedStatus.length, 0);
  }
});

test("18.3 malformed native arguments and ambiguous protocol writes are not file IO or status-only", async () => {
  for (const args of [[], "{}", { timeoutMs: 0 }]) {
    assert.equal(classifyTool("wait", args).behavior, "mixed/unknown");
    const value = { ...emptyWait, args };
    assert.equal((await scan([value, value])).diagnostics.repeatedStatus.length, 0);
  }
  assert.equal(classifyTool("write", { path: "README.md", paths: ["agent://A"] }).behavior, "mixed/unknown");
});

test("18.3 protocol target changes and cancellation/message activity break repeated snapshots", async () => {
  const a = { ...proc(), args: { path: "proc://A" } }, b = { ...proc(), args: { path: "proc://B" } };
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
  for (const path of ["proc://A/kill", "agent://A", "agent://all", "proc://svc", "proc://svc/mode", "README.md"]) {
    assert.equal((await scan([proc(), { name: "write", args: { path, content: "x" } }, proc()])).diagnostics.repeatedStatus.length, 0);
  }
});

test("18.3 proc-only agent roster snapshots preserve actual liveness and activity", async () => {
  const a = { name: "read", args: { path: "proc://FE-原名" }, text: "running", details: { proc: { agents: [{ id: "FE-原名", live: true, ageMs: 1000, activity: "review" }] } } };
  const b = structuredClone(a); b.details.proc.agents[0].ageMs = 5000;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 1);
  b.details.proc.agents[0].live = false;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
});

test("18.3 no-job wait with stale-agent roster preserves registration state", async () => {
  const a = { text: emptyWait.text + "\n\n## Running Agents (1)\n- FE-原名", details: { op: "wait", jobs: [], agents: [{ id: "FE-原名", live: false, ageMs: 1000 }] } };
  const b = structuredClone(a); b.details.agents[0].ageMs = 5000;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 1);
  b.details.agents[0].acceptedAt = epoch;
  assert.equal((await scan([a, b])).diagnostics.repeatedStatus.length, 0);
});
