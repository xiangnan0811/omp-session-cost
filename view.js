import {
  formatCost,
  formatInt,
  metricValue,
  percent,
  sortRows,
} from "./format.js";
import { copyOptions } from "./export.js";
import {
  advisorRows,
  agentRows,
  detailsRows,
  modelRows,
  overviewRows,
  providerRows,
} from "./view-pages.js";
import { renderExplorer } from "./view-render.js";

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

function noop() {}

export class CostExplorerView {
  constructor(tui, theme, keybindings, report, callbacks = {}, done = noop) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.report = report;
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
  }

  requestRender() {
    this.invalidate();
    this.tui?.requestRender?.();
  }

  pageSize() {
    const rows = Number.isFinite(this.tui?.terminal?.rows) ? this.tui.terminal.rows : 40;
    return Math.max(9, rows - 7);
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

  separator() {
    return { text: "", selectable: false };
  }

  buildRows(width = this.lastWidth - 4) {
    const id = this.currentTab().id;
    if (id === "overview") return overviewRows(this, width);
    if (id === "providers") return providerRows(this);
    if (id === "models") return modelRows(this);
    if (id === "agents") return agentRows(this);
    if (id === "advisors") return advisorRows(this);
    return detailsRows(this);
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
    this.requestRender();
  }

  openHelp() {
    this.modal = "help";
    this.requestRender();
  }

  async runCopy() {
    const option = copyOptions()[this.modalIndex];
    if (!option) return;
    const selection = this.currentSelection();
    const tabId = this.currentTab().id;
    this.modal = null;
    this.toast = "Copying…";
    this.requestRender();
    try {
      const result = await this.callbacks.onCopy?.(option.id, { selection, tabId });
      this.toast = result?.message ?? `${option.label} copied`;
    } catch (error) {
      this.toast = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
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
        this.report = report;
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
    if (data === "\u001b" || data === "q" || data === "Q") {
      this.modal = null;
      this.requestRender();
      return true;
    }
    if (this.modal === "help") return true;
    const options = copyOptions();
    if (data === "j" || data === "\u001b[B" || data === "\u001bOB") {
      this.modalIndex = Math.min(options.length - 1, this.modalIndex + 1);
      this.requestRender();
      return true;
    }
    if (data === "k" || data === "\u001b[A" || data === "\u001bOA") {
      this.modalIndex = Math.max(0, this.modalIndex - 1);
      this.requestRender();
      return true;
    }
    if (data === "\r" || data === "\n") {
      void this.runCopy();
      return true;
    }
    return true;
  }

  handleInput(data) {
    if (this.closed) return;
    if (this.modal) {
      this.handleModalInput(data);
      return;
    }
    if (this.keybindings?.matches?.(data, "app.interrupt") || data === "\u0003") {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (data === "q" || data === "Q") {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (data === "\u001b") {
      if (!this.collapseOrParent()) {
        this.closed = true;
        this.done(undefined);
      }
      return;
    }
    if (data === "\t") {
      this.switchTab(1);
      return;
    }
    if (data === "\u001b[Z") {
      this.switchTab(-1);
      return;
    }
    if (data === "\u001b[C" || data === "\u001bOC") {
      this.toggleSelected(true);
      return;
    }
    if (data === "\u001b[D" || data === "\u001bOD") {
      this.collapseOrParent();
      return;
    }
    if (/^[1-6]$/.test(data)) {
      this.selectTab(Number(data) - 1);
      return;
    }
    if (data === "j" || data === "\u001b[B" || data === "\u001bOB") this.moveSelection(1);
    else if (data === "k" || data === "\u001b[A" || data === "\u001bOA") this.moveSelection(-1);
    else if (data === "\u001b[6~") this.moveSelection(Math.max(1, this.pageSize() - 2));
    else if (data === "\u001b[5~") this.moveSelection(-Math.max(1, this.pageSize() - 2));
    else if (data === "\u001b[H" || data === "\u001b[1~" || data === "\u001bOH") this.selectBoundary(false);
    else if (data === "\u001b[F" || data === "\u001b[4~" || data === "\u001bOF") this.selectBoundary(true);
    else if (data === "\r" || data === "\n") this.toggleSelected(false);
    else if (data === "m" || data === "M") this.cycleMetric();
    else if (data === "s" || data === "S") this.cycleSort();
    else if (data === "c" || data === "C") this.openCopy();
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
