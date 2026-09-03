import {
  clipAnsi,
  fitAnsi,
  formatCost,
  formatInt,
  formatMetric,
  formatPercent,
  formatTokens,
  metricTitle,
  metricValue,
  percent,
  textWidth,
} from "./format.js";
import { copyOptions } from "./export.js";

const METRICS = ["cost", "tokens", "calls"];

export function itemLine(view, item, width, selected) {
  const row = item.row;
  const depth = item.depth ?? 0;
  const total = item.parentTotal ?? view.report.total;
  const share = view.share(row, total);
  const color = item.color ?? (row.model ? view.colorForModel(row.name) : "accent");
  const cursor = selected ? view.accent("›") : " ";
  const disclosure = item.expandable ? (view.tabState(view.expanded).has(item.id) ? "▾" : "▸") : " ";
  const indent = "  ".repeat(depth);
  const badge = item.badge ? `${item.badge} ` : "";
  const prefix = `${cursor} ${indent}${view.paint(color, disclosure)} ${badge}`;
  const value = formatMetric(metricValue(row, view.metric), view.metric);
  const pct = formatPercent(share);
  const secondary = width >= 108
    ? `  ${view.muted(`${formatInt(row.calls)} calls · ${formatTokens(row.measuredTokens)}`)}`
    : "";
  const graph = width >= 76 ? ` ${view.bar(share, color, width >= 112 ? 14 : 10)}` : "";
  const suffix = ` ${view.paint(view.metric === "cost" ? "warning" : color, view.strong(value)).padStart(0)} ${view.dim(pct)}${graph}${secondary}`;
  const available = Math.max(8, width - textWidth(prefix) - textWidth(suffix));
  const label = clipAnsi(item.label ?? row.name, available);
  return `${prefix}${view.paint(color, selected ? view.strong(label) : label)}${" ".repeat(Math.max(1, available - textWidth(label) + 1))}${suffix}`;
}

export function actorLine(view, item, width, selected) {
  const row = item.row;
  if (width < 86) return itemLine(view, item, width, selected);
  const cursor = selected ? view.accent("›") : " ";
  const nameWidth = Math.max(10, width - 67);
  const name = `${cursor} ${clipAnsi(row.name, nameWidth - 2)}`;
  const callShare = formatPercent(percent(row.calls, view.report.total.calls));
  const tokenShare = formatPercent(percent(row.measuredTokens, view.report.total.measuredTokens));
  const costShare = formatPercent(percent(row.costTotal, view.report.total.costTotal));
  return `${fitAnsi(view.paint("text", name), nameWidth)} ${String(formatInt(row.calls)).padStart(8)} ${callShare.padStart(7)} ${formatTokens(row.measuredTokens).padStart(9)} ${tokenShare.padStart(7)} ${formatCost(row.costTotal).padStart(9)} ${costShare.padStart(7)} ${view.bar(view.share(row, view.report.total), "accent", 8)}`;
}

export function tabBar(view, width, tabs) {
  const render = key => tabs.map((tab, index) => {
    const label = tab[key];
    return index === view.activeTab
      ? view.accent(view.strong(`[${label}]`))
      : view.muted(` ${label} `);
  }).join(` ${view.dim("│")} `);
  const full = render("label");
  return textWidth(full) <= width ? full : render("short");
}

export function metricBar(view, width) {
  const chips = METRICS.map(metric => metric === view.metric ? view.accent(view.strong(`[${metricTitle(metric)}]`)) : view.muted(metricTitle(metric))).join(" ");
  const suffix = `${view.dim("·")} sort:${view.sortMode === "metric" ? metricTitle(view.metric).toLowerCase() : "name"}  ${view.accent("[c Copy]")}`;
  return clipAnsi(`Metric: ${chips}  ${suffix}`, width);
}

