import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CostExplorerView } from "../view.js";
import { textWidth, stripAnsi } from "../format.js";
import { parseCostArgs, saveReportFile } from "../command.js";
import { buildReport, scopeReport } from "../core.js";
import { buildDiagnosticData } from "../diagnostic-export.js";
import { fixtureReport } from "./report-fixture.mjs";
import { assistant, user, header, advisorCard, writeJsonl, tempDir, removeDir } from "./helpers.mjs";
const theme = { fg: (_c, t) => String(t), bold: t => String(t), bgFill: (_c, t) => String(t), fgOnBg: (_f, _b, t) => String(t) };
const make = (callbacks = {}, report = fixtureReport(), rows = 36) => new CostExplorerView({ terminal: { rows }, requestRender() {} }, theme, {}, report, callbacks);

test("subject detail and preview preserve half-height, wrap, and scroll without losing selection", () => {
  const v = make(); v.selectTab(3); const selected = v.currentSelection().id;
  v.handleInput("d"); assert.equal(v.modal, "subject");
  for (const width of [32, 70, 100, 160]) {
    const output = v.render(width); assert.ok(output.length <= Math.floor(36 * .52));
    assert.ok(output.every(row => textWidth(row) <= width));
  }
  v.handleInput("\x1b[6~"); v.render(100); assert.ok(v.modalOffset > 0);
  v.handleInput("\x1b[F"); v.render(100); assert.ok(v.modalOffset > 20);
  v.handleInput("\x1b"); assert.equal(v.modal, null); assert.equal(v.currentSelection().id, selected);
});

test("preview scope and protected context are reflected in the exact copied payload", async () => {
  let copied, savedProfile;
  const v = make({ onCopy: async (_mode, c) => { copied = c.payload; return { message: "copied" }; }, onProfile: p => savedProfile = p });
  v.handleInput("c"); v.handleInput("\r");
  v.handleInput("f"); assert.equal(v.preview.scope, "main"); assert.equal(v.preview.calls, 1);
  v.handleInput("p"); assert.equal(v.modal, "edit"); v.handleInput("\x15"); v.handleInput("Advisor, subagents, three reviews"); v.handleInput("\r");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(v.modal, "preview"); assert.equal(savedProfile.protectedScopes, "Advisor, subagents, three reviews");
  const preview = v.preview.payload;
  assert.match(preview, /Advisor, subagents, three reviews/);
  v.handleInput("\r"); await new Promise(r => setTimeout(r, 0));
  assert.equal(copied, preview);
  v.handleInput("\x1b"); assert.equal(v.modal, "copy"); v.handleInput("\x1b"); assert.equal(v.modal, null);
});

test("evidence requires an explicit toggle and always remains in local preview before copy", () => {
  const v = make(); v.openPreview("json");
  assert.equal(JSON.parse(v.preview.payload).privacy.mode, "diagnostic-evidence");
  v.handleInput("e"); assert.equal(JSON.parse(v.preview.payload).privacy.mode, "reviewed-excerpts");
  assert.match(v.render(110).map(stripAnsi).join("\n"), /EXCERPTS ON/);
});

test("new-record scope excludes bookmark record identities across refresh; returning to all restores calls", () => {
  const v = make(); v.markSnapshot(); assert.ok(v.bookmark);
  v.handleInput("w"); assert.equal(v.report.total.calls, 0);
  v.handleInput("w"); assert.equal(v.report.total.calls, 4);
});

test("save writes the entire exact preview with restrictive mode and never overwrites an existing file", async () => {
  const dir = await tempDir();
  try {
    const payload = "secret context\n".repeat(9000);
    const out = await saveReportFile("report.md", payload, dir);
    assert.equal(await fs.readFile(out.path, "utf8"), payload);
    if (process.platform !== "win32") assert.equal((await fs.stat(out.path)).mode & 0o777, 0o600);
    await assert.rejects(saveReportFile("report.md", "replacement", dir), /EEXIST/);
    await assert.rejects(saveReportFile("", payload, dir), /valid new file/);
  } finally { await removeDir(dir); }
});

