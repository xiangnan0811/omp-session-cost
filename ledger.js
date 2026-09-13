import path from "node:path";
import { runtimeDelegationTools, poolDelegations } from "./lineage.js";
import { summarizeCalls, distribution } from "./diagnostics.js";
import { displayName } from "./semantic.js";
import { transcriptStem } from "./transcript.js";

export const SHARED_TASK = "shared/unattributed";
const add = (a, n) => a + (typeof n === "number" && Number.isFinite(n) ? n : 0);
const group = (values, keyOf) => {
  const map = new Map();
  for (const v of values) { const k = keyOf(v); if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
  return map;
};
export function measure(calls) {
  const totals = { calls: calls.length, failed: calls.filter(c => c.failed).length };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "orchestrationInput", "orchestrationOutput", "orchestrationCacheRead", "measuredTokens"])
    totals[key] = calls.reduce((n, c) => add(n, c[key]), 0);
  totals.costTotal = calls.reduce((n, c) => add(n, c.priceStatus === "missing" ? null : (c.selectedCost ?? c.cost)?.total), 0);
  const categories = {};
  for (const key of ["input", "cacheRead", "cacheWrite", "output"]) {
    const tokenCalls = calls.filter(c => typeof c.usageFacts?.fields?.[key] === "number");
    const priceCalls = calls.filter(c => c.priceStatus !== "missing" && typeof (c.selectedCost ?? c.cost)?.[key] === "number");
    categories[key] = { tokens: tokenCalls.reduce((n, c) => add(n, c.usageFacts.fields[key]), 0), tokenRecords: tokenCalls.length,
      cost: priceCalls.reduce((n, c) => add(n, (c.selectedCost ?? c.cost)[key]), 0), pricedRecords: priceCalls.length };
  }
  return { ...totals, categories, measurement: summarizeCalls(calls) };
}
export function measuredGroups(calls, keyOf, decorate = (c, id) => ({ name: id })) {
  return [...group(calls, keyOf)].map(([id, items]) => ({ id, name: id, ...decorate(items[0], id), ...measure(items) }))
    .sort((a, b) => b.costTotal - a.costTotal || b.measuredTokens - a.measuredTokens || String(a.name).localeCompare(String(b.name)));
}

