/** OMP 18.3 coordination protocols. Pure classification: never execute transcript code. */
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const unknown = () => ({ behavior: "mixed/unknown", statusOps: [] });

function targets(args) {
  if (own(args, "path") && own(args, "paths")) return null;
  if (typeof args.path === "string") return [args.path];
  if (Array.isArray(args.paths) && args.paths.length && args.paths.every(p => typeof p === "string")) return args.paths;
  return null;
}
function parseTarget(path, scheme) {
  // Keep the original case/ID. Do not apply URL host lowercasing to agent names.
  const match = new RegExp(`^${scheme}:\\/\\/([^/\\s?#:]*)(/[^\\s?#]*)?$`).exec(path);
  if (!match || [".", ".."].includes(match[1])) return null;
  return { id: match[1], action: match[2] || "" };
}
export function protocolToolFacts(name, args = {}) {
  if (!record(args)) return name === "wait" ? unknown() : null;
  if (name === "wait") return Object.keys(args).length ? unknown() : {
    behavior: "status-only", operation: "wait", statusOps: [{ name, op: "wait", ids: [], timeoutMs: null }],
  };
  if (!["read", "write"].includes(name)) return null;
  const paths = targets(args);
  if (!paths) {
    const supplied = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])];
    return supplied.some(p => typeof p === "string" && /^(?:proc|agent):\/\//.test(p)) ? unknown() : null;
  }
  if (name === "read") {
    if (!paths.every(p => p.startsWith("proc://"))) return null;
    const parsed = paths.map(p => parseTarget(p, "proc"));
    if (parsed.some(p => !p || !["", "/"].includes(p.action))) return unknown();
    const partial = Object.keys(args).some(k => !["path", "paths"].includes(k));
    return { behavior: "status-only", operation: "snapshot", statusOps: [{ name, op: "snapshot", ids: parsed.map(p => p.id).filter(Boolean), targets: paths, partial, timeoutMs: null }] };
  }
  if (paths.length !== 1) return paths.some(p => /^(?:proc|agent):\/\//.test(p)) ? unknown() : null;
  const target = paths[0];
  if (target.startsWith("agent://")) {
    const p = parseTarget(target, "agent");
    if (!p?.id || !["", "/"].includes(p.action)) return unknown();
    return { behavior: "message", operation: p.id === "all" ? "broadcast" : "send", target, recipient: p.id, broadcast: p.id === "all", statusOps: [] };
  }
  if (target.startsWith("proc://")) {
    const p = parseTarget(target, "proc");
    if (!p?.id) return unknown();
    const op = { "": ["service-input", "stdin"], "/": ["service-input", "stdin"], "/kill": ["cancel", "cancel"], "/mode": ["service-control", "mode"] }[p.action];
    return op ? { behavior: op[0], operation: op[1], target, statusOps: [] } : unknown();
  }
  return null;
}

/** Also repairs old v0.9.1 sidecars where a native wait had operation:null. */
export const isNativeWait = (name, operation) => name === "wait" || (["hub", "irc", "job"].includes(name) && operation === "wait");
export function toolOperation(name, args) {
  if (name === "wait") return "wait";
  return protocolToolFacts(name, args)?.operation ?? args?.op ?? args?.action ?? null;
}

