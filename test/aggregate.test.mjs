import test from "node:test";
import assert from "node:assert/strict";
import { buildAggregates } from "../aggregate.js";

function call(overrides = {}) {
  return {
    provider: "openai",
    model: "sol",
    agentType: "main",
    agent: "main",
    ownerAgent: "main",
    advisorSlug: "",
    advisorName: "",
    advisorKey: "",
    input: 100,
    output: 10,
    cacheRead: 200,
    cacheWrite: 0,
    orchestrationInput: 0,
    orchestrationOutput: 0,
    orchestrationCacheRead: 0,
    measuredTokens: 310,
    premiumRequests: 0,
    failed: false,
    timestamp: 1000,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
    ...overrides,
  };
}

function scan(calls, activity = new Map(), descriptors = new Map()) {
  return {
    calls,
    advisorActivity: activity,
    advisorDescriptors: descriptors,
    sessionId: "s",
    rootSessionFile: "/private/root.jsonl",
    metadata: { filesScanned: 1 },
    pricing: { sourceCounts: { transcript: calls.length }, sync: { attempted: false, ok: true }, dbMatched: 0 },
  };
}

test("aggregate totals and actor types use calls rather than ambiguous requests", () => {
  const report = buildAggregates(scan([
    call(),
    call({ provider: "xai", model: "grok", agentType: "advisor", agent: "main > advisor", advisorName: "default", advisorKey: "main\u0000", cost: { total: 1 }, measuredTokens: 100 }),
  ]));
  assert.equal(report.total.calls, 2);
  assert.equal(report.actorTypes.length, 2);
  assert.equal(report.actorTypes.find(row => row.actorType === "advisor").calls, 1);
});

test("provider, model, and agent child distributions are built", () => {
  const report = buildAggregates(scan([
    call(),
    call({ agentType: "subagent", agent: "Worker" }),
    call({ provider: "xai", model: "grok", agentType: "subagent", agent: "Worker", cost: { total: 1 } }),
  ]));
  assert.equal(report.providers.find(row => row.name === "openai").models.length, 1);
  assert.equal(report.models.find(row => row.name === "openai/sol").agents.length, 2);
  assert.equal(report.primaryAgents.find(row => row.name === "Worker").models.length, 2);
});

test("activity-only advisor descriptors survive with zero model calls", () => {
  const key = "main\u0000silent";
  const activity = new Map([[key, { reviewUpdates: 2, deliveredNotes: 1 }]]);
  const descriptors = new Map([[key, {
    advisorKey: key,
    advisorName: "silent",
    advisorSlug: "silent",
    agent: "main > advisor:silent",
    ownerAgent: "main",
  }]]);
  const report = buildAggregates(scan([], activity, descriptors));
  assert.equal(report.advisors.length, 1);
  assert.equal(report.advisors[0].calls, 0);
  assert.equal(report.advisors[0].reviewUpdates, 2);
  assert.equal(report.advisors[0].deliveredNotes, 1);
});
