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
export const titleOf = value => displayName(String(value ?? "").split(/\r?\n/).find(line => line.trim())?.trim(), "未记录任务标题");
const string = value => typeof value === "string" && value.length > 0;

export function taskFacts(name, args, toolCallId) {
  if (name !== "task" || !args || typeof args !== "object") return [];
  return (Array.isArray(args.tasks) ? args.tasks : [args]).filter(t => t && typeof t === "object").map((t, index) => ({
    toolCallId, index, name: string(t.name) ? displayName(t.name) : null,
    role: string(t.agent) ? displayName(t.agent) : null, title: string(t.task) ? titleOf(t.task) : null,
    taskHash: string(t.task) ? hash(t.task) : null, source: "task-tool-arguments",
  }));
}

export function noteFacts(notes, occurrence) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && typeof n === "object").map((n, i) => ({
    id: string(n.id) ? displayName(n.id) : occurrence ? `${occurrence}/note/${i + 1}` : null,
    explicitId: string(n.id), revision: string(n.revision) || typeof n.revision === "number" ? n.revision : null,
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
    const explicit = workflowFact(v.costObservation ?? v.observation);
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
  if (entry.type === "session_init") {
    event.kind = "session-init";
    event.init = { role: string(entry.agent) ? displayName(entry.agent) : null, title: titleOf(entry.task),
      taskHash: string(entry.task) ? hash(entry.task) : null, modelRole: string(entry.modelRole) ? displayName(entry.modelRole) : null,
      resolvedModel: string(entry.resolvedModel) ? displayName(entry.resolvedModel) : null,
      systemPromptHash: string(entry.systemPrompt) ? hash(entry.systemPrompt) : null, readOnly: typeof entry.readOnly === "boolean" ? entry.readOnly : null };
  }
  if (event.kind === "user-task") event.taskTitle = string(message.title) ? displayName(message.title) : titleOf(visibleText(message.content));
  if (entry.type === "label") { event.kind = "label"; event.label = displayName(entry.label); event.targetId = entry.targetId || null; }
  if (["title_change", "title"].includes(entry.type)) { event.kind = "title-change"; event.title = displayName(entry.title); }
  if (entry.type === "model_usage") { event.purpose = displayName(entry.purpose, "unknown"); event.modelRole = string(entry.role) ? displayName(entry.role) : null; }
  const customType = entry.customType ?? message.customType;
  const data = entry.data ?? entry.details ?? message.details;
  if (customType === "advisor") event.notes = noteFacts(data?.notes, event.key);
  if (customType === "omp-session-cost:observation") {
    event.workflow = workflowFact(data);
    if (event.workflow) event.kind = "workflow-observation";
  }
  if (["toolResult", "tool_result"].includes(message.role)) event.observations = resultFacts(message.details);
  if (event.kind === "compaction") {
    event.tokensAfter = typeof entry.tokensAfter === "number" ? entry.tokensAfter : null;
    event.method = string(entry.method) ? displayName(entry.method) : null;
  }
}
