import * as path from "node:path";
import { attributeScan } from "./ledger.js";
import { sidecarPath } from "./runtime.js";
import { readRuntime, attachRuntime } from "./telemetry.js";
import { buildAggregates } from "./aggregate.js";
import { finite, slugify } from "./format.js";
import { freezeFiles, visitFrozen } from "./snapshot.js";
import { createDiagnosticIndexer, attachCallFacts, observedCost, digest, numberOrNull } from "./diagnostics.js";
import { enrichCosts } from "./pricing.js";
import {
  collectTranscriptsRecursive,
  normalizeCost,
  parseTime,
  readHeader,
  resolveInteractiveRoot,
  severityKey,
  toolCalls,
  transcriptIdentity,
  transcriptStem,
  exists,
} from "./transcript.js";

export { resolveInteractiveRoot, transcriptIdentity } from "./transcript.js";

function emptyAdvisorActivity() {
  return {
    reviewUpdates: 0,
    adviseCalls: 0,
    otherToolCalls: 0,
    deliveredNotes: 0,
    deliveredCards: 0,
    primaryFollowupCalls: 0,
    requestedSeverity: { nit: 0, concern: 0, blocker: 0, unspecified: 0 },
    deliveredSeverity: { nit: 0, concern: 0, blocker: 0, unspecified: 0 },
  };
}

function activityFor(map, key) {
  let row = map.get(key);
  if (!row) {
    row = emptyAdvisorActivity();
    map.set(key, row);
  }
  return row;
}

function customAdvisorCard(entry) {
  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const customType = entry.customType ?? message?.customType;
  if (customType !== "advisor") return null;
  const details = entry.details ?? message?.details;
  const notes = Array.isArray(details?.notes) ? details.notes.filter(note => note && typeof note === "object") : [];
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    notes,
  };
}

function advisorKeyForNote(ownerAgent, advisorName, descriptors) {
  const ownerDescriptors = [...descriptors.values()].filter(row => row.ownerAgent === ownerAgent);
  const rawName = String(advisorName ?? "").trim();
  if (!rawName || rawName === "default") {
    const defaultKey = `${ownerAgent}\u0000`;
    if (descriptors.has(defaultKey)) return defaultKey;
  }
  const slug = slugify(rawName);
  const exact = `${ownerAgent}\u0000${slug}`;
  if (descriptors.has(exact)) return exact;
  const byRawSlug = ownerDescriptors.find(row => row.advisorSlug === rawName || row.advisorSlug === slug);
  if (byRawSlug) return byRawSlug.advisorKey;
  if (ownerDescriptors.length === 1) return ownerDescriptors[0].advisorKey;
  return exact;
}

function extractCall(entry, file, rootFile, identity, cutoffMs) {
  if (entry.type !== "message" && entry.type !== "model_usage") return null;
  const message = entry.type === "model_usage" ? { ...entry, role: "assistant", content: [] } : entry.message;
  if (!message || message.role !== "assistant" || !message.usage || typeof message.usage !== "object") return null;
  const provider = typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";

  const envelopeTimestamp = parseTime(entry.timestamp);
  const timestamp = parseTime(message.timestamp) || envelopeTimestamp;
  const comparableTimestamp = envelopeTimestamp || (timestamp > 10_000_000_000 ? timestamp : 0);
  if (cutoffMs > 0 && comparableTimestamp > 0 && comparableTimestamp < cutoffMs) return { inherited: true };

  const usage = message.usage;
  const originalCost = observedCost(usage.cost);
  const orchestration = usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : {};
  const input = (numberOrNull(usage.input) ?? 0);
  const output = (numberOrNull(usage.output) ?? 0);
  const cacheRead = (numberOrNull(usage.cacheRead) ?? 0);
  const cacheWrite = (numberOrNull(usage.cacheWrite) ?? 0);
  const orchestrationInput = (numberOrNull(orchestration.input) ?? 0);
  const orchestrationOutput = (numberOrNull(orchestration.output) ?? 0);
  const orchestrationCacheRead = (numberOrNull(orchestration.cacheRead) ?? 0);
  const measuredTokens = input + output + cacheRead + cacheWrite + orchestrationInput + orchestrationOutput + orchestrationCacheRead;

  return {
    inherited: false,
    sessionFile: path.resolve(file),
    entryId: typeof entry.id === "string" && entry.id ? entry.id : `${path.basename(file)}:${timestamp}:${model}`,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    statsTimestamp: timestamp,
    timestamp: comparableTimestamp || timestamp,
    provider,
    model,
    api: typeof message.api === "string" ? message.api : "",
    failed: Boolean(message.errorMessage) || message.stopReason === "error",
    ...identity,
    input,
    output,
    cacheRead,
    cacheWrite,
    orchestrationInput,
    orchestrationOutput,
    orchestrationCacheRead,
    measuredTokens,
    premiumRequests: finite(usage.premiumRequests),
    transcriptCost: originalCost,
    selectedCost: originalCost,
    statsCost: null,
    priceStatus: originalCost?.total === null || !originalCost ? "missing" : originalCost.total === 0 ? "explicit-zero" : "recorded",
    cost: normalizeCost(originalCost),
    explicitEntryId: typeof entry.id === "string" && Boolean(entry.id),
    costSource: originalCost?.total != null ? "transcript" : "missing",
    content: message.content,
  };
}