/** Resolve on the full snapshot before filtering; later user messages cannot steal earlier delegated work. */
export function attributeScan(scan) {
  const events = scan.events || [], calls = scan.calls || [], frames = scan.runtimeEvents || [];
  const instances = new Map(), eventsByKey = new Map(events.map(e => [e.key, e]));
  for (const e of events) {
    if (!instances.has(e.transcriptId)) instances.set(e.transcriptId, { id: e.transcriptId, name: e.agent, actorType: e.agentType,
      role: e.agentType === "subagent" ? null : e.agentType, roleSource: e.agentType === "subagent" ? "not-recorded" : "actor-type", owner: e.ownerAgent,
      file: e.sessionFile ? path.resolve(e.sessionFile) : null, title: null, initEventKey: null, parentToolCallId: null, parentAgent: null, assignmentEvidence: [] });
    if (e.kind === "session-init") Object.assign(instances.get(e.transcriptId), e.init, { initEventKey: e.key, roleSource: e.init.role ? "session_init.agent" : "not-recorded" });
  }
  for (const t of scan.transcripts || []) {
    if (!t.id || instances.has(t.id)) continue;
    instances.set(t.id, { id: t.id, name: t.agent, actorType: t.agentType, owner: t.ownerAgent,
      role: t.agentType === "subagent" ? null : t.agentType, roleSource: "session-header-only",
      file: path.resolve(t.file), title: null, initialTitle: null, parentAgent: null, assignmentEvidence: [] });
  }
  for (const instance of instances.values()) instance.initialTitle = instance.title;
  const byFile = new Map([...instances.values()].filter(i => i.file).map(i => [i.file, i]));
  for (const c of calls) if (instances.has(c.transcriptId)) {
    const instance = instances.get(c.transcriptId);
    instance.file = path.resolve(c.sessionFile); byFile.set(instance.file, instance);
  }
  const byStem = new Map([...byFile].map(([file, instance]) => [transcriptStem(file), instance]));
  for (const instance of instances.values()) {
    if (!instance.file || instance.actorType === "main") continue;
    const parent = byStem.get(path.dirname(instance.file));
    if (parent && parent.id !== instance.id) {
      instance.parentAgent = parent.name; instance.parentInstanceId = parent.id;
      instance.parentSource = "transcript-directory";
    }
    if (instance.actorType === "advisor" && !instance.parentAgent) {
      instance.parentAgent = instance.owner; instance.parentSource = "advisor-owner";
    }
  }
  for (const f of frames.filter(f => f.kind === "subagent-lifecycle")) {
    const childFile = f.childFile || f.targetSessionFile;
    const instance = childFile ? byFile.get(path.resolve(childFile)) : null;
    if (!instance || instance.actorType !== "subagent") continue;
    if (f.role) { instance.role = f.role; instance.roleSource = "task:subagent:lifecycle.agent"; }
    if (f.name) instance.runtimeName = f.name;
    if (f.title) {
      instance.instructionHistory ??= [];
      if (instance.instructionHistory.at(-1)?.title !== f.title) instance.instructionHistory.push({ title: f.title, timestamp: f.timestamp, evidence: f.id, source: "lifecycle-description" });
      instance.latestInstruction = f.title;
    }
    if (f.parentToolCallId) { instance.parentToolCallId = f.parentToolCallId; instance.parentAgent = f.agent; instance.assignmentEvidence.push(f.id); }
    if (["started", "completed", "failed", "aborted"].includes(f.status)) instance.status = f.status;
  }
  const tasks = new Map(events.filter(e => e.agentType === "main" && e.kind === "user-task").map(e => [e.key, {
    id: e.key, name: e.taskTitle || e.phase, eventId: e.entryId, eventKey: e.key, timestamp: e.timestamp, source: "human-message-boundary" }]));
  for (const e of events.filter(e => e.kind === "label" && e.targetId)) {
    const t = tasks.get(`${e.transcriptId}\u0000${e.targetId}`);
    if (t) { t.originalTitle = t.name; t.name = e.label; t.labelEventKey = e.key; t.source = "explicit-task-label"; }
  }
  const tasksByEventId = group([...tasks.values()], t => t.eventId);
  const tools = events.flatMap(e => (e.tools || []).map(t => ({ ...t, eventKey: e.key, parentAgent: e.agent, transcriptId: e.transcriptId, phaseKey: e.phaseKey })));
  tools.push(...runtimeDelegationTools(frames, byFile, eventsByKey));
  const delegations = tools.flatMap(t => (t.delegations || []).map(d => ({ ...d, eventKey: t.eventKey, parentAgent: t.parentAgent, transcriptId: t.transcriptId, phaseKey: t.phaseKey, evidence: t.evidence || [] })));
  const parents = new Map();
  for (const instance of instances.values()) {
    if (instance.actorType !== "subagent") continue;
    const hierarchy = instance.name.split(" > "), leaf = hierarchy.pop();
    const parentName = instance.parentAgent || hierarchy.join(" > ") || "main";
    const allocatedName = instance.file ? path.basename(transcriptStem(instance.file)) : leaf;
    const parentTools = tools.filter(t => instance.parentInstanceId ? t.transcriptId === instance.parentInstanceId : t.parentAgent === parentName);
    const parentDelegations = delegations.filter(d => instance.parentInstanceId ? d.transcriptId === instance.parentInstanceId : d.parentAgent === parentName);
    // Task results retain the allocated output ID even when OMP generated or normalized the requested name.
    const fromResults = events.flatMap(e => {
      const tool = parentTools.find(t => t.id && t.id === e.toolCallId && t.transcriptId === e.transcriptId);
      if (!tool) return [];
      return (e.taskResults || []).filter(r => r.id === allocatedName).map(r => ({ ...r, toolCallId: tool.id,
        eventKey: tool.eventKey, evidence: [tool.eventKey, e.key], parentAgent: tool.parentAgent,
        transcriptId: tool.transcriptId, phaseKey: tool.phaseKey, match: "task-result-allocated-id" }));
    });
    let candidates = fromResults;
    if (!candidates.length) candidates = poolDelegations(instance, events, tools, instance.parentInstanceId);
    if (!candidates.length && instance.parentToolCallId) {
      candidates = parentDelegations.filter(d => d.toolCallId === instance.parentToolCallId &&
        (!d.name || [leaf, instance.runtimeName].includes(d.name) || (instance.taskHash && d.taskHash === instance.taskHash)));
      if (!candidates.length) candidates = parentTools.filter(t => t.id === instance.parentToolCallId);
      candidates = candidates.map(d => ({ ...d, match: "runtime-parent-tool" }));
    }
    if (!candidates.length) {
      const hashes = parentDelegations.filter(d => instance.taskHash && d.taskHash === instance.taskHash && (!instance.role || !d.role || instance.role === d.role));
      candidates = hashes.length ? hashes.map(d => ({ ...d, match: "normalized-assignment-hash" })) :
        parentDelegations.filter(d => d.name && [leaf, instance.runtimeName].includes(d.name)).map(d => ({ ...d, match: "exact-requested-name" }));
    }
    candidates = [...new Map(candidates.map(d => [JSON.stringify([d.eventKey, d.toolCallId || d.id, d.index]), d])).values()];
    const parentToolIds = [...new Set(candidates.map(d => d.toolCallId || d.id).filter(Boolean))];
    if (!instance.parentToolCallId && parentToolIds.length === 1) instance.parentToolCallId = parentToolIds[0];
    instance.delegationMatches = [...new Set(candidates.map(d => d.match))];
    if (!instance.role) {
      const roles = [...new Set(candidates.map(c => c.role).filter(Boolean))];
      if (roles.length === 1) { instance.role = roles[0]; instance.roleSource = "task.agent"; }
    }
    if (!instance.title) {
      const titles = [...new Set(candidates.map(c => c.title).filter(Boolean))];
      if (titles.length === 1) instance.title = titles[0];
    }
    const parentNames = [...new Set(candidates.map(c => c.parentAgent).filter(Boolean))];
    if (!instance.parentAgent && parentNames.length === 1) instance.parentAgent = parentNames[0];
    parents.set(instance.id, candidates);
  }
  const memo = new Map();
  function ownership(id, visited = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (visited.has(id)) return { ids: [], evidence: [], reason: "delegation-cycle" };
    const next = new Set([...visited, id]), ids = new Set(), evidence = [];
    for (const d of parents.get(id) || []) {
      evidence.push(d.eventKey, ...(d.evidence || []));
      if (tasks.has(d.phaseKey)) ids.add(d.phaseKey);
      else {
        const upstream = ownership(d.transcriptId, next);
        for (const key of upstream.ids) ids.add(key);
        evidence.push(...upstream.evidence);
      }
    }
    const result = { ids: [...ids], evidence: [...new Set(evidence)], reason: ids.size === 1 ? "explicit-delegation" : ids.size > 1 ? "ambiguous-delegation" : "source-not-recorded" };
    memo.set(id, result); return result;
  }
  function ownerFor(e) {
    const explicitId = e.assignment?.taskId;
    const explicit = explicitId && (tasks.has(explicitId) ? [tasks.get(explicitId)] : tasksByEventId.get(explicitId));
    if (explicit?.length === 1) return { ids: [explicit[0].id], evidence: [e.key || e.recordKey], reason: "explicit-task-id" };
    if (e.agentType === "main") return { ids: tasks.has(e.phaseKey) ? [e.phaseKey] : [], evidence: [e.phaseKey].filter(Boolean), reason: "main-parent-chain" };
    if (e.agentType === "advisor") return { ids: [], evidence: [], reason: "advisor-shared-without-explicit-task-id" };
    const segment = eventsByKey.get(e.phaseKey), instance = instances.get(e.transcriptId);
    if (segment?.kind === "user-task" && segment.taskHash && instance?.taskHash && segment.taskHash !== instance.taskHash) {
      const matching = delegations.filter(d => d.transcriptId === instance.parentInstanceId && d.taskHash === segment.taskHash);
      const ids = [...new Set(matching.map(d => d.phaseKey).filter(k => tasks.has(k)))];
      return { ids, evidence: [segment.key, ...matching.flatMap(d => [d.eventKey, ...(d.evidence || [])])],
        reason: ids.length === 1 ? "assignment-segment-exact-hash" : ids.length > 1 ? "ambiguous-assignment-segment" : "assignment-segment-unlinked" };
    }
    return ownership(e.transcriptId);
  }
  function fields(e) {
    const instance = instances.get(e.transcriptId), owner = ownerFor(e), taskKey = owner.ids.length === 1 ? owner.ids[0] : SHARED_TASK;
    return { instanceId: e.transcriptId, instanceName: instance?.runtimeName || e.agent, role: (e.purpose ? e.modelRole : null) || instance?.role || null,
      roleSource: e.purpose && e.modelRole ? "model_usage.role" : instance?.roleSource || "not-recorded", title: eventsByKey.get(e.phaseKey)?.taskTitle || instance?.initialTitle || instance?.title || null,
      taskKey, taskName: tasks.get(taskKey)?.name || "共享／未归属", taskAttribution: owner.reason,
      assignmentEvidence: owner.evidence, candidateTasks: owner.ids, workPhase: e.assignment?.phase || null, roundId: e.assignment?.roundId || null };
  }
  const enrichedCalls = calls.map(c => ({ ...c, ...fields(c) }));
  const enrichedEvents = events.map(e => ({ ...e, ...fields(e) }));
  const sourceCounts = group(calls, c => c.transcriptId);
  for (const instance of instances.values()) {
    instance.sourceCallCount = sourceCounts.get(instance.id)?.length || 0;
    const initial = enrichedEvents.find(e => e.transcriptId === instance.id && e.kind === "session-init");
    if (initial) {
      instance.taskKey = initial.taskKey; instance.taskName = initial.taskName; instance.attribution = initial.taskAttribution;
      instance.assignmentEvidence = [...new Set([...instance.assignmentEvidence, ...initial.assignmentEvidence])];
    }
  }
  // Source references stay exact even when their display labels contain control bytes.
  return { ...scan, calls: enrichedCalls, events: enrichedEvents, instances: [...instances.values()], tasks: [...tasks.values()] };
}

