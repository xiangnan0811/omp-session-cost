import path from "node:path";
import { collectionCoverage } from "./report-contract.js";
import { distribution } from "./diagnostics.js";
import { responseIdentity, RUNTIME_SCHEMA } from "./runtime.js";
import { measure, measuredGroups } from "./ledger.js";
import { visitFrozen } from "./snapshot.js";

export function intervalUnion(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0]);
  let total = 0, start = null, end = null;
  for (const [a, b] of sorted) {
    if (start === null) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return total + (start === null ? 0 : end - start);
}
const kinds = new Set(["observer-start", "observer-status", "configuration-files", "system-prompt-observed", "agent-start", "agent-end", "turn-start", "context-notes", "request-start", "request-end", "request-unclosed", "assistant-message-start", "response-headers", "first-output", "tool-start", "tool-end", "tool-dispatch", "tool-dispatch-result", "eval-status", "approval-start", "approval-end", "compaction-start", "compaction-end", "auto-retry-start", "auto-retry-end", "subagent-lifecycle", "workflow"]);
export async function readRuntime(descriptors, transcripts) {
  const identity = new Map(transcripts.map(t => [path.resolve(t.file), t.identity]));
  const events = [], files = []; let invalid = 0;
  const seen = new Set();
  for (const descriptor of descriptors) {
    const stats = await visitFrozen(descriptor, frame => {
      if (frame.schema !== RUNTIME_SCHEMA || typeof frame.id !== "string" || typeof frame.runId !== "string" || !kinds.has(frame.kind) || !Number.isFinite(frame.timestamp) || typeof frame.targetSessionFile !== "string") { invalid++; return; }
      const sourceFile = path.resolve(frame.targetSessionFile), actor = identity.get(sourceFile);
      if (!actor) { invalid++; return; }
      // A frame ID is unique in a collector process; duplicated copies are not additional observations.
      const key = `${sourceFile}\u0000${frame.id}`;
      if (seen.has(key)) return; seen.add(key);
      events.push({ ...frame, ...actor, sourceFile, targetSessionFile: frame.childFile || frame.targetSessionFile });
    });
    files.push({ name: descriptor.file, ...stats });
  }
  return { events, files, coverage: { sidecars: descriptors.length, frames: events.length, invalidFrames: invalid + files.reduce((n, f) => n + f.invalidJson, 0),
    unavailable: files.filter(f => f.unavailable).length, partialTails: files.reduce((n, f) => n + f.partialTail, 0), changedFiles: files.filter(f => f.changedDuringScan).length } };
}
const key = (f, id) => `${f.sourceFile}\u0000${f.runId}\u0000${id}`;
const elapsed = (a, b) => a && b && a.runId === b.runId && Number.isFinite(a.monotonicMs) && Number.isFinite(b.monotonicMs) && b.monotonicMs >= a.monotonicMs ? b.monotonicMs - a.monotonicMs : null;
function unique(items, keyOf) {
  const out = new Map();
  for (const x of items) { const k = keyOf(x); if (k) out.set(k, out.has(k) ? null : x); }
  return out;
}
const timeSort = (a, b) => (a.timestamp || 0) - (b.timestamp || 0);

