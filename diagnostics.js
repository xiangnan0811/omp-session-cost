import { createHash } from "node:crypto";
import { parseTime } from "./transcript.js";
import { displayName, taskFacts, observeSemanticEntry, resultFacts } from "./semantic.js";
import { noteFacts } from "./semantic.js";
import { RULE_VERSION } from "./version.js";

export const numberOrNull = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const KNOWN_TOOLS = new Set(["hub", "irc", "job", "eval", "bash", "read", "grep", "glob", "write", "edit", "task", "todo", "advise"]);

export function cleanText(value, limit = 800) {
  return String(value ?? "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END [\s\S]*?PRIVATE KEY-----|$)/g, "[REDACTED KEY]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AIza[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[REDACTED TOKEN]")
    .replace(/\b(authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[=:]\s*(?:["'][^"']*["']|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
    .replace(/(?:\b[A-Za-z]:[\\/]|~\/|(?<![\w/]):?\/)(?:[^\s<>"'|,;]+[\\/])*[^\s<>"'|,;]*/g, "[PATH]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|local|internal|cn|cloud|test)\b/gi, "[HOST]")
    .slice(0, limit);
}

function textContent(content, limit = 4096) {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  let result = "";
  for (const block of content) {
    // Never read/export thinking blocks, signatures or provider-native opaque content.
    if (block?.type === "text" && typeof block.text === "string") result += block.text.slice(0, limit - result.length) + "\n";
    if (result.length >= limit) break;
  }
  return result.slice(0, limit);
}

export function observedCost(value) {
  if (!value || typeof value !== "object") return null;
  const cost = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "total"].map(k => [k, numberOrNull(value[k])]));
  if (cost.total === null && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(v => v !== null)) {
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    cost.totalDerived = true;
  }
  return Object.values(cost).some(v => v !== null) ? cost : null;
}

export function usageFacts(message) {
  const u = message?.usage;
  const carryingUsage = Boolean(u && typeof u === "object");
  const fields = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(k => [k, numberOrNull(u?.[k])]));
  const canonical = Object.values(fields).every(v => v !== null);
  const reasoning = numberOrNull(u?.reasoningTokens ?? u?.outputDetails?.reasoningTokens ?? u?.output_tokens_details?.reasoning_tokens);
  const rawSum = canonical ? Object.values(fields).reduce((a, b) => a + b, 0) : null;
  return {
    carryingUsage, fields, canonical,
    baseTotalComparison: "input + output + cacheRead + cacheWrite; orchestration is separate",
    inputSide: canonical ? fields.input + fields.cacheRead + fields.cacheWrite : null,
    inputSemantics: canonical ? "OMP normalized input excludes cache; cache categories are disjoint" : "unknown: incomplete canonical OMP usage",
    reasoningTokens: reasoning,
    reasoningWithinOutput: reasoning === null || fields.output === null ? null : reasoning <= fields.output,
    reportedTotal: numberOrNull(u?.totalTokens),
    totalConsistent: rawSum === null || numberOrNull(u?.totalTokens) === null ? null : rawSum === u.totalTokens,
  };
}

export function stopStatus(message) {
  const stop = String(message?.stopReason || "").toLowerCase();
  if (["aborted", "abort", "cancelled", "canceled", "interrupted"].includes(stop)) return "interrupted";
  if (message?.errorMessage || stop === "error") return "error";
  if (["stop", "length", "tooluse", "tool_use", "end_turn", "max_tokens"].includes(stop)) return "success";
  return "unknown";
}

// A deliberately small literal grammar. Never evaluate code found in a transcript.
function literalObject(source) {
  if (source.length > 4096 || /[`$\\]/.test(source)) return null;
  try {
    const json = source.replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))
      .replace(/([{,]\s*)([A-Za-z]\w*)\s*:/g, '$1"$2":').replace(/,\s*([}\]])/g, "$1");
    const object = JSON.parse(json);
    if (!object || Array.isArray(object)) return null;
    const allowed = new Set(["op", "action", "ids", "timeoutMs", "peek"]);
    if (Object.keys(object).some(key => !allowed.has(key))) return null;
    if (object.ids !== undefined && (!Array.isArray(object.ids) || object.ids.some(id => typeof id !== "string"))) return null;
    if (object.timeoutMs !== undefined && numberOrNull(object.timeoutMs) === null) return null;
    return object;
  } catch { return null; }
}

function nativeStatus(name, args) {
  const op = args?.op ?? args?.action;
  if (!["hub", "irc", "job"].includes(name) || !["inbox", "list", "jobs", "wait"].includes(op)) return null;
  if (!args || typeof args !== "object" || Array.isArray(args) || args.name || args.from || args.to) return null;
  if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.some(id => typeof id !== "string"))) return null;
  if (args.timeoutMs !== undefined && numberOrNull(args.timeoutMs) === null) return null;
  if (args.peek !== undefined && typeof args.peek !== "boolean") return null;
  if (Object.keys(args).some(k => !["op", "action", "ids", "timeoutMs", "peek"].includes(k))) return null;
  return { name, op, ids: Array.isArray(args.ids) ? args.ids.slice().sort() : [], timeoutMs: numberOrNull(args.timeoutMs) };
}

export function classifyTool(name, args = {}) {
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const direct = nativeStatus(name, args);
  if (direct) return { behavior: "status-only", statusOps: [direct] };
  if (name !== "eval") return { behavior: ["read", "grep", "glob"].includes(name) ? "read" : ["edit", "write"].includes(name) ? "write" : "mixed/unknown", statusOps: [] };
  let code = typeof args.code === "string" ? args.code.trim() : "";
  if (!code || code.length > 6000) return { behavior: "mixed/unknown", statusOps: [] };
  const ops = [];
  // Known sleep calls are allowed, but no arbitrary shell, assignments or dynamic expressions.
  code = code.replace(/await\s+asyncio\.sleep\(\s*\d+(?:\.\d+)?\s*\)\s*;?/g, "")
    .replace(/await\s+Bun\.sleep\(\s*\d+\s*\)\s*;?/g, "")
    .replace(/await\s+new\s+Promise\(\s*(\w+)\s*=>\s*setTimeout\(\s*\1\s*,\s*\d+\s*\)\s*\)\s*;?/g, "");
  const pattern = /(?:display|print)\(\s*\(?\s*await\s+tool\.(hub|irc|job)\(\s*(\{[^{}]*\})\s*\)\s*\)?\s*(?:\.text)?\s*\)\s*;?/g;
  code = code.replace(pattern, (_all, tool, raw) => {
    const parsed = literalObject(raw);
    const op = parsed && nativeStatus(tool, parsed);
    if (op) { ops.push(op); return ""; }
    return "UNRECOGNIZED";
  });
  if (!code.trim() && ops.length) return { behavior: "status-only", statusOps: ops, staticRecognition: "known literal eval grammar" };
  return { behavior: "mixed/unknown", statusOps: [] };
}

function stableStatus(value) {
  if (Array.isArray(value)) return value.map(stableStatus);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter(k => !["heartbeatAge", "heartbeatAgeMs", "heartbeatAgeSeconds"].includes(k)).map(k => [k, stableStatus(value[k])]));
  }
  return value;
}

function resultEvidence(message) {
  const details = message?.details;
  const text = textContent(message?.content, 65536);
  const completeText = typeof message?.content === "string" ? message.content.length <= 65536 :
    Array.isArray(message?.content) && message.content.every(b => b?.type === "text" && typeof b.text === "string") && message.content.reduce((n, b) => n + (b.text?.length || 0), 0) <= 65536;
  const hasEmptyInbox = /(?:^|\n)\s*(?:Inbox empty\.|No messages\.?|No new messages\.?)\s*(?:\n|$)/i.test(text) ||
    (Array.isArray(details?.inbox) && details.inbox.length === 0);
  const hasMessages = (Array.isArray(details?.inbox) && details.inbox.length > 0) || Boolean(details?.from || details?.waited?.message);
  const normalized = text.replace(/\bheartbeat(?: age)?\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?|m)\b/gi, "heartbeat age=[ignored]").trim();
  return {
    complete: Boolean(completeText) && !message?.isError && !details?.isError && !details?.meta?.truncated && !details?.truncated,
    emptyInbox: hasEmptyInbox && !hasMessages,
    statusFingerprint: digest([normalized, stableStatus(details || {})]),
    excerpt: cleanText(text, 320),
    outcome: message?.isError || details?.isError ? "error" : "returned",
  };
}

export function createDiagnosticIndexer() {
  const events = [], responses = [], states = new Map(), lastByFile = new Map(), usersByFile = new Map(), pendingTools = new Map();
  const graph = new Map();
  const seenEntryDigests = new Map(), conflictedKeys = new Set();
  const transcriptKeys = new Map();
  const fileKeys = new Map();
  let order = 0;
  function accept(entry, file, identity, position = {}) {
    const fileKey = fileKeys.get(file) || `F${fileKeys.size + 1}`;
    fileKeys.set(file, fileKey);
    if (entry.type === "session") { transcriptKeys.set(file, (typeof entry.id === "string" && entry.id ? entry.id : fileKey)); return null; }

    const entryId = typeof entry.id === "string" && entry.id ? entry.id : `line-${position.line || ++order}`;
    const fileId = transcriptKeys.get(file) || fileKey;
    const baseKey = `${fileId}\u0000${entryId}`;
    const sourceDigest = position.lineDigest || digest(entry);
    const previousDigest = seenEntryDigests.get(baseKey);
    const conflict = previousDigest && previousDigest !== sourceDigest;
    if (conflict) conflictedKeys.add(baseKey);
    if (!previousDigest) seenEntryDigests.set(baseKey, sourceDigest);
    const key = conflict ? `${baseKey}\u0000variant:${sourceDigest}` : baseKey;
    const timestamp = parseTime(entry.timestamp) || parseTime(entry.message?.timestamp) || null;
    const parentKey = typeof entry.parentId === "string" ? `${fileId}\u0000${entry.parentId}` : null;
    const explicitParent = has(entry, "parentId");
    const parentState = (parentKey && !conflictedKeys.has(parentKey) ? states.get(parentKey) : !explicitParent ? lastByFile.get(file) : null) || {};
    const state = { ...parentState };
    const event = { key, fileKey, transcriptId: fileId, entryId, parentKey, parentId: entry.parentId ?? null,
      timestamp, order: order++, line: position.line ?? null, sourceDigest: position.lineDigest || null,
      agent: identity.agent, agentType: identity.agentType, ownerAgent: identity.ownerAgent, advisorKey: identity.advisorKey,
      kind: "metadata", type: typeof entry.type === "string" ? entry.type : "unknown", identityConflict: Boolean(conflict), privateExcerpt: "" };
    if (entry.type === "thinking_level_change") {
      event.kind = "thinking-setting";
      event.thinkingLevel = LEVELS.has(entry.thinkingLevel) ? entry.thinkingLevel : null;
      event.configured = LEVELS.has(entry.configured) ? entry.configured : null;
      state.thinking = { value: event.thinkingLevel, eventKey: key, timestamp, source: "historical-session-event" };
    } else if (entry.type === "model_change") {
      event.kind = "model-setting";
      event.model = typeof entry.model === "string" ? entry.model : typeof entry.modelId === "string" ? `${entry.provider || "unknown"}/${entry.modelId}` : null;
      event.modelRole = typeof entry.role === "string" ? entry.role : "default";
      if (event.modelRole === "default") state.model = { value: event.model, eventKey: key, timestamp, source: "historical-session-event" };
    } else if (entry.type === "compaction" || entry.message?.role === "compactionSummary") {
      event.kind = "compaction"; event.tokensBefore = numberOrNull(entry.tokensBefore);
      event.compactionMode = entry.preserveData?.openaiRemoteCompaction ? "recorded-provider-native" : "not-recorded";
    } else if (entry.type === "message" || entry.type === "model_usage") {
      const message = entry.type === "model_usage" ? { ...entry, role: "assistant", content: [] } : entry.message || {};
      if (message.role === "user" && message.synthetic !== true && message.attribution !== "agent") {
        const n = (usersByFile.get(file) || 0) + 1; usersByFile.set(file, n);
        event.kind = "user-task"; event.phase = `U${n}`; state.phase = key;
        event.privateExcerpt = cleanText(textContent(message.content), 320);
      } else if (message.role === "assistant") {
        event.kind = "assistant";
        event.previousAssistantKey = state.lastAssistantKey || null;
        state.lastAssistantKey = key;
        event.provider = typeof message.provider === "string" ? message.provider : "unknown";
        event.model = typeof message.model === "string" ? message.model : "unknown";
        event.usage = usageFacts(message);
        event.stopStatus = stopStatus(message);
        event.hasResponseId = typeof message.responseId === "string" && Boolean(message.responseId);
        event.hasRequestId = typeof message.requestId === "string" && Boolean(message.requestId);
        event.responseRef = event.hasResponseId ? "Response-" + digest([event.provider, event.model, message.responseId]).slice(0, 24) : null;
        event.requestRef = event.hasRequestId ? "Request-" + digest([event.provider, message.requestId]).slice(0, 24) : null;
        event.historicalThinking = state.thinking || null;
        event.historicalModel = state.model || null;
        const effort = message.requestParameters?.reasoning?.effort ?? message.requestMetadata?.reasoningEffort;
        event.requestEffort = LEVELS.has(effort) ? { value: effort, source: message.requestParameters ? "message.requestParameters.reasoning.effort" : "message.requestMetadata.reasoningEffort" } : null;
        event.phaseKey = state.phase || null;
        event.tools = [];
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!["toolcall", "tool_call", "tool-use", "tool_use"].includes(String(block?.type).toLowerCase())) continue;
          const name = block.name ?? block.toolName ?? "unknown";
          const rawArgs = block.arguments ?? block.args ?? block.input;
          const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
          const rawId = block.id ?? block.toolCallId;
          const id = typeof rawId === "string" ? rawId : null;
          const tool = { id, name: displayName(name), delegations: taskFacts(name, args, id), ...classifyTool(name, args), result: null, startedAt: null,
            severity: ["nit", "concern", "blocker"].includes(args?.severity) ? args.severity : "unspecified" };
          if (name === "advise" && typeof args.note === "string") tool.generatedNotes = noteFacts([{ ...args, advisor: args.advisor || "default" }]);
          event.tools.push(tool);
          if (id) pendingTools.set(`${fileId}\u0000${id}`, tool);
        }
        event.behavior = event.tools.length && event.tools.every(t => t.behavior === "status-only") ? "status-only" :
          event.tools.length ? "tools/mixed" : "text-or-unknown";
        event.privateExcerpt = cleanText(textContent(message.content), 320);
        responses.push(event);
      } else if (["toolResult", "tool_result"].includes(message.role)) {
        event.kind = "tool-result";
        const resultToolId = typeof message.toolCallId === "string" ? message.toolCallId : null;
        const tool = resultToolId ? pendingTools.get(`${fileId}\u0000${resultToolId}`) : null;
        event.toolCallId = resultToolId;
        event.toolName = displayName(message.toolName);
        const result = resultEvidence(message);
        event.outcome = result.outcome; event.privateExcerpt = result.excerpt;
        if (tool) {
          tool.result = { ...result, eventKey: key, timestamp, observations: resultFacts(message.details) };
          pendingTools.delete(`${fileId}\u0000${message.toolCallId}`);
        }
      } else if (message.role === "user") {
        event.kind = "agent-update";
        event.privateExcerpt = cleanText(textContent(message.content), 320);
      }
    }
    if (["custom", "custom_message"].includes(entry.type) || entry.message?.customType) {
      const customType = entry.customType ?? entry.message?.customType;
      const data = entry.data ?? entry.details ?? entry.message?.details ?? {};
      if (customType === "tool_execution_start") {
        event.kind = "tool-start";
        const tool = typeof data.toolCallId === "string" ? pendingTools.get(`${fileId}\u0000${data.toolCallId}`) : null;
        if (tool) tool.startedAt = parseTime(data.startedAt) || timestamp;
      } else if (["remote_compaction", "remote-compaction", "openai-codex:compaction", "openai-codex:remote-compaction"].includes(customType)) {
        event.kind = "compaction"; event.tokensBefore = numberOrNull(data.tokensBefore);
      } else if (["irc:incoming", "irc:message", "hub:incoming", "advisor"].includes(customType)) {
        event.kind = customType === "advisor" ? "advisor-delivery" : "incoming-message";
        event.deliveryLayer = "observed-in-primary-transcript";
        event.severity = data.severity === "blocker" || (Array.isArray(data.notes) && data.notes.some(n => n?.severity === "blocker")) ? "blocker" : null;
        event.privateExcerpt = cleanText(textContent(entry.content ?? entry.message?.content), 320);
      } else if (entry.type === "custom_message") {
        event.kind = "notification";
        event.privateExcerpt = cleanText(textContent(entry.content ?? entry.message?.content), 320);
      }
    }
    observeSemanticEntry(entry, event);
    if (event.kind === "session-init") state.init = { ...event.init, eventKey: key };
    const assignment = event.workflow;
    if (assignment && ["task-assignment", "review-round"].includes(assignment.kind)) state.assignment = assignment;
    event.assignment = state.assignment || null; event.historicalInit = state.init || null;
    event.phaseKey ??= state.phase || null;
    if (!parentKey && explicitParent) event.stateBoundary = "explicit-root";
    if (parentKey && (!states.has(parentKey) || conflictedKeys.has(parentKey))) event.historyGap = true;
    states.set(key, state); lastByFile.set(file, state);
    graph.set(key, conflictedKeys.has(parentKey) ? null : parentKey); events.push(event);
    return event;
  }
  return { accept, events, responses, graph, fileKeys };
}

export function attachCallFacts(call, event) {
  if (!event) return;
  Object.assign(call, { recordKey: event.key, fileKey: event.fileKey, sequence: event.order,
    transcriptId: event.transcriptId, historicalInit: event.historicalInit, assignment: event.assignment, purpose: event.purpose || null, modelRole: event.modelRole || null, usageFacts: event.usage, stopStatus: event.stopStatus, hasResponseId: event.hasResponseId,
    hasRequestId: event.hasRequestId, responseRef: event.responseRef, requestRef: event.requestRef, identityConflict: event.identityConflict, historicalThinking: event.historicalThinking,
    historicalModel: event.historicalModel, requestEffort: event.requestEffort, phaseKey: event.phaseKey,
    behavior: event.behavior, previousAssistantKey: event.previousAssistantKey, toolFacts: event.tools });
}

const timeOrder = (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0);
function upperBound(values, number, key = value => value) {
  let low = 0, high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (key(values[mid]) <= number) low = mid + 1; else high = mid; }
  return low;
}
export function distribution(values) {
  const source = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const quantile = p => {
    if (!source.length) return null;
    const index = (source.length - 1) * p;
    return source[Math.floor(index)] + (source[Math.ceil(index)] - source[Math.floor(index)]) * (index % 1);
  };
  return { samples: source.length, p50: quantile(0.5), p95: quantile(0.95), max: source.at(-1) ?? null };
}

export function summarizeCalls(calls, responses = []) {
  const statusCounts = { success: 0, error: 0, interrupted: 0, unknown: 0 };
  const result = { usageRecords: calls.length, nonzeroUsageRecords: 0, zeroUsageRecords: 0,
    unknownZeroUsageRecords: 0, identityConflicts: 0, uniqueResponseIds: 0, repeatedResponseIdRecords: 0, responseIdRecords: 0, requestIdRecords: 0, unmeteredResponses: responses.filter(r => !r.usage?.carryingUsage).length,
    missingPriceRecords: 0, explicitZeroPriceRecords: 0, incompleteUsageRecords: 0, reasoningRecords: 0,
    reasoningTokens: null, reasoningInconsistencies: 0, totalInconsistencies: 0, historicalThinkingRecords: 0,
    requestEffortRecords: 0, statusCounts, inputDistribution: null, priceSources: {}, historicalSettings: [],
    historicalCost: null, databaseCost: null, selectedCost: null, priceDifferences: 0 };
  const settings = new Map(), responsesSeen = new Set();
  const amounts = { historicalCost: [], databaseCost: [], selectedCost: [] };
  for (const call of calls) {
    result[call.measuredTokens > 0 ? "nonzeroUsageRecords" : call.usageFacts?.canonical ? "zeroUsageRecords" : "unknownZeroUsageRecords"]++;
    result.responseIdRecords += call.hasResponseId ? 1 : 0;
    result.identityConflicts += call.identityConflict ? 1 : 0;
    if (call.responseRef) { if (responsesSeen.has(call.responseRef)) result.repeatedResponseIdRecords++; else { result.uniqueResponseIds++; responsesSeen.add(call.responseRef); } }
    result.requestIdRecords += call.hasRequestId ? 1 : 0;
    result.statusCounts[call.stopStatus || "unknown"]++;
    result.incompleteUsageRecords += call.usageFacts?.canonical ? 0 : 1;
    const cost = call.priceStatus === "missing" ? null : call.selectedCost ?? call.cost;
    if (numberOrNull(cost?.total) === null || call.priceStatus === "missing") result.missingPriceRecords++;
    else if (cost.total === 0) result.explicitZeroPriceRecords++;
    result.priceSources[call.costSource || "unknown"] = (result.priceSources[call.costSource || "unknown"] || 0) + 1;
    for (const [field, object] of [["historicalCost", call.transcriptCost], ["databaseCost", call.statsCost], ["selectedCost", cost]]) {
      if (numberOrNull(object?.total) !== null) amounts[field].push(object.total);
    }
    if (numberOrNull(call.transcriptCost?.total) !== null && numberOrNull(call.statsCost?.total) !== null && Math.abs(call.transcriptCost.total - call.statsCost.total) > 1e-9) result.priceDifferences++;
    if (call.usageFacts?.reasoningTokens !== null && call.usageFacts?.reasoningTokens !== undefined) {
      result.reasoningRecords++; result.reasoningTokens = (result.reasoningTokens || 0) + call.usageFacts.reasoningTokens;
      if (call.usageFacts.reasoningWithinOutput === false) result.reasoningInconsistencies++;
    }
    if (call.usageFacts?.totalConsistent === false) result.totalInconsistencies++;
    if (call.historicalThinking?.value) {
      result.historicalThinkingRecords++;
      const key = `${call.historicalThinking.eventKey}\u0000${call.historicalThinking.value}`;
      const row = settings.get(key) || { ...call.historicalThinking, calls: 0, measuredTokens: 0, knownCostSubtotal: 0, pricedRecords: 0 };
      row.calls++; row.measuredTokens += call.measuredTokens; if (cost?.total != null) { row.knownCostSubtotal += cost.total; row.pricedRecords++; } settings.set(key, row);
    }
    if (call.requestEffort) result.requestEffortRecords++;
  }
  for (const field of Object.keys(amounts)) result[field] = { knownSubtotal: amounts[field].length ? amounts[field].reduce((a, b) => a + b, 0) : null, coveredRecords: amounts[field].length };
  result.historicalSettings = [...settings.values()];
  result.inputDistribution = distribution(calls.filter(c => c.measuredTokens > 0).map(c => c.usageFacts?.inputSide ?? null));
  return result;
}

export function analyzeEvents(calls, events, contextEvents = events) {
  const byAgent = new Map();
  for (const call of calls.slice().sort(timeOrder)) {
    const key = `${call.fileKey}\u0000${call.agent}`;
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(call);
  }
  const repeated = [], interruptions = [], compactions = [], phases = [];
  const barriers = new Map();
  for (const event of events) {
    if (["user-task", "incoming-message", "agent-update", "notification", "advisor-delivery", "compaction", "thinking-setting", "model-setting"].includes(event.kind) || (event.kind === "assistant" && !event.usage?.carryingUsage) || (event.type === "custom" && event.kind === "metadata")) {
      if (!barriers.has(event.fileKey)) barriers.set(event.fileKey, []);
      barriers.get(event.fileKey).push(event.order);
    }
  }
  for (const values of barriers.values()) values.sort((a, b) => a - b);
  const shape = call => {
    if (call.behavior !== "status-only" || !call.toolFacts?.length) return null;
    if (!call.toolFacts.every(t => t.result?.complete)) return null;
    if (!call.toolFacts.some(t => t.result.emptyInbox)) return null;
    return digest(call.toolFacts.map(t => [t.statusOps, t.result.statusFingerprint]));
  };
  for (const group of byAgent.values()) {
    let previous = null;
    for (const call of group) {
      const current = shape(call);
      const boundaryOrders = barriers.get(call.fileKey) || [];
      const barrierIndex = previous ? upperBound(boundaryOrders, previous.call.sequence) : boundaryOrders.length;
      const barrier = previous && boundaryOrders[barrierIndex] < call.sequence;
      if (current && previous?.shape === current && !barrier && (call.previousAssistantKey === undefined || call.previousAssistantKey === previous.call.recordKey) && previous.call.provider === call.provider && previous.call.model === call.model) {
        repeated.push({ rule: "repeated-status-v1", ruleVersion: RULE_VERSION, kind: "candidate", callKey: call.recordKey,
          precedingCallKey: previous.call.recordKey, recordSet: [call.recordKey], overlapGroup: "status-calls",
          timestamp: call.timestamp, historicalGrossCost: call.transcriptCost?.total ?? null,
          adoptedGrossCost: call.priceStatus === "missing" ? null : call.selectedCost?.total ?? call.cost?.total ?? null,
          evidence: call.toolFacts.map(t => t.result.eventKey),
          caveat: "Same known read-only status path, empty inbox and unchanged result; health checks can still be useful. Not guaranteed net savings." });
      }
      previous = current ? { call, shape: current } : null;
    }
  }
  const mainCalls = calls.filter(c => c.agentType === "main").sort(timeOrder);
  const inputsByFile = new Map(), phasesByKey = new Map(), eventsByFile = new Map();
  for (const call of calls.slice().sort(timeOrder)) {
    if (call.usageFacts?.inputSide != null && call.measuredTokens > 0) {
      if (!inputsByFile.has(call.fileKey)) inputsByFile.set(call.fileKey, []);
      inputsByFile.get(call.fileKey).push(call);
    }
    if (call.phaseKey) { if (!phasesByKey.has(call.phaseKey)) phasesByKey.set(call.phaseKey, []); phasesByKey.get(call.phaseKey).push(call); }
  }
  for (const event of events) { if (!eventsByFile.has(event.fileKey)) eventsByFile.set(event.fileKey, []); eventsByFile.get(event.fileKey).push(event.order); }
  for (const values of eventsByFile.values()) values.sort((a, b) => a - b);
  for (const event of events) {
    if (event.agentType === "main" && ["incoming-message", "advisor-delivery", "agent-update"].includes(event.kind)) {
      const next = mainCalls[upperBound(mainCalls, event.order, c => c.sequence)];
      interruptions.push({ eventKey: event.key, kind: "recorded-fact", deliveryLayer: event.deliveryLayer || "observed-in-transcript",
        severity: event.severity || null, nextCallKey: next?.recordKey || null,
        intervalMs: event.timestamp && next?.timestamp && next.timestamp >= event.timestamp ? next.timestamp - event.timestamp : null,
        measuredCallsBeforeNext: 0, adjudicationAt: null,
        caveat: "Transcript timestamp gap to the next main usage record, not proof of handling, request start, continuous inference or charges. Other side channels may be unmetered." });
    }
    if (event.kind === "compaction") {
      const group = inputsByFile.get(event.fileKey) || [];
      const index = upperBound(group, event.order, c => c.sequence);
      const before = group[index - 1];
      const after = group[index];
      const eventOrders = eventsByFile.get(event.fileKey) || [];
      compactions.push({ eventKey: event.key, timestamp: event.timestamp, compactionMode: event.compactionMode || "not-recorded", beforeCallKey: before?.recordKey || null,
        afterCallKey: after?.recordKey || null, beforeInput: before?.usageFacts.inputSide ?? null, afterInput: after?.usageFacts.inputSide ?? null,
        sameModel: before && after ? before.provider === after.provider && before.model === after.model : null,
        interveningEvents: before && after ? upperBound(eventOrders, after.sequence - 1) - upperBound(eventOrders, before.sequence) - 1 : null,
        separateUsage: null, caveat: "Observed neighboring inputs, not a controlled comparison; compaction usage, reread cost and quality impact are unknown." });
    }
  }
  const selectedKeys = new Set(events.map(e => e.key));
  for (const event of contextEvents) {
    if (event.kind !== "user-task") continue;
    const selected = phasesByKey.get(event.key) || [];
    if (!selected.length && !selectedKeys.has(event.key)) continue;
    phases.push({ eventKey: event.key, label: event.phase, agent: event.agent, source: "user-message-boundary", outsideSelectedRange: !selectedKeys.has(event.key), calls: selected.length,
      measuredTokens: selected.reduce((s, c) => s + c.measuredTokens, 0), cost: selected.reduce((s, c) => s + (c.cost?.total || 0), 0),
      recordSet: selected.map(c => c.recordKey), interpretation: "A recorded user-task segment, not an automatic judgment of engineering purpose or necessity." });
  }
  return { ruleVersion: RULE_VERSION, repeatedStatus: repeated, incomingActivity: interruptions, compactions, phases,
    toolCount: calls.reduce((n, c) => n + (c.toolFacts?.length || 0), 0),
    statusCallCount: calls.filter(c => c.behavior === "status-only").length,
    unknownToolCallCount: calls.filter(c => c.toolFacts?.some(t => t.behavior === "mixed/unknown")).length,
    limitations: ["Costs attached to calls are counted once, not once per tool.", "No model is called and no transcript code is executed.",
      "Activity intervals cannot prove advice adoption, blocker adjudication, model latency or quality.", "Unknown/dynamic eval paths are not classified as strict polling."] };
}