export function buildLedger(scan) {
  const calls = scan.calls || [], contexts = scan.contextEvents || scan.events || [];
  const taskInfo = new Map((scan.tasks || []).map(t => [t.id, t]));
  const tasks = measuredGroups(calls, c => c.taskKey || SHARED_TASK, (c, id) => ({ ...taskInfo.get(id), id, name: c.taskName || "共享／未归属" }));
  const taskCalls = group(calls, c => c.taskKey || SHARED_TASK);
  for (const t of tasks) {
    const items = taskCalls.get(t.id);
    t.actors = measuredGroups(items, c => c.agentType);
    t.agents = measuredGroups(items, c => c.agent, c => ({ name: c.agent, agent: c.agent, actorType: c.agentType }));
    t.models = measuredGroups(items, c => `${c.provider}/${c.model}`);
  }
  const roleModels = measuredGroups(calls, c => JSON.stringify([c.agentType, c.role, c.provider, c.model]), c => ({
    name: `${c.agentType} / ${c.role || "角色未记录"} / ${c.provider}/${c.model}`, role: c.role, actorType: c.agentType, provider: c.provider, model: c.model }));
  const metadata = new Map((scan.instances || []).map(i => [i.id, i]));
  const instances = measuredGroups(calls, c => c.instanceId || c.transcriptId || c.agent, (c, id) => ({ ...metadata.get(id), id,
    name: c.instanceName || c.agent, agent: c.agent, taskName: c.taskName, taskKey: c.taskKey, attribution: c.taskAttribution, role: c.role,
    assignmentEvidence: c.assignmentEvidence || [] }));
  const includedIds = new Set(instances.map(i => i.id));
  const eventInstanceIds = new Set((scan.events || []).filter(e => !e.inherited).map(e => e.transcriptId));
  for (const meta of metadata.values()) {
    // An empty transcript is visible only in the unfiltered inventory. Time/model scopes must not import unrelated actors.
    if (includedIds.has(meta.id) || (!eventInstanceIds.has(meta.id) && (scan.scope || (scan.events || []).some(e => e.transcriptId === meta.id)))) continue;
    instances.push({ ...meta, id: meta.id, name: meta.runtimeName || meta.name, agent: meta.name, ...measure([]) });
  }
  const instanceCalls = group(calls, c => c.instanceId || c.transcriptId || c.agent);
  for (const instance of instances) {
    const items = instanceCalls.get(instance.id) || [];
    instance.usageStatus = items.length ? "recorded" : instance.sourceCallCount > 0 ? "no-selected-usage" : "not-recorded";
    instance.unmeteredResponses = (scan.events || []).filter(e => e.transcriptId === instance.id && e.kind === "assistant" && !e.usage?.carryingUsage).length;
    // Only selected lifecycle observations may describe the current state of a historical slice.
    const lifecycle = (scan.runtimeEvents || []).filter(f => f.kind === "subagent-lifecycle" && instance.file &&
      (f.childFile || f.targetSessionFile) === instance.file).sort((a, b) => a.timestamp - b.timestamp);
    instance.status = lifecycle.findLast(f => ["started", "completed", "failed", "aborted"].includes(f.status))?.status || null;
    instance.instructionHistory = lifecycle.filter(f => f.title).map(f => ({ title: f.title, timestamp: f.timestamp, evidence: f.id, source: "lifecycle-description" }));
    instance.latestInstruction = instance.instructionHistory.at(-1)?.title || null;
    instance.lifecycleEvidence = lifecycle.map(f => f.id);
    instance.taskAssignments = measuredGroups(items, c => c.taskKey || SHARED_TASK, c => ({ name: c.taskName || "共享／未归属" }));
    instance.taskKey = !items.length ? instance.taskKey || null : instance.taskAssignments.length === 1 ? instance.taskAssignments[0].id : null;
    instance.taskName = !items.length ? instance.taskName || "未记录任务归属" : instance.taskAssignments.length === 1 ? instance.taskAssignments[0].name : `跨 ${instance.taskAssignments.length} 个任务／归因桶`;
    instance.attributionReasons = [...new Set(items.map(c => c.taskAttribution))];
    instance.attribution = !items.length ? instance.attribution || "source-not-recorded" : instance.attributionReasons.length === 1 ? instance.attributionReasons[0] : "multiple-attributions";
    instance.assignmentEvidence = [...new Set([...(metadata.get(instance.id)?.assignmentEvidence || []), ...items.flatMap(c => c.assignmentEvidence || [])])];
  }
  const bounds = contexts.filter(e => e.kind === "user-task" && e.agentType === "main" && e.timestamp).sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  const timeMap = new Map();
  for (const c of calls) {
    let lo = 0, hi = bounds.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (bounds[mid].timestamp <= c.timestamp) lo = mid + 1; else hi = mid; }
    const index = c.timestamp && lo ? lo - 1 : -1;
    if (!timeMap.has(index)) timeMap.set(index, []);
    timeMap.get(index).push(c);
  }
  const windows = [...timeMap].sort((a, b) => a[0] - b[0]).map(([index, values]) => ({
    id: bounds[index]?.key || "time-unassigned", name: bounds[index]?.taskTitle || "时间／边界未记录", from: bounds[index]?.timestamp || null,
    to: index >= 0 ? bounds[index + 1]?.timestamp || null : bounds[0]?.timestamp || null, ...measure(values) }));
  const expected = measure(calls), checks = [];
  for (const [dimension, rows] of [["tasks", tasks], ["timeWindows", windows], ["instances", instances], ["roleModels", roleModels]]) {
    for (const metric of ["calls", "input", "output", "cacheRead", "cacheWrite", "orchestrationInput", "orchestrationOutput", "orchestrationCacheRead", "measuredTokens", "costTotal"]) {
      const actual = rows.reduce((sum, r) => sum + r[metric], 0), delta = actual - expected[metric];
      const tolerance = metric === "costTotal" ? Math.max(1e-9, Math.abs(expected[metric]) * 1e-12) : 0;
      checks.push({ dimension, metric, expected: expected[metric], actual, delta, ok: Math.abs(delta) <= tolerance });
    }
  }
  const attributionReasons = measuredGroups(calls, c => JSON.stringify([c.agentType, c.taskAttribution]), c => ({ actorType: c.agentType, reason: c.taskAttribution }));
  return { tasks, roleModels, instances, timeWindows: windows,
    reconciliation: { checks, ok: checks.every(c => c.ok), selected: calls.length, taskRows: tasks.reduce((n, t) => n + t.calls, 0), windowRows: windows.reduce((n, t) => n + t.calls, 0),
      shared: tasks.find(t => t.id === SHARED_TASK)?.calls || 0, rule: "Each usage record counts once per additive dimension; detail rows are not additional spend." },
    coverage: { attributionReasons, roleKnown: calls.filter(c => c.role).length, taskKnown: calls.filter(c => c.taskKey && c.taskKey !== SHARED_TASK).length, selected: calls.length } };
}
