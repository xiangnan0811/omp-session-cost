import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";

export async function tempDir(prefix = "omp-cost-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function header(id, timestamp = "2026-09-03T00:00:00.000Z", extra = {}) {
  return { type: "session", version: 3, id, timestamp, cwd: "/tmp/project", ...extra };
}

export function user(id, content = "update", options = {}) {
  return {
    type: "message",
    id,
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? "2026-09-03T00:00:01.000Z",
    message: {
      role: "user",
      content,
      timestamp: Date.parse(options.timestamp ?? "2026-09-03T00:00:01.000Z"),
      ...(options.synthetic ? { synthetic: true, attribution: "agent" } : {}),
    },
  };
}

export function assistant(id, provider, model, options = {}) {
  const timestamp = options.timestamp ?? "2026-09-03T00:00:02.000Z";
  const usage = {
    input: options.input ?? 100,
    output: options.output ?? 20,
    cacheRead: options.cacheRead ?? 200,
    cacheWrite: options.cacheWrite ?? 0,
    totalTokens: (options.input ?? 100) + (options.output ?? 20) + (options.cacheRead ?? 200) + (options.cacheWrite ?? 0),
    cost: options.cost ?? { input: 0.1, output: 0.1, cacheRead: 0.05, cacheWrite: 0, total: 0.25 },
  };
  if (options.orchestration) usage.orchestration = options.orchestration;
  return {
    type: "message",
    id,
    parentId: options.parentId ?? null,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      api: "test",
      content: options.content ?? [{ type: "text", text: "ok" }],
      usage,
      stopReason: options.failed ? "error" : "stop",
      ...(options.failed ? { errorMessage: "boom" } : {}),
      timestamp: Date.parse(timestamp),
    },
  };
}

export function advisorCard(id, notes, options = {}) {
  return {
    type: "custom_message",
    id,
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? "2026-09-03T00:00:03.000Z",
    customType: "advisor",
    content: notes.map(note => `<advisory>${note.note}</advisory>`).join("\n"),
    details: { notes },
    display: true,
  };
}

export async function writeJsonl(file, entries, gzip = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  if (gzip) await fs.writeFile(file, gzipSync(text));
  else await fs.writeFile(file, text);
}

export async function removeDir(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}
