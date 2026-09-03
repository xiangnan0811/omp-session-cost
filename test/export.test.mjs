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
  assert.match(text, /Metric definitions/);
  assert.match(text, /Call share/);
  assert.match(text, /Token share/);
  assert.match(text, /Cost share/);
  assert.match(text, /Actor types/);
  assert.match(text, /Providers/);
  assert.match(text, /Advisors/);
  assert.match(text, /Review updates/);
  assert.match(text, /Deterministic observations/);
});

test("AI brief excludes local transcript and stats database paths", () => {
  const text = buildAiBrief(fixtureReport());
  assert.doesNotMatch(text, /\/home\/alice/);
  assert.doesNotMatch(text, /stats\.db/);
  assert.doesNotMatch(text, /private\/main\.jsonl/);
});

test("public JSON excludes sensitive path and database error fields", () => {
  const text = buildPublicJson(fixtureReport());
  const json = JSON.parse(text);
  assert.equal(json.sessionId, "fixture-session");
  assert.equal("rootSessionFile" in json, false);
  assert.equal("dbPath" in json.pricing, false);
  assert.equal("dbError" in json.pricing, false);
  assert.doesNotMatch(text, /\/home\/alice/);
});

test("selection export includes focused row and child attribution", () => {
  const report = fixtureReport();
  const model = report.models.find(row => row.name === "xai-oauth/grok-4.6");
  const text = buildSelectionMarkdown(report, { kind: "Model", row: model });
  assert.match(text, /xai-oauth\/grok-4\.6/);
  assert.match(text, /Agents/);
  assert.match(text, /Frontend/);
  assert.match(text, /main > advisor/);
});

test("tab export selects the active dimension", () => {
  const text = buildTabMarkdown(fixtureReport(), "providers");
  assert.match(text, /Session Cost: Providers/);
  assert.match(text, /openai-codex/);
  assert.match(text, /xai-oauth/);
});

test("full Markdown contains complete model to agent attribution", () => {
  const text = buildFullMarkdown(fixtureReport());
  assert.match(text, /Model → agent attribution/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /Backend/);
});

test("copy payload dispatcher maps all menu modes", () => {
  const report = fixtureReport();
  assert.match(buildCopyPayload(report, "brief"), /Analysis Bundle/);
  assert.match(buildCopyPayload(report, "tab", { tabId: "agents" }), /Session Cost: Agents/);
  assert.match(buildCopyPayload(report, "markdown"), /All primary agents/);
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
