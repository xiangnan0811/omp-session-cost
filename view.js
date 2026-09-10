import {
  formatCost,
  formatInt,
  formatTokens,
  metricValue,
  percent,
  sortRows,
} from "./format.js";
import { copyOptions, buildCopyPayload } from "./export.js";
import { scopeReport, selectionFilter } from "./core.js";
import { cleanText } from "./diagnostics.js";
import {
  advisorRows,
  agentRows,
  detailsRows,
  modelRows,
  overviewRows,
  providerRows,
} from "./view-pages.js";
import { listHeaderLine, renderExplorer } from "./view-render.js";

const TABS = Object.freeze([
  { id: "overview", label: "Overview", short: "Overview" },
  { id: "providers", label: "Providers", short: "Providers" },
  { id: "models", label: "Models", short: "Models" },
  { id: "agents", label: "Agents", short: "Agents" },
  { id: "advisors", label: "Advisors", short: "Advisors" },
  { id: "details", label: "Details", short: "Details" },
]);

const PALETTE = ["accent", "success", "warning", "mdLink", "mdCode", "thinkingMedium", "thinkingHigh", "toolTitle"];
const METRICS = ["cost", "tokens", "calls"];

export const PANEL_HEIGHT_RATIO = 0.52;
const PANEL_CHROME_ROWS = 6;

const RAW_KEYS = Object.freeze({
  escape: ["\u001b", "\u001b\u001b"],
  esc: ["\u001b", "\u001b\u001b"],
  tab: ["\t"],
  "shift+tab": ["\u001b[Z"],
  enter: ["\r", "\n"],
  return: ["\r", "\n"],
  up: ["\u001b[A", "\u001bOA"],
  down: ["\u001b[B", "\u001bOB"],
  left: ["\u001b[D", "\u001bOD"],
  right: ["\u001b[C", "\u001bOC"],
  pageUp: ["\u001b[5~"],
  pageDown: ["\u001b[6~"],
  home: ["\u001b[H", "\u001b[1~", "\u001bOH"],
  end: ["\u001b[F", "\u001b[4~", "\u001bOF"],
  "ctrl+c": ["\u0003"],
});

