import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { buildReport, collectSessionData, resolveInteractiveRoot, transcriptIdentity } from "../core.js";
import { advisorCard, assistant, header, removeDir, tempDir, user, writeJsonl } from "./helpers.mjs";

const ctx = { cwd: "/tmp/project" };
const pi = { exec: async () => ({ code: 0 }) };

async function richFixture() {
  const dir = await tempDir();
  const root = path.join(dir, "main.jsonl");
  const artifacts = path.join(dir, "main");

  await writeJsonl(root, [
    header("main"),
    user("u-main", "do work"),
    assistant("main-1", "openai-codex", "gpt-5.6-sol", { cost: { input: 0.2, output: 0.1, cacheRead: 0.1, cacheWrite: 0, total: 0.4 } }),
    advisorCard("card-default", [{ note: "Check error handling", severity: "concern" }]),
    assistant("main-follow", "openai-codex", "gpt-5.6-sol", { parentId: "card-default", cost: { input: 0.1, output: 0.1, cacheRead: 0.05, cacheWrite: 0, total: 0.25 } }),
    advisorCard("card-security", [{ note: "Validate auth boundary", severity: "blocker", advisor: "Security Review" }]),
  ]);

  await writeJsonl(path.join(artifacts, "__advisor.jsonl"), [
    header("main-advisor"),
    user("adv-u1", "session update", { synthetic: true }),
    assistant("adv-a1", "xai-oauth", "grok-4.6", {
      content: [
        { type: "toolCall", name: "read", arguments: { path: "src/a.js" } },
        { type: "toolCall", name: "advise", arguments: { note: "Check error handling", severity: "concern" } },
      ],
      cost: { input: 0.08, output: 0.04, cacheRead: 0.02, cacheWrite: 0, total: 0.14 },
    }),
  ]);

  await writeJsonl(path.join(artifacts, "__advisor.security-review.jsonl"), [
    header("security-advisor"),
    user("sec-u1", "session update", { synthetic: true }),
    assistant("sec-a1", "xai-oauth", "grok-4.6", {
      content: [{ type: "tool_call", name: "advise", args: { note: "Validate auth boundary", severity: "blocker" } }],
      cost: { input: 0.04, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.07 },
    }),
  ]);

  await writeJsonl(path.join(artifacts, "Worker.jsonl"), [
    header("worker"),
    user("worker-u", "task"),
    assistant("worker-a", "openai-codex", "gpt-5.6-luna", { cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.03 } }),
  ]);

  await writeJsonl(path.join(artifacts, "Worker", "__advisor.jsonl"), [
    header("worker-advisor"),
    user("worker-adv-u", "worker update", { synthetic: true }),
    assistant("worker-adv-a", "xai-oauth", "grok-4.6", {
      content: [{ type: "tool_use", name: "grep", input: { pattern: "TODO" } }],
      cost: { input: 0.02, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.04 },
    }),
  ]);

  await writeJsonl(path.join(artifacts, "Worker", "Worker.Checker.jsonl"), [
    header("checker"),
    user("checker-u", "nested task"),
    assistant("checker-a", "openai-codex", "gpt-5.6-terra", { cost: { input: 0.02, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.05 } }),
  ]);

  await fs.writeFile(path.join(artifacts, "not-a-session.jsonl"), `${JSON.stringify({ type: "message", id: "junk" })}\n`);
  return { dir, root };
}

test("transcript identity distinguishes main, nested subagents, and owned advisors", () => {
  const root = "/tmp/s/main.jsonl";
  assert.equal(transcriptIdentity(root, root).agentType, "main");
  assert.equal(transcriptIdentity("/tmp/s/main/Worker.jsonl", root).agent, "Worker");
  assert.equal(transcriptIdentity("/tmp/s/main/Worker/Worker.Checker.jsonl", root).agent, "Worker > Checker");
  const advisor = transcriptIdentity("/tmp/s/main/Worker/__advisor.security.jsonl", root);
  assert.equal(advisor.agentType, "advisor");
  assert.equal(advisor.ownerAgent, "Worker");
  assert.equal(advisor.advisorSlug, "security");
});

