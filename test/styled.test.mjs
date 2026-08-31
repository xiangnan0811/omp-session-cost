import test from "node:test";
import assert from "node:assert/strict";
import styledCostExtension, { StyledCostReportView } from "../styled.js";

test("styled public entry registers /cost", () => {
  const commands = new Map();
  styledCostExtension({ registerCommand(name, spec) { commands.set(name, spec); } });
  assert.equal(typeof commands.get("cost")?.handler, "function");
});

test("styled view groups agent models and emits theme output", () => {
  const ansi = (name, text) => `<${name}>${text}</${name}>`;
  const theme = { fg: ansi, bold: text => `<b>${text}</b>` };
  const tabs = [
    { id: "overview", label: "Overview", shortLabel: "Overview", lines: ["SUMMARY", "-------", "API-equivalent cost        $8.00"] },
    { id: "models", label: "Models", shortLabel: "Models", lines: ["xai/grok", "  10 req  1.0M tok  50.0%  $6.00  75.0%", "openai/sol", "  5 req  500K tok  25.0%  $2.00  25.0%"] },
    { id: "agents", label: "Agents", shortLabel: "Agents", lines: ["reviewer", "  15 req  1.5M tok  75.0%  $8.00  100.0%"] },
    { id: "agent-model", label: "Agent x Model", shortLabel: "A×M", lines: ["reviewer @ xai/grok", "  10 req  1.0M tok  50.0%  $6.00  75.0%", "reviewer @ openai/sol", "  5 req  500K tok  25.0%  $2.00  25.0%"] },
    { id: "details", label: "Details", shortLabel: "Details", lines: ["SESSION", "-------", "Root: /tmp/a.jsonl"] },
  ];
  const view = new StyledCostReportView({ terminal: { rows: 30 }, requestRender() {} }, { matches: () => false }, tabs, () => {}, theme);
  view.selectTab(2);
  assert.match(view.render(120).join("\n"), /dominant.*xai\/grok/);
  view.selectTab(3);
  const rendered = view.render(120).join("\n");
  assert.match(rendered, /reviewer/);
  assert.match(rendered, /xai\/grok/);
  assert.match(rendered, /openai\/sol/);
  assert.match(rendered, /<accent>/);
});
