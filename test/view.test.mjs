import test from "node:test";
import assert from "node:assert/strict";
import { CostExplorerView, PANEL_HEIGHT_RATIO, TABS } from "../view.js";
import { stripAnsi, textWidth } from "../format.js";
import { fixtureReport } from "./report-fixture.mjs";

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bold(text) { return String(text); },
    bgFill(_color, text) { return String(text); },
    fgOnBg(_foreground, _background, text) { return String(text); },
    inverse(text) { return String(text); },
  };
}

function contrastTheme() {
  return {
    fg(_color, text) { return `\x1b[37m${String(text)}\x1b[0m`; },
    bold(text) { return `\x1b[1m${String(text)}\x1b[0m`; },
    bgFill(_color, text) { return `\x1b[48;5;230m${String(text)}\x1b[0m`; },
    fgOnBg(_foreground, _background, text) { return `\x1b[38;5;16m${String(text)}\x1b[0m`; },
    inverse(text) { return `\x1b[7m${String(text)}\x1b[0m`; },
  };
}

function view(callbacks = {}, done = () => {}, options = {}) {
  return new CostExplorerView(
    { terminal: { rows: options.rows ?? 60 }, requestRender() {} },
    options.theme ?? plainTheme(),
    { matches: () => false },
    fixtureReport(),
    callbacks,
    done,
  );
}

test("explorer exposes six agreed tabs", () => {
  assert.deepEqual(TABS.map(tab => tab.label), ["Overview", "Providers", "Models", "Agents", "Advisors", "Details"]);
});

test("overview labels CALL%, TOK%, and COST% explicitly", () => {
  const rendered = view().render(120).join("\n");
  assert.match(rendered, /CALL%/);
  assert.match(rendered, /TOK%/);
  assert.match(rendered, /COST%/);
  assert.match(rendered, /Cache-read ratio/);
});

test("cost explorer stays within the lower half and avoids full-page blank padding", () => {
  const explorer = view({}, () => {}, { rows: 60 });
  const rendered = explorer.render(160);
  assert.ok(rendered.length <= Math.floor(60 * PANEL_HEIGHT_RATIO));
  assert.ok(rendered.length < 60 / 2);
});

test("Tab and Shift+Tab switch tabs while arrow keys drill down", () => {
  const explorer = view();
  explorer.handleInput("\t");
  assert.equal(explorer.currentTab().id, "providers");
  explorer.handleInput("\u001b[Z");
  assert.equal(explorer.currentTab().id, "overview");
  explorer.handleInput("\t");
  const before = explorer.tabState(explorer.expanded).size;
  explorer.handleInput("\u001b[C");
  assert.ok(explorer.tabState(explorer.expanded).size > before);
  assert.match(explorer.render(160).join("\n"), /Models · percentages below are share of/);
});

test("Providers and Models use explicit wide-table columns instead of a distant unlabeled suffix", () => {
  const explorer = view();
  explorer.selectTab(1);
  explorer.handleInput("\r");
  const rendered = explorer.render(160).join("\n");
  assert.match(rendered, /NAME\s+CALLS\s+TOKENS\s+COST\s+COST%\s+DISTRIBUTION/);
  assert.doesNotMatch(rendered, /calls ·/);
  assert.match(rendered, /Models · percentages below are share of/);
});

test("active metric changes the labeled share column", () => {
  const explorer = view();
  explorer.selectTab(1);
  assert.match(explorer.render(160).join("\n"), /COST%/);
  explorer.handleInput("m");
  assert.match(explorer.render(160).join("\n"), /TOK%/);
  explorer.handleInput("m");
  assert.match(explorer.render(160).join("\n"), /CALL%/);
});

test("Models drill into agent attribution", () => {
  const explorer = view();
  explorer.selectTab(2);
  explorer.handleInput("\r");
  const rendered = explorer.render(160).join("\n");
  assert.match(rendered, /Used by agents/);
  assert.match(rendered, /\[MAIN\]|\[SUB\]|\[ADV\]/);
});

test("Agents are grouped and expand to model attribution", () => {
  const explorer = view();
  explorer.selectTab(3);
  let rendered = explorer.render(160).join("\n");
  assert.match(rendered, /MAIN/);
  assert.match(rendered, /SUBAGENTS/);
  explorer.handleInput("\r");
  rendered = explorer.render(160).join("\n");
  assert.match(rendered, /Models · percentages below are share of this agent/);
});