test("resolveInteractiveRoot climbs from nested subagent transcripts", async () => {
  const fixture = await richFixture();
  try {
    const nested = path.join(fixture.dir, "main", "Worker", "Worker.Checker.jsonl");
    assert.equal(await resolveInteractiveRoot(nested), fixture.root);
  } finally {
    await removeDir(fixture.dir);
  }
});

test("buildReport aggregates providers, models, primary agents, and advisors", async () => {
  const fixture = await richFixture();
  try {
    const report = await buildReport(fixture.root, pi, ctx);
    assert.equal(report.version, "0.5.2");
    assert.equal(report.total.calls, 7);
    assert.equal(report.providers.length, 2);
    assert.equal(report.models.length, 4);
    assert.equal(report.primaryAgents.length, 3);
    assert.equal(report.advisors.length, 3);
    assert.equal(report.metadata.filesScanned, 6);
    assert.equal(report.metadata.skippedInvalidFiles, 1);
    assert.equal(report.pricing.sync.attempted, false);
  } finally {
    await removeDir(fixture.dir);
  }
});

test("advisor activity includes review, tool, delivery, and direct follow-up attribution", async () => {
  const fixture = await richFixture();
  try {
    const report = await buildReport(fixture.root, pi, ctx);
    const rootAdvisor = report.advisors.find(row => row.ownerAgent === "main" && row.advisorSlug === "");
    assert.ok(rootAdvisor);
    assert.equal(rootAdvisor.reviewUpdates, 1);
    assert.equal(rootAdvisor.adviseCalls, 1);
    assert.equal(rootAdvisor.otherToolCalls, 1);
    assert.equal(rootAdvisor.deliveredNotes, 1);
    assert.equal(rootAdvisor.deliveredCards, 1);
    assert.equal(rootAdvisor.primaryFollowupCalls, 1);
    assert.equal(rootAdvisor.requestedSeverity.concern, 1);
    assert.equal(rootAdvisor.deliveredSeverity.concern, 1);

    const named = report.advisors.find(row => row.advisorSlug === "security-review");
    assert.ok(named);
    assert.equal(named.reviewUpdates, 1);
    assert.equal(named.adviseCalls, 1);
    assert.equal(named.deliveredSeverity.blocker, 1);

    const sub = report.advisors.find(row => row.ownerAgent === "Worker");
    assert.ok(sub);
    assert.equal(sub.scope, "subagent");
    assert.equal(sub.reviewUpdates, 1);
    assert.equal(sub.otherToolCalls, 1);
  } finally {
    await removeDir(fixture.dir);
  }
});

test("model and agent intersections retain parent-relative totals", async () => {
  const fixture = await richFixture();
  try {
    const report = await buildReport(fixture.root, pi, ctx);
    const grok = report.models.find(row => row.name === "xai-oauth/grok-4.6");
    assert.ok(grok);
    assert.equal(grok.calls, 3);
    assert.equal(grok.agents.length, 3);
    const main = report.primaryAgents.find(row => row.agent === "main");
    assert.ok(main);
    assert.equal(main.calls, 2);
    assert.equal(main.models.length, 1);
    assert.equal(main.dominantModel, "openai-codex/gpt-5.6-sol");
  } finally {
    await removeDir(fixture.dir);
  }
});

test("gzip transcripts are scanned recursively", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "main.jsonl");
  try {
    await writeJsonl(root, [header("main"), assistant("main-a", "openai", "m1")]);
    await writeJsonl(path.join(dir, "main", "Compressed.jsonl.gz"), [header("compressed"), assistant("gz-a", "xai", "m2")], true);
    const report = await buildReport(root, pi, ctx);
    assert.equal(report.total.calls, 2);
    assert.equal(report.metadata.filesScanned, 2);
    assert.ok(report.primaryAgents.some(row => row.agent === "Compressed"));
  } finally {
    await removeDir(dir);
  }
});