const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const jobValid = job => record(job) && typeof job.id === "string" && ["running", "completed", "failed", "cancelled"].includes(job.status);
const agentValid = agent => record(agent) && typeof agent.id === "string" && typeof agent.live === "boolean";
const daemonValid = daemon => record(daemon) && typeof daemon.name === "string" && typeof daemon.state === "string";
const arrayOf = (value, predicate) => Array.isArray(value) && value.every(predicate);
// Only elapsed fields on the actual snapshot rows are volatile. Result payload
// fields with the same names (e.g. structured.data.durationMs) remain evidence.
function snapshot(value) {
  const result = { ...value };
  if (Array.isArray(value.jobs)) result.jobs = value.jobs.map(job => job.status === "running" ? omit(job, ["durationMs"]) : job);
  if (record(value.job)) result.job = value.job.status === "running" ? omit(value.job, ["durationMs"]) : value.job;
  if (Array.isArray(value.agents)) result.agents = value.agents.map(agent => omit(agent, ["ageMs"]));
  return result;
}
// Sort keys without stripping similarly named fields inside user task output.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function incompleteStatusResult(details) {
  // Inspect only known result containers, not arbitrary task result payloads.
  const queue = [details], seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const d = queue[i];
    if (!record(d) || seen.has(d)) continue;
    seen.add(d);
    if (d.isError || d.truncated || d.meta?.truncated || d.meta?.truncation || d.truncation?.truncated || d.async?.state === "running") return true;
    if (Array.isArray(d.cells)) {
      if (d.cells.some(c => !record(c) || c.status !== "complete")) return true;
      queue.push(...d.cells);
    }
    if (record(d.proc)) queue.push(d.proc);
    if (Array.isArray(d.jobs)) queue.push(...d.jobs);
    if (record(d.job)) queue.push(d.job);
  }
  return false;
}
const EMPTY_WAIT = /^(?:No running background jobs to wait for\.|Nothing to wait for\.?)$/i;
const CAP_WAIT = "Wait limit reached; background work may still be running. Read proc:// for status.";
const uncomparable = statusKind => ({ statusComparable: false, statusKind });

/** Return an evidence value to hash, never the raw output to export. */
export function coordinationStatusEvidence(tool, details, text) {
  if (tool?.name === "wait") {
    if (!record(details) || details.op !== "wait") return uncomparable("wait-unverified-result");
    if (details.interrupted || details.from || details.waited || (Array.isArray(details.inbox) && details.inbox.length)) return uncomparable("wait-message-or-interruption");
    if (!arrayOf(details.jobs, jobValid) || (details.agents !== undefined && !arrayOf(details.agents, agentValid)) || details.cancelled?.length) return uncomparable("wait-unverified-result");
    if (details.jobs.some(job => job.status !== "running")) return uncomparable("wait-completion");
    let statusKind;
    if (details.jobs.length) statusKind = "wait-running-snapshot";
    else if (EMPTY_WAIT.test(text.trim()) || (details.agents?.length && text.trim().startsWith("No running background jobs to wait for.\n"))) statusKind = "wait-empty";
    else if (text.trim() === CAP_WAIT) statusKind = "wait-safety-cap";
    else return uncomparable("wait-unverified-wake");
    return { statusComparable: true, statusKind, fingerprintValue: [statusKind, canonical(snapshot(details))] };
  }
  if (tool?.name === "read" && tool.statusOps?.some(op => op.op === "snapshot")) {
    const ops = tool.statusOps;
    if (ops.some(op => op.partial || op.targets?.length !== 1)) return uncomparable("proc-partial-or-batch-read");
    const p = details?.proc;
    if (!record(p) || p.action || p.op) return uncomparable("proc-unverified-result");
    const only = allowed => Object.keys(p).every(key => allowed.includes(key));
    const list = only(["jobs", "agents", "daemons"]) && arrayOf(p.jobs, jobValid) && arrayOf(p.agents, agentValid) && arrayOf(p.daemons, daemonValid);
    const job = only(["job", "log"]) && jobValid(p.job) && typeof p.log === "string";
    const daemon = only(["daemon", "log", "terminalRows"]) && daemonValid(p.daemon) && typeof p.log === "string";
    const agents = only(["agents"]) && p.agents?.length > 0 && arrayOf(p.agents, agentValid);
    if (!(list || job || daemon || agents)) return uncomparable("proc-unverified-result");
    return { statusComparable: true, statusKind: "proc-snapshot", fingerprintValue: ["proc-snapshot", canonical(snapshot(p))] };
  }
  // Static classification does not prove which inner results were printed.
  // Bare waits and selectively displayed results cannot establish a no-progress
  // chain, and the outer Eval duration never measures the inner native wait.
  if (tool?.name === "eval" && tool.statusOps?.some(op => ["wait", "read"].includes(op.name))) {
    return uncomparable("eval-inner-result-unverified");
  }
  return null;
}
