import tabbedCostExtension, { TabbedCostReportView } from "./tabbed.js";

const COMMAND = "cost";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PALETTE = ["accent", "success", "warning", "mdLink", "mdCode", "thinkingMedium", "thinkingHigh", "toolTitle"];

const strip = value => String(value).replace(ANSI, "");
const width = value => Array.from(strip(value).replace(/\t/g, "    ")).reduce((n, ch) => n + (/^[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]$/.test(ch) || ch.codePointAt(0) >= 0x1f300 ? 2 : 1), 0);
const paint = (theme, color, text) => { try { return theme?.fg?.(color, String(text)) ?? String(text); } catch { return String(text); } };
const strong = (theme, text) => { try { return theme?.bold?.(String(text)) ?? String(text); } catch { return String(text); } };
const muted = (theme, text) => paint(theme, "muted", text);
const dim = (theme, text) => paint(theme, "dim", text);

function clip(text, max) {
  const source = String(text).replace(/\t/g, "    ");
  if (width(source) <= max) return source;
  if (max <= 1) return "…";
  let out = "", used = 0, match;
  const tokens = /(\x1b\[[0-?]*[ -/]*[@-~])|([\s\S])/g;
  while ((match = tokens.exec(source))) {
    if (match[1]) { out += match[1]; continue; }
    const w = width(match[2]);
    if (used + w > max - 1) break;
    out += match[2]; used += w;
  }
  return `${out}\x1b[0m…`;
}

function fit(text, max) {
  const clipped = clip(text, max);
  return `${clipped}${" ".repeat(Math.max(0, max - width(clipped)))}`;
}

function parseMetric(line) {
  const m = String(line).match(/^\s*(\d+)\s+req\s+(\S+)\s+tok\s+(\d+(?:\.\d+)?%)\s+(\$\S+)\s+(\d+(?:\.\d+)?%)(?:\s+(\d+)\s+failed)?\s*$/);
  return m ? { requests: +m[1], tokens: m[2], tokenShare: m[3], cost: m[4], costShare: m[5], failed: +(m[6] || 0) } : null;
}

function rows(lines) {
  const out = [];
  for (let i = 0; i < (lines?.length || 0); i += 1) {
    const title = String(lines[i] || "").trim();
    const metric = parseMetric(lines[i + 1]);
    if (title && metric) { out.push({ title, ...metric }); i += 1; }
  }
  return out;
}

const money = value => Number(String(value).replace(/[$,]/g, "")) || 0;
const share = value => Number(String(value).replace("%", "")) || 0;

function pairTitle(title) {
  const i = String(title).lastIndexOf(" @ ");
  return i < 0 ? { agent: String(title), model: "unknown" } : { agent: title.slice(0, i), model: title.slice(i + 3) };
}

function bar(theme, percent, color, cells = 10) {
  const filled = Math.round(Math.max(0, Math.min(100, share(percent))) / 100 * cells);
  return `${paint(theme, color, "━".repeat(filled))}${dim(theme, "─".repeat(cells - filled))}`;
}

function metricLine(theme, row, color, max) {
  const failed = row.failed ? ` ${paint(theme, "error", `${row.failed} failed`)}` : "";
  if (max >= 88) return `${muted(theme, `${row.requests} req`)}  ${paint(theme, color, strong(theme, row.tokens))} tok ${dim(theme, row.tokenShare)}  ${paint(theme, "warning", strong(theme, row.cost))} ${dim(theme, row.costShare)}  ${bar(theme, row.costShare, color)}${failed}`;
  if (max >= 62) return `${muted(theme, `${row.requests} req`)}  ${paint(theme, color, strong(theme, row.tokens))} tok ${dim(theme, row.tokenShare)}  ${paint(theme, "warning", strong(theme, row.cost))} ${dim(theme, row.costShare)}${failed}`;
  return `${paint(theme, color, strong(theme, row.tokens))} tok  ${paint(theme, "warning", strong(theme, row.cost))}${failed}`;
}

function stylePlain(theme, line, details = false) {
  const text = String(line), t = text.trim();
  if (!t) return "";
  if (/^[A-Z][A-Z x×]+$/.test(t)) return paint(theme, "accent", strong(theme, t));
  if (/^-+$/.test(t)) return dim(theme, t);
  if (details && /^(Session|Root|Files|stats\.db):/i.test(t)) {
    const i = text.indexOf(":");
    return `${muted(theme, text.slice(0, i + 1))}${paint(theme, /Root|stats\.db/i.test(text.slice(0, i)) ? "mdCode" : "text", text.slice(i + 1))}`;
  }
  if (/stats sync:\s*ok/i.test(t)) return paint(theme, "success", text);
  if (/warning|failed|error/i.test(t)) return paint(theme, "warning", text);
  if (/API-equivalent cost/i.test(t)) return paint(theme, "warning", strong(theme, text));
  if (/^Notes:/i.test(t)) return muted(theme, text);
  return paint(theme, "text", text);
}

export class StyledCostReportView extends TabbedCostReportView {
  constructor(tui, keybindings, tabs, done, theme) {
    super(tui, keybindings, tabs, done);
    this.theme = theme;
    this.modelRows = rows(tabs.find(t => t.id === "models")?.lines);
    this.agentRows = rows(tabs.find(t => t.id === "agents")?.lines);
    this.pairRows = rows(tabs.find(t => t.id === "agent-model")?.lines).map(row => ({ ...row, ...pairTitle(row.title) }));
    this.colors = new Map(this.modelRows.map((row, i) => [row.title, PALETTE[i % PALETTE.length]]));
    this.dominant = new Map();
    for (const row of this.pairRows) {
      const old = this.dominant.get(row.agent);
      if (!old || money(row.cost) > money(old.cost)) this.dominant.set(row.agent, row);
    }
    const byAgent = new Map();
    for (const row of this.pairRows) {
      const list = byAgent.get(row.agent) || [];
      list.push(row); byAgent.set(row.agent, list);
    }
    for (const list of byAgent.values()) list.sort((a, b) => money(b.cost) - money(a.cost));
    const totals = new Map(this.agentRows.map(row => [row.title, row]));
    const order = [...this.agentRows.map(row => row.title), ...[...byAgent.keys()].filter(agent => !totals.has(agent))];
    this.groups = order.filter(agent => byAgent.has(agent)).map(agent => ({ agent, total: totals.get(agent), rows: byAgent.get(agent) }));
  }

  color(model) { return this.colors.get(model) || "accent"; }

  currentLines() {
    const tab = this.currentTab();
    if (tab.id === "models") return this.renderModels();
    if (tab.id === "agents") return this.renderAgents();
    if (tab.id === "agent-model") return this.renderPairs();
    return (tab.lines || []).map(line => stylePlain(this.theme, line, tab.id === "details"));
  }

  renderModels() {
    if (!this.modelRows.length) return this.currentTab().lines || [];
    const out = [];
    this.modelRows.forEach((row, i) => {
      const color = this.color(row.title);
      out.push(`${paint(this.theme, color, "●")} ${paint(this.theme, color, strong(this.theme, row.title))}`);
      out.push(`  ${metricLine(this.theme, row, color, 100)}`);
      if (i < this.modelRows.length - 1) out.push("");
    });
    return out;
  }

  renderAgents() {
    if (!this.agentRows.length) return this.currentTab().lines || [];
    const out = [];
    for (const row of this.agentRows) {
      const dominant = this.dominant.get(row.title);
      const color = dominant ? this.color(dominant.model) : "accent";
      const badge = dominant ? `  ${dim(this.theme, "dominant")} ${paint(this.theme, color, `● ${dominant.model}`)}` : "";
      out.push(`${paint(this.theme, "accent", "◆")} ${paint(this.theme, "text", strong(this.theme, row.title))}${badge}`);
      out.push(`  ${metricLine(this.theme, row, color, 100)}`);
    }
    return out;
  }

  renderPairs() {
    if (!this.groups.length) return this.currentTab().lines || [];
    const out = [];
    this.groups.forEach((group, gi) => {
      const suffix = group.total ? `  ${paint(this.theme, "warning", strong(this.theme, group.total.cost))} ${dim(this.theme, group.total.costShare)}` : "";
      out.push(`${paint(this.theme, "accent", "◆")} ${paint(this.theme, "text", strong(this.theme, group.agent))}${suffix}`);
      group.rows.forEach((row, i) => {
        const color = this.color(row.model);
        const branch = i === group.rows.length - 1 ? "└─" : "├─";
        out.push(`  ${dim(this.theme, branch)} ${paint(this.theme, color, "●")} ${paint(this.theme, color, strong(this.theme, row.model))}`);
        out.push(`     ${metricLine(this.theme, row, color, 95)}`);
      });
      if (gi < this.groups.length - 1) out.push("");
    });
    return out;
  }

  tabBar(max) {
    const full = this.tabs.map((tab, i) => i === this.activeTab ? paint(this.theme, "accent", strong(this.theme, `[${tab.label}]`)) : muted(this.theme, ` ${tab.label} `)).join(` ${dim(this.theme, "│")} `);
    if (width(full) <= max) return full;
    return this.tabs.map((tab, i) => i === this.activeTab ? paint(this.theme, "accent", strong(this.theme, `[${tab.shortLabel || tab.label}]`)) : muted(this.theme, ` ${tab.shortLabel || tab.label} `)).join(` ${dim(this.theme, "│")} `);
  }

  render(maxWidth) {
    if (this.lastRendered && this.lastWidth === maxWidth) return this.lastRendered;
    const w = Math.max(10, maxWidth), inner = Math.max(6, w - 4), page = this.pageSize();
    this.setCurrentOffset(this.currentOffset());
    const lines = this.currentLines(), offset = this.currentOffset(), visible = lines.slice(offset, offset + page);
    const edge = text => paint(this.theme, "borderMuted", text), accentEdge = text => paint(this.theme, "borderAccent", text);
    const row = content => `${edge("│")} ${fit(content, inner)} ${edge("│")}`;
    const out = [
      accentEdge(`┌${"─".repeat(Math.max(1, w - 2))}┐`),
      row(`${paint(this.theme, "accent", "◆")} ${paint(this.theme, "accent", strong(this.theme, "SESSION COST"))}${muted(this.theme, "  main + recursive subagents + advisors")}`),
      row(this.tabBar(inner)), row(""),
      ...visible.map(row),
      ...Array.from({ length: Math.max(0, page - visible.length) }, () => row("")),
    ];
    const first = lines.length ? offset + 1 : 0, last = Math.min(lines.length, offset + page);
    out.push(row(muted(this.theme, `Tab/Shift+Tab ←/→ switch  ↑/↓ j/k scroll  PgUp/PgDn  1-5 tabs  q/Esc close  ${first}-${last}/${lines.length}`)));
    out.push(accentEdge(`└${"─".repeat(Math.max(1, w - 2))}┘`));
    this.lastWidth = maxWidth; this.lastRendered = out;
    return out;
  }
}

const bound = (value, target) => typeof value === "function" ? value.bind(target) : value;

function capture(pi) {
  let command;
  const proxy = new Proxy(pi, { get(target, property) {
    if (property === "registerCommand") return (name, spec) => { if (name === COMMAND) command = spec; else target.registerCommand(name, spec); };
    return bound(Reflect.get(target, property, target), target);
  }});
  tabbedCostExtension(proxy);
  if (!command) throw new Error("omp-session-cost tabbed entry did not register /cost");
  return command;
}

function themedContext(ctx) {
  if (!ctx?.ui || typeof ctx.ui.custom !== "function") return ctx;
  const ui = new Proxy(ctx.ui, { get(target, property) {
    if (property === "custom") return async (factory, options) => target.custom((tui, theme, keybindings, done) => {
      const view = factory(tui, theme, keybindings, done);
      return Array.isArray(view?.tabs) ? new StyledCostReportView(tui, keybindings, view.tabs, done, theme) : view;
    }, options);
    return bound(Reflect.get(target, property, target), target);
  }});
  return new Proxy(ctx, { get(target, property) { return property === "ui" ? ui : bound(Reflect.get(target, property, target), target); }});
}

export default function styledCostExtension(pi) {
  const command = capture(pi);
  pi.registerCommand(COMMAND, { ...command, handler: async (args, ctx) => command.handler(args, themedContext(ctx)) });
}
