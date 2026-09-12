import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { hash, displayName, titleOf, assignmentTitle, noteFacts, resultFacts, workflowFact } from "./semantic.js";
import { VERSION } from "./version.js";

export const RUNTIME_SCHEMA = 1;
export const sidecarPath = file => `${file}.cost-events.ndjson`;
export const OBSERVATION_CHANNEL = "omp-session-cost:observation";
export const HOOKS = ["session_start", "session_switch", "before_agent_start", "agent_start", "agent_end", "turn_start", "context", "before_provider_request", "after_provider_response", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "tool_approval_requested", "tool_approval_resolved", "auto_compaction_start", "session_before_compact", "session_compact", "auto_compaction_end", "auto_retry_start", "auto_retry_end", "session_shutdown"];
const number = n => typeof n === "number" && Number.isFinite(n) ? n : null;
const text = s => typeof s === "string" ? displayName(s, "") : null;

export function responseIdentity(m = {}) {
  if (m.responseId && m.provider && m.model) return { responseRef: "Response-" + hash([m.provider, m.model, m.responseId]).slice(0, 24) };
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.parse(m.timestamp);
  if (m.provider && m.model && m.usage && Number.isFinite(timestamp)) return {
    responseSignature: hash([m.provider, m.model, timestamp, ...["input", "output", "cacheRead", "cacheWrite"].map(k => number(m.usage[k]))]) };
  return {};
}
export function requestEffort(payload) {
  for (const [value, source] of [[payload?.reasoning?.effort, "payload.reasoning.effort"], [payload?.reasoning_effort, "payload.reasoning_effort"],
    [payload?.generationConfig?.thinkingConfig?.thinkingLevel, "payload.generationConfig.thinkingConfig.thinkingLevel"]])
    if (typeof value === "string") return { value: displayName(value), source, evidence: "request-hook-input; not provider execution proof" };
  return null;
}
/** Exact OMP XML blocks only. No payload or note text is persisted. */
export function wireNotes(payload) {
  const strings = [];
  function visit(v, depth = 0) {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") { if (v.includes("<advisory")) strings.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === "object") for (const k of ["content", "parts", "text"]) visit(v[k], depth + 1);
  }
  for (const k of ["input", "messages", "contents"]) visit(payload?.[k]);
  const decode = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[k]);
  const out = [];
  for (const s of strings) for (const match of s.matchAll(/<advisory\b([^>]*)>\r?\n([\s\S]*?)\r?\n<\/advisory>/g)) {
    const advisor = /\badvisor="([^"]*)"/.exec(match[1])?.[1], severity = /\bseverity="([^"]*)"/.exec(match[1])?.[1];
    out.push(...noteFacts([{ advisor: advisor ? decode(advisor) : "default", severity, note: decode(match[2]) }]));
  }
  return out;
}

/** OMP files only; hashes are observations, never labeled as loaded versions. */
export async function configurationFiles(cwd, agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent")) {
  const candidates = [];
  for (const dir of [agentDir, ...(cwd ? [path.join(cwd, ".omp")] : [])]) {
    for (const name of ["RULES.md", "config.yml"]) candidates.push(path.join(dir, name));
    try { for (const f of await fs.readdir(path.join(dir, "agents"), { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".md")) candidates.push(path.join(dir, "agents", f.name)); }
    catch (e) { if (e.code !== "ENOENT") candidates.push(path.join(dir, "agents")); }
  }
  const result = [];
  for (const file of candidates) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) { result.push({ name: file, unavailable: "not-a-small-text-file" }); continue; }
      result.push({ name: file, hash: hash(await fs.readFile(file)), bytes: stat.size, source: "disk-observation-not-effective-loading" });
    } catch (e) { if (e.code !== "ENOENT") result.push({ name: file, unavailable: e.code || "unreadable" }); }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Passive observer; never changes messages, models, tools, scheduling or context. */
