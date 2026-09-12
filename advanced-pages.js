import { formatCost, formatInt, formatTokens, formatTimestamp } from "./format.js";
const ms = n => typeof n === "number" ? n.toFixed(1) : "未记录";
function breakdown(view, row) {
  const rows = [];
  for (const [label, key] of [["非缓存输入", "input"], ["缓存读取", "cacheRead"], ["缓存写入", "cacheWrite"], ["输出（含推理）", "output"]]) {
    const c = row.categories?.[key]; if (!c) continue;
    rows.push(view.detail(`${label}: ${c.tokenRecords ? formatTokens(c.tokens) : "未记录"} / ${c.pricedRecords ? formatCost(c.cost) : "未记录"} · 价格覆盖 ${c.pricedRecords}/${row.calls}`));
  }
  const d = row.measurement?.inputDistribution;
  if (d) rows.push(view.detail(`输入 P50 ${d.p50 == null ? "未记录" : formatTokens(d.p50)} / P95 ${d.p95 == null ? "未记录" : formatTokens(d.p95)} / max ${d.max == null ? "未记录" : formatTokens(d.max)} · ${d.samples} 样本`));
  return rows;
}
export function taskRows(view, width) {
  const l = view.report.ledger;
  const rows = [view.heading("任务总账 · 原始名称与明确归属"), view.detail("每条调用计入一个任务；共享／未归属不强行分摊。占比分母：选定范围。", 0), view.columnHeader(width, "任务原名")];
  for (const task of view.sorted(l?.tasks || [])) {
    const id = `task:${task.id}`; rows.push(view.item(id, task, { kind: "Task", expandable: true }));
    if (!view.tabState(view.expanded).has(id)) continue;
    rows.push(...breakdown(view, task));
    for (const a of task.actors) rows.push(view.detail(`${a.name}: ${formatInt(a.calls)} calls / ${formatTokens(a.measuredTokens)} / ${formatCost(a.costTotal)}`));
    for (const a of task.agents) rows.push(view.item(`${id}:${a.agent}`, { ...a, taskKey: task.id }, { kind: "Task agent", depth: 1, parentId: id, badge: view.badge(a.actorType) }));
  }
  rows.push(view.separator(), view.heading("角色 × 模型 · Advisor 与普通子代理分开"), view.columnHeader(width, "角色 / 模型"));
  for (const r of view.sorted(l?.roleModels || [])) {
    const id = `role:${r.id}`; rows.push(view.item(id, r, { kind: "Role model", expandable: true }));
    if (view.tabState(view.expanded).has(id)) rows.push(...breakdown(view, r));
  }
  rows.push(view.separator(), view.heading("原始运行实例"), view.columnHeader(width));
  for (const i of view.sorted(l?.instances || [])) rows.push(view.item(`instance:${i.id}`, i, { kind: "Instance", badge: view.badge(i.actorType) }));
  rows.push(view.detail(`守恒核验：选定 ${l?.reconciliation?.selected || 0} / 任务 ${l?.reconciliation?.taskRows || 0} / 时间窗口 ${l?.reconciliation?.windowRows || 0}`, 0));
  return rows;
}
export function runtimeRows(view) {
  const r = view.report.telemetry;
  const rows = [view.heading("时序 · 请求 / 等待 / Advisor / 审查 / 压缩"), view.detail(`请求时长覆盖 ${r?.coverage?.measuredRequests || 0}/${view.report.total.calls}；历史未采集数据不能补造。`, 0)];
  for (const c of r?.coverage?.collectors || []) rows.push(view.detail(`${c.agent}: ${c.reasons.measured}/${c.calls} 已测；首次观察 ${c.firstObservedAt ? formatTimestamp(c.firstObservedAt) : "未记录"}`, 0), view.detail(`缺口：${JSON.stringify(c.reasons)}`));
  for (const [name, d] of [["请求到结束", r?.requestDuration], ["请求到首个输出", r?.firstOutput], ["请求到响应头", r?.responseHeaders]])
    rows.push(view.detail(`${name} ms: P50 ${ms(d?.p50)} / P95 ${ms(d?.p95)} / max ${ms(d?.max)} (${d?.samples || 0})`, 0));
  rows.push(view.detail("时长包含网络与运行时；并行 agent 时间不能直接相加。", 0));
  for (const x of r?.waits || []) rows.push(view.heading(x.agent), view.detail(`工具时间并集 ${ms(x.unionMs)} ms`, 0), ...x.categories.map(c => view.detail(`${c.category}: ${c.count} 次 / ${ms(c.unionMs)} ms`)));
  rows.push(view.separator(), view.heading("Advisor 明确关联"), view.detail(`交付 ${r?.advisor?.delivered || 0} · 请求观察 ${r?.advisor?.requestObserved || 0} · 明确处置 ${r?.advisor?.disposed || 0} · 处置未知 ${r?.advisor?.dispositionUnknown || 0} · blocker 明确未闭合 ${r?.advisor?.blockerOpen || 0}`, 0));
  for (const x of r?.notes || []) rows.push(view.detail(`${x.advisor} → ${x.owner} / ${x.severity} / ${x.disposition}`, 0), view.detail(`ID ${x.id}；交付到请求 ${ms(x.deliveryToRequestMs)} ms`));
  rows.push(view.separator(), view.heading("审查轮次与问题账本"));
  for (const x of r?.reviews || []) rows.push(view.detail(`${x.name} / ${x.agent} / ${x.phase || "阶段未记录"} / ${formatCost(x.costTotal)}`, 0), ...x.findings.map(f => view.detail(`${f.id} ${f.name}: ${f.status}`)));
  if (!r?.reviews?.length) rows.push(view.detail("没有明确 round / finding ID；原始 reviewer 任务与用量仍保留。", 0));
  rows.push(view.separator(), view.heading("压缩与辅助调用"));
  for (const x of r?.compactions || []) rows.push(view.detail(`${x.agent} / ${x.method || "压缩"}：前 ${x.before.calls} 次，后 ${x.after.calls} 次，同模型 ${x.sameModel ?? "未记录"}`, 0));
  for (const x of r?.helperUsage || []) rows.push(view.detail(`${x.name}：${formatInt(x.calls)} calls / ${formatCost(x.costTotal)}`, 0));
  rows.push(view.detail("c 复制含完整关联与证据的中文报告。", 0)); return rows;
}
export function comparisonRows(view) {
  const c = view.report.comparison;
  if (!c) return [view.heading("命名基线对比"), view.detail("b 保存当前基线；w 查看新增记录。", 0),
    view.detail('/cost mark="等待规则调整前"', 0), view.detail('/cost since="等待规则调整前"', 0), view.detail('/cost compare="等待规则调整前"', 0), view.detail("/cost baselines 查看重启后仍保留的基线。", 0)];
  const rows = [view.heading(`基线：${c.name}`), view.detail(`保存 ${formatTimestamp(c.baselineAt)} · 当前 ${formatTimestamp(c.currentAt)}`, 0), view.detail(c.caveat, 0)];
  for (const [label, totals, roles] of [["基线记录", c.before, c.beforeRoles], ["当前范围新增", c.after, c.afterRoles]]) {
    rows.push(view.heading(`${label}: ${formatInt(totals.calls)} calls · ${formatTokens(totals.measuredTokens)} · ${formatCost(totals.costTotal)}`), ...breakdown(view, totals));
    for (const x of roles) rows.push(view.detail(`${x.name}：${formatInt(x.calls)} calls / ${formatCost(x.costTotal)}`));
  }
  rows.push(view.detail(`旧记录价格变化 ${c.changedHistoricalPrices}；缺失基线记录 ${c.missingBaselineRecords}。旧价格不覆盖。`, 0)); return rows;
}
