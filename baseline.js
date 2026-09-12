import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, displayName } from "./semantic.js";
import { measure, measuredGroups } from "./ledger.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASELINE = "默认基线";
const directory = root => `${root}.cost-state`;
const filename = (root, name) => path.join(directory(root), "baselines", `${hash(name)}.json`);
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function read(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value?.schema !== 1) throw new Error("本地状态格式不受支持，未修改原文件。");
    return value;
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export async function loadProfile(root) { return (await read(path.join(directory(root), "profile.json")))?.profile || {}; }
export async function saveProfile(root, profile) {
  const value = Object.fromEntries(["question", "protectedScopes", "annotation"].map(k => [k, displayName(profile?.[k], "")]));
  await write(path.join(directory(root), "profile.json"), { schema: 1, profile: value });
}
export function makeBaseline(report, name = DEFAULT_BASELINE) {
  if (typeof name !== "string" || !name.trim()) throw new Error("基线名称不能为空。");
  const scan = report._sourceScan || report;
  const fields = ["recordKey", "entryId", "instanceId", "agent", "agentType", "advisorKey", "role", "provider", "model", "timestamp", "stopStatus", "failed", "input", "output", "cacheRead", "cacheWrite", "orchestrationInput", "orchestrationOutput", "orchestrationCacheRead", "measuredTokens", "taskKey", "taskName", "workPhase", "promptHash", "purpose", "selectedCost", "cost", "transcriptCost", "statsCost", "priceStatus", "costSource", "usageFacts", "historicalThinking", "requestEffort"];
  return { schema: 1, name: displayName(name), version: VERSION, sessionId: report.sessionId, frozenAt: scan.snapshot?.frozenAt || report.generatedAt,
    source: "user observation boundary, not a configuration activation claim", createdAt: Date.now(),
    calls: (scan.calls || []).map(c => Object.fromEntries(fields.filter(k => c[k] !== undefined).map(k => [k, c[k]]))),
    eventKeys: (scan.events || []).map(e => e.key), runtimeKeys: (scan.runtimeEvents || []).map(f => f.id),
    configuration: report.telemetry?.configuration || null };
}
export function bookmarkFor(baseline) {
  return { name: baseline.name, sessionId: baseline.sessionId, frozenAt: baseline.frozenAt, baseline,
    callKeys: new Set(baseline.calls.map(c => c.recordKey)), eventKeys: new Set(baseline.eventKeys), runtimeKeys: new Set(baseline.runtimeKeys || []) };
}
export async function saveBaseline(root, baseline) { await write(filename(root, baseline.name), baseline); return bookmarkFor(baseline); }
export async function loadBaseline(root, name = DEFAULT_BASELINE, sessionId = null) {
  const b = await read(filename(root, name)); if (!b) return null;
  if (b.name !== name || !Array.isArray(b.calls) || !Array.isArray(b.eventKeys) || (sessionId && b.sessionId !== sessionId)) throw new Error("基线格式或所属会话不匹配。");
  return bookmarkFor(b);
}
export async function listBaselines(root) {
  let files; try { files = await fs.readdir(path.join(directory(root), "baselines")); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const f of files.filter(x => x.endsWith(".json"))) { const b = await read(path.join(directory(root), "baselines", f)); if (b?.name) rows.push({ name: b.name, frozenAt: b.frozenAt, calls: b.calls?.length || 0, sessionId: b.sessionId }); }
  return rows.sort((a, b) => b.frozenAt - a.frozenAt);
}
function subjectFilter(c, o) {
  return (!o.actorType || c.agentType === o.actorType) && (!o.agent || c.agent === o.agent) && (!o.advisorKey || c.advisorKey === o.advisorKey) &&
    (!o.provider || c.provider === o.provider) && (!o.modelId || `${c.provider}/${c.model}` === o.modelId) &&
    (o.role === undefined || c.role === o.role) && (!o.instanceId || c.instanceId === o.instanceId) &&
    (!o.taskKey || c.taskKey === o.taskKey || c.taskName === o.taskKey) && (!o.phase || c.workPhase === o.phase) && (!o.status || c.stopStatus === o.status);
}
export function compareBaseline(report, baseline) {
  if (!baseline || baseline.sessionId !== report.sessionId) throw new Error("比较基线属于其他会话。");
  const current = report._sourceScan?.calls || report.calls, currentMap = new Map(current.map(c => [c.recordKey, c]));
  const oldKeys = new Set(baseline.calls.map(c => c.recordKey));
  const before = baseline.calls.filter(c => subjectFilter(c, report._scopeOptions || report.scope || {}));
  const after = report.calls.filter(c => !oldKeys.has(c.recordKey));
  const roleKey = c => `${c.agentType} / ${c.role || "角色未记录"} / ${c.provider}/${c.model}`;
  return { name: baseline.name, baselineAt: baseline.frozenAt, currentAt: report.snapshot?.frozenAt || report.generatedAt,
    source: baseline.source, before: measure(before), after: measure(after), beforeRoles: measuredGroups(before, roleKey), afterRoles: measuredGroups(after, roleKey),
    changedHistoricalPrices: baseline.calls.filter(c => currentMap.has(c.recordKey) && JSON.stringify(c.selectedCost ?? c.cost) !== JSON.stringify(currentMap.get(c.recordKey).selectedCost ?? currentMap.get(c.recordKey).cost)).length,
    missingBaselineRecords: baseline.calls.filter(c => !currentMap.has(c.recordKey)).length,
    beforeConfiguration: baseline.configuration, afterConfiguration: report.telemetry?.configuration || null,
    beforeTaskCount: new Set(before.map(c => c.taskKey).filter(Boolean)).size, afterTaskCount: new Set(after.map(c => c.taskKey).filter(Boolean)).size,
    caveat: "基线侧保留当时历史记录与价格，新增侧使用当前选定范围。任务组成、时长及配置可能不同；不是受控实验，不自动宣称优化有效。" };
}
