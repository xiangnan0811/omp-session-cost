import fs from "node:fs/promises";
import { verifyMarkdown, verifyJson } from "../report-contract.js";
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/verify-report.mjs REPORT.md|REPORT.json"); process.exitCode = 2; }
else {
  try {
    const text = await fs.readFile(file, "utf8");
    const result = text.trimStart().startsWith("{") ? verifyJson(text) : verifyMarkdown(text);
    console.log(JSON.stringify({ file, ok: result.ok, reason: result.reason, bytes: result.bytes ?? Buffer.byteLength(text), caveat: "Transport integrity only, not completeness of source data." }));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(`Cannot verify report: ${error.message}`); process.exitCode = 2; }
}
