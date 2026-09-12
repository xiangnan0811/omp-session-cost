import path from "node:path";
import { summarizeCalls, distribution } from "./diagnostics.js";
import { displayName } from "./semantic.js";

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
      title: null, initEventKey: null, parentToolCallId: null, parentAgent: null, assignmentEvidence: [] });
    if (e.kind === "session-init") Object.assign(instances.get(e.transcriptId), e.init, { initEventKey: e.key, roleSource: e.init.role ? "session_init.agent" : "not-recorded" });
  }
  const byFile = new Map();
  for (const c of calls) if (instances.has(c.transcriptId)) byFile.set(c.sessionFile, instances.get(c.transcriptId));
  for (const f of frames.filter(f => f.kind === "subagent-lifecycle")) {
    const childFile = f.childFile || f.targetSessionFile;
    const instance = childFile ? byFile.get(path.resolve(childFile)) : null;
    if (!instance || instance.actorType !== "subagent") continue;
    if (f.role) { instance.role = f.role; instance.roleSource = "task:subagent:lifecycle.agent"; }
    if (f.name) instance.runtimeName = f.name;
    if (f.title) instance.title = f.title;
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
  const delegations = tools.flatMap(t => (t.delegations || []).map(d => ({ ...d, eventKey: t.eventKey, parentAgent: t.parentAgent, transcriptId: t.transcriptId, phaseKey: t.phaseKey })));
  const parents = new Map();
  for (const instance of instances.values()) {
    if (instance.actorType !== "subagent") continue;
    const hierarchy = instance.name.split(" > "), leaf = hierarchy.pop(), parentName = hierarchy.join(" > ") || "main";
    const candidates = delegations.filter(d => instance.parentToolCallId ?
      d.toolCallId === instance.parentToolCallId && d.parentAgent === instance.parentAgent && (!d.name || [leaf, instance.runtimeName].includes(d.name)) :
      d.parentAgent === parentName && (d.name ? [leaf, instance.runtimeName].includes(d.name) : Boolean(instance.taskHash && d.taskHash === instance.taskHash)));
    if (!candidates.length && instance.parentToolCallId) for (const t of tools)
      if (t.id === instance.parentToolCallId && t.parentAgent === instance.parentAgent) candidates.push(t);
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
      evidence.push(d.eventKey);
      if (tasks.has(d.phaseKey)) ids.add(d.phaseKey);
      else for (const key of ownership(d.transcriptId, next).ids) ids.add(key);
    }
    const result = { ids: [...ids], evidence: [...new Set(evidence)], reason: ids.size === 1 ? "explicit-delegation" : ids.size > 1 ? "shared-across-tasks" : "source-not-recorded" };
    memo.set(id, result); return result;
  }
  function ownerFor(e) {
    const explicitId = e.assignment?.taskId;
    const explicit = explicitId && (tasks.has(explicitId) ? [tasks.get(explicitId)] : tasksByEventId.get(explicitId));
    if (explicit?.length === 1) return { ids: [explicit[0].id], evidence: [e.key || e.recordKey], reason: "explicit-task-id" };
    if (e.agentType === "main") return { ids: tasks.has(e.phaseKey) ? [e.phaseKey] : [], evidence: [e.phaseKey].filter(Boolean), reason: "main-parent-chain" };
    if (e.agentType === "advisor") return { ids: [], evidence: [], reason: "advisor-shared-without-explicit-task-id" };
    return ownership(e.transcriptId);
  }
  function fields(e) {
    const instance = instances.get(e.transcriptId), owner = ownerFor(e), taskKey = owner.ids.length === 1 ? owner.ids[0] : SHARED_TASK;
    return { instanceId: e.transcriptId, instanceName: instance?.runtimeName || e.agent, role: (e.purpose ? e.modelRole : null) || instance?.role || null,
      roleSource: e.purpose && e.modelRole ? "model_usage.role" : instance?.roleSource || "not-recorded", title: instance?.title || null,
      taskKey, taskName: tasks.get(taskKey)?.name || "共享／未归属", taskAttribution: owner.reason,
      assignmentEvidence: owner.evidence, candidateTasks: owner.ids, workPhase: e.assignment?.phase || null, roundId: e.assignment?.roundId || null };
  }
  const enrichedCalls = calls.map(c => ({ ...c, ...fields(c) }));
  const enrichedEvents = events.map(e => ({ ...e, ...fields(e) }));
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
  return { tasks, roleModels, instances, timeWindows: windows,
    reconciliation: { selected: calls.length, taskRows: tasks.reduce((n, t) => n + t.calls, 0), windowRows: windows.reduce((n, t) => n + t.calls, 0),
      shared: tasks.find(t => t.id === SHARED_TASK)?.calls || 0, rule: "Each usage record counts once per additive dimension; detail rows are not additional spend." },
    coverage: { roleKnown: calls.filter(c => c.role).length, taskKnown: calls.filter(c => c.taskKey && c.taskKey !== SHARED_TASK).length, selected: calls.length } };
}