function dedupeCalls(calls) {
  const buckets = new Map();
  let duplicates = 0;
  for (const call of calls) {
    const key = `${call.provider}\u0000${call.model}\u0000${call.entryId}\u0000${call.statsTimestamp}\u0000${call.sourceDigest || call.sessionFile}`;
    const bucket = buckets.get(key) || [];
    const index = bucket.findIndex(existing => call.explicitEntryId && existing.explicitEntryId &&
      (existing.transcriptId === call.transcriptId || existing.sessionFile === call.sessionFile));
    if (index < 0) bucket.push(call);
    else {
      duplicates++;
      if (call.sessionFile.split(path.sep).length < bucket[index].sessionFile.split(path.sep).length) bucket[index] = call;
    }
    buckets.set(key, bucket);
  }
  return { calls: [...buckets.values()].flat(), duplicates };
}

// One bounded normalized snapshot, never raw provider payloads. Repricing is always fresh.
let parsedSnapshotCache = null;
export function clearParsedSnapshotCache() { parsedSnapshotCache = null; }
export async function collectSessionData(sessionFile, pi, ctx, forceRefresh = false) {
  const rootSessionFile = await resolveInteractiveRoot(sessionFile);
  if (!await exists(rootSessionFile)) throw new Error(`Session transcript is not on disk yet: ${rootSessionFile}`);
  const rootHeader = await readHeader(rootSessionFile);
  if (!rootHeader) throw new Error(`Invalid root session transcript: ${rootSessionFile}`);

  const forkAware = typeof rootHeader.parentSession === "string" && rootHeader.parentSession.length > 0;
  const cutoffMs = forkAware ? parseTime(rootHeader.timestamp) : 0;
  const candidates = [rootSessionFile, ...await collectTranscriptsRecursive(transcriptStem(rootSessionFile))]
    .map(file => path.resolve(file));

  const sidecars = [];
  for (const file of candidates) if (await exists(sidecarPath(file))) sidecars.push(sidecarPath(file));
  const snapshot = await freezeFiles([...candidates, ...sidecars]);
  let cacheContext;
  try { cacheContext = [ctx?.model?.provider, ctx?.model?.id, pi?.getThinkingLevel?.(), ctx?.sessionManager?.getLeafId?.()]; } catch { cacheContext = null; }
  const cacheKey = digest([rootSessionFile, cacheContext, snapshot.descriptors.map(d => [d.file, d.ino, d.size, d.mtimeMs, d.ctimeMs, d.unavailable])]);
  if (!forceRefresh && parsedSnapshotCache?.key === cacheKey) {
    const source = parsedSnapshotCache.scan;
    const calls = source.calls.map(c => ({ ...c, selectedCost: c.transcriptCost, statsCost: null, cost: normalizeCost(c.transcriptCost),
      priceStatus: c.transcriptCost?.total == null ? "missing" : c.transcriptCost.total === 0 ? "explicit-zero" : "recorded",
      costSource: c.transcriptCost?.total == null ? "missing" : "transcript" }));
    const pricing = await enrichCosts(calls, rootSessionFile, pi, ctx, false);
    return { ...source, calls, pricing, metadata: { ...source.metadata, parsedSnapshotCache: "hit: unchanged metadata; prices reread", cacheCheckedAt: Date.now() } };
  }
  const indexer = createDiagnosticIndexer();
  const scanFiles = [];
  const activityTimeline = [];
  const valid = [];
  let skippedInvalidFiles = 0;
  for (const file of candidates) {
    const header = file === rootSessionFile ? rootHeader : await readHeader(file);
    if (!header) {
      skippedInvalidFiles += 1;
      continue;
    }
    valid.push({ file, header, identity: transcriptIdentity(file, rootSessionFile) });
  }

  const advisorDescriptors = new Map();
  for (const transcript of valid) {
    if (transcript.identity.agentType !== "advisor") continue;
    advisorDescriptors.set(transcript.identity.advisorKey, { ...transcript.identity, file: transcript.file });
  }

  const advisorActivity = new Map();
  const calls = [];
  const reviewEvents = [];
  const deliveryEvents = [];
  let excludedInheritedCalls = 0;

  for (const transcript of valid) {
    const { file, identity } = transcript;
    const advisorCards = new Map();
    const descriptor = snapshot.descriptors.find(row => row.file === file);
    const fileStats = await visitFrozen(descriptor, (entry, position) => {
      const diagnosticEvent = indexer.accept(entry, file, identity, position);
      if (diagnosticEvent) diagnosticEvent.inherited = cutoffMs > 0 && diagnosticEvent.timestamp > 0 && diagnosticEvent.timestamp < cutoffMs;
      const card = identity.agentType !== "advisor" ? customAdvisorCard(entry) : null;
      if (card) {
        const keys = new Set(card.notes.map(note => advisorKeyForNote(identity.agent, note.advisor, advisorDescriptors)));
        if (card.id) advisorCards.set(card.id, [...keys]);
        const eventTime = parseTime(entry.timestamp);
        if (!(cutoffMs > 0 && eventTime > 0 && eventTime < cutoffMs)) {
          deliveryEvents.push({
            eventKey: `${card.id || file}\u0000${eventTime}`,
            file,
            ownerAgent: identity.agent,
            timestamp: eventTime,
            recordKey: diagnosticEvent?.key,
            notes: card.notes,
          });
        }
      }

      if (entry.type === "message") {
        const message = entry.message;
        if (identity.agentType === "advisor" && message?.role === "user" && (message.synthetic === true || message.attribution === "agent")) {
          const eventTime = parseTime(entry.timestamp) || parseTime(message.timestamp);
          if (!(cutoffMs > 0 && eventTime > 0 && eventTime < cutoffMs)) {
            reviewEvents.push({
              eventKey: `${entry.id || file}\u0000${eventTime}`,
              file,
              advisorKey: identity.advisorKey,
              timestamp: eventTime,
              recordKey: diagnosticEvent?.key,
            });
          }
        }
      }

      const call = extractCall(entry, file, rootSessionFile, identity, cutoffMs);
      if (!call) return;
      if (call.inherited) {
        excludedInheritedCalls += 1;
        return;
      }

      attachCallFacts(call, diagnosticEvent);
      call.sourceDigest = position.lineDigest;
      if (!entry.id) call.entryId = diagnosticEvent?.entryId || call.entryId;
      if (identity.agentType === "advisor") {
        call.advisorToolEvents = toolCalls(call.content).map(tool => ({
          name: tool.name,
          severity: severityKey(tool.args?.severity),
        }));
      } else if (call.parentId && advisorCards.has(call.parentId)) {
        call.followupAdvisorKeys = [...advisorCards.get(call.parentId)];
      }

      delete call.content;
      calls.push(call);
    });
    scanFiles.push({ fileKey: indexer.fileKeys.get(file), localPath: file, sessionFormatVersion: transcript.header.version ?? null, frozenAt: descriptor.frozenAt, ...fileStats });
  }

  const canonicalEvents = events => {
    const map = new Map();
    const depth = file => path.resolve(file).split(path.sep).filter(Boolean).length;
    for (const event of events) {
      const existing = map.get(event.eventKey);
      if (!existing || depth(event.file) < depth(existing.file)) map.set(event.eventKey, event);
    }
    return [...map.values()];
  };
  for (const event of canonicalEvents(reviewEvents)) {
    activityFor(advisorActivity, event.advisorKey).reviewUpdates += 1;
    activityTimeline.push({ kind: "review", key: event.advisorKey, recordKey: event.recordKey, timestamp: event.timestamp });
  }
  for (const event of canonicalEvents(deliveryEvents)) {
    const keys = new Set();
    for (const note of event.notes) {
      const key = advisorKeyForNote(event.ownerAgent, note.advisor, advisorDescriptors);
      keys.add(key);
      const activity = activityFor(advisorActivity, key);
      activity.deliveredNotes += 1;
      activity.deliveredSeverity[severityKey(note.severity)] += 1;
      activityTimeline.push({ kind: "note", key, recordKey: event.recordKey, timestamp: event.timestamp, severity: severityKey(note.severity) });
    }
    for (const key of keys) {
      activityFor(advisorActivity, key).deliveredCards += 1;
      activityTimeline.push({ kind: "card", key, recordKey: event.recordKey, timestamp: event.timestamp });
    }
  }

  const deduped = dedupeCalls(calls);
  for (const call of deduped.calls) {
    if (call.agentType === "advisor") {
      const activity = activityFor(advisorActivity, call.advisorKey);
      for (const tool of call.advisorToolEvents ?? []) {
        if (tool.name === "advise") {
          activity.adviseCalls += 1;
          activity.requestedSeverity[severityKey(tool.severity)] += 1;
        } else {
          activity.otherToolCalls += 1;
        }
      }
    }
    for (const key of call.followupAdvisorKeys ?? []) activityFor(advisorActivity, key).primaryFollowupCalls += 1;
    // These are normalized metadata, retained for filtered reports; no note text.
    call.advisorToolEvents ??= [];
    call.followupAdvisorKeys ??= [];
  }
  const pricing = await enrichCosts(deduped.calls, rootSessionFile, pi, ctx, forceRefresh);

  let currentThinking = null;
  try { currentThinking = pi?.getThinkingLevel?.() ?? null; } catch {}
  let activeLeafId = null;
  try { if (path.resolve(sessionFile) === rootSessionFile) activeLeafId = ctx?.sessionManager?.getLeafId?.() ?? null; } catch {}
  const retained = new Set(deduped.calls.map(c => c.recordKey));
  const canonicalEventMap = new Map();
  for (const event of indexer.events) {
    if (event.kind === "assistant" && event.usage?.carryingUsage && !retained.has(event.key)) continue;
    const key = `${event.key}\u0000${event.sourceDigest}`;
    if (!canonicalEventMap.has(key)) canonicalEventMap.set(key, event);
  }
  const events = [...canonicalEventMap.values()];
  const manifest = deduped.calls.map(c => c.recordKey).sort();
  const snapshotFacts = {
    strategy: snapshot.strategy, startedAt: snapshot.startedAt, frozenAt: snapshot.frozenAt,
    files: scanFiles, recordCount: manifest.length, recordManifestDigest: digest(manifest),
    lastIncludedCallKey: deduped.calls.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).at(-1)?.recordKey || null,
    atomic: false, activeLeafId, activeBranchAvailable: Boolean(activeLeafId && events.filter(e => e.agentType === "main" && e.entryId === activeLeafId).length === 1),
    limitations: ["File prefixes are frozen sequentially, not atomically; later appends and files created after discovery are excluded.",
      "Recorded spend is limited to this artifact tree; pre-fork inherited records are excluded using the documented timestamp cutoff.",
      "In-place rewrites during an append cannot be completely ruled out without writer cooperation.",
      "Recorded spend includes abandoned paths; active-main-path mode excludes descendants whose branch association is not proven."]
  };
  const telemetry = await readRuntime(snapshot.descriptors.filter(d => sidecars.includes(d.file)), valid);
  const scan = attributeScan(attachRuntime({
    sessionTitle: events.findLast(e => e.agentType === "main" && e.kind === "title-change")?.title || rootHeader.title || null, runtimeEvents: telemetry.events, runtimeFiles: telemetry.files, runtimeCoverage: telemetry.coverage,
    rootSessionFile,
    sessionId: typeof rootHeader.id === "string" && rootHeader.id ? rootHeader.id : path.basename(transcriptStem(rootSessionFile)),
    calls: deduped.calls,
    events,
    graph: indexer.graph,
    activityTimeline,
    snapshot: snapshotFacts,
    currentContext: { source: "export-time-only-not-historical", provider: ctx?.model?.provider ?? null, model: ctx?.model?.id ?? null, thinkingLevel: currentThinking },
    advisorActivity,
    advisorDescriptors,
    pricing,
    metadata: {
      parsedSnapshotCache: "miss: source reindexed",
      filesScanned: valid.length,
      filesDiscovered: candidates.length,
      skippedInvalidFiles,
      forkAware,
      excludedInheritedCalls,
      duplicateCallsRemoved: deduped.duplicates,
      cutoffMs,
      invalidJson: scanFiles.reduce((n, f) => n + f.invalidJson, 0),
      partialTails: scanFiles.reduce((n, f) => n + f.partialTail, 0),
      oversizedLines: scanFiles.reduce((n, f) => n + f.oversizedLines, 0),
      changedFiles: scanFiles.filter(f => f.changedDuringScan).length,
      unavailableFiles: snapshot.descriptors.filter(f => f.unavailable).length + scanFiles.filter(f => f.unavailable).length,
      missingTimestamps: events.filter(e => !e.timestamp).length,
    },
  }));
  if (scan.calls.length <= 50000 && scan.events.length <= 150000 && !scan.metadata.changedFiles && !scan.metadata.unavailableFiles && !scan.runtimeCoverage.changedFiles) {
    parsedSnapshotCache = { key: cacheKey, scan };
  } else parsedSnapshotCache = null;
  return scan;
}

