import * as path from "node:path";
import { buildAggregates } from "./aggregate.js";
import { finite, slugify } from "./format.js";
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
  visitTranscript,
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
  if (entry.type !== "message") return null;
  const message = entry.message;
  if (!message || message.role !== "assistant" || !message.usage || typeof message.usage !== "object") return null;
  const provider = typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  if (provider === "unknown" && model === "unknown") return null;

  const envelopeTimestamp = parseTime(entry.timestamp);
  const timestamp = parseTime(message.timestamp) || envelopeTimestamp;
  const comparableTimestamp = envelopeTimestamp || (timestamp > 10_000_000_000 ? timestamp : 0);
  if (cutoffMs > 0 && comparableTimestamp > 0 && comparableTimestamp < cutoffMs) return { inherited: true };

  const usage = message.usage;
  const orchestration = usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : {};
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const orchestrationInput = finite(orchestration.input);
  const orchestrationOutput = finite(orchestration.output);
  const orchestrationCacheRead = finite(orchestration.cacheRead);
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
    cost: normalizeCost(usage.cost),
    costSource: "transcript",
    content: message.content,
  };
}

function dedupeCalls(calls) {
  const byKey = new Map();
  let duplicates = 0;
  const depth = file => path.resolve(file).split(path.sep).filter(Boolean).length;
  for (const call of calls) {
    const key = `${call.entryId}\u0000${call.statsTimestamp}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, call);
      continue;
    }
    duplicates += 1;
    // Forked/copied artifact trees can contain the same entry under a deeper
    // path. Keep the shallowest transcript so owner/advisor attribution stays
    // attached to the original session rather than a copied descendant.
    if (depth(call.sessionFile) < depth(existing.sessionFile)) byKey.set(key, call);
  }
  return { calls: [...byKey.values()], duplicates };
}

export async function collectSessionData(sessionFile, pi, ctx, forceRefresh = false) {
  const rootSessionFile = await resolveInteractiveRoot(sessionFile);
  if (!await exists(rootSessionFile)) throw new Error(`Session transcript is not on disk yet: ${rootSessionFile}`);
  const rootHeader = await readHeader(rootSessionFile);
  if (!rootHeader) throw new Error(`Invalid root session transcript: ${rootSessionFile}`);

  const forkAware = typeof rootHeader.parentSession === "string" && rootHeader.parentSession.length > 0;
  const cutoffMs = forkAware ? parseTime(rootHeader.timestamp) : 0;
  const candidates = [rootSessionFile, ...await collectTranscriptsRecursive(transcriptStem(rootSessionFile))]
    .map(file => path.resolve(file));

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
    await visitTranscript(file, entry => {
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
  for (const event of canonicalEvents(reviewEvents)) activityFor(advisorActivity, event.advisorKey).reviewUpdates += 1;
  for (const event of canonicalEvents(deliveryEvents)) {
    const keys = new Set();
    for (const note of event.notes) {
      const key = advisorKeyForNote(event.ownerAgent, note.advisor, advisorDescriptors);
      keys.add(key);
      const activity = activityFor(advisorActivity, key);
      activity.deliveredNotes += 1;
      activity.deliveredSeverity[severityKey(note.severity)] += 1;
    }
    for (const key of keys) activityFor(advisorActivity, key).deliveredCards += 1;
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
    delete call.advisorToolEvents;
    delete call.followupAdvisorKeys;
  }
  const pricing = await enrichCosts(deduped.calls, rootSessionFile, pi, ctx, forceRefresh);

  return {
    rootSessionFile,
    sessionId: typeof rootHeader.id === "string" && rootHeader.id ? rootHeader.id : path.basename(transcriptStem(rootSessionFile)),
    calls: deduped.calls,
    advisorActivity,
    advisorDescriptors,
    pricing,
    metadata: {
      filesScanned: valid.length,
      filesDiscovered: candidates.length,
      skippedInvalidFiles,
      forkAware,
      excludedInheritedCalls,
      duplicateCallsRemoved: deduped.duplicates,
      cutoffMs,
    },
  };
}

export async function buildReport(sessionFile, pi = {}, ctx = {}, forceRefresh = false) {
  return buildAggregates(await collectSessionData(sessionFile, pi, ctx, forceRefresh));
}