test("Advisors expose behavior metrics and owner attribution", () => {
  const explorer = view({}, () => {}, { rows: 70 });
  explorer.selectTab(4);
  explorer.handleInput("\r");
  const rendered = explorer.render(160).join("\n");
  assert.match(rendered, /Review updates/);
  assert.match(rendered, /LLM calls \/ review/);
  assert.match(rendered, /Advise tool calls/);
  assert.match(rendered, /Primary follow-ups/);
  assert.match(rendered, /main/);
});

test("selected rows resolve a foreground against selectedBg instead of preserving low-contrast ANSI colors", () => {
  const explorer = view({}, () => {}, { rows: 60, theme: contrastTheme() });
  const selectedLine = explorer.render(120).find(line => stripAnsi(line).includes("›") && /Main|Subagents|Advisors/.test(stripAnsi(line)));
  assert.ok(selectedLine);
  assert.match(selectedLine, /\x1b\[48;5;230m/);
  assert.match(selectedLine, /\x1b\[38;5;16m/);
});

test("metric key cycles Cost, Tokens, and Calls", () => {
  const explorer = view();
  assert.equal(explorer.metric, "cost");
  explorer.handleInput("m");
  assert.equal(explorer.metric, "tokens");
  explorer.handleInput("m");
  assert.equal(explorer.metric, "calls");
  explorer.handleInput("m");
  assert.equal(explorer.metric, "cost");
});

test("sort key toggles metric and name ordering", () => {
  const explorer = view();
  assert.equal(explorer.sortMode, "metric");
  explorer.handleInput("s");
  assert.equal(explorer.sortMode, "name");
  explorer.handleInput("s");
  assert.equal(explorer.sortMode, "metric");
});

test("each tab preserves its own selected row", () => {
  const explorer = view();
  explorer.selectTab(1);
  explorer.handleInput("j");
  const providerSelection = explorer.selected.get("providers");
  explorer.selectTab(2);
  const modelSelection = explorer.selectedId(explorer.buildRows());
  explorer.selectTab(1);
  assert.equal(explorer.selected.get("providers"), providerSelection);
  assert.notEqual(providerSelection, modelSelection);
});

test("copy menu invokes selected export callback", async () => {
  let copied = null;
  const explorer = view({
    async onCopy(mode, context) {
      copied = { mode, context };
      return { message: "done" };
    },
  });
  explorer.handleInput("c");
  assert.equal(explorer.modal, "copy");
  explorer.handleInput("\r");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied.mode, "brief");
  assert.equal(explorer.modal, null);
  assert.match(explorer.toast, /done/);
});

test("OMP/Kitty Escape closes Help and Copy modals without closing the explorer", () => {
  const matchesKey = (data, key) => data === "KITTY_ESCAPE" && (key === "escape" || key === "esc");
  const explorer = view({ matchesKey });

  explorer.handleInput("?");
  assert.equal(explorer.modal, "help");
  explorer.handleInput("KITTY_ESCAPE");
  assert.equal(explorer.modal, null);
  assert.equal(explorer.closed, false);

  explorer.handleInput("c");
  assert.equal(explorer.modal, "copy");
  explorer.handleInput("KITTY_ESCAPE");
  assert.equal(explorer.modal, null);
  assert.equal(explorer.closed, false);
});

test("refresh callback replaces report without closing overlay", async () => {
  const explorer = view({
    async onRefresh() {
      const report = fixtureReport();
      report.sessionId = "refreshed";
      return report;
    },
  });
  explorer.handleInput("r");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(explorer.report.sessionId, "refreshed");
  assert.equal(explorer.closed, false);
});

test("Escape collapses an expanded row before closing", () => {
  let closed = false;
  const explorer = view({}, () => { closed = true; });
  explorer.selectTab(1);
  explorer.handleInput("\r");
  assert.equal(explorer.tabState(explorer.expanded).size, 1);
  explorer.handleInput("\u001b");
  assert.equal(explorer.tabState(explorer.expanded).size, 0);
  assert.equal(closed, false);
  explorer.handleInput("\u001b");
  assert.equal(closed, true);
});

test("render cache invalidates when terminal height changes", () => {
  const explorer = view({}, () => {}, { rows: 60 });
  const first = explorer.render(120);
  explorer.tui.terminal.rows = 30;
  const second = explorer.render(120);
  assert.notStrictEqual(second, first);
  assert.ok(second.length <= Math.floor(30 * PANEL_HEIGHT_RATIO));
});

test("rendering remains bounded across narrow, transition, and wide column counts", () => {
  const explorer = view();
  explorer.selectTab(1);
  explorer.handleInput("\r");
  for (const width of [60, 72, 80, 94, 100, 120, 160]) {
    for (const line of explorer.render(width)) assert.ok(textWidth(line) <= width, `${textWidth(line)} > ${width}: ${line}`);
  }
});
