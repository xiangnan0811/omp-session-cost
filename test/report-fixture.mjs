import { buildAggregates } from "../aggregate.js";

function baseCall(overrides = {}) {
  return {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    agentType: "main",
    agent: "main",
    ownerAgent: "main",
    advisorSlug: "",
    advisorName: "",
    advisorKey: "",
    input: 1000,
    output: 100,
    cacheRead: 9000,
    cacheWrite: 0,
    orchestrationInput: 0,
    orchestrationOutput: 0,
    orchestrationCacheRead: 0,
    measuredTokens: 10100,
    premiumRequests: 0,
    failed: false,
    timestamp: Date.parse("2026-09-03T00:00:00Z"),
    cost: { input: 1, output: 0.5, cacheRead: 1.5, cacheWrite: 0, total: 3 },
    ...overrides,
  };
}

export function fixtureReport() {
  const advisorKey = "main\u0000";
  const calls = [
    baseCall(),
    baseCall({ agentType: "subagent", agent: "Backend", ownerAgent: "Backend", model: "gpt-5.6-luna", measuredTokens: 18000, cost: { total: 0.4 } }),
    baseCall({ agentType: "subagent", agent: "Frontend", ownerAgent: "Frontend", provider: "xai-oauth", model: "grok-4.6", measuredTokens: 8000, cost: { total: 0.8 } }),
    baseCall({ agentType: "advisor", agent: "main > advisor", ownerAgent: "main", advisorName: "default", advisorKey, provider: "xai-oauth", model: "grok-4.6", measuredTokens: 7000, cost: { total: 0.7 } }),
  ];
  const activity = new Map([[advisorKey, {
    reviewUpdates: 2,
    adviseCalls: 1,
    otherToolCalls: 3,
    deliveredNotes: 1,
    deliveredCards: 1,
    primaryFollowupCalls: 1,
    requestedSeverity: { nit: 0, concern: 1, blocker: 0, unspecified: 0 },
    deliveredSeverity: { nit: 0, concern: 1, blocker: 0, unspecified: 0 },
  }]]);
  return buildAggregates({
    calls,
    advisorActivity: activity,
    advisorDescriptors: new Map(),
    sessionId: "fixture-session",
    rootSessionFile: "/home/alice/.omp/sessions/private/main.jsonl",
    metadata: {
      filesScanned: 4,
      filesDiscovered: 5,
      skippedInvalidFiles: 1,
      forkAware: false,
      excludedInheritedCalls: 0,
      duplicateCallsRemoved: 0,
      cutoffMs: 0,
    },
    pricing: {
      dbPath: "/home/alice/.omp/stats.db",
      dbError: "sensitive /home/alice path",
      dbMatched: 4,
      sync: { attempted: false, ok: true, error: null },
      sourceCounts: { transcript: 4 },
    },
  });
}
