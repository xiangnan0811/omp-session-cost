import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { createGunzip } from "node:zlib";
import { finite } from "./format.js";

export const ADVISOR_PREFIX = "__advisor";
export const TRANSCRIPT_RE = /\.jsonl(?:\.gz)?$/i;
export const TITLE_SLOT_ENTRY_TYPE = "title";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

export function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeCost(value) {
  const source = value && typeof value === "object" ? value : ZERO_COST;
  return {
    input: finite(source.input),
    output: finite(source.output),
    cacheRead: finite(source.cacheRead),
    cacheWrite: finite(source.cacheWrite),
    total: finite(source.total),
  };
}

export function transcriptStem(file) {
  return String(file).replace(/\.gz$/i, "").replace(/\.jsonl$/i, "");
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function parentTranscriptFor(file) {
  const candidateStem = path.dirname(path.resolve(file));
  for (const suffix of [".jsonl", ".jsonl.gz"]) {
    const candidate = `${candidateStem}${suffix}`;
    if (candidate !== file && await exists(candidate)) return candidate;
  }
  return null;
}

export async function resolveInteractiveRoot(sessionFile) {
  let current = path.resolve(sessionFile);
  while (true) {
    const parent = await parentTranscriptFor(current);
    if (!parent) return current;
    current = parent;
  }
}

export async function collectTranscriptsRecursive(directory) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await collectTranscriptsRecursive(full));
    else if (entry.isFile() && TRANSCRIPT_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function inputStream(file) {
  const stream = createReadStream(file);
  if (!file.toLowerCase().endsWith(".gz")) return stream;
  const gunzip = createGunzip();
  stream.on("error", error => gunzip.destroy(error));
  return stream.pipe(gunzip);
}

export async function visitTranscript(file, visitor) {
  const stream = inputStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry && typeof entry === "object") await visitor(entry);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function overlayTitleSlot(header, titleSlot) {
  if (!titleSlot) return header;
  const result = { ...header };
  if (typeof titleSlot.title === "string") result.title = titleSlot.title;
  if (titleSlot.source === "auto" || titleSlot.source === "user") result.titleSource = titleSlot.source;
  return result;
}

export async function readHeader(file) {
  const stream = inputStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let titleSlot = null;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;

      // OMP 18 session files physically start with a fixed-width `type: "title"`
      // slot before the logical `type: "session"` header. Legacy files start
      // directly with the session header. Only this one physical prefix record
      // may precede the logical header; any other first object is malformed.
      if (entry.type === TITLE_SLOT_ENTRY_TYPE && titleSlot === null) {
        titleSlot = entry;
        continue;
      }
      if (entry.type === "session") return overlayTitleSlot(entry, titleSlot);
      return null;
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function normalizeChain(parts) {
  const chain = [];
  for (const raw of parts) {
    const segments = String(raw).split(".").filter(Boolean);
    let prefix = 0;
    while (prefix < chain.length && prefix < segments.length && chain[prefix] === segments[prefix]) prefix += 1;
    for (const segment of segments.slice(prefix)) {
      if (chain[chain.length - 1] !== segment) chain.push(segment);
    }
  }
  return chain;
}

export function transcriptIdentity(file, rootFile) {
  if (path.resolve(file) === path.resolve(rootFile)) {
    return {
      agentType: "main",
      agent: "main",
      ownerAgent: "main",
      advisorSlug: "",
      advisorName: "",
      advisorKey: "",
    };
  }

  const rootArtifacts = transcriptStem(rootFile);
  let relative = path.relative(rootArtifacts, file).replace(/\\/g, "/");
  relative = relative.replace(/\.gz$/i, "").replace(/\.jsonl$/i, "");
  if (!relative || relative.startsWith("..")) relative = transcriptStem(path.basename(file));
  const parts = relative.split("/").filter(Boolean);
  const leaf = parts.pop() ?? relative;
  const advisor = leaf === ADVISOR_PREFIX || leaf.startsWith(`${ADVISOR_PREFIX}.`);
  const ownerChain = normalizeChain(parts);

  if (advisor) {
    const ownerAgent = ownerChain.length ? ownerChain.join(" > ") : "main";
    const advisorSlug = leaf === ADVISOR_PREFIX ? "" : leaf.slice(ADVISOR_PREFIX.length + 1);
    const advisorName = advisorSlug || "default";
    return {
      agentType: "advisor",
      agent: `${ownerAgent} > advisor${advisorSlug ? `:${advisorSlug}` : ""}`,
      ownerAgent,
      advisorSlug,
      advisorName,
      advisorKey: `${ownerAgent}\u0000${advisorSlug}`,
    };
  }

  const chain = normalizeChain([...parts, leaf]);
  const agent = chain.length ? chain.join(" > ") : leaf;
  return {
    agentType: "subagent",
    agent,
    ownerAgent: agent,
    advisorSlug: "",
    advisorName: "",
    advisorKey: "",
  };
}

export function toolCalls(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type ?? "").toLowerCase();
    if (!new Set(["toolcall", "tool_call", "tool-use", "tool_use"]).has(type)) continue;
    const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "";
    const args = block.arguments ?? block.args ?? block.input ?? {};
    if (name) out.push({ name, args: args && typeof args === "object" ? args : {} });
  }
  return out;
}

export function severityKey(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "nit" || normalized === "concern" || normalized === "blocker" ? normalized : "unspecified";
}