export function attachRuntime(scan) {
  const frames = scan.runtimeEvents || [], calls = scan.calls || [];
  const starts = unique(frames.filter(f => f.kind === "request-start"), f => key(f, f.requestId));
  const byResponse = unique(calls.filter(c => c.responseRef), c => `${c.sessionFile}\u0000${c.responseRef}`);
  const bySignature = unique(calls, c => {
    const signature = responseIdentity({ provider: c.provider, model: c.model, timestamp: c.statsTimestamp, usage: c.usageFacts?.fields }).responseSignature;
    return signature ? `${c.sessionFile}\u0000${signature}` : null;
  });
  const matched = new Map();
  for (const f of frames.filter(f => f.kind === "request-end")) {
    const c = f.responseRef ? byResponse.get(`${f.sourceFile}\u0000${f.responseRef}`) : bySignature.get(`${f.sourceFile}\u0000${f.responseSignature}`);
    if (!c) continue;
    f.callKey = c.recordKey;
    if (!matched.has(c.recordKey)) matched.set(c.recordKey, []);
    matched.get(c.recordKey).push(f);
  }
  const scopes = new Map();
  for (const f of frames.filter(f => f.kind === "workflow" && ["task-assignment", "review-round"].includes(f.observation?.kind)).sort(timeSort)) {
    const k = key(f, "scope"); if (!scopes.has(k)) scopes.set(k, []); scopes.get(k).push(f);
  }
  const enriched = calls.map(c => {
    let candidates = (matched.get(c.recordKey) || []).filter(f => f.requestId && starts.get(key(f, f.requestId)) && !f.ambiguous);
    const direct = candidates.filter(f => f.observerSource === "local-extension");
    if (direct.length) candidates = direct;
    if (candidates.length !== 1) return c;
    const end = candidates[0], start = starts.get(key(end, end.requestId));
    if (start.ambiguous) return c;
    const scope = (scopes.get(key(start, "scope")) || []).findLast(f => f.monotonicMs <= start.monotonicMs);
    return { ...c, runtimeEndId: end.id, runtimeRequestId: start.requestId, runtimeStartId: start.id,
      requestEffort: c.requestEffort || start.effort || null, promptHash: start.promptHash || null,
      promptHashSource: start.promptHashSource || "legacy-observation-source-unspecified", toolSchemaHash: start.toolSchemaHash || null,
      assignment: scope?.observation || c.assignment, requestDurationMs: elapsed(start, end) };
  });
  return { ...scan, calls: enriched };
}

