import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import costExtension from "../index.js";
import { assistant, header, removeDir, tempDir, writeJsonl } from "./helpers.mjs";

test("public entry registers /cost", () => {
  const commands = new Map();
  costExtension({ registerCommand(name, spec) { commands.set(name, spec); } });
  assert.equal(typeof commands.get("cost")?.handler, "function");
});

test("manifest publishes v0.5.1 and points to structured explorer entry", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "0.5.1");
  assert.deepEqual(pkg.omp.extensions, ["./index.js"]);
  for (const file of ["core.js", "aggregate.js", "format.js", "export.js", "view.js"]) assert.ok(pkg.files.includes(file));
});

test("compatibility entries still register the command", async () => {
  for (const file of ["../tabbed.js", "../styled.js"]) {
    const module = await import(file);
    const commands = new Map();
    module.default({ registerCommand(name, spec) { commands.set(name, spec); } });
    assert.equal(typeof commands.get("cost")?.handler, "function");
  }
});

test("command builds an interactive overlay from a persisted session", async () => {
  const dir = await tempDir();
  const session = path.join(dir, "main.jsonl");
  try {
    await writeJsonl(session, [header("main"), assistant("a", "openai", "model")]);
    const commands = new Map();
    costExtension({ registerCommand(name, spec) { commands.set(name, spec); }, exec: async () => ({ code: 0 }) });
    let rendered = "";
    const notifications = [];
    await commands.get("cost").handler("", {
      waitForIdle: async () => {},
      cwd: dir,
      hasUI: true,
      sessionManager: { getSessionFile: () => session },
      ui: {
        setStatus() {},
        notify(message, type) { notifications.push({ message, type }); },
        async custom(factory, options) {
          assert.deepEqual(options, { overlay: true });
          const instance = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            { fg: (_color, text) => String(text), bold: text => String(text), bgFill: (_color, text) => String(text) },
            { matches: () => false },
            () => {},
          );
          rendered = instance.render(100).join("\n");
        },
      },
    });
    assert.match(rendered, /SESSION COST EXPLORER/);
    assert.match(rendered, /Overview/);
    assert.equal(notifications.filter(row => row.type === "error").length, 0);
  } finally {
    await removeDir(dir);
  }
});

test("headless command reports a compact summary", async () => {
  const dir = await tempDir();
  const session = path.join(dir, "main.jsonl");
  try {
    await writeJsonl(session, [header("main"), assistant("a", "openai", "model")]);
    const commands = new Map();
    costExtension({ registerCommand(name, spec) { commands.set(name, spec); }, exec: async () => ({ code: 0 }) });
    const notifications = [];
    await commands.get("cost").handler("", {
      waitForIdle: async () => {},
      cwd: dir,
      hasUI: false,
      sessionManager: { getSessionFile: () => session },
      ui: { setStatus() {}, notify(message, type) { notifications.push({ message, type }); } },
    });
    assert.match(notifications[0].message, /1 LLM calls/);
    assert.match(notifications[0].message, /API-equivalent/);
  } finally {
    await removeDir(dir);
  }
});
