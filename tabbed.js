import coreCostExtension from "./index.js";

const COMMAND = "cost";

function visibleChars(text) {
  return Array.from(String(text).replace(/\t/g, "    "));
}

function fit(text, width) {
  if (width <= 0) return "";
  const chars = visibleChars(text);
  if (chars.length <= width) return chars.join("").padEnd(width, " ");
  if (width <= 3) return chars.slice(0, width).join("");
  return `${chars.slice(0, width - 3).join("")}...`;
}

function textWidth(text) {
  return visibleChars(text).length;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start]).trim()) start += 1;
  while (end > start && !String(lines[end - 1]).trim()) end -= 1;
  return lines.slice(start, end);
}

function headingIndex(lines, heading) {
  return lines.findIndex(line => String(line).trim() === heading);
}

function sectionBody(lines, heading, nextHeading) {
  const start = headingIndex(lines, heading);
  if (start < 0) return [];
  const end = nextHeading ? headingIndex(lines, nextHeading) : lines.length;
  const stop = end >= 0 ? end : lines.length;
  let bodyStart = start + 1;
  if (bodyStart < stop && /^-+$/.test(String(lines[bodyStart]).trim())) bodyStart += 1;
  return trimBlankEdges(lines.slice(bodyStart, stop));
}

function requestSummaryFromMetadata(lines) {
  const meta = lines.find(line => /Requests:\s*\d+/i.test(String(line)));
  if (!meta) return [];
  const requests = String(meta).match(/Requests:\s*(\d+)/i)?.[1];
  const failed = String(meta).match(/Failed:\s*(\d+)/i)?.[1];
  const out = [];
  if (requests) out.push(`Requests              ${requests.padStart(12)}`);
  if (failed) out.push(`Failed requests       ${failed.padStart(12)}`);
  return out;
}

export function splitReportLines(lines) {
  const source = Array.isArray(lines) ? lines.map(line => String(line)) : [];
  const summaryIndex = headingIndex(source, "SUMMARY");
  const modelIndex = headingIndex(source, "BY MODEL");
  const agentIndex = headingIndex(source, "BY AGENT");
  const pairIndex = headingIndex(source, "AGENT x MODEL");
  const pricingIndex = headingIndex(source, "PRICING SOURCE");

  if (summaryIndex < 0 || modelIndex < 0 || agentIndex < 0 || pairIndex < 0) {
    return [{ id: "overview", label: "Overview", shortLabel: "Overview", lines: source }];
  }

  const metadata = trimBlankEdges(source.slice(0, summaryIndex));
  const overview = trimBlankEdges(source.slice(summaryIndex, modelIndex));
  const requestSummary = requestSummaryFromMetadata(metadata);
  if (requestSummary.length) {
    const insertAt = overview[0] === "SUMMARY" && /^-+$/.test(overview[1] || "") ? 2 : 0;
    overview.splice(insertAt, 0, ...requestSummary);
  }

  const models = sectionBody(source, "BY MODEL", "BY AGENT");
  const agents = sectionBody(source, "BY AGENT", "AGENT x MODEL");
  const pairs = sectionBody(source, "AGENT x MODEL", pricingIndex >= 0 ? "PRICING SOURCE" : null);

  const details = ["SESSION", "-------", ...metadata];
  if (pricingIndex >= 0) details.push("", ...trimBlankEdges(source.slice(pricingIndex)));

  return [
    { id: "overview", label: "Overview", shortLabel: "Overview", lines: overview },
    { id: "models", label: "Models", shortLabel: "Models", lines: models },
    { id: "agents", label: "Agents", shortLabel: "Agents", lines: agents },
    { id: "agent-model", label: "Agent x Model", shortLabel: "A×M", lines: pairs },
    { id: "details", label: "Details", shortLabel: "Details", lines: trimBlankEdges(details) },
  ];
}

export class TabbedCostReportView {
  constructor(tui, keybindings, tabs, done) {
    this.tui = tui;
    this.keybindings = keybindings;
    this.tabs = tabs;
    this.done = done;
    this.activeTab = 0;
    this.offsets = tabs.map(() => 0);
    this.lastRendered = null;
    this.lastWidth = -1;
  }

  currentTab() {
    return this.tabs[this.activeTab] || { label: "", shortLabel: "", lines: [] };
  }

  currentLines() {
    return this.currentTab().lines || [];
  }

  currentOffset() {
    return this.offsets[this.activeTab] || 0;
  }

  setCurrentOffset(value) {
    this.offsets[this.activeTab] = Math.max(0, Math.min(this.maxOffset(), value));
  }

  pageSize() {
    const rows = Number.isFinite(this.tui?.terminal?.rows) ? this.tui.terminal.rows : 40;
    return Math.max(8, Math.min(32, rows - 7));
  }

  maxOffset() {
    return Math.max(0, this.currentLines().length - this.pageSize());
  }

  move(delta) {
    this.setCurrentOffset(this.currentOffset() + delta);
    this.invalidate();
    this.tui?.requestRender?.();
  }