test("command parsing preserves explicit filters without shell expansion", () => {
  const p = parseCostArgs('refresh main from=2026-09-01T00:00:00Z to=2026-09-02T00:00:00Z agent="Frontend Engineer"');
  assert.equal(p.refresh, true); assert.equal(p.options.actorType, "main"); assert.equal(p.options.agent, "Frontend Engineer");
  assert.throws(() => parseCostArgs("--unknown"), /Unknown/);
  assert.throws(() => parseCostArgs("actor=administrator"), /actor must/);
  assert.equal(parseCostArgs("active since").options.branch, "active-main-path");
});

test("advisor-only and model-scoped diagnostics retain related owner deliveries and direct follow-ups", async () => {
  const dir = await tempDir(), root = path.join(dir, "root.jsonl");
  try {
    await writeJsonl(root, [header("root"), advisorCard("card", [{ note: "A concern", severity: "concern" }]), assistant("follow", "openai", "main-model", { parentId: "card" })]);
    await writeJsonl(path.join(dir, "root", "__advisor.jsonl"), [header("adv"), user("u", "delta", { synthetic: true }), assistant("ad", "xai", "grok", { content: [{ type: "toolCall", id: "advise1", name: "advise", arguments: { severity: "concern" } }] })]);
    const report = await buildReport(root);
    const selected = scopeReport(report, { actorType: "advisor" });
    assert.equal(selected.total.calls, 1); assert.equal(selected.advisors[0].deliveredCards, 1);
    assert.equal(selected.advisors[0].primaryFollowupCalls, 1); assert.equal(selected.advisors[0].reviewUpdates, 1);
    assert.equal(selected.advisors[0].requestedSeverity.concern, 1);
    const data = buildDiagnosticData(selected);
    assert.equal(data.advisors[0].directPrimaryFollowups, 1);
    assert.equal(data.total.costTotal, selected.total.costTotal);
  } finally { await removeDir(dir); }
});

test("large excerpt previews are explicitly bounded and cannot silently copy unreviewed tails", async () => {
  let copied = false;
  const v = make({ onCopy: async () => { copied = true; } });
  v.openPreview("json"); v.preview.includeEvidence = true;
  v.preview.payload = "visible\n".repeat(30000); v.preview.wrapCache = null; v.invalidate();
  v.render(80);
  assert.equal(v.preview.wrapCache.truncated, true);
  assert.ok(v.preview.wrapCache.rows.length <= 5001);
  await v.runCopy();
  assert.equal(copied, false); assert.match(v.toast, /save it for full review/);
  assert.equal(v.preview.payload.length, 240000, "only the preview is limited, never the payload");
});

test("new tasks/runtime/comparison tabs stay in the lower-half overlay at narrow widths", () => {
  const v = make();
  for (const tab of [6, 7, 8]) {
    v.selectTab(tab);
    for (const width of [32, 52, 80, 120]) {
      const rendered = v.render(width);
      assert.ok(rendered.length <= Math.floor(36 * .52));
      assert.ok(rendered.every(line => textWidth(line) <= width));
      assert.ok(rendered.join("\n").includes(["任务", "时序", "对比"][tab - 6]));
    }
  }
});

test("persistent baseline write failure does not claim success or replace an existing bookmark", async () => {
  const prior = { name: "已有基线", callKeys: new Set(), eventKeys: new Set(), runtimeKeys: new Set() };
  const v = make({ bookmark: prior, onBookmark: async () => { throw new Error("EACCES"); } });
  await v.markSnapshot();
  assert.equal(v.bookmark, prior); assert.match(v.toast, /失败|failed/);
});

test("original names and schema 4 are present in the frozen copy preview", () => {
  const v = make(); v.openPreview("json");
  const d = JSON.parse(v.preview.payload);
  assert.equal(d.schemaVersion, 4); assert.equal(d.sessionId, "fixture-session");
  assert.equal(d.privacy.agentNames, "preserved");
  assert.ok(v.preview.payload.includes("Frontend"));
  assert.ok(!v.preview.payload.includes('"Agent-3"'));
});
