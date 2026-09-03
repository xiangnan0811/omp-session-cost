import test from "node:test";
import assert from "node:assert/strict";
import { CostExplorerView, TABS } from "../view.js";
import { textWidth } from "../format.js";
import { fixtureReport } from "./report-fixture.mjs";

function theme() {
  return {
    fg(_color, text) { return String(text); },
    bold(text) { return String(text); },
    bgFill(_color, text) { return String(text); },
    inverse(text) { return String(text); },
  };
}

function view(callbacks = {}, done = () => {}) {
  return new CostExplorerView(
    { terminal: { rows: 30 }, requestRender() {} },
    theme(),
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
  assert.match(explorer.render(120).join("\n"), /Models · percentages below are share of/);
});

test("Models drill into agent attribution", () => {
  const explorer = view();
  explorer.selectTab(2);
  explorer.handleInput("\r");
  const rendered = explorer.render(120).join("\n");
  assert.match(rendered, /Used by agents/);
  assert.match(rendered, /\[MAIN\]|\[SUB\]|\[ADV\]/);
});

test("Agents are grouped and expand to model attribution", () => {
  const explorer = view();
  explorer.selectTab(3);
  let rendered = explorer.render(120).join("\n");
  assert.match(rendered, /MAIN/);
  assert.match(rendered, /SUBAGENTS/);
  explorer.handleInput("\r");
  rendered = explorer.render(120).join("\n");
  assert.match(rendered, /Models · percentages below are share of this agent/);
});

test("Advisors expose behavior metrics and owner attribution", () => {
  const explorer = view();
  explorer.selectTab(4);
  explorer.handleInput("\r");
  const rendered = explorer.render(120).join("\n");
  assert.match(rendered, /Review updates/);
  assert.match(rendered, /LLM calls \/ review/);
  assert.match(rendered, /Advise tool calls/);
  assert.match(rendered, /Primary follow-ups/);
  assert.match(rendered, /main/);
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

test("rendering remains bounded at 80, 100, and 120 columns", () => {
  const explorer = view();
  for (const width of [80, 100, 120]) {
    for (const line of explorer.render(width)) assert.ok(textWidth(line) <= width, `${textWidth(line)} > ${width}: ${line}`);
  }
});
