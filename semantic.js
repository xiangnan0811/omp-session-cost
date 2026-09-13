import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
/** Names are data, not anonymous IDs. Only remove terminal control sequences. */
export function displayName(value, fallback = "未记录") {
  if (typeof value !== "string" || !value.length) return fallback;
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function visibleText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : "";
}
/** Strip only OMP's known outer task template, never arbitrary user headings. */
export function assignmentText(value) {
  const raw = String(value ?? "").trim();
  return raw.replace(/^Complete assignment thoroughly:\r?\n\s*\r?\n/, "").trim();
}
export const assignmentHash = value => hash(assignmentText(value));
export const assignmentTitle = value => titleOf(assignmentText(value));
/** Preserve names and useful evidence; redact credential syntax, not paths or hosts. */
export function evidenceText(value) {
  return displayName(value, "").replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END [\s\S]*?PRIVATE KEY-----|$)/g, "[REDACTED KEY]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AIza[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[REDACTED TOKEN]")
    .replace(/\b(authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[=:]\s*(?:["'][^"']*["']|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}
export const titleOf = value => displayName(String(value ?? "").split(/\r?\n/).find(line => line.trim())?.trim(), "未记录任务标题");
const string = value => typeof value === "string" && value.length > 0;

export function taskFacts(name, args, toolCallId) {
  if (name !== "task" || !args || typeof args !== "object") return [];
  return (Array.isArray(args.tasks) ? args.tasks : [args]).filter(t => t && typeof t === "object").map((t, index) => ({
    toolCallId, index, name: string(t.name) ? displayName(t.name) : null,
    role: string(t.agent) ? displayName(t.agent) : null, title: string(t.task) ? assignmentTitle(t.task) : null,
    taskHash: string(t.task) ? assignmentHash(t.task) : null, rawTaskHash: string(t.task) ? hash(t.task) : null, source: "task-tool-arguments",
  }));
}

export function noteFacts(notes, occurrence, includeText = false) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && typeof n === "object").map((n, i) => ({
    id: string(n.id) ? displayName(n.id) : occurrence ? `${occurrence}/note/${i + 1}` : null,
    ...(includeText && typeof n.note === "string" ? { text: evidenceText(n.note), textSource: "advisor-delivery.note; credential-redacted; untrusted data" } : {}),
    explicitId: string(n.id), revision: string(n.revision) || typeof n.revision === "number" ? n.revision : null,
    supersedes: string(n.supersedes) ? n.supersedes : null,
    advisor: displayName(n.advisor, "default"), severity: ["nit", "concern", "blocker"].includes(n.severity) ? n.severity : "nit",
    fingerprint: hash([n.advisor || "default", n.severity || "nit", n.note || ""]),
    contentHash: hash([n.severity || "nit", n.note || ""]),
    identitySource: string(n.id) ? "recorded-id" : "delivery-occurrence; exact content is not a revision ID",
  }));
}

/** This optional observation format is explicit evidence, never a semantic guess. */
export function workflowFact(value, source = "structured-metadata") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!["task-assignment", "review-round", "finding", "advisor-decision", "acceptance", "config-loaded"].includes(value.kind)) return null;
  const out = { kind: value.kind, source };
  for (const key of ["id", "name", "taskId", "taskName", "phase", "roundId", "roundName", "findingId", "findingName", "status", "severity", "baseline", "revision", "noteId", "noteFingerprint", "actionId", "agent", "role", "requestId", "configName", "configHash", "evidenceId"])
    if (string(value[key])) out[key] = displayName(value[key]);
  for (const key of ["callIds", "findingIds", "evidenceIds", "acceptanceChecks"])
    if (Array.isArray(value[key])) out[key] = value[key].filter(string).map(v => displayName(v));
  return out;
}

export function resultFacts(details) {
  const out = [];
  const visit = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 5) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const explicit = workflowFact(v.costObservation ?? v.observation ?? v);
    if (explicit) out.push(explicit);
    if (Array.isArray(v.findings)) for (const f of v.findings) {
      if (!f || !string(f.findingId ?? f.id)) continue;
      out.push(workflowFact({ ...f, kind: "finding", findingId: f.findingId || f.id, findingName: f.name || f.title,
        roundId: f.roundId || v.roundId || v.reviewId, baseline: f.baseline || v.baseline }));
    }
    // OMP structured task results use structuredOutput.data. Do not parse free text.
    for (const key of ["results", "result", "structuredOutput", "data"]) if (v[key] !== undefined) visit(v[key], depth + 1);
  };
  visit(details);
  return out.filter(Boolean);
}