export function buildTelemetry(scan) {
  const calls = scan.calls || [], frames = scan.runtimeEvents || [], all = scan.contextRuntimeEvents || frames;
  const byId = new Map(all.map(f => [f.id, f])), selectedFrames = new Set(frames.map(f => f.id));
  const selectedCalls = new Map(calls.map(c => [c.recordKey, c]));
  const selectedEvents = new Set((scan.events || []).map(e => e.key));
  const related = scan.contextEvents || scan.events || [];
  const starts = unique(all.filter(f => f.kind === "request-start"), f => key(f, f.requestId));
  const outputs = unique(all.filter(f => f.kind === "first-output"), f => key(f, f.requestId));
  const headers = unique(all.filter(f => f.kind === "response-headers"), f => key(f, f.requestId));
  const requests = calls.filter(c => c.runtimeEndId).map(c => {
    const end = byId.get(c.runtimeEndId), start = byId.get(c.runtimeStartId);
    return { id: c.runtimeRequestId, callKey: c.recordKey, agent: c.agent, taskName: c.taskName, model: `${c.provider}/${c.model}`,
      startAt: start?.timestamp, endAt: end?.timestamp, durationMs: elapsed(start, end), firstOutputMs: elapsed(start, outputs.get(key(start, start.requestId))),
      responseHeadersMs: elapsed(start, headers.get(key(start, start.requestId))), evidence: [start.id, end.id, outputs.get(key(start, start.requestId))?.id, headers.get(key(start, start.requestId))?.id].filter(Boolean), startOutsideRange: !selectedFrames.has(start.id),
      source: "exact response ID or unique usage/timestamp signature, one observed request" };
  });
  const toolKeys = new Set(calls.flatMap(c => (c.toolFacts || []).map(t => `${c.sessionFile}\u0000${t.id}`)));
  const executionIds = new Set(all.filter(f => f.kind === "tool-start").map(f => key(f, f.toolCallId)));
  const executionEnds = new Set(all.filter(f => f.kind === "tool-end").map(f => key(f, f.toolCallId)));
  const spanFrames = all.filter(f => !(f.kind === "tool-dispatch" && executionIds.has(key(f, f.toolCallId))) && !(f.kind === "tool-dispatch-result" && executionEnds.has(key(f, f.toolCallId))))
    .map(f => f.kind === "tool-dispatch" ? { ...f, kind: "tool-start" } : f.kind === "tool-dispatch-result" ? { ...f, kind: "tool-end" } : f);
  const spanStarts = spanFrames.filter(f => ["tool-start", "approval-start"].includes(f.kind) && (toolKeys.has(`${f.sourceFile}\u0000${f.toolCallId}`) || selectedFrames.has(f.id)));
  const spanEnds = unique(spanFrames.filter(f => ["tool-end", "approval-end"].includes(f.kind)), f => `${key(f, f.toolCallId)}\u0000${f.kind}`);
  const uniqueStarts = unique(spanStarts, f => `${key(f, f.toolCallId)}\u0000${f.kind}`);
  let spans = [...uniqueStarts.values()].filter(Boolean).map(start => {
    const end = spanEnds.get(`${key(start, start.toolCallId)}\u0000${start.kind === "tool-start" ? "tool-end" : "approval-end"}`);
    return { id: start.id, agent: start.agent, sourceFile: start.sourceFile, runId: start.runId, toolCallId: start.toolCallId, name: start.name,
      category: start.kind === "approval-start" ? "approval-wait" : ["hub", "irc", "job"].includes(start.name) && start.operation === "wait" ? "native-wait" : start.name === "eval" ? "wrapped-tool-unobserved" : "tool-execution",
      operation: start.operation || null, startAt: start.timestamp, endAt: end?.timestamp || null, durationMs: elapsed(start, end),
      monotonicStart: start.monotonicMs, monotonicEnd: end?.monotonicMs ?? null, observerSource: start.observerSource,
      evidence: [start.id, end?.id].filter(Boolean), missingReason: !end ? "end-event-not-recorded" : elapsed(start, end) === null ? "invalid-clock-span" : null,
      startOutsideRange: !selectedFrames.has(start.id), endOutsideRange: end ? !selectedFrames.has(end.id) : null };
  });
  // Prefer direct observation over duplicate parent-bus observation for the same tool.
  const directKeys = new Set(spans.filter(s => s.observerSource === "local-extension").map(s => `${s.sourceFile}\u0000${s.toolCallId}\u0000${s.category}`));
  spans = spans.filter(s => s.observerSource !== "parent-task-bus" || !directKeys.has(`${s.sourceFile}\u0000${s.toolCallId}\u0000${s.category}`));
  const spanGroups = new Map();
  for (const s of spans) { const k = `${s.agent}\u0000${s.runId}`; if (!spanGroups.has(k)) spanGroups.set(k, []); spanGroups.get(k).push(s); }
  const waits = [...spanGroups.values()].map(rows => ({ agent: rows[0].agent, runId: rows[0].runId,
    unionMs: intervalUnion(rows.filter(s => s.durationMs !== null).map(s => [s.monotonicStart, s.monotonicEnd])),
    categories: ["native-wait", "approval-wait", "tool-execution", "wrapped-tool-unobserved"].map(category => ({ category, count: rows.filter(s => s.category === category).length,
      unionMs: intervalUnion(rows.filter(s => s.category === category && s.durationMs !== null).map(s => [s.monotonicStart, s.monotonicEnd])) })) }));

  const workflow = [
    ...related.flatMap(e => [...(e.workflow ? [e.workflow] : []), ...(e.observations || [])].map(o => ({ ...o, agent: e.agent, timestamp: e.timestamp, evidence: e.key, selected: selectedEvents.has(e.key) }))),
    ...all.filter(f => f.kind === "workflow" && f.observation).map(f => ({ ...f.observation, agent: f.agent, timestamp: f.timestamp, evidence: f.id, selected: selectedFrames.has(f.id) })),
  ].sort(timeSort);
  const delivered = related.flatMap(e => (e.notes || []).map(n => ({ ...n, owner: e.agent, deliveredAt: e.timestamp, eventKey: e.key })));
  const generations = related.flatMap(e => (e.tools || []).flatMap(t => (t.generatedNotes || []).map(n => ({ ...n, owner: e.ownerAgent || e.agent,
    generator: e.agent, generatedAt: t.startedAt || e.timestamp, timestampSource: t.startedAt ? "tool-start" : "assistant-transcript-timestamp",
    evidence: e.key, toolCallId: t.id }))));
  const generationByContent = new Map();
  for (const g of generations) {
    const k = `${g.owner}\u0000${g.contentHash}`;
    if (!generationByContent.has(k)) generationByContent.set(k, []);
    generationByContent.get(k).push(g);
  }
  const uniqueNotes = unique(delivered, n => `${n.owner}\u0000${n.fingerprint}`);
  const byExplicitNoteId = unique(delivered, n => `${n.owner}\u0000${n.id}`);
  const noteKey = n => `${n.owner}\u0000${n.eventKey}\u0000${n.id}`;
  const noteRequest = new Map(), noteContext = new Map();
  function observeNotes(f, list, target) {
    const identity = n => n.explicitId ? `id:${n.id}` : `content:${n.fingerprint}`;
    const counts = new Map(); for (const n of list) counts.set(identity(n), (counts.get(identity(n)) || 0) + 1);
    for (const n of list) {
      const delivery = n.explicitId ? byExplicitNoteId.get(`${f.agent}\u0000${n.id}`) : uniqueNotes.get(`${f.agent}\u0000${n.fingerprint}`);
      if (counts.get(identity(n)) === 1 && delivery?.deliveredAt && delivery.fingerprint === n.fingerprint && f.timestamp >= delivery.deliveredAt && !target.has(noteKey(delivery))) target.set(noteKey(delivery), f);
    }
  }
  // Context ingress is evidence in its own right, even without a provider hook.
  for (const f of all.filter(f => f.kind === "context-notes" && selectedFrames.has(f.id)).sort(timeSort)) observeNotes(f, f.notes || [], noteContext);
  for (const f of all.filter(f => f.kind === "request-start" && selectedFrames.has(f.id)).sort(timeSort)) {
    observeNotes(f, f.notes || [], noteRequest);
    const context = byId.get(f.contextId);
    if (context) observeNotes(context, context.notes || [], noteContext);
  }
  const notes = delivered.filter(n => selectedEvents.has(n.eventKey) || (noteRequest.has(noteKey(n)) && selectedFrames.has(noteRequest.get(noteKey(n)).id)) || (noteContext.has(noteKey(n)) && selectedFrames.has(noteContext.get(noteKey(n)).id))).map(n => {
    const req = noteRequest.get(noteKey(n)), context = noteContext.get(noteKey(n));
    const decisions = workflow.filter(w => w.selected && w.kind === "advisor-decision" && w.agent === n.owner && w.timestamp >= n.deliveredAt &&
      ((w.noteId === n.id && byExplicitNoteId.get(`${n.owner}\u0000${n.id}`) === n) || (uniqueNotes.get(`${n.owner}\u0000${n.fingerprint}`) && w.noteFingerprint === n.fingerprint)));
    const first = decisions[0], last = decisions.at(-1);
    const matches = (generationByContent.get(`${n.owner}\u0000${n.contentHash}`) || []).filter(g => g.generatedAt <= n.deliveredAt);
    const source = n.contentHash && matches.length === 1 && delivered.filter(d => d.owner === n.owner && d.contentHash === n.contentHash).length === 1 ? matches[0] : null;
    return { ...n, generator: source?.generator || null, generatedAt: source?.generatedAt || null,
      generationTimestampSource: source?.timestampSource || null, sourceToolCallId: source?.toolCallId || null,
      generationToDeliveryMs: source && n.deliveredAt >= source.generatedAt ? n.deliveredAt - source.generatedAt : null, contextAt: context?.timestamp || null, requestObservedAt: req?.timestamp || null, requestId: req?.requestId || null,
      decisionAt: first?.timestamp || null, disposition: last?.status || "not-recorded", actionId: last?.actionId || null,
      deliveryToRequestMs: req ? req.timestamp - n.deliveredAt : null, deliveryToDecisionMs: first ? first.timestamp - n.deliveredAt : null,
      evidence: [source?.evidence, n.eventKey, context?.id, req?.id, ...decisions.map(d => d.evidence)].filter(Boolean),
      association: n.explicitId ? "explicit note ID" : uniqueNotes.get(`${n.owner}\u0000${n.fingerprint}`) ? "unique exact contents, not cross-revision identity" : "repeated contents: occurrence association unknown" };
  });
  const roundMap = new Map();
  for (const w of workflow) {
    if (!w.roundId || !["review-round", "finding", "acceptance"].includes(w.kind)) continue;
    const id = `${w.agent}\u0000${w.roundId}`; if (!roundMap.has(id)) roundMap.set(id, []); roundMap.get(id).push(w);
  }
  const reviews = [...roundMap].flatMap(([id, records]) => {
    const relatedCalls = calls.filter(c => c.agent === records[0].agent && (c.roundId === records[0].roundId || records.some(r => r.callIds?.some(k => [c.recordKey, c.entryId, c.responseRef].includes(k)))));
    if (!records.some(r => r.selected) && !relatedCalls.length) return [];
    const selected = records.filter(r => r.selected), last = selected.at(-1) || records[0];
    const findings = new Map();
    // Unselected later states do not leak into a historical filtered report.
    for (const f of selected.filter(r => r.kind === "finding" && r.findingId)) {
      if (!findings.has(f.findingId)) findings.set(f.findingId, []); findings.get(f.findingId).push(f);
    }
    return [{ id, name: last.roundName || last.roundId, agent: last.agent, roundId: last.roundId, phase: last.phase || null, baseline: last.baseline || null,
      ...measure(relatedCalls), costAssociation: relatedCalls.length ? "explicit round/call linkage" : "no linked metered calls",
      findings: [...findings].map(([findingId, history]) => ({ id: findingId, name: history.at(-1).findingName || findingId, status: history.at(-1).status || "not-recorded", history })),
      acceptance: selected.filter(r => r.kind === "acceptance"), evidence: selected.map(r => r.evidence) }];
  });
  const compactions = (scan.events || []).filter(e => e.kind === "compaction").map(e => {
    const actorCalls = calls.filter(c => c.fileKey === e.fileKey).sort((a, b) => a.sequence - b.sequence);
    const bounds = related.filter(x => x.kind === "compaction" && x.fileKey === e.fileKey).sort((a, b) => a.order - b.order);
    const beforeBound = bounds.findLast(x => x.order < e.order), afterBound = bounds.find(x => x.order > e.order);
    const before = actorCalls.filter(c => !c.purpose && c.sequence < e.order && (!beforeBound || c.sequence > beforeBound.order)).slice(-5);
    const after = actorCalls.filter(c => !c.purpose && c.sequence > e.order && (!afterBound || c.sequence < afterBound.order)).slice(0, 5);
    const ends = all.filter(f => f.kind === "compaction-end" && f.entryId === e.entryId && f.agent === e.agent);
    const end = ends.length === 1 ? ends[0] : null;
    const start = end?.compactionId ? all.find(f => f.kind === "compaction-start" && f.runId === end.runId && f.compactionId === end.compactionId) : null;
    const own = start && end ? actorCalls.filter(c => /^(?:compact|compaction)(?:$|[:/_-])/.test(c.purpose || "") && c.timestamp >= start.timestamp && c.timestamp <= end.timestamp) : [];
    return { eventKey: e.key, agent: e.agent, method: e.method || e.compactionMode || null, taskName: e.taskName, phase: e.workPhase,
      before: measure(before), after: measure(after), sameModel: before.length && after.length ? `${before.at(-1).provider}/${before.at(-1).model}` === `${after[0].provider}/${after[0].model}` : null,
      ownUsage: own.length ? measure(own) : null, ownUsageStatus: own.length ? "explicit-helper-records-in-observed-interval" : "not-recorded; not zero and not proof of missing billing", durationMs: elapsed(start, end), evidence: [e.key, start?.id, end?.id, ...own.map(c => c.recordKey)].filter(Boolean),
      window: "up to five non-helper calls each side, bounded by selection and adjacent compactions", netSavings: null, qualityImpact: "not-measured" };
  });
  const linkedRequests = new Set(calls.filter(c => c.runtimeRequestId).map(c => c.runtimeRequestId));
  const requestObservations = frames.filter(f => f.kind === "request-start").map(f => ({
    id: f.id, requestId: f.requestId, collectorAgent: f.agent, provider: f.provider || null, model: f.model || f.payloadModel || null,
    status: linkedRequests.has(f.requestId) ? "usage-linked" : "unlinked-request-observation", ambiguous: Boolean(f.ambiguous),
    responseHeadersObserved: Boolean(headers.get(key(f, f.requestId))), timestamp: f.timestamp, evidence: [f.id],
    owner: linkedRequests.has(f.requestId) ? f.agent : null,
    caveat: "Collector session is not proof of request owner; auxiliary requests can share the primary hooks. Response headers are not completion." }));
  const configurationDefinitions = new Map();
  const configEvents = frames.filter(f => ["configuration-files", "system-prompt-observed"].includes(f.kind)).map(f => {
    if (f.kind !== "configuration-files" || !f.fingerprint || !Array.isArray(f.files)) return f;
    const k = f.fingerprint;
    if (!configurationDefinitions.has(k)) configurationDefinitions.set(k, { fingerprint: k, files: f.files, source: "disk-observation-not-effective-loading" });
    const { files, ...observation } = f;
    return { ...observation, definitionRef: k };
  });
  const cards = [...new Map(notes.map(n => [n.eventKey, { eventKey: n.eventKey, owner: n.owner, deliveredAt: n.deliveredAt }])).values()].map(card => {
    const items = notes.filter(n => n.eventKey === card.eventKey);
    return { ...card, noteIds: items.map(n => n.id), noteCount: items.length,
      oldestNoteAgeMs: items.some(n => n.generationToDeliveryMs !== null) ? Math.max(...items.map(n => n.generationToDeliveryMs ?? 0)) : null,
      deliveryToRequestMs: items.find(n => n.deliveryToRequestMs !== null)?.deliveryToRequestMs ?? null };
  });
  const explicitCorrections = notes.filter(n => n.supersedes).map(n => ({ noteId: n.id, supersedes: n.supersedes,
    targetRecorded: notes.some(old => old.owner === n.owner && old.id === n.supersedes), evidence: n.evidence, source: "explicit-supersedes-metadata" }));
  const referenced = new Set([...requests, ...spans, ...notes, ...reviews, ...compactions].flatMap(x => x.evidence || []));
  const evidence = all.filter(f => selectedFrames.has(f.id) || referenced.has(f.id) || (["observer-start", "observer-status"].includes(f.kind) && calls.some(c => c.sessionFile === f.sourceFile))).map(f => ({ ...f, outsideSelectedRange: !selectedFrames.has(f.id) }));
  return { coverage: { ...scan.runtimeCoverage, collectors: collectionCoverage(calls, all, requests), selectedFrames: frames.length, selectedCalls: calls.length, measuredRequests: requests.filter(r => r.durationMs !== null).length,
      unmatchedEnds: frames.filter(f => f.kind === "request-end" && !f.callKey).length, source: all.length ? "passive-runtime-plus-transcript" : "transcript-only; runtime not collected historically" },
    retryEvents: frames.filter(f => ["auto-retry-start", "auto-retry-end"].includes(f.kind)),
    requestObservations, requests, requestDuration: distribution(requests.map(r => r.durationMs)), firstOutput: distribution(requests.map(r => r.firstOutputMs)),
    responseHeaders: distribution(requests.map(r => r.responseHeadersMs)), spans, waits, notes,
    advisor: { cards, deliveredCards: cards.length, explicitCorrections, cardDeliveryToRequest: distribution(cards.map(c => c.deliveryToRequestMs)), generationLinked: notes.filter(n => n.generatedAt !== null).length, generationToDelivery: distribution(notes.map(n => n.generationToDeliveryMs)), delivered: notes.length, contextObserved: notes.filter(n => n.contextAt !== null).length, requestObserved: notes.filter(n => n.requestObservedAt).length, disposed: notes.filter(n => n.decisionAt).length,
      dispositionUnknown: notes.filter(n => !n.decisionAt).length, open: notes.filter(n => ["open", "pending", "in-progress", "accepted"].includes(n.disposition)).length, blockers: notes.filter(n => n.severity === "blocker").length, blockerAwaitingDisposition: notes.filter(n => n.severity === "blocker" && !n.decisionAt).length,
      blockerOpen: notes.filter(n => n.severity === "blocker" && ["open", "pending", "in-progress", "accepted"].includes(n.disposition)).length,
      deliveryToRequest: distribution(notes.map(n => n.deliveryToRequestMs)), deliveryToDecision: distribution(notes.map(n => n.deliveryToDecisionMs)) },
    reviews, compactions, auxiliaryCoverage: { observedCompactions: compactions.length, withUsage: compactions.filter(c => c.ownUsage !== null).length, usageUnknown: compactions.filter(c => c.ownUsage === null).length, meaning: "Unknown helper usage is not zero; ordinary response coverage does not establish auxiliary billing completeness." }, helperUsage: measuredGroups(calls.filter(c => c.purpose), c => `${c.agent} / ${c.purpose} / ${c.provider}/${c.model}`),
    configuration: { definitions: [...configurationDefinitions.values()], events: configEvents,
      explicitLoads: workflow.filter(w => w.selected && w.kind === "config-loaded"),
      requestGroups: measuredGroups(calls, c => c.promptHash || "运行时提示版本未记录") },
    evidence,
    limitations: ["Provider hooks expose their input, not changes applied by subsequent extensions or proof of provider execution.",
      "Request/first-output timing includes transport, provider and runtime; pure reasoning and provider queue time are not measured.",
      "Per-agent/per-process interval unions are not end-to-end task latency; parallel agents and categories must not be summed.",
      "Advice dispositions and review findings require explicit IDs/states. No inferred adoption, adjudication, quality score or net savings."] };
}
