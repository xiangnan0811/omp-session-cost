import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createGunzip, constants } from "node:zlib";
import { createHash } from "node:crypto";

export const SNAPSHOT_STRATEGY = "File byte limits captured before parsing; append-only prefixes, not an atomic cross-file snapshot";
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export async function freezeFiles(files) {
  const startedAt = Date.now();
  const descriptors = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      descriptors.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, frozenAt: Date.now() });
    } catch (error) {
      descriptors.push({ file, size: 0, unavailable: error?.code || "unavailable", frozenAt: Date.now() });
    }
  }
  return { startedAt, frozenAt: Date.now(), strategy: SNAPSHOT_STRATEGY, descriptors };
}

// Never read beyond a frozen byte prefix. Keep only one bounded JSONL line in memory.
// The mutable title slot is intentionally not treated as historical context.
export async function visitFrozen(descriptor, visitor) {
  const meta = { bytes: descriptor.size, records: 0, invalidJson: 0, nonObjects: 0, partialTail: 0,
    oversizedLines: 0, changedDuringScan: false, unavailable: descriptor.unavailable || null, digest: null };
  if (descriptor.unavailable || !descriptor.size) return meta;
  const raw = createReadStream(descriptor.file, { start: 0, end: descriptor.size - 1 });
  const hash = createHash("sha256");
  raw.on("data", chunk => hash.update(chunk));
  const gzip = descriptor.file.endsWith(".gz");
  const stream = gzip ? raw.pipe(createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })) : raw;
  if (gzip) raw.on("error", error => stream.destroy(error));
  let fragments = [], length = 0, dropping = false, line = 0;
  const consume = async bytes => {
    line += 1;
    if (dropping) { meta.oversizedLines += 1; return; }
    const text = bytes.toString("utf8").trim();
    if (!text) return;
    let entry;
    try { entry = JSON.parse(text); } catch { meta.invalidJson += 1; return; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { meta.nonObjects += 1; return; }
    meta.records += 1;
    await visitor(entry, { line, lineDigest: createHash("sha256").update(bytes).digest("hex") });
  };
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        if (!dropping && length + part.length <= MAX_LINE_BYTES) fragments.push(part);
        else dropping = true;
        await consume(dropping ? Buffer.alloc(0) : Buffer.concat(fragments));
        fragments = []; length = 0; dropping = false; start = end + 1;
      }
      if (start < chunk.length) {
        const tail = chunk.subarray(start);
        length += tail.length;
        if (length <= MAX_LINE_BYTES && !dropping) fragments.push(tail);
        else { fragments = []; dropping = true; }
      }
    }
    // Even valid JSON without a newline may still be an unfinished append. Exclude it.
    if (length || dropping) meta.partialTail += 1;
    meta.digest = hash.digest("hex");
  } catch (error) {
    meta.unavailable = error?.code || "read-failed";
  } finally {
    stream.destroy(); raw.destroy();
  }
  try {
    const after = await fs.stat(descriptor.file);
    meta.changedDuringScan = after.ino !== descriptor.ino || after.size < descriptor.size ||
      (after.mtimeMs !== descriptor.mtimeMs && after.size === descriptor.size);
    meta.appendedBytesExcluded = Math.max(0, after.size - descriptor.size);
  } catch { meta.changedDuringScan = true; }
  return meta;
}