export function observeSemanticEntry(entry, event) {
  const message = entry.message || {};
  if (message.role === "assistant" && (message.errorMessage || ["error", "aborted", "interrupted"].includes(message.stopReason))) {
    const text = typeof message.errorMessage === "string" ? evidenceText(message.errorMessage) : null;
    event.failure = { message: text?.slice(0, 4000) ?? null, truncated: (text?.length || 0) > 4000,
      stopReason: typeof message.stopReason === "string" ? displayName(message.stopReason) : null,
      source: "assistant.errorMessage/stopReason; credential-redacted untrusted diagnostic data" };
  }
  if (entry.type === "session_init") {
    event.kind = "session-init";
    event.init = { role: string(entry.agent) ? displayName(entry.agent) : null, title: string(entry.task) && assignmentText(entry.task) ? assignmentTitle(entry.task) : null,
      taskHash: string(entry.task) ? assignmentHash(entry.task) : null, rawTaskHash: string(entry.task) ? hash(entry.task) : null, modelRole: string(entry.modelRole) ? displayName(entry.modelRole) : null,
      resolvedModel: string(entry.resolvedModel) ? displayName(entry.resolvedModel) : null,
      systemPromptHash: string(entry.systemPrompt) ? hash(entry.systemPrompt) : null, readOnly: typeof entry.readOnly === "boolean" ? entry.readOnly : null };
  }
  if (event.kind === "user-task") {
    event.taskTitle = string(message.title) ? displayName(message.title) : titleOf(visibleText(message.content));
    event.taskHash = assignmentHash(visibleText(message.content));
  }
  if (entry.type === "label") { event.kind = "label"; event.label = displayName(entry.label); event.targetId = entry.targetId || null; }
  if (["title_change", "title"].includes(entry.type)) { event.kind = "title-change"; event.title = displayName(entry.title); }
  if (entry.type === "model_usage") { event.purpose = displayName(entry.purpose, "unknown"); event.modelRole = string(entry.role) ? displayName(entry.role) : null; }
  const customType = entry.customType ?? message.customType;
  const data = entry.data ?? entry.details ?? message.details;
  if (customType === "advisor") event.notes = noteFacts(data?.notes, event.key, true);
  if (customType === "omp-session-cost:observation") {
    event.workflow = workflowFact(data);
    if (event.workflow) event.kind = "workflow-observation";
  }
  if (["toolResult", "tool_result"].includes(message.role)) {
    event.observations = resultFacts(message.details);
    if (message.toolName === "task") event.taskResults = taskResultFacts(message.details);
    if (message.toolName === "eval") event.evalStatuses = evalStatusFacts(message.details);
  }
  if (event.kind === "compaction") {
    event.tokensAfter = typeof entry.tokensAfter === "number" ? entry.tokensAfter : null;
    event.method = string(entry.method) ? displayName(entry.method) : null;
  }
}

/** Final task output only, not conversation or reasoning. Every text cap is explicit. */
function resultExcerpt(value, sourceTruncated = false) {
  if (typeof value !== "string") return null;
  const redacted = evidenceText(value), limit = 8192;
  // Avoid cutting a surrogate pair at the boundary.
  let end = Math.min(limit, redacted.length);
  if (end < redacted.length && /[\uD800-\uDBFF]/.test(redacted[end - 1])) end--;
  return { text: redacted.slice(0, end), originalChars: value.length, retainedChars: end,
    truncated: end < redacted.length, sourceTruncated: sourceTruncated === true,
    source: "native task final-result text; credential-redacted untrusted data; UTF-16 character counts" };
}

function structuredExcerpt(value) {
  if (value === undefined) return null;
  try { return resultExcerpt(JSON.stringify(value)); }
  catch { return { text: null, unavailable: "non-json-structured-result" }; }
}

/** OMP TaskToolDetails: no nested arbitrary result text is interpreted. */
export function taskResultFacts(details) {
  if (!details || typeof details !== "object") return [];
  return [...(Array.isArray(details.results) ? details.results.map(r => ({ ...r, resultKind: "result" })) : []), ...(Array.isArray(details.progress) ? details.progress.map(r => ({ ...r, resultKind: "progress" })) : [])]
    .filter(r => r && string(r.id) && (string(r.agent) || string(r.task) || string(r.assignment)))
    .map(r => ({ id: displayName(r.id), index: Number.isInteger(r.index) && r.index >= 0 ? r.index : null,
      role: string(r.agent) ? displayName(r.agent) : null,
      title: string(r.assignment ?? r.task) ? assignmentTitle(r.assignment ?? r.task) : null,
      taskHash: string(r.assignment ?? r.task) ? assignmentHash(r.assignment ?? r.task) : null,
      source: "task-result-allocated-id", resultKind: r.resultKind,
      status: string(r.status) ? displayName(r.status) : null,
      exitCode: Number.isSafeInteger(r.exitCode) ? r.exitCode : null,
      durationMs: Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : null,
      output: r.resultKind === "result" ? resultExcerpt(r.output, r.truncated) : null,
      stderr: r.resultKind === "result" ? resultExcerpt(r.stderr, r.truncated) : null,
      structuredOutput: r.resultKind === "result" && r.structuredOutput && typeof r.structuredOutput === "object" ? {
        status: string(r.structuredOutput.status) ? displayName(r.structuredOutput.status) : null,
        mode: string(r.structuredOutput.mode) ? displayName(r.structuredOutput.mode) : null,
        source: string(r.structuredOutput.source) ? displayName(r.structuredOutput.source) : null,
        error: resultExcerpt(r.structuredOutput.error), data: structuredExcerpt(r.structuredOutput.data),
      } : null }));
}

/** OMP EvalToolDetails.statusEvents: no evaluation or parsing of arbitrary stdout. */
export function evalStatusFacts(details) {
  if (!details || typeof details !== "object") return [];
  const statuses = Array.isArray(details.statusEvents) ? details.statusEvents :
    (Array.isArray(details.cells) ? details.cells.flatMap(c => Array.isArray(c?.statusEvents) ? c.statusEvents : []) : []);
  return statuses.filter(s => s && typeof s === "object" && ["workpool", "agent", "hub", "wait"].includes(s.op)).map(s => {
    const out = { op: s.op, source: "eval-structured-status; not task completion or item ownership" };
    for (const k of ["action", "pool", "id", "agent", "status"]) if (string(s[k])) out[k] = displayName(s[k]);
    if (Number.isSafeInteger(s.count) && s.count >= 0) out.count = s.count;
    return out;
  });
}
/** Parse only the exact workpool opening tag generated in a child assignment. */
export function workpoolIdentity(title) {
  const m = /^<workpool pool="([^"\r\n]+)" batch="([^"\r\n]+)">$/.exec(String(title || ""));
  return m ? { pool: m[1], batch: m[2], source: "workpool-assignment-tag" } : null;
}