function matchesKittyCodepoint(data, codepoint) {
  const match = String(data).match(/^\u001b\[(\d+)(?::\d*)?(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u$/);
  if (!match || Number(match[1]) !== codepoint) return false;
  return match[2] === undefined || Number(match[2]) === 1;
}

function noop() {}

export class CostExplorerView {
  constructor(tui, theme, keybindings, report, callbacks = {}, done = noop) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.report = report;
    this.baseReport = report;
    this.scopeMode = "current";
    this.profile = { question: "", protectedScopes: "", annotation: "", ...(callbacks.profile || {}) };
    this.bookmark = callbacks.bookmark || null;
    this.sinceBookmark = false;
    this.modalOffset = 0;
    this.preview = null;
    this.editing = null;
    this.busy = false;
    this.callbacks = callbacks;
    this.done = done;
    this.activeTab = 0;
    this.metric = "cost";
    this.sortMode = "metric";
    this.selected = new Map();
    this.offsets = new Map(TABS.map(tab => [tab.id, 0]));
    this.expanded = new Map(TABS.map(tab => [tab.id, new Set()]));
    this.modal = null;
    this.modalIndex = 0;
    this.toast = "";
    this.refreshing = false;
    this.closed = false;
    this.lastWidth = 100;
    this.lastRendered = null;
    this.lastRenderedWidth = -1;
    this.lastRenderedRows = -1;
    this.rebuildColors();
  }

  rebuildColors() {
    this.modelColors = new Map((this.report.models ?? []).map((row, index) => [row.name, PALETTE[index % PALETTE.length]]));
    this.providerColors = new Map((this.report.providers ?? []).map((row, index) => [row.name, PALETTE[index % PALETTE.length]]));
  }

  currentTab() {
    return TABS[this.activeTab];
  }

  tabState(map) {
    return map.get(this.currentTab().id);
  }

  paint(color, text) {
    try { return this.theme?.fg?.(color, String(text)) ?? String(text); } catch { return String(text); }
  }

  strong(text) {
    try { return this.theme?.bold?.(String(text)) ?? String(text); } catch { return String(text); }
  }

  muted(text) { return this.paint("muted", text); }
  dim(text) { return this.paint("dim", text); }
  accent(text) { return this.paint("accent", text); }
  warning(text) { return this.paint("warning", text); }
  error(text) { return this.paint("error", text); }

  colorForModel(name) {
    return this.modelColors.get(name) ?? "accent";
  }

  colorForProvider(name) {
    return this.providerColors.get(name) ?? "accent";
  }

  invalidate() {
    this.lastRendered = null;
    this.lastRenderedWidth = -1;
    this.lastRenderedRows = -1;
  }

  requestRender() {
    this.invalidate();
    this.tui?.requestRender?.();
  }

  terminalRows() {
    return Number.isFinite(this.tui?.terminal?.rows) ? this.tui.terminal.rows : 40;
  }

  panelMaxRows() {
    return Math.max(PANEL_CHROME_ROWS + 1, Math.floor(this.terminalRows() * PANEL_HEIGHT_RATIO));
  }

  pageSize() {
    return Math.max(1, this.panelMaxRows() - PANEL_CHROME_ROWS);
  }

  sorted(rows) {
    return sortRows(rows ?? [], this.metric, this.sortMode);
  }

  share(row, total) {
    return percent(metricValue(row, this.metric), metricValue(total, this.metric));
  }

  bar(shareValue, color, cells = 12) {
    const filled = Math.round(Math.max(0, Math.min(100, shareValue)) / 100 * cells);
    return `${this.paint(color, "━".repeat(filled))}${this.dim("─".repeat(cells - filled))}`;
  }

  badge(type) {
    if (type === "main") return this.paint("accent", "[MAIN]");
    if (type === "advisor") return this.paint("warning", "[ADV]");
    return this.paint("success", "[SUB]");
  }

  detail(text, depth = 1, color = "muted") {
    return { text: `${"  ".repeat(depth)}${this.paint(color, text)}`, selectable: false };
  }

  item(id, row, options = {}) {
    return {
      id,
      row,
      selectable: true,
      expandable: Boolean(options.expandable),
      parentId: options.parentId ?? null,
      depth: options.depth ?? 0,
      kind: options.kind ?? "item",
      label: options.label ?? row.name,
      badge: options.badge,
      color: options.color,
      parentTotal: options.parentTotal,
      renderer: options.renderer,
    };
  }

  heading(text) {
    return { text: this.accent(this.strong(text)), selectable: false };
  }

  columnHeader(width, label = "NAME") {
    return { text: listHeaderLine(this, width, label), selectable: false };
  }

  separator() {
    return { text: "", selectable: false };
  }

  buildRows(width = this.lastWidth - 4) {
    const id = this.currentTab().id;
    if (id === "overview") return overviewRows(this, width);
    if (id === "providers") return providerRows(this, width);
    if (id === "models") return modelRows(this, width);
    if (id === "agents") return agentRows(this, width);
    if (id === "advisors") return advisorRows(this, width);
    return detailsRows(this, width);
  }

  selectableRows(rows) {
    return rows.filter(row => row.selectable);
  }

  selectedId(rows) {
    const tabId = this.currentTab().id;
    const selectable = this.selectableRows(rows);
    let id = this.selected.get(tabId);
    if (!selectable.some(row => row.id === id)) {
      id = selectable[0]?.id;
      if (id) this.selected.set(tabId, id);
      else this.selected.delete(tabId);
    }
    return id;
  }

  selectedItem(rows = this.buildRows()) {
    const id = this.selectedId(rows);
    return rows.find(row => row.id === id) ?? null;
  }

  currentSelection() {
    const item = this.selectedItem();
    return item ? { kind: item.kind, row: item.row, id: item.id } : null;
  }

  ensureSelectedVisible(rows) {
    const id = this.selectedId(rows);
    if (!id) return;
    const lineIndex = rows.findIndex(row => row.id === id);
    const tabId = this.currentTab().id;
    let offset = this.offsets.get(tabId) ?? 0;
    const page = this.pageSize();
    if (lineIndex < offset) offset = lineIndex;
    else if (lineIndex >= offset + page) offset = Math.max(0, lineIndex - page + 1);
    this.offsets.set(tabId, offset);
  }

  moveSelection(delta) {
    const rows = this.buildRows();
    const selectable = this.selectableRows(rows);
    if (!selectable.length) return;
    const id = this.selectedId(rows);
    let index = selectable.findIndex(row => row.id === id);
    index = Math.max(0, Math.min(selectable.length - 1, index + delta));
    this.selected.set(this.currentTab().id, selectable[index].id);
    this.ensureSelectedVisible(rows);
    this.requestRender();
  }

  selectBoundary(last) {
    const rows = this.buildRows();
    const selectable = this.selectableRows(rows);
    if (!selectable.length) return;
    this.selected.set(this.currentTab().id, selectable[last ? selectable.length - 1 : 0].id);
    this.ensureSelectedVisible(rows);
    this.requestRender();
  }

  toggleSelected(expandOnly = false) {
    const rows = this.buildRows();
    const item = this.selectedItem(rows);
    if (!item) return;
    const expanded = this.tabState(this.expanded);
    if (item.expandable) {
      if (expanded.has(item.id)) {
        if (!expandOnly) expanded.delete(item.id);
      } else {
        expanded.add(item.id);
      }
      this.ensureSelectedVisible(this.buildRows());
      this.requestRender();
      return;
    }
    if (expandOnly && item.parentId) {
      const parent = rows.find(row => row.id === item.parentId);
      if (parent?.expandable) expanded.add(parent.id);
      this.requestRender();
    }
  }

  collapseOrParent() {
    const rows = this.buildRows();
    const item = this.selectedItem(rows);
    if (!item) return false;
    const expanded = this.tabState(this.expanded);
    if (item.expandable && expanded.has(item.id)) {
      expanded.delete(item.id);
      this.requestRender();
      return true;
    }
    if (item.parentId) {
      expanded.delete(item.parentId);
      this.selected.set(this.currentTab().id, item.parentId);
      this.ensureSelectedVisible(this.buildRows());
      this.requestRender();
      return true;
    }
    return false;
  }

  switchTab(delta) {
    this.activeTab = (this.activeTab + delta + TABS.length) % TABS.length;
    this.ensureSelectedVisible(this.buildRows());
    this.requestRender();
  }

  selectTab(index) {
    if (index < 0 || index >= TABS.length || index === this.activeTab) return;
    this.activeTab = index;
    this.ensureSelectedVisible(this.buildRows());
    this.requestRender();
  }

  cycleMetric() {
    this.metric = METRICS[(METRICS.indexOf(this.metric) + 1) % METRICS.length];
    this.offsets.set(this.currentTab().id, 0);
    this.requestRender();
  }

  cycleSort() {
    this.sortMode = this.sortMode === "metric" ? "name" : "metric";
    this.offsets.set(this.currentTab().id, 0);
    this.requestRender();
  }

  openCopy() {
    this.modal = "copy";
    this.modalIndex = 0;
    this.modalOffset = 0;
    this.requestRender();
  }

  openHelp() {
    this.modal = "help";
    this.modalOffset = 0;
    this.requestRender();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.done(undefined);
  }

  key(data, key) {
    try {
      if (typeof this.callbacks.matchesKey === "function" && this.callbacks.matchesKey(data, key)) return true;
    } catch {}
    if (RAW_KEYS[key]?.includes(data)) return true;
    if (key === "escape" || key === "esc") return matchesKittyCodepoint(data, 27);
    if (key === "enter" || key === "return") return matchesKittyCodepoint(data, 13);
    if (key === "tab") return matchesKittyCodepoint(data, 9);
    return false;
  }

  interrupted(data) {
    try {
      if (this.keybindings?.matches?.(data, "app.interrupt")) return true;
    } catch {}
    return this.key(data, "ctrl+c");
  }

  exportContext() {
    const p = this.preview;
    let report = this.report;
    const clearActors = { actorType: undefined, agent: undefined, advisorKey: undefined, provider: undefined, modelId: undefined };
    if (p.scope === "main") report = scopeReport(report, { ...clearActors, actorType: "main" });
    else if (p.scope === "all") report = scopeReport(report, clearActors);
    else if (p.scope === "selection") report = scopeReport(report, { ...clearActors, ...selectionFilter(p.selection) });
    return { ...this.profile, includeEvidence: p.includeEvidence, selection: null, tabId: p.tabId, report };
  }

  rebuildPreview() {
    if (!this.preview) return;
    const context = this.exportContext();
    const mode = this.preview.mode === "selection" ? "brief" : this.preview.mode;
    this.preview.payload = buildCopyPayload(context.report, mode, context);
    this.preview.calls = context.report.total.calls;
    const t = context.report.total, m = context.report.measurement;
    this.preview.summaryLines = m ? [
      `${formatInt(t.calls)} usage records · ${formatCost(t.costTotal)} known API-equivalent subtotal · ${formatTokens(t.measuredTokens)} measured tokens`,
      `Nonzero ${m.nonzeroUsageRecords} · known zero ${m.zeroUsageRecords} · missing usage ${m.unmeteredResponses} · missing price ${m.missingPriceRecords}`,
      `Input ${formatTokens(t.input)} / ${formatCost(t.costInput)} · Cache read ${formatTokens(t.cacheRead)} / ${formatCost(t.costCacheRead)}`,
      `Output ${formatTokens(t.output)} / ${formatCost(t.costOutput)} · Cache write ${formatTokens(t.cacheWrite)} / ${formatCost(t.costCacheWrite)}`,
      `Input P50 ${m.inputDistribution.p50 == null ? "unknown" : formatTokens(m.inputDistribution.p50)} · P95 ${m.inputDistribution.p95 == null ? "unknown" : formatTokens(m.inputDistribution.p95)} · max ${m.inputDistribution.max == null ? "unknown" : formatTokens(m.inputDistribution.max)}`,
      `Historical thinking: ${[...new Set(m.historicalSettings.map(s => s.value))].join(", ") || "unknown"} (${m.historicalThinkingRecords}/${m.usageRecords}); request effort ${m.requestEffortRecords}/${m.usageRecords}`,
      `Repeated-status candidates ${context.report.diagnostics?.repeatedStatus?.length || 0} · Incoming intervals ${context.report.diagnostics?.incomingActivity?.length || 0} · Compactions ${context.report.diagnostics?.compactions?.length || 0}`,
      "Candidates are not guaranteed savings. Scroll for scope, coverage, evidence and interpretation limits."
    ] : [];
    this.preview.scopeLabel = this.preview.scope;
    this.preview.bytes = Buffer.byteLength(this.preview.payload, "utf8");
    this.preview.wrapCache = null;
    this.modalOffset = 0;
    this.requestRender();
  }

  openPreview(mode = "brief", details = false) {
    this.preview = { mode, selection: this.currentSelection(), tabId: this.currentTab().id,
      scope: mode === "selection" || details ? "selection" : "current", includeEvidence: false, payload: "", details };
    this.modal = details ? "subject" : "preview";
    try { this.rebuildPreview(); }
    catch (error) { this.toast = `Preview failed: ${cleanText(error.message)}`; this.modal = "copy"; this.requestRender(); }
  }

  async runCopy() {
    if (!this.preview || this.busy) return;
    const p = this.preview;
    this.render(this.lastWidth);
    if (p.includeEvidence && p.wrapCache?.truncated) {
      this.toast = "Excerpt payload exceeds local preview; save it for full review before sharing. Nothing copied.";
      this.requestRender(); return;
    }
    this.busy = true;
    this.toast = "Copying the exact preview…";
    this.requestRender();
    try {
      const result = await this.callbacks.onCopy?.(p.mode, { ...this.exportContext(), payload: p.payload });
      this.toast = result?.message ?? "Copy callback unavailable";
    } catch (error) { this.toast = `Copy failed: ${cleanText(error.message)}; press s to save.`; }
    finally { this.busy = false; this.requestRender(); }
  }

  beginEdit(field) {
    this.editing = { field, parent: this.modal, value: field === "savePath" ? "omp-cost-diagnostic." + (this.preview?.mode === "json" ? "json" : "md") : this.profile[field] || "" };
    this.modal = "edit"; this.modalOffset = 0; this.requestRender();
  }

  async finishEdit() {
    const edit = this.editing;
    if (!edit || this.busy) return;
    if (edit.field === "savePath") {
      this.busy = true;
      try {
        const result = await this.callbacks.onSave?.(edit.value, this.preview.payload);
        this.toast = result?.message || "Save callback unavailable";
      } catch (error) { this.toast = `Save failed: ${cleanText(error.message)}`; }
      finally { this.busy = false; }
    } else {
      this.profile[edit.field] = edit.value;
      this.callbacks.onProfile?.({ ...this.profile });
    }
    this.modal = edit.parent; this.editing = null;
    if (edit.field !== "savePath") this.rebuildPreview();
    else this.requestRender();
  }

  cycleScope() {
    const modes = ["current", "main", "all"];
    this.scopeMode = modes[(modes.indexOf(this.scopeMode) + 1) % modes.length];
    this.applyScope();
  }

  applyScope() {
    try {
      const clearActors = { actorType: undefined, agent: undefined, advisorKey: undefined, provider: undefined, modelId: undefined };
      const options = this.scopeMode === "current" ? {} : this.scopeMode === "main" ? { ...clearActors, actorType: "main" } : clearActors;
      if (this.sinceBookmark && this.bookmark) { options.sinceKeys = this.bookmark.callKeys; options.sinceEventKeys = this.bookmark.eventKeys; }
      this.report = Object.keys(options).length ? scopeReport(this.baseReport, options) : this.baseReport;
      this.rebuildColors();
      this.toast = `Scope ${this.scopeMode}${this.sinceBookmark ? " since bookmark" : ""}: ${this.report.total.calls} calls`;
    } catch (error) { this.toast = cleanText(error.message); }
    this.requestRender();
  }

  markSnapshot() {
    const scan = this.baseReport._sourceScan;
    this.bookmark = { sessionId: this.baseReport.sessionId, callKeys: new Set((scan?.calls || this.baseReport.calls || []).map(c => c.recordKey)),
      eventKeys: new Set((scan?.events || []).map(e => e.key)), frozenAt: this.baseReport.snapshot?.frozenAt || this.baseReport.generatedAt };
    this.callbacks.onBookmark?.(this.bookmark);
    this.toast = `Bookmark saved in memory: ${this.bookmark.callKeys.size} records; w toggles newly observed records.`;
    this.requestRender();
  }

  async refresh() {
    if (this.refreshing || typeof this.callbacks.onRefresh !== "function") return;
    this.refreshing = true;
    this.toast = "Refreshing transcripts and OMP stats…";
    this.requestRender();
    try {
      const report = await this.callbacks.onRefresh();
      if (report) {
        this.baseReport = report;
        this.applyScope();
        this.rebuildColors();
        this.toast = `Refreshed · ${formatInt(report.total.calls)} calls · ${formatCost(report.total.costTotal)}`;
      }
    } catch (error) {
      this.toast = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.refreshing = false;
      this.requestRender();
    }
  }

  handleModalInput(data) {
    if (this.interrupted(data)) { this.close(); return true; }
    if (this.key(data, "escape") || this.key(data, "esc") || (this.modal !== "edit" && (data === "q" || data === "Q"))) {
      if (this.busy) return true;
      if (this.modal === "edit") { this.modal = this.editing.parent; this.editing = null; }
      else this.modal = this.modal === "preview" ? "copy" : null;
      this.modalOffset = 0; this.requestRender(); return true;
    }
    if (this.modal === "edit") {
      if (this.key(data, "enter") || this.key(data, "return")) void this.finishEdit();
      else if (data === "\x7f" || data === "\b") this.editing.value = Array.from(this.editing.value).slice(0, -1).join("");
      else if (data === "\x15") this.editing.value = "";
      else {
        const plain = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
        if (!/[\x00-\x1f\x7f]/.test(plain)) this.editing.value = (this.editing.value + plain).slice(0, 2000);
      }
      this.requestRender(); return true;
    }
    if (this.modal === "copy") {
      if (data === "j" || this.key(data, "down")) this.modalIndex = Math.min(copyOptions().length - 1, this.modalIndex + 1);
      else if (data === "k" || this.key(data, "up")) this.modalIndex = Math.max(0, this.modalIndex - 1);
      else if (this.key(data, "enter") || this.key(data, "return")) this.openPreview(copyOptions()[this.modalIndex].id);
      this.modalOffset = Math.max(0, this.modalIndex + 3 - this.pageSize());
      this.requestRender(); return true;
    }
    if (["preview", "subject"].includes(this.modal)) {
      if (data === "e") { this.preview.includeEvidence = !this.preview.includeEvidence; this.rebuildPreview(); return true; }
      if (data === "f") {
        const modes = ["current", "main", "all", "selection"];
        this.preview.scope = modes[(modes.indexOf(this.preview.scope) + 1) % modes.length]; this.rebuildPreview(); return true;
      }
      if (data === "g" || data === "p" || data === "n" || data === "s") {
        this.beginEdit({ g: "question", p: "protectedScopes", n: "annotation", s: "savePath" }[data]); return true;
      }
      if (this.key(data, "enter") || data === "c") { void this.runCopy(); return true; }
    }
    if (data === "j" || this.key(data, "down")) this.modalOffset++;
    else if (data === "k" || this.key(data, "up")) this.modalOffset = Math.max(0, this.modalOffset - 1);
    else if (this.key(data, "pageDown")) this.modalOffset += this.pageSize();
    else if (this.key(data, "pageUp")) this.modalOffset = Math.max(0, this.modalOffset - this.pageSize());
    else if (this.key(data, "home")) this.modalOffset = 0;
    else if (this.key(data, "end")) this.modalOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender(); return true;
  }

  handleInput(data) {
    if (this.closed) return;
    if (this.modal) {
      this.handleModalInput(data);
      return;
    }
    if (this.key(data, "escape") || this.key(data, "esc")) {
      if (!this.collapseOrParent()) this.close();
      return;
    }
    if (this.interrupted(data)) {
      this.close();
      return;
    }
    if (data === "q" || data === "Q") {
      this.close();
      return;
    }
    if (this.key(data, "tab")) {
      this.switchTab(1);
      return;
    }
    if (this.key(data, "shift+tab")) {
      this.switchTab(-1);
      return;
    }
    if (this.key(data, "right")) {
      this.toggleSelected(true);
      return;
    }
    if (this.key(data, "left")) {
      this.collapseOrParent();
      return;
    }
    if (/^[1-6]$/.test(data)) {
      this.selectTab(Number(data) - 1);
      return;
    }
    if (data === "j" || this.key(data, "down")) this.moveSelection(1);
    else if (data === "k" || this.key(data, "up")) this.moveSelection(-1);
    else if (this.key(data, "pageDown")) this.moveSelection(Math.max(1, this.pageSize() - 2));
    else if (this.key(data, "pageUp")) this.moveSelection(-Math.max(1, this.pageSize() - 2));
    else if (this.key(data, "home")) this.selectBoundary(false);
    else if (this.key(data, "end")) this.selectBoundary(true);
    else if (this.key(data, "enter") || this.key(data, "return")) this.toggleSelected(false);
    else if (data === "m" || data === "M") this.cycleMetric();
    else if (data === "s" || data === "S") this.cycleSort();
    else if (data === "c" || data === "C") this.openCopy();
    else if (data === "d" || data === "D") this.openPreview("selection", true);
    else if (data === "f" || data === "F") this.cycleScope();
    else if (data === "b" || data === "B") this.markSnapshot();
    else if (data === "w" || data === "W") {
      if (!this.bookmark) { this.toast = "No bookmark. Press b to mark this snapshot first."; this.requestRender(); }
      else { this.sinceBookmark = !this.sinceBookmark; this.applyScope(); }
    }
    else if (data === "?" || data === "h" || data === "H") this.openHelp();
    else if (data === "r" || data === "R") void this.refresh();
  }

  render(maxWidth) {
    return renderExplorer(this, maxWidth, TABS);
  }

  dispose() {
    this.closed = true;
  }
}

export { TABS };
