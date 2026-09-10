import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { VERSION } from "../version.js";

const archive = process.argv[2];
if (!archive) throw new Error("Provide an npm package archive");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-package-check-"));
try {
  const result = spawnSync("tar", ["-xzf", path.resolve(archive), "-C", dir], { encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
  const root = path.join(dir, "package");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, VERSION);
  for (const name of pkg.files) await fs.access(path.join(root, name));
  const mod = await import(pathToFileURL(path.join(root, "index.js")));
  assert.equal(typeof mod.default, "function");
  const commands = new Map(); mod.default({ registerCommand: (name, command) => commands.set(name, command) });
  assert.equal(typeof commands.get("cost").handler, "function");
  console.log(`Verified ${pkg.name}@${pkg.version}: all published files present; isolated import and registration work without OMP native modules.`);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
