import path from "node:path";
import { workpoolIdentity } from "./semantic.js";

/** Join an observed nested tool dispatch to the precise recorded parent entry. */
export function runtimeDelegationTools(frames, byFile, eventsByKey) {
  const result = [];
  for (const f of frames) {
    if (!["tool-dispatch", "tool-start"].includes(f.kind) || !f.toolCallId || !f.parentEntryId) continue;
    const parent = byFile.get(path.resolve(f.sourceFile || f.targetSessionFile || ""));
    const event = parent && eventsByKey.get(`${parent.id}\u0000${f.parentEntryId}`);
    if (!event) continue;
    result.push({ id: f.toolCallId, name: f.name, eventKey: event.key, evidence: [event.key, f.id],
      parentAgent: event.agent, transcriptId: event.transcriptId, phaseKey: event.phaseKey,
      delegations: f.delegations || [], match: "runtime-dispatch-parent-entry" });
  }
  // tool_call and tool_execution_start can observe the same dispatch.
  return [...new Map(result.map(t => [JSON.stringify([t.transcriptId, t.id, t.eventKey]), t])).values()];
}

/** All observed pushes constrain pool ownership. Never derive worker IDs from a prefix. */
export function poolDelegations(instance, events, tools, parentId) {
  const pool = workpoolIdentity(instance.initialTitle || instance.title);
  if (!pool) return [];
  const matches = [];
  for (const e of events) {
    if (e.transcriptId !== parentId) continue;
    if (!(e.evalStatuses || []).some(s => s.op === "workpool" && s.action === "push" && s.pool === pool.pool && s.count > 0)) continue;
    const origin = tools.find(t => t.id === e.toolCallId && t.transcriptId === e.transcriptId);
    if (origin) matches.push({ ...origin, toolCallId: origin.id, evidence: [origin.eventKey, e.key, instance.initEventKey].filter(Boolean),
      match: "workpool-push-scope", pool: pool.pool, batch: pool.batch });
  }
  return matches;
}
