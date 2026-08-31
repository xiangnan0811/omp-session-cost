import test from "node:test";
import assert from "node:assert/strict";
import costExtension from "../index.js";

test("registers the /cost command without runtime imports", () => {
  const commands = new Map();
  const pi = {
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
  };

  costExtension(pi);

  assert.equal(commands.has("cost"), true);
  assert.equal(typeof commands.get("cost")?.handler, "function");
});