export async function buildReport(sessionFile, pi = {}, ctx = {}, forceRefresh = false, options = {}) {
  const report = buildAggregates(await collectSessionData(sessionFile, pi, ctx, forceRefresh));
  return Object.keys(options).length ? scopeReport(report, options) : report;
}

export function selectionFilter(selection) {
  const row = selection?.row;
  if (!row) return {};
  if (selection.kind === "Task") return { taskKey: row.id };
  if (selection.kind === "Task agent") return { taskKey: row.taskKey, agent: row.agent };
  if (selection.kind === "Role model") return { role: row.role, actorType: row.actorType, modelId: `${row.provider}/${row.model}` };
  if (selection.kind === "Instance") return { instanceId: row.id };
  if (selection.kind === "Advisor") return { advisorKey: row.id };
  if (row.modelId) return { modelId: row.modelId, agent: row.agent || row.name };
  if (row.model && row.provider) return { modelId: `${row.provider}/${row.model}`, ...(row.agent ? { agent: row.agent } : {}) };
  if (row.provider) return { provider: row.provider };
  if (row.agent) return { agent: row.agent };
  if (row.actorType) return { actorType: row.actorType };
  return {};
}

export function scopeReport(report, options = {}) {
  options = { ...(report._scopeOptions || {}), ...options };
  const original = report._sourceScan;
  if (!original) return report;
  const allCalls = original.calls;
  const allEvents = original.events || [];
  let from = options.from ? parseTime(options.from) : 0;
  let to = options.to ? parseTime(options.to) : 0;
  if ((options.from && !from) || (options.to && !to) || (from && to && from >= to)) throw new Error("Invalid time range; use ISO timestamps, from inclusive and to exclusive.");
  const eventBounds = {};
  for (const [field, lower] of [["afterEvent", true], ["beforeEvent", false]]) {
    if (!options[field]) continue;
    const matches = allEvents.filter(e => e.key === options[field] || e.entryId === options[field]);
    if (matches.length !== 1 || !matches[0].timestamp) throw new Error("Event boundary must identify exactly one timestamped event.");
    eventBounds[field] = matches[0];
    if (lower) from = matches[0].timestamp; else to = matches[0].timestamp;
  }
  if (from && to && from > to) throw new Error("Invalid event/time range.");
  let activeKeys = null;
  if (options.branch === "active-main-path") {
    const leaf = original.snapshot?.activeLeafId;
    const leafEvents = allEvents.filter(e => e.entryId === leaf && e.agentType === "main");
    if (leafEvents.length !== 1) throw new Error("Active main leaf is unavailable or ambiguous; no active branch is inferred from file order.");
    const event = leafEvents[0];
    activeKeys = new Set();
    let key = event.key;
    while (key && !activeKeys.has(key)) { activeKeys.add(key); key = original.graph.get(key); }
  }
  const matchesActor = c => (!options.actorType || c.agentType === options.actorType) &&
    (!options.agent || c.agent === options.agent) && (!options.advisorKey || c.advisorKey === options.advisorKey);
  const matchesTime = c => {
    const order = c.sequence ?? c.order;
    const lower = eventBounds.afterEvent, upper = eventBounds.beforeEvent;
    const above = lower && c.fileKey === lower.fileKey && order != null ? order > lower.order : !from || c.timestamp >= from;
    const below = upper && c.fileKey === upper.fileKey && order != null ? order < upper.order : !to || c.timestamp < to;
    return (!from && !to) || Boolean(c.timestamp && above && below);
  };
  const calls = allCalls.filter(c => matchesActor(c) && matchesTime(c) &&
    (!options.provider || c.provider === options.provider) && (!options.modelId || `${c.provider}/${c.model}` === options.modelId) &&
    (options.role === undefined || c.role === options.role) && (!options.instanceId || c.instanceId === options.instanceId) &&
    (!options.taskKey || c.taskKey === options.taskKey || c.taskName === options.taskKey) && (!options.phase || c.workPhase === options.phase) && (!options.status || c.stopStatus === options.status) &&
    (!activeKeys || (c.agentType === "main" && activeKeys.has(c.recordKey))) && !options.sinceKeys?.has(c.recordKey));
  const callKeys = new Set(calls.map(c => c.recordKey));
  const agents = new Set(calls.map(c => c.agent));
  const events = allEvents.filter(e => (options.role === undefined || e.role === options.role) && (!options.instanceId || e.instanceId === options.instanceId) &&
    (!options.taskKey || e.taskKey === options.taskKey || e.taskName === options.taskKey) && (!options.phase || e.workPhase === options.phase) && !e.inherited && matchesTime(e) && matchesActor(e) &&
    (!activeKeys || (e.agentType === "main" && activeKeys.has(e.key))) && !options.sinceEventKeys?.has(e.key) &&
    ((!options.provider && !options.modelId) || agents.has(e.agent)) &&
    (e.kind !== "assistant" || callKeys.has(e.key) || (!e.usage?.carryingUsage && (!options.provider || e.provider === options.provider) && (!options.modelId || `${e.provider}/${e.model}` === options.modelId))));
  const eventKeys = new Set(events.map(e => e.key));
  const relevantCalls = calls.map(c => ({ ...c, toolFacts: c.toolFacts?.map(t => ({ ...t,
    result: t.result && eventKeys.has(t.result.eventKey) ? t.result : null })) }));
  const activity = new Map();
  // Advisor deliveries live in the OWNER transcript; do not discard them just
  // because the selected actor is the advisor. Their own timeline is time-scoped.
  const allowedAdvisorKeys = new Set();
  for (const [key, descriptor] of original.advisorDescriptors || []) {
    if (matchesActor(descriptor) && (!activeKeys || descriptor.ownerAgent === "main")) allowedAdvisorKeys.add(key);
  }
  for (const c of calls) if (c.agentType === "advisor") allowedAdvisorKeys.add(c.advisorKey);
  if (options.provider || options.modelId) {
    for (const key of allowedAdvisorKeys) if (!calls.some(c => c.advisorKey === key)) allowedAdvisorKeys.delete(key);
  }
  for (const e of original.activityTimeline || []) {
    if (!matchesTime(e) || !allowedAdvisorKeys.has(e.key) || options.sinceEventKeys?.has(e.recordKey)) continue;
    if (activeKeys && !activeKeys.has(e.recordKey)) continue;
    const a = activityFor(activity, e.key);
    if (e.kind === "review") a.reviewUpdates++;
    if (e.kind === "note") { a.deliveredNotes++; a.deliveredSeverity[e.severity]++; }
    if (e.kind === "card") a.deliveredCards++;
  }
  for (const c of relevantCalls) {
    if (c.agentType === "advisor") {
      const a = activityFor(activity, c.advisorKey);
      for (const t of c.advisorToolEvents || []) {
        if (t.name === "advise") { a.adviseCalls++; a.requestedSeverity[t.severity]++; } else a.otherToolCalls++;
      }
    }
  }
  // Direct follow-ups measure related primary records, not advisor usage.
  for (const c of allCalls) {
    if (!matchesTime(c) || options.sinceKeys?.has(c.recordKey) || (activeKeys && !activeKeys.has(c.recordKey))) continue;
    for (const key of c.followupAdvisorKeys || []) if (allowedAdvisorKeys.has(key)) activityFor(activity, key).primaryFollowupCalls++;
  }
  // Older aggregate-only callers have no event index: preserve their recorded
  // advisor activity, explicitly without inventing time filtering.
  if (!original.activityTimeline && !from && !to && !options.sinceKeys) {
    for (const [key, value] of original.advisorActivity || []) if (allowedAdvisorKeys.has(key)) activity.set(key, value);
  }
  const relatedRuntimeIds = new Set(calls.flatMap(c => [c.runtimeStartId, c.runtimeEndId].filter(Boolean)));
  const selectedToolIds = new Set(calls.flatMap(c => (c.toolFacts || []).map(t => `${c.sessionFile}\u0000${t.id}`)));
  const runtimeSubjectRestricted = Boolean(activeKeys || options.taskKey || options.phase || options.status || options.provider || options.modelId || options.instanceId || options.role !== undefined);
  const runtimeEvents = (original.runtimeEvents || []).filter(f => matchesActor(f) && matchesTime(f) && !options.sinceRuntimeKeys?.has(f.id) &&
    (!runtimeSubjectRestricted || callKeys.has(f.callKey) || relatedRuntimeIds.has(f.id) || selectedToolIds.has(`${f.sourceFile}\u0000${f.toolCallId}`)));
  const scoped = buildAggregates({ ...original, calls: relevantCalls, events, runtimeEvents, contextRuntimeEvents: original.runtimeEvents,

    advisorActivity: activity, contextEvents: original.events, scope: { ...options, sinceKeys: undefined, sinceEventKeys: undefined, sinceRuntimeKeys: undefined, from: from || null, to: to || null,
      afterEventKey: eventBounds.afterEvent?.key || null, beforeEventKey: eventBounds.beforeEvent?.key || null,
      branch: options.branch || "recorded-spend", denominator: "selected calls", selectedCalls: calls.length,
      baselineExcluded: options.sinceKeys ? allCalls.filter(c => options.sinceKeys.has(c.recordKey)).length : 0,
      missingTimeExcluded: from || to ? allCalls.filter(c => !c.timestamp).length : 0,
      manifestDigest: digest([...callKeys].sort()) } });
  Object.defineProperty(scoped, "_sourceScan", { value: original, configurable: true });
  Object.defineProperty(scoped, "_scopeOptions", { value: options, configurable: true });
  return scoped;
}