export function modalRows(view) {
  if (view.modal === "help") {
    return [
      view.heading("HELP · METRICS & CONTROLS"),
      view.separator(),
      view.detail("Calls = assistant/provider calls with usage metadata, not user prompts or task count.", 0),
      view.detail("Token% includes input, output, cache read/write, and orchestration tokens.", 0),
      view.detail("Cost% is API-equivalent and may differ from OAuth/subscription billing.", 0),
      view.detail("Cost intensity = cost share ÷ token share; 1.00× is session average.", 0),
      view.separator(),
      view.detail("Tab / Shift+Tab          switch tabs", 0),
      view.detail("1..6                     jump to tab", 0),
      view.detail("↑↓ / j k                 move focus", 0),
      view.detail("Enter / →                expand", 0),
      view.detail("← / Esc                  collapse / back", 0),
      view.detail("m                         Cost → Tokens → Calls", 0),
      view.detail("s                         sort by metric / name", 0),
      view.detail("c                         copy menu", 0),
      view.detail("r                         refresh transcripts + stats", 0),
      view.detail("q                         close", 0),
      view.separator(),
      view.detail("Esc closes this help panel.", 0),
    ];
  }
  const options = copyOptions();
  const rows = [view.heading("COPY REPORT"), view.separator()];
  options.forEach((option, index) => {
    const selected = index === view.modalIndex;
    const marker = selected ? view.accent("›") : " ";
    rows.push({ text: `${marker} ${selected ? view.strong(option.label) : option.label}`, selectable: false });
    rows.push(view.detail(option.description, 2));
  });
  rows.push(view.separator(), view.detail("↑↓ choose · Enter copy · Esc cancel", 0));
  return rows;
}

export function styleContentRow(view, entry, width, selectedId) {
  let content;
  const selected = entry.id && entry.id === selectedId;
  if (entry.selectable) {
    content = entry.renderer === "actor" ? actorLine(view, entry, width, selected) : itemLine(view, entry, width, selected);
  } else {
    content = entry.text ?? "";
  }
  const fitted = fitAnsi(content, width);
  if (!selected) return fitted;
  try {
    if (typeof view.theme?.bgFill === "function") return view.theme.bgFill("selectedBg", fitted);
    if (typeof view.theme?.inverse === "function") return view.theme.inverse(fitted);
  } catch {}
  return fitted;
}

export function renderExplorer(view, maxWidth, tabs) {
  if (view.lastRendered && view.lastRenderedWidth === maxWidth) return view.lastRendered;
  view.lastWidth = maxWidth;
  const width = Math.max(40, maxWidth);
  const inner = Math.max(36, width - 4);
  const page = view.pageSize();
  const rows = view.modal ? modalRows(view) : view.buildRows(inner);
  const selectedId = view.modal ? null : view.selectedId(rows);
  if (!view.modal) view.ensureSelectedVisible(rows);
  const tabId = view.currentTab().id;
  const maxOffset = Math.max(0, rows.length - page);
  const offset = view.modal ? 0 : Math.min(maxOffset, view.offsets.get(tabId) ?? 0);
  if (!view.modal) view.offsets.set(tabId, offset);
  const visible = rows.slice(offset, offset + page);

  const edge = text => view.paint("borderMuted", text);
  const accentEdge = text => view.paint("borderAccent", text);
  const frameRow = content => `${edge("│")} ${fitAnsi(content, inner)} ${edge("│")}`;
  const headerLeft = `${view.accent("◆")} ${view.accent(view.strong("SESSION COST EXPLORER"))}`;
  const headerRight = metricBar(view, Math.max(0, inner - textWidth(headerLeft) - 2));
  const headerGap = " ".repeat(Math.max(2, inner - textWidth(headerLeft) - textWidth(headerRight)));

  const out = [
    accentEdge(`┌${"─".repeat(Math.max(1, width - 2))}┐`),
    frameRow(`${headerLeft}${headerGap}${headerRight}`),
    frameRow(tabBar(view, inner, tabs)),
    frameRow(""),
  ];
  for (const entry of visible) out.push(`${edge("│")} ${styleContentRow(view, entry, inner, selectedId)} ${edge("│")}`);
  for (let index = visible.length; index < page; index += 1) out.push(frameRow(""));

  const first = rows.length ? offset + 1 : 0;
  const last = Math.min(rows.length, offset + page);
  const baseFooter = view.modal
    ? view.modal === "copy" ? "↑↓ choose  Enter copy  Esc cancel" : "Esc close help"
    : "↑↓ select  Enter expand  m metric  s sort  c copy  r refresh  ? help  q close";
  const footer = view.toast ? `${baseFooter}  ${view.dim("│")}  ${view.toast}` : `${baseFooter}  ${view.dim("│")}  ${first}-${last}/${rows.length}`;
  out.push(frameRow(view.muted(footer)));
  out.push(accentEdge(`└${"─".repeat(Math.max(1, width - 2))}┘`));

  view.lastRenderedWidth = maxWidth;
  view.lastRendered = out;
  return out;
}