  switchTab(delta) {
    if (!this.tabs.length) return;
    this.activeTab = (this.activeTab + delta + this.tabs.length) % this.tabs.length;
    this.setCurrentOffset(this.currentOffset());
    this.invalidate();
    this.tui?.requestRender?.();
  }

  selectTab(index) {
    if (index < 0 || index >= this.tabs.length || index === this.activeTab) return;
    this.activeTab = index;
    this.setCurrentOffset(this.currentOffset());
    this.invalidate();
    this.tui?.requestRender?.();
  }

  handleInput(data) {
    if (this.keybindings?.matches?.(data, "app.interrupt") || data === "q" || data === "Q" || data === "\u001b" || data === "\u0003") {
      this.done(undefined);
      return;
    }

    if (data === "\t" || data === "\u001b[C" || data === "\u001bOC") {
      this.switchTab(1);
      return;
    }
    if (data === "\u001b[Z" || data === "\u001b[D" || data === "\u001bOD") {
      this.switchTab(-1);
      return;
    }
    if (/^[1-5]$/.test(data)) {
      this.selectTab(Number(data) - 1);
      return;
    }

    if (data === "j" || data === "\u001b[B" || data === "\u001bOB") this.move(1);
    else if (data === "k" || data === "\u001b[A" || data === "\u001bOA") this.move(-1);
    else if (data === "\u001b[6~") this.move(this.pageSize() - 2);
    else if (data === "\u001b[5~") this.move(-(this.pageSize() - 2));
    else if (data === "\u001b[H" || data === "\u001b[1~" || data === "\u001bOH") this.move(-this.currentOffset());
    else if (data === "\u001b[F" || data === "\u001b[4~" || data === "\u001bOF") this.move(this.maxOffset() - this.currentOffset());
  }

  invalidate() {
    this.lastRendered = null;
    this.lastWidth = -1;
  }

  tabBar(width) {
    const render = key => this.tabs.map((tab, index) => {
      const label = tab[key] || tab.label;
      return index === this.activeTab ? `[${label}]` : ` ${label} `;
    }).join("  ");
    const full = render("label");
    return textWidth(full) <= width ? full : render("shortLabel");
  }

  render(width) {
    if (this.lastRendered && this.lastWidth === width) return this.lastRendered;
    const w = Math.max(10, width);
    const inner = Math.max(6, w - 4);
    const page = this.pageSize();
    this.setCurrentOffset(this.currentOffset());
    const lines = this.currentLines();
    const offset = this.currentOffset();
    const visible = lines.slice(offset, offset + page);
    const out = [];

    out.push(`+${"-".repeat(Math.max(1, w - 2))}+`);
    out.push(`| ${fit("SESSION COST  main + recursive subagents + advisors", inner)} |`);
    out.push(`| ${fit(this.tabBar(inner), inner)} |`);
    out.push(`| ${fit("", inner)} |`);
    for (const line of visible) out.push(`| ${fit(line, inner)} |`);
    for (let i = visible.length; i < page; i += 1) out.push(`| ${" ".repeat(inner)} |`);

    const first = lines.length ? offset + 1 : 0;
    const last = Math.min(lines.length, offset + page);
    const footer = `Tab/Shift+Tab ←/→ switch  ↑/↓ j/k scroll  PgUp/PgDn  1-5 tabs  q/Esc close  ${first}-${last}/${lines.length}`;
    out.push(`| ${fit(footer, inner)} |`);
    out.push(`+${"-".repeat(Math.max(1, w - 2))}+`);

    this.lastWidth = width;
    this.lastRendered = out;
    return out;
  }
}

function bindForwarded(value, target) {
  return typeof value === "function" ? value.bind(target) : value;
}

function captureCoreCommand(pi) {
  let command = null;
  const proxy = new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand") {
        return (name, spec) => {
          if (name === COMMAND) command = spec;
          else target.registerCommand(name, spec);
        };
      }
      return bindForwarded(Reflect.get(target, property, target), target);
    },
  });

  coreCostExtension(proxy);
  if (!command) throw new Error("omp-session-cost core did not register /cost");
  return command;
}

function tabbedContext(ctx) {
  if (!ctx?.ui || typeof ctx.ui.custom !== "function") return ctx;

  const ui = new Proxy(ctx.ui, {
    get(target, property) {
      if (property === "custom") {
        return async (factory, options) => target.custom(
          (tui, theme, keybindings, done) => {
            const legacyView = factory(tui, theme, keybindings, done);
            const lines = Array.isArray(legacyView?.lines) ? legacyView.lines : null;
            if (!lines) return legacyView;
            return new TabbedCostReportView(tui, keybindings, splitReportLines(lines), done);
          },
          options,
        );
      }
      return bindForwarded(Reflect.get(target, property, target), target);
    },
  });

  return new Proxy(ctx, {
    get(target, property) {
      if (property === "ui") return ui;
      return bindForwarded(Reflect.get(target, property, target), target);
    },
  });
}

export default function tabbedCostExtension(pi) {
  const coreCommand = captureCoreCommand(pi);
  pi.registerCommand(COMMAND, {
    ...coreCommand,
    handler: async (args, ctx) => coreCommand.handler(args, tabbedContext(ctx)),
  });
}