export function createRuntimeObserver(pi, options = {}) {
  const runId = randomUUID(), now = options.now || Date.now, clock = options.clock || (() => performance.now());
  const append = options.append || ((file, line) => fs.appendFile(file, line, { mode: 0o600 }));
  const observeConfig = options.configurationFiles || configurationFiles;
  const states = new Map(), children = new Map(), removers = [], errors = [];
  let chain = Promise.resolve(), seq = 0, queued = 0, dropped = 0, current = null;
  function stateFor(file, ctx, sink = file) {
    if (!file) return null;
    let s = states.get(file);
    if (!s) { s = { file, sink, ctx, request: null, context: null, promptHash: null, configHash: null, compactId: null, observedHooks: {}, started: false }; states.set(file, s); }
    if (ctx) s.ctx = ctx;
    return s;
  }
  function record(s, kind, fields = {}) {
    if (!s) return null;
    if (queued >= 4096) { dropped++; return null; }
    const frame = { schema: RUNTIME_SCHEMA, pluginVersion: VERSION, runId, id: `${runId}:${++seq}`, kind,
      timestamp: now(), monotonicMs: clock(), observerSource: s.sink === s.file ? "local-extension" : "parent-task-bus", targetSessionFile: s.file, ...fields };
    queued++;
    chain = chain.then(() => append(sidecarPath(s.sink), JSON.stringify(frame) + "\n"))
      .catch(e => { if (errors.length < 20) errors.push({ kind, code: e?.code || "write-failed" }); })
      .finally(() => { queued--; });
    return frame;
  }
  function start(s, trigger) {
    if (s && !s.started) { s.started = true; s.firstObservedAt = now(); record(s, "observer-start", { hooks: HOOKS, trigger }); }
  }
  async function flush(ctx) {
    if (ctx) {
      const s = stateFor(ctx.sessionManager?.getSessionFile?.(), ctx);
      start(s, "cost-snapshot");
    }
    await chain;
    for (const s of states.values()) {
      const health = { observedHooks: { ...s.observedHooks }, firstObservedAt: s.firstObservedAt || null, dropped, errors: errors.slice(), scope: "collector-process cumulative counters; do not sum snapshots" };
      const fingerprint = hash(health);
      if (s.healthHash !== fingerprint) { record(s, "observer-status", health); s.healthHash = fingerprint; }
    }
    await chain;
  }
  async function config(s) {
    const files = await observeConfig(s.ctx?.cwd), fingerprint = hash(files);
    if (fingerprint !== s.configHash) { record(s, "configuration-files", { files, fingerprint }); s.configHash = fingerprint; }
  }
  async function handle(event, ctx, childState = null) {
    const s = childState || stateFor(ctx?.sessionManager?.getSessionFile?.(), ctx);
    if (!s) return;
    if (!childState) current = s;
    start(s, event.type);
    s.observedHooks[event.type] = (s.observedHooks[event.type] || 0) + 1;
    switch (event.type) {
      case "session_start": case "session_switch": await config(s); break;
      case "before_agent_start":
        if (event.systemPrompt) { const fingerprint = hash(event.systemPrompt); if (s.promptHash !== fingerprint) record(s, "system-prompt-observed", { fingerprint, source: "before_agent_start input; may be modified by later extensions" }); s.promptHash = fingerprint; }
        await config(s); break;
      case "agent_start": record(s, "agent-start"); break;
      case "agent_end": record(s, "agent-end", { willContinue: event.willContinue ?? null }); break;
      case "turn_start": s.turnId = `${runId}/turn/${seq + 1}`; record(s, "turn-start", { turnId: s.turnId, turnIndex: number(event.turnIndex) }); break;
      case "context": {
        const notes = (event.messages || []).flatMap(m => m?.customType === "advisor" ? noteFacts(m.details?.notes) : []);
        const fingerprint = hash(notes);
        if (fingerprint !== s.contextHash) { s.context = record(s, "context-notes", { notes }); s.contextHash = fingerprint; }
        break;
      }
      case "before_provider_request": {
        if (s.request && !s.request.closed) record(s, "request-unclosed", { requestId: s.request.id, reason: "new request before prior message end" });
        const ambiguous = Boolean(s.request && !s.request.closed);
        s.request = { id: `${runId}/request/${seq + 1}`, closed: false, first: false, ambiguous };
        record(s, "request-start", { requestId: s.request.id, turnId: s.turnId, ambiguous,
          contextId: s.context?.id || null, promptHash: s.promptHash, effort: requestEffort(event.payload), notes: wireNotes(event.payload),
          payloadModel: text(event.payload?.model), source: "before_provider_request input; later extensions can replace payload" }); break;
      }
      case "after_provider_response": record(s, "response-headers", { requestId: s.request?.id || null, status: number(event.status), providerRequestId: text(event.requestId) }); break;
      case "message_start":
        if (event.message?.role === "assistant") { s.messageStart = record(s, "assistant-message-start"); }
        break;
      case "message_update":
        if (s.request && !s.request.first && /^(?:text|thinking|toolcall)_delta$/.test(event.assistantMessageEvent?.type || "")) {
          s.request.first = true; record(s, "first-output", { requestId: s.request.id, outputKind: event.assistantMessageEvent.type });
        }
        break;
      case "message_end":
        if (event.message?.role === "assistant") {
          record(s, "request-end", { requestId: s.request?.id || null, messageStartId: s.messageStart?.id || null,
            ambiguous: s.request?.ambiguous || false, ...responseIdentity(event.message), stopReason: text(event.message.stopReason) });
          if (s.request) s.request.closed = true;
          s.messageStart = null;
        }
        break;
      case "tool_execution_start":
        record(s, "tool-start", { toolCallId: text(event.toolCallId), name: text(event.toolName), operation: text(event.args?.op ?? event.args?.action),
          timeoutMs: number(event.args?.timeoutMs), turnId: s.turnId,
          generatedNotes: event.toolName === "advise" ? noteFacts([{ ...event.args, advisor: event.args?.advisor || "default" }]) : [] }); break;
      case "tool_execution_end":
        record(s, "tool-end", { toolCallId: text(event.toolCallId), name: text(event.toolName), isError: Boolean(event.isError) });
        for (const observation of resultFacts(event.result?.details)) record(s, "workflow", { observation, toolCallId: text(event.toolCallId) });
        break;
      case "tool_approval_requested": case "tool_approval_resolved":
        record(s, event.type === "tool_approval_requested" ? "approval-start" : "approval-end", { toolCallId: text(event.toolCallId), name: text(event.toolName), approved: event.approved ?? null }); break;
      case "auto_compaction_start": case "session_before_compact":
        if (!s.compactId) { s.compactId = `${runId}/compact/${seq + 1}`; record(s, "compaction-start", { compactionId: s.compactId, reason: text(event.reason), tokensBefore: number(event.preparation?.tokensBefore) }); } break;
      case "session_compact": case "auto_compaction_end":
        record(s, "compaction-end", { compactionId: s.compactId, entryId: text(event.compactionEntry?.id), aborted: event.aborted ?? null, skipped: event.skipped ?? null }); s.compactId = null; break;
      case "auto_retry_start": case "auto_retry_end": record(s, event.type.replaceAll("_", "-"), { attempt: number(event.attempt), delayMs: number(event.delayMs), success: event.success ?? null }); break;
      case "session_shutdown": await chain; for (const remove of removers.splice(0)) { try { remove(); } catch {} } break;
    }
  }
  if (typeof pi?.on === "function") for (const type of HOOKS) {
    try { pi.on(type, async (event, ctx) => { try { await handle({ ...event, type }, ctx); } catch (e) { if (errors.length < 20) errors.push({ kind: type, code: e?.code || "observer-failed" }); } }); }
    catch { errors.push({ kind: type, code: "hook-unsupported" }); }
  }
  function listen(channel, fn) {
    if (typeof pi?.events?.on !== "function") return;
    try { const remove = pi.events.on(channel, data => { try { fn(data); } catch (e) { if (errors.length < 20) errors.push({ kind: channel, code: e?.code || "event-failed" }); } }); if (typeof remove === "function") removers.push(remove); }
    catch { errors.push({ kind: channel, code: "channel-unsupported" }); }
  }
  function ownerFor(file) {
    const candidates = [...states.values()].filter(s => s.sink === s.file && file?.startsWith(s.file.replace(/\.gz$/i, "").replace(/\.jsonl$/i, "") + path.sep));
    return candidates.sort((a, b) => b.file.length - a.file.length)[0] || null;
  }
  function registerChild(id, child) {
    if (!id) return;
    const existing = children.get(id);
    if (children.has(id) && existing?.file !== child.file) {
      if (existing && errors.length < 20) errors.push({ kind: "task:subagent:event", code: "ambiguous-child-id", name: displayName(id) });
      children.set(id, null);
    } else children.set(id, child);
  }
  listen("task:subagent:lifecycle", data => {
    const parent = ownerFor(data?.sessionFile);
    if (!parent) return;
    const child = stateFor(data.sessionFile, null, parent.sink); registerChild(data.id, child);
    record(parent, "subagent-lifecycle", { childFile: data.sessionFile, name: text(data.id), role: text(data.agent), title: text(data.description), status: text(data.status), parentToolCallId: text(data.parentToolCallId) });
  });
  listen("task:subagent:progress", data => {
    const parent = ownerFor(data?.sessionFile); if (!parent) return;
    const child = stateFor(data.sessionFile, null, parent.sink); if (data.progress?.id) registerChild(data.progress.id, child);
    const fingerprint = hash([data.agent, data.task, data.parentToolCallId, data.assignment]);
    if (child.progressHash === fingerprint) return; child.progressHash = fingerprint;
    record(parent, "subagent-lifecycle", { childFile: data.sessionFile, name: text(data.progress?.id), role: text(data.agent), title: typeof data.task === "string" ? assignmentTitle(data.task) : null, parentToolCallId: text(data.parentToolCallId), status: "progress", assignment: text(data.assignment) });
  });
  listen("task:subagent:event", data => {
    const s = children.get(data?.id); if (!s || !data.event) return;
    // Raw AgentSession events expose streaming/tool spans; do not relabel message_start as a provider request start.
    void handle(data.event, null, s).catch(e => { if (errors.length < 20) errors.push({ kind: data.event.type, code: e?.code || "child-event-failed" }); });
  });
  listen(OBSERVATION_CHANNEL, data => {
    const observation = workflowFact(data, "explicit-observation-channel");
    const s = data?.sessionFile ? states.get(data.sessionFile) : current;
    if (observation && s) record(s, "workflow", { observation });
  });
  return { handle, flush, status: () => ({ runId, queued, dropped, errors: errors.slice(), hooks: HOOKS }),
    dispose: () => { for (const remove of removers.splice(0)) { try { remove(); } catch {} } } };
}
