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
  stripAnsi,
  textWidth,
} from "./format.js";
import { copyOptions } from "./export.js";

const METRICS = ["cost", "tokens", "calls"];

function rightAnsi(value, width) {
  const clipped = clipAnsi(String(value ?? ""), width);
  return `${" ".repeat(Math.max(0, width - textWidth(clipped)))}${clipped}`;
}

function shareHeading(metric) {
  if (metric === "calls") return "CALL%";
  if (metric === "tokens") return "TOK%";
  return "COST%";
}

export function listLayout(width) {
  if (width >= 94) {
    const name = Math.min(58, Math.max(30, Math.floor(width * 0.38)));
    const bar = Math.min(48, Math.max(10, width - name - 45));
    return { mode: "wide", name, calls: 10, tokens: 11, cost: 11, share: 8, bar };
  }
  if (width >= 68) {
    const bar = Math.min(24, Math.max(8, Math.floor(width * 0.17)));
    return { mode: "medium", name: Math.max(20, width - bar - 22), value: 11, share: 8, bar };
  }
  return { mode: "narrow", name: Math.max(8, width - 21), value: 11, share: 8, bar: 0 };
}

export function listHeaderLine(view, width, label = "NAME") {
  const layout = listLayout(width);
  if (layout.mode === "wide") {
    return view.dim([
      fitAnsi(label, layout.name),
      "CALLS".padStart(layout.calls),
      "TOKENS".padStart(layout.tokens),
      "COST".padStart(layout.cost),
      shareHeading(view.metric).padStart(layout.share),
      "DISTRIBUTION".padEnd(layout.bar),
    ].join(" "));
  }
  const cells = [
    fitAnsi(label, layout.name),
    metricTitle(view.metric).toUpperCase().padStart(layout.value),
    shareHeading(view.metric).padStart(layout.share),
  ];
  if (layout.bar) cells.push("DISTRIBUTION".padEnd(layout.bar));
  return view.dim(cells.join(" "));
}

export function actorHeaderLine(view, width) {
  if (width < 94) return listHeaderLine(view, width, "TYPE");
  const bar = 8;
  const nameWidth = Math.max(12, width - 62);
  return view.dim([
    fitAnsi("TYPE", nameWidth),
    "CALLS".padStart(8),
    "CALL%".padStart(7),
    "TOKENS".padStart(9),
    "TOK%".padStart(7),
    "COST".padStart(9),
    "COST%".padStart(7),
    `BAR(${metricTitle(view.metric).toUpperCase()})`.padEnd(bar),
  ].join(" "));
}

function itemNameCell(view, item, layout, selected, color) {
  const depth = item.depth ?? 0;
  const cursor = selected ? "›" : " ";
  const disclosure = item.expandable ? (view.tabState(view.expanded).has(item.id) ? "▾" : "▸") : " ";
  const indent = "  ".repeat(depth);
  const badge = item.badge ? `${item.badge} ` : "";
  const prefix = `${cursor} ${indent}${view.paint(color, disclosure)} ${badge}`;
  const available = Math.max(1, layout.name - textWidth(prefix));
  const label = clipAnsi(item.label ?? item.row.name, available);
  const styled = view.paint(color, selected ? view.strong(label) : label);
  return fitAnsi(`${prefix}${styled}`, layout.name);
}

export function itemLine(view, item, width, selected) {
  const row = item.row;
  const total = item.parentTotal ?? view.report.total;
  const share = view.share(row, total);
  const color = item.color ?? (row.model ? view.colorForModel(row.name) : "accent");
  const layout = listLayout(width);
  const name = itemNameCell(view, item, layout, selected, color);

  if (layout.mode === "wide") {
    const calls = row.failed
      ? view.error(rightAnsi(formatInt(row.calls), layout.calls))
      : view.muted(rightAnsi(formatInt(row.calls), layout.calls));
    const tokens = view.paint(color, rightAnsi(formatTokens(row.measuredTokens), layout.tokens));
    const cost = view.warning(rightAnsi(formatCost(row.costTotal), layout.cost));
    const shareText = view.dim(rightAnsi(formatPercent(share), layout.share));
    return `${name} ${calls} ${tokens} ${cost} ${shareText} ${view.bar(share, color, layout.bar)}`;
  }

  const value = view.paint(
    view.metric === "cost" ? "warning" : color,
    rightAnsi(formatMetric(metricValue(row, view.metric), view.metric), layout.value),
  );
  const shareText = view.dim(rightAnsi(formatPercent(share), layout.share));
  const graph = layout.bar ? ` ${view.bar(share, color, layout.bar)}` : "";
  return `${name} ${value} ${shareText}${graph}`;
}

