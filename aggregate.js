import { finite } from "./format.js";

export function emptyTotals() {
  return {
    calls: 0,
    failed: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    orchestrationInput: 0,
    orchestrationOutput: 0,
    orchestrationCacheRead: 0,
    measuredTokens: 0,
    premiumRequests: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    zeroPricedCalls: 0,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
}

export function addCall(target, call) {
  target.calls += 1;
  target.failed += call.failed ? 1 : 0;
  target.input += finite(call.input);
  target.output += finite(call.output);
  target.cacheRead += finite(call.cacheRead);
  target.cacheWrite += finite(call.cacheWrite);
  target.orchestrationInput += finite(call.orchestrationInput);
  target.orchestrationOutput += finite(call.orchestrationOutput);
  target.orchestrationCacheRead += finite(call.orchestrationCacheRead);
  target.measuredTokens += finite(call.measuredTokens);
  target.premiumRequests += finite(call.premiumRequests);
  target.costInput += finite(call.cost?.input);
  target.costOutput += finite(call.cost?.output);
  target.costCacheRead += finite(call.cost?.cacheRead);
  target.costCacheWrite += finite(call.cost?.cacheWrite);
  target.costTotal += finite(call.cost?.total);
  if (call.measuredTokens > 0 && finite(call.cost?.total) === 0) target.zeroPricedCalls += 1;
  const timestamp = finite(call.timestamp);
  if (timestamp > 0) {
    if (!target.firstTimestamp || timestamp < target.firstTimestamp) target.firstTimestamp = timestamp;
    if (!target.lastTimestamp || timestamp > target.lastTimestamp) target.lastTimestamp = timestamp;
  }
  return target;
}

export function addTotals(target, source) {
  for (const key of [
    "calls", "failed", "input", "output", "cacheRead", "cacheWrite",
    "orchestrationInput", "orchestrationOutput", "orchestrationCacheRead",
    "measuredTokens", "premiumRequests", "costInput", "costOutput",
    "costCacheRead", "costCacheWrite", "costTotal", "zeroPricedCalls",
  ]) target[key] += finite(source?.[key]);
  if (source?.firstTimestamp && (!target.firstTimestamp || source.firstTimestamp < target.firstTimestamp)) {
    target.firstTimestamp = source.firstTimestamp;
  }
  if (source?.lastTimestamp && (!target.lastTimestamp || source.lastTimestamp > target.lastTimestamp)) {
    target.lastTimestamp = source.lastTimestamp;
  }
  return target;
}

function groupCalls(calls, keyFn, decorate = () => ({})) {
  const map = new Map();
  for (const call of calls) {
    const key = keyFn(call);
    if (!key) continue;
    let row = map.get(key);
    if (!row) {
      row = { id: key, name: key, ...decorate(call, key), ...emptyTotals() };
      map.set(key, row);
    }
    addCall(row, call);
  }
  return map;
}

function sortedValues(map) {
  return [...map.values()].sort((a, b) => b.costTotal - a.costTotal || b.measuredTokens - a.measuredTokens || b.calls - a.calls || a.name.localeCompare(b.name));
}

function severityTotals() {
  return { nit: 0, concern: 0, blocker: 0, unspecified: 0 };
}

function normalizeActivity(activity = {}) {
  return {
    reviewUpdates: finite(activity.reviewUpdates),
    adviseCalls: finite(activity.adviseCalls),
    otherToolCalls: finite(activity.otherToolCalls),
    deliveredNotes: finite(activity.deliveredNotes),
    deliveredCards: finite(activity.deliveredCards),
    primaryFollowupCalls: finite(activity.primaryFollowupCalls),
    requestedSeverity: { ...severityTotals(), ...(activity.requestedSeverity ?? {}) },
    deliveredSeverity: { ...severityTotals(), ...(activity.deliveredSeverity ?? {}) },
  };
}

export function buildAggregates(scan) {
  const calls = scan.calls ?? [];
  const total = emptyTotals();
  for (const call of calls) addCall(total, call);

  const actorMap = groupCalls(calls, call => call.agentType, (_call, key) => ({
    name: key === "main" ? "Main" : key === "advisor" ? "Advisors" : "Subagents",
    actorType: key,
  }));

  const providerMap = groupCalls(calls, call => call.provider, call => ({
    name: call.provider,
    provider: call.provider,
  }));

  const modelMap = groupCalls(calls, call => `${call.provider}/${call.model}`, call => ({
    name: `${call.provider}/${call.model}`,
    provider: call.provider,
    model: call.model,
  }));

  const agentMap = groupCalls(calls, call => call.agent, call => ({
    name: call.agent,
    agent: call.agent,
    agentType: call.agentType,
    ownerAgent: call.ownerAgent,
    advisorSlug: call.advisorSlug,
  }));

  const advisorMap = groupCalls(
    calls.filter(call => call.agentType === "advisor"),
    call => call.advisorKey,
    call => ({
      name: call.advisorName,
      displayName: call.advisorName,
      agent: call.agent,
      ownerAgent: call.ownerAgent,
      advisorSlug: call.advisorSlug,
      scope: call.ownerAgent === "main" ? "main" : "subagent",
    }),
  );

  const providerModelMap = new Map();
  const modelAgentMap = new Map();
  const agentModelMap = new Map();
  const advisorModelMap = new Map();

  for (const call of calls) {
    const modelId = `${call.provider}/${call.model}`;
    const providerModelKey = `${call.provider}\u0000${modelId}`;
    let pm = providerModelMap.get(providerModelKey);
    if (!pm) {
      pm = { id: modelId, name: modelId, provider: call.provider, model: call.model, ...emptyTotals() };
      providerModelMap.set(providerModelKey, pm);
    }
    addCall(pm, call);

    const modelAgentKey = `${modelId}\u0000${call.agent}`;
    let ma = modelAgentMap.get(modelAgentKey);
    if (!ma) {
      ma = { id: call.agent, name: call.agent, modelId, agentType: call.agentType, ...emptyTotals() };
      modelAgentMap.set(modelAgentKey, ma);
    }
    addCall(ma, call);

    const agentModelKey = `${call.agent}\u0000${modelId}`;
    let am = agentModelMap.get(agentModelKey);
    if (!am) {
      am = { id: modelId, name: modelId, provider: call.provider, model: call.model, agent: call.agent, ...emptyTotals() };
      agentModelMap.set(agentModelKey, am);
    }
    addCall(am, call);

    if (call.agentType === "advisor") {
      const advisorModelKey = `${call.advisorKey}\u0000${modelId}`;
      let advm = advisorModelMap.get(advisorModelKey);
      if (!advm) {
        advm = { id: modelId, name: modelId, provider: call.provider, model: call.model, advisorKey: call.advisorKey, ...emptyTotals() };
        advisorModelMap.set(advisorModelKey, advm);
      }
      addCall(advm, call);
    }
  }

  for (const provider of providerMap.values()) {
    provider.models = sortedValues(new Map([...providerModelMap].filter(([key]) => key.startsWith(`${provider.provider}\u0000`))));
  }
  for (const model of modelMap.values()) {
    model.agents = sortedValues(new Map([...modelAgentMap].filter(([key]) => key.startsWith(`${model.id}\u0000`))));
  }
  for (const agent of agentMap.values()) {
    agent.models = sortedValues(new Map([...agentModelMap].filter(([key]) => key.startsWith(`${agent.agent}\u0000`))));
    agent.dominantModel = agent.models[0]?.name ?? "unknown";
  }
  for (const advisor of advisorMap.values()) {
    advisor.models = sortedValues(new Map([...advisorModelMap].filter(([key]) => key.startsWith(`${advisor.id}\u0000`))));
    advisor.dominantModel = advisor.models[0]?.name ?? "unknown";
    Object.assign(advisor, normalizeActivity(scan.advisorActivity?.get(advisor.id)));
  }

  // Preserve advisors that delivered cards or review updates but had no priced assistant call.
  for (const [key, activity] of scan.advisorActivity ?? []) {
    if (advisorMap.has(key)) continue;
    const descriptor = scan.advisorDescriptors?.get(key);
    if (!descriptor) continue;
    advisorMap.set(key, {
      id: key,
      name: descriptor.advisorName,
      displayName: descriptor.advisorName,
      agent: descriptor.agent,
      ownerAgent: descriptor.ownerAgent,
      advisorSlug: descriptor.advisorSlug,
      scope: descriptor.ownerAgent === "main" ? "main" : "subagent",
      dominantModel: "n/a",
      models: [],
      ...emptyTotals(),
      ...normalizeActivity(activity),
    });
  }

  const agents = sortedValues(agentMap);
  const advisors = sortedValues(advisorMap);
  const primaryAgents = agents.filter(row => row.agentType !== "advisor");

  return {
    version: "0.5.1",
    generatedAt: Date.now(),
    sessionId: scan.sessionId,
    rootSessionFile: scan.rootSessionFile,
    total,
    actorTypes: sortedValues(actorMap),
    providers: sortedValues(providerMap),
    models: sortedValues(modelMap),
    agents,
    primaryAgents,
    advisors,
    metadata: scan.metadata,
    pricing: scan.pricing,
  };
}
