import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import tabbedCostExtension, { splitReportLines, TabbedCostReportView } from "../tabbed.js";

test("public entry registers /cost without eager OMP runtime imports", () => {
  const commands = new Map();
  const pi = { registerCommand(name, spec) { commands.set(name, spec); } };
  tabbedCostExtension(pi);
  assert.equal(commands.has("cost"), true);
  assert.equal(typeof commands.get("cost")?.handler, "function");
});

test("manifest points to the tabbed public entry", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.omp.extensions, ["./tabbed.js"]);
});

test("flat core report is split into five priority-ordered tabs", () => {
  const lines = [
    "Session: session-123", "Root:    /tmp/session-123.jsonl", "Files:   4   Requests: 12   Failed: 1", "",
    "SUMMARY", "-------", "Measured tokens          10.0M", "API-equivalent cost       $4.20", "",
    "COST BREAKDOWN", "--------------", "Input                     $1.00", "",
    "BY AGENT TYPE", "-------------", "subagent ...", "",
    "BY MODEL", "--------", "openai/model", "  10 req ...", "",
    "BY AGENT", "--------", "reviewer", "  8 req ...", "",
    "AGENT x MODEL", "-------------", "reviewer @ openai/model", "  8 req ...", "",
    "PRICING SOURCE", "--------------", "stats.db       12 request(s)", "stats.db: /tmp/stats.db",
  ];
  const tabs = splitReportLines(lines);
  assert.deepEqual(tabs.map(tab => tab.label), ["Overview", "Models", "Agents", "Agent x Model", "Details"]);
  assert.match(tabs[0].lines.join("\n"), /Requests\s+12/);
  assert.match(tabs[0].lines.join("\n"), /BY AGENT TYPE/);
  assert.doesNotMatch(tabs[0].lines.join("\n"), /session-123|stats\.db/);
  assert.match(tabs[1].lines.join("\n"), /openai\/model/);
  assert.match(tabs[2].lines.join("\n"), /reviewer/);
  assert.match(tabs[3].lines.join("\n"), /reviewer @ openai\/model/);
  assert.match(tabs[4].lines.join("\n"), /session-123/);
  assert.match(tabs[4].lines.join("\n"), /\/tmp\/stats\.db/);
});

test("Tab, Shift+Tab, and arrow keys switch tabs", () => {
  let renders = 0;
  const tui = { terminal: { rows: 30 }, requestRender() { renders += 1; } };
  const keybindings = { matches: () => false };
  const tabs = [
    { label: "Overview", shortLabel: "Overview", lines: ["summary"] },
    { label: "Models", shortLabel: "Models", lines: ["models"] },
    { label: "Agents", shortLabel: "Agents", lines: ["agents"] },
    { label: "Agent x Model", shortLabel: "A×M", lines: ["pairs"] },
    { label: "Details", shortLabel: "Details", lines: ["details"] },
  ];
  const view = new TabbedCostReportView(tui, keybindings, tabs, () => {});
  assert.match(view.render(100).join("\n"), /\[Overview\]/);
  view.handleInput("\t");
  assert.match(view.render(100).join("\n"), /\[Models\]/);
  view.handleInput("\u001b[C");
  assert.match(view.render(100).join("\n"), /\[Agents\]/);
  view.handleInput("\u001b[Z");
  assert.match(view.render(100).join("\n"), /\[Models\]/);
  view.handleInput("\u001b[D");
  assert.match(view.render(100).join("\n"), /\[Overview\]/);
  assert.ok(renders >= 4);
});

test("every tab preserves its own scroll position", () => {
  const tui = { terminal: { rows: 18 }, requestRender() {} };
  const keybindings = { matches: () => false };
  const longLines = Array.from({ length: 40 }, (_, i) => `row-${i}`);
  const view = new TabbedCostReportView(tui, keybindings, [
    { label: "Overview", shortLabel: "Overview", lines: longLines },
    { label: "Models", shortLabel: "Models", lines: longLines },
  ], () => {});
  view.handleInput("\u001b[B");
  view.handleInput("\u001b[B");
  assert.equal(view.currentOffset(), 2);
  view.handleInput("\t");
  assert.equal(view.currentOffset(), 0);
  view.handleInput("\u001b[B");
  assert.equal(view.currentOffset(), 1);
  view.handleInput("\u001b[Z");
  assert.equal(view.currentOffset(), 2);
});
