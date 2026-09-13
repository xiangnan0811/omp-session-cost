import { verifyMarkdown, verifyJson } from "./report-contract.js";
import { buildReplay, verifyReplay, readParentGraph } from "./evidence-package.js";
import { hash } from "./semantic.js";

/** Offline validation: transport, normalized row replay, and declared parent dependencies. */
export function verifyExport(text) {
  const json = text.trimStart().startsWith("{");
  const transport = json ? verifyJson(text) : verifyMarkdown(text);
  if (!transport.ok) return { ok: false, transport: { ok: false, reason: transport.reason } };
  let data = null, replay, manifest, events;
  const issues = [];
  if (json) {
    data = JSON.parse(text); replay = data.replay; manifest = data.evidenceManifest; events = data.events || [];
    if (data.schemaVersion >= 5 && !replay) issues.push("missing-or-repeated-replay-ledger");
    if (Array.isArray(data.calls) && replay && hash(buildReplay(data)) !== hash(replay)) issues.push("full-call-records-disagree-with-replay");
  } else {
    const objects = [];
    for (const line of transport.body.split("\n")) {
      if (!line.startsWith("{")) continue;
      try { objects.push(JSON.parse(line)); } catch { issues.push("invalid-json-evidence-line"); }
    }
    const ledgers = objects.filter(o => o.recordType === "omp-cost-replay");
    if (ledgers.length > 1 || (!ledgers.length && /(?:格式|Schema:)\s*[5-9]\d*/.test(transport.body))) issues.push("missing-or-repeated-replay-ledger");
    replay = ledgers[0]; manifest = objects.find(o => o.recordType === "omp-cost-evidence-manifest");
    events = objects.filter(o => typeof o.ref === "string" && typeof o.kind === "string");
    for (const graph of objects.filter(o => o.recordType === "omp-cost-parent-graph")) {
      const parsed = readParentGraph(graph); issues.push(...parsed.errors);
      const byRef = new Map(events.map(e => [e.ref, e]));
      for (const e of parsed.events) {
        if (byRef.has(e.ref) && (byRef.get(e.ref).parentRef ?? null) !== e.parentRef) issues.push(`conflicting-parent-definition:${e.ref}`);
        else if (!byRef.has(e.ref)) events.push(e);
      }
    }
  }
  if (!replay) return { ok: issues.length === 0, transport: { ok: true }, arithmetic: { ok: null, reason: "legacy-report-without-replay" }, issues,
    caveat: "Legacy report: transport only. Source and evidence completeness have not been established." };
  const arithmetic = verifyReplay(replay);
  const definitions = new Set(events.map(e => e.ref));
  if (replay.rows.some(row => !definitions.has(row?.[0]))) issues.push("missing-call-event-definitions");
  const declaredMissing = new Set((manifest?.unresolvedParents || []).map(e => e.ref));
  const dangling = [...new Set(events.map(e => e.parentRef).filter(ref => ref && !definitions.has(ref)))];
  const undeclared = dangling.filter(ref => !declaredMissing.has(ref));
  if (!manifest) issues.push("missing-evidence-manifest");
  if (undeclared.length) issues.push("undeclared-parent-references");
  if (data?.total && replay.expected?.find(r => r.dimension === "total")) {
    const expected = replay.expected.find(r => r.dimension === "total");
    for (const key of ["calls", "measuredTokens", "costTotal"]) if (data.total[key] !== expected[key]) issues.push(`top-level-total-disagrees:${key}`);
  }
  return { ok: arithmetic.ok && issues.length === 0, transport: { ok: true, reason: transport.reason },
    arithmetic, evidence: { indexedEvents: definitions.size, declaredMissing: declaredMissing.size,
      undeclaredMissing: undeclared, parentClosureComplete: dangling.length === 0 }, issues,
    caveat: "Verifies exported normalized accounting and declared dependencies, not provider billing, upstream source completeness, advice adoption, or engineering acceptance." };
}
