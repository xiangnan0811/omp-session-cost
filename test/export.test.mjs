import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiBrief,
  buildCopyPayload,
  buildFullMarkdown,
  buildPublicJson,
  buildSelectionMarkdown,
  buildTabMarkdown,
  copyOptions,
} from "../export.js";
import { fixtureReport } from "./report-fixture.mjs";

test("copy menu exposes five analysis-oriented formats", () => {
  assert.deepEqual(copyOptions().map(row => row.id), ["brief", "selection", "tab", "markdown", "json"]);
});

test("AI brief is self-explaining and labels call/token/cost shares", () => {
  const text = buildAiBrief(fixtureReport());
  assert.match(text, /统计范围/);
  assert.match(text, /调用占比/);
  assert.match(text, /Token 占比/);
  assert.match(text, /金额占比/);
  assert.match(text, /主体类型/);
  assert.match(text, /提供商/);
  assert.match(text, /Advisors/);
  assert.match(text, /Review updates/);
  assert.match(text, /严格重复状态候选/);
});

test("AI brief preserves meaningful source paths and omits stats database internals", () => {
  const text = buildAiBrief(fixtureReport());
  assert.match(text, /\/home\/alice/);
  assert.doesNotMatch(text, /stats\.db/);
  assert.match(text, /private\/main\.jsonl/);
});

test("public JSON preserves original identity and excludes database error fields", () => {
  const text = buildPublicJson(fixtureReport());
  const json = JSON.parse(text);
  assert.match(json.sessionId, /^fixture-session$/);
  assert.equal(json.schemaVersion, 5);
  assert.equal("rootSessionFile" in json, true);
  assert.equal("dbPath" in json.pricing, false);
  assert.equal("dbError" in json.pricing, false);
  assert.match(text, /\/home\/alice/);
});

test("selection export includes focused row and child attribution", () => {
  const report = fixtureReport();
  const model = report.models.find(row => row.name === "xai-oauth/grok-4.6");
  const text = buildSelectionMarkdown(report, { kind: "Model", row: model });
  assert.match(text, /xai-oauth\/grok-4\.6/);
  assert.match(text, /主控与子代理/);
  assert.match(text, /Frontend/);
  assert.match(text, /main > advisor/);
});

test("tab export selects the active dimension", () => {
  const text = buildTabMarkdown(fixtureReport(), "providers");
  assert.match(text, /当前标签页：providers/);
  assert.match(text, /openai-codex/);
  assert.match(text, /xai-oauth/);
});

test("full Markdown contains complete model to agent attribution", () => {
  const text = buildFullMarkdown(fixtureReport());
  assert.match(text, /模型 → agent 原名/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /Backend/);
});

test("copy payload dispatcher maps all menu modes", () => {
  const report = fixtureReport();
  assert.match(buildCopyPayload(report, "brief"), /会话成本分析报告/);
  assert.match(buildCopyPayload(report, "tab", { tabId: "agents" }), /当前标签页：agents/);
  assert.match(buildCopyPayload(report, "markdown"), /主控与子代理/);
  assert.doesNotThrow(() => JSON.parse(buildCopyPayload(report, "json")));
});

test("copyText uses a native clipboard command when available", async () => {
  if (process.platform !== "linux") return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { copyText } = await import("../export.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copy-"));
  const output = path.join(dir, "clipboard.txt");
  const command = path.join(dir, "wl-copy");
  const oldPath = process.env.PATH;
  const oldWayland = process.env.WAYLAND_DISPLAY;
  try {
    await fs.writeFile(command, `#!/bin/sh\ncat > "${output}"\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${oldPath ?? ""}`;
    process.env.WAYLAND_DISPLAY = "wayland-test";
    const result = await copyText("hello explorer");
    assert.equal(result.method, "wl-copy");
    assert.equal(await fs.readFile(output, "utf8"), "hello explorer");
  } finally {
    process.env.PATH = oldPath;
    if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = oldWayland;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