export function actorLine(view, item, width, selected) {
  const row = item.row;
  if (width < 94) return itemLine(view, item, width, selected);
  const nameWidth = Math.max(12, width - 62);
  const cursor = selected ? "›" : " ";
  const name = fitAnsi(`${cursor} ${row.name}`, nameWidth);
  const callShare = formatPercent(percent(row.calls, view.report.total.calls));
  const tokenShare = formatPercent(percent(row.measuredTokens, view.report.total.measuredTokens));
  const costShare = formatPercent(percent(row.costTotal, view.report.total.costTotal));
  return [
    view.paint("text", name),
    rightAnsi(formatInt(row.calls), 8),
    rightAnsi(callShare, 7),
    rightAnsi(formatTokens(row.measuredTokens), 9),
    rightAnsi(tokenShare, 7),
    view.warning(rightAnsi(formatCost(row.costTotal), 9)),
    rightAnsi(costShare, 7),
    view.bar(view.share(row, view.report.total), "accent", 8),
  ].join(" ");
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
      view.detail("Calls are provider calls with usage metadata; they are not user prompts or task count.", 0),
      view.detail("Token% includes input, output, cache read/write, and orchestration tokens.", 0),
      view.detail("Cost% is API-equivalent. Intensity = cost share ÷ token share; 1.00× is average.", 0),
      view.separator(),
      view.detail("Tab/Shift+Tab tabs     ↑↓ or j/k select     Enter/→ expand", 0),
      view.detail("←/Esc collapse/back    m metric             s sort", 0),
      view.detail("c copy                 r refresh            ? help", 0),
      view.detail("q close                Esc closes this panel", 0),
    ];
  }
  const options = copyOptions();
  const selectedOption = options[view.modalIndex];
  const rows = [view.heading("COPY REPORT"), view.separator()];
  options.forEach((option, index) => {
    const selected = index === view.modalIndex;
    const marker = selected ? view.accent("›") : " ";
    rows.push({ text: `${marker} ${selected ? view.strong(option.label) : option.label}`, selectable: false });
  });
  rows.push(
    view.separator(),
    view.detail(selectedOption?.description ?? "", 0),
    view.detail("↑↓ choose · Enter copy · Esc cancel", 0),
  );
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

  const plain = fitAnsi(stripAnsi(content), width);
  try {
    if (typeof view.theme?.bgFill === "function") {
      const foreground = typeof view.theme?.fgOnBg === "function"
        ? view.theme.fgOnBg("text", "selectedBg", plain)
        : typeof view.theme?.fg === "function"
          ? view.theme.fg("text", plain)
          : plain;
      return view.theme.bgFill("selectedBg", foreground);
    }
    if (typeof view.theme?.inverse === "function") return view.theme.inverse(plain);
  } catch {}
  return plain;
}

function footerHint(view, width) {
  if (view.modal === "copy") return "↑↓ choose  Enter copy  Esc cancel";
  if (view.modal === "help") return "Esc close help";
  if (width >= 104) return "↑↓ select  Enter expand  m metric  s sort  c copy  r refresh  ? help  q close";
  return "↑↓ select  Enter expand  m metric  c copy  ? help  q close";
}

export function renderExplorer(view, maxWidth, tabs) {
  const terminalRows = view.terminalRows();
  if (view.lastRendered && view.lastRenderedWidth === maxWidth && view.lastRenderedRows === terminalRows) return view.lastRendered;
  view.lastWidth = maxWidth;
  const width = Math.max(8, maxWidth);
  const inner = Math.max(4, width - 4);
  const page = view.pageSize();
  const rows = view.modal ? modalRows(view) : view.buildRows(inner);
  const selectedId = view.modal ? null : view.selectedId(rows);
  if (!view.modal) view.ensureSelectedVisible(rows);
  const tabId = view.currentTab().id;
  const maxOffset = Math.max(0, rows.length - page);
  const offset = view.modal ? 0 : Math.min(maxOffset, view.offsets.get(tabId) ?? 0);
  if (!view.modal) view.offsets.set(tabId, offset);
  const visible = rows.slice(offset, offset + page);
  const minimumBodyRows = view.modal ? visible.length : Math.min(8, page);
  const bodyRows = Math.min(page, Math.max(visible.length, minimumBodyRows));

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
  for (let index = visible.length; index < bodyRows; index += 1) out.push(frameRow(""));

  const first = rows.length ? offset + 1 : 0;
  const last = Math.min(rows.length, offset + page);
  const baseFooter = footerHint(view, inner);
  const footer = view.toast ? `${baseFooter}  ${view.dim("│")}  ${view.toast}` : `${baseFooter}  ${view.dim("│")}  ${first}-${last}/${rows.length}`;
  out.push(frameRow(view.muted(footer)));
  out.push(accentEdge(`└${"─".repeat(Math.max(1, width - 2))}┘`));

  view.lastRenderedWidth = maxWidth;
  view.lastRenderedRows = terminalRows;
  view.lastRendered = out;
  return out;
}