test("fork-aware sessions exclude pre-fork copied calls", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "fork.jsonl");
  try {
    await writeJsonl(root, [
      header("fork", "2026-09-03T12:00:00.000Z", { parentSession: "/tmp/parent.jsonl" }),
      assistant("new", "openai", "new", { timestamp: "2026-09-03T12:00:01.000Z" }),
    ]);
    await writeJsonl(path.join(dir, "fork", "Copied.jsonl"), [
      header("copied", "2026-09-02T00:00:00.000Z"),
      assistant("old", "openai", "old", { timestamp: "2026-09-02T00:00:01.000Z" }),
    ]);
    const report = await buildReport(root, pi, ctx);
    assert.equal(report.total.calls, 1);
    assert.equal(report.metadata.forkAware, true);
    assert.equal(report.metadata.excludedInheritedCalls, 1);
  } finally {
    await removeDir(dir);
  }
});

test("duplicate copied assistant entries are suppressed before advisor tool counts", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "main.jsonl");
  const duplicate = assistant("same", "xai", "grok", {
    content: [{ type: "toolCall", name: "advise", arguments: { severity: "nit" } }],
  });
  try {
    await writeJsonl(root, [header("main"), assistant("main-a", "openai", "m")]);
    await writeJsonl(path.join(dir, "main", "__advisor.jsonl"), [header("adv"), user("u", "update", { synthetic: true }), duplicate]);
    await writeJsonl(path.join(dir, "main", "Copy", "__advisor.jsonl"), [header("adv-copy"), duplicate]);
    const data = await collectSessionData(root, pi, ctx);
    assert.equal(data.calls.length, 2);
    assert.equal(data.metadata.duplicateCallsRemoved, 1);
    const rootActivity = data.advisorActivity.get("main\u0000");
    assert.equal(rootActivity.adviseCalls, 1);
  } finally {
    await removeDir(dir);
  }
});

test("zero-priced calls request official stats refresh without crashing when sync fails", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "main.jsonl");
  try {
    await writeJsonl(root, [header("main"), assistant("a", "openai", "m", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })]);
    const report = await buildReport(root, { exec: async () => ({ code: 2, stderr: "nope" }) }, ctx);
    assert.equal(report.total.calls, 1);
    assert.equal(report.total.zeroPricedCalls, 1);
    assert.equal(report.pricing.sync.attempted, true);
    assert.equal(report.pricing.sync.ok, false);
  } finally {
    await removeDir(dir);
  }
});

test("fork cutoff excludes inherited advisor cards and review updates", async () => {
  const dir = await tempDir();
  const root = path.join(dir, "fork.jsonl");
  try {
    await writeJsonl(root, [
      header("fork", "2026-09-03T12:00:00.000Z", { parentSession: "/tmp/parent.jsonl" }),
      advisorCard("old-card", [{ note: "old", severity: "blocker" }], { timestamp: "2026-09-02T00:00:00.000Z" }),
      assistant("new-main", "openai", "new", { timestamp: "2026-09-03T12:00:01.000Z" }),
    ]);
    await writeJsonl(path.join(dir, "fork", "__advisor.jsonl"), [
      header("advisor"),
      user("old-review", "old", { synthetic: true, timestamp: "2026-09-02T00:00:00.000Z" }),
      user("new-review", "new", { synthetic: true, timestamp: "2026-09-03T12:00:01.000Z" }),
      assistant("advisor-call", "xai", "grok", { timestamp: "2026-09-03T12:00:02.000Z" }),
    ]);
    const report = await buildReport(root, pi, ctx);
    const advisor = report.advisors[0];
    assert.equal(advisor.reviewUpdates, 1);
    assert.equal(advisor.deliveredNotes, 0);
    assert.equal(advisor.deliveredCards, 0);
  } finally {
    await removeDir(dir);
  }
});
