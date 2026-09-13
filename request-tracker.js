import { hash } from "./semantic.js";

/** Only request metadata is retained. Payloads are never mutated or persisted. */
export function requestModel(payload, model) {
  const id = typeof payload?.model === "string" ? payload.model : typeof model?.id === "string" ? model.id : null;
  return { model: id, provider: typeof model?.provider === "string" && (!payload?.model || !model.id || model.id === payload.model) ? model.provider : null };
}
export function promptEvidence(payload) {
  const parts = [];
  for (const key of ["instructions", "system", "systemInstruction"]) if (payload?.[key] != null) parts.push([key, payload[key]]);
  for (const key of ["input", "messages"]) if (Array.isArray(payload?.[key])) {
    const system = payload[key].filter(m => ["system", "developer"].includes(m?.role));
    if (system.length) parts.push([key, system]);
  }
  return { promptHash: parts.length ? hash(parts) : null,
    promptHashSource: parts.length ? "provider-hook-system-fields; not final provider payload" : "system-fields-not-observed",
    toolSchemaHash: Array.isArray(payload?.tools) ? hash(payload.tools) : null };
}
const compatible = (a, b) => (!a.model || !b.model || a.model === b.model) && (!a.provider || !b.provider || a.provider === b.provider) && (!a.scope || !b.scope || a.scope === b.scope);

/** A missing side-channel completion must not poison a different model's lane. */
export class RequestTracker {
  pending = new Map();
  overflow = false;
  omitted = 0;
  overflowLanes = [];
  retiredHeaderLanes = [];
  retired = 0;
  constructor(limit = 1024) { this.limit = limit; }
  start(id, identity = {}) {
    const overlaps = [...this.pending.values()].filter(r => compatible(r, identity));
    const newlyAmbiguous = overlaps.filter(r => !r.ambiguous).map(r => r.id);
    for (const r of overlaps) r.ambiguous = true;
    const request = { id, ...identity, ambiguous: overlaps.length > 0 || this.overflowLanes.some(l => compatible(l, identity)), first: false };
    if (this.pending.size >= this.limit) {
      const oldest = this.pending.values().next().value;
      this.pending.delete(oldest.id); this.overflow = true; this.omitted++;
      const lane = { provider: oldest.provider || null, model: oldest.model || null, scope: oldest.scope || null };
      if (!this.overflowLanes.some(l => l.provider === lane.provider && l.model === lane.model && l.scope === lane.scope)) this.overflowLanes.push(lane);
      if (this.overflowLanes.length > 32) this.overflowLanes = [{}];
      if (compatible(oldest, identity)) request.ambiguous = true;
    }
    this.pending.set(id, request);
    return { request, overlaps: newlyAmbiguous };
  }
  select(identity = {}, explicitId) {
    if (explicitId) {
      const r = this.pending.get(explicitId);
      return r && compatible(r, identity) ? { request: r, reason: "explicit-request-id" } : { request: null, reason: "request-id-not-observed" };
    }
    if (!identity.scope && this.retiredHeaderLanes.some(l => compatible(l, identity))) return { request: null, reason: "unresolved-prior-scope-headers" };
    if (this.overflowLanes.some(l => compatible(l, identity))) return { request: null, reason: "request-tracker-capacity-exceeded" };
    const matches = [...this.pending.values()].filter(r => compatible(r, identity));
    return matches.length === 1 && !matches[0].ambiguous ? { request: matches[0], reason: "unique-provider-model-lane" } :
      { request: null, reason: matches.length ? "overlapping-or-unscoped-requests" : "request-start-not-observed", candidates: matches.map(r => r.id) };
  }
  /** Native turn boundaries isolate primary message events, but cannot manufacture side-channel completion. */
  retireExceptScope(scope) {
    let count = 0;
    for (const r of this.pending.values()) {
      if (!r.scope || r.scope === scope) continue;
      this.pending.delete(r.id); count++;
      if (!r.headers) {
        const lane = { provider: r.provider || null, model: r.model || null };
        if (!this.retiredHeaderLanes.some(l => l.provider === lane.provider && l.model === lane.model)) this.retiredHeaderLanes.push(lane);
      }
    }
    if (this.retiredHeaderLanes.length > 32) this.retiredHeaderLanes = [{}];
    this.overflowLanes = this.overflowLanes.filter(l => !l.scope || l.scope === scope);
    this.retired += count;
    return count;
  }
  finish(request) { if (request) this.pending.delete(request.id); }
}
