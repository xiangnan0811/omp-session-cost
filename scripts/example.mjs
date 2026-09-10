import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildReport, scopeReport } from "../core.js";
import { buildAiBrief, buildPublicJson } from "../export.js";
import { CostExplorerView } from "../view.js";

const out = path.resolve(process.argv[2] || "dist");
await fs.mkdir(out, { recursive: true });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cost-example-"));
const file = path.join(dir, "example.jsonl");
const timestamp = n => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 1000).toISOString();
const entries = [{ type: "session", version: 3, id: "synthetic-example", timestamp: timestamp(0) }];
let parent = null;
function add(entry) { entry.parentId = parent; parent = entry.id; entries.push(entry); }
function call(id, second, input = 100, cacheRead = 1000) {
  add({ type: "message", id, timestamp: timestamp(second), message: { role: "assistant", provider: "example-provider", model: "example-model", responseId: `response-${id}`, stopReason: "toolUse", content: [{ type: "toolCall", id: `tool-${id}`, name: "hub", arguments: { op: "inbox" } }], usage: {
    input, cacheRead, cacheWrite: 0, output: 20, reasoningTokens: 5,
    cost: { input: input * .000001, cacheRead: cacheRead * .0000001, cacheWrite: 0, output: .00004, total: input * .000001 + cacheRead * .0000001 + .00004 }
  } } });
  add({ type: "message", id: `return-${id}`, timestamp: timestamp(second + 1), message: { role: "toolResult", toolCallId: `tool-${id}`, toolName: "hub", content: [{ type: "text", text: "Inbox empty." }] } });
}
add({ type: "thinking_level_change", id: "medium-history", timestamp: timestamp(0), thinkingLevel: "medium" });
add({ type: "message", id: "task1", timestamp: timestamp(1), message: { role: "user", content: "SYNTHETIC TEST ONLY: finish an example task; preserve acceptance checks." } });
call("first", 2); call("second", 4);
add({ type: "custom_message", id: "incoming", timestamp: timestamp(6), customType: "irc:incoming", details: { severity: "blocker" }, content: "SYNTHETIC: executor needs a main decision; token=sk-secret-sample /home/example/private.txt" });
call("respond", 600);
add({ type: "compaction", id: "compact", timestamp: timestamp(602), tokensBefore: 1100, summary: "Not exported" });
call("after", 604, 50, 100);
try {
  await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  const report = scopeReport(await buildReport(file, { getThinkingLevel: () => "xhigh" }, { model: { provider: "example-provider", id: "example-model" } }), { actorType: "main" });
  const options = { question: "SYNTHETIC EXAMPLE: assess main only", protectedScopes: "Advisor, subagents, independent review and acceptance checks", annotation: "All records in this example are fabricated test fixtures, not a user's session.", includeEvidence: true };
  await fs.writeFile(path.join(out, "example-diagnostic.md"), buildAiBrief(report, options));
  await fs.writeFile(path.join(out, "example-diagnostic.json"), buildPublicJson(report, options));
  const plainTheme = { fg: (_c, t) => t, bold: t => t };
  const view = new CostExplorerView({ terminal: { rows: 40 } }, plainTheme, {}, report, { profile: options });
  const views = ["OVERVIEW\n" + view.render(120).join("\n")];
  view.handleInput("d"); views.push("SUBJECT DETAILS\n" + view.render(120).join("\n"));
  view.handleInput("e"); views.push("EVIDENCE PREVIEW\n" + view.render(120).join("\n"));
  await fs.writeFile(path.join(out, "example-tui.txt"), views.join("\n\n") + "\n");
  console.log(`Synthetic examples written to ${out}`);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
