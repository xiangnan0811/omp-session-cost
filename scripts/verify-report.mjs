import fs from "node:fs/promises";
import { verifyExport } from "../verify-export.js";
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/verify-report.mjs REPORT.md|REPORT.json"); process.exitCode = 2; }
else {
  try {
    const result = verifyExport(await fs.readFile(file, "utf8"));
    const arithmetic = result.arithmetic && { ...result.arithmetic, checks: result.arithmetic.checks?.filter(c => !c.ok), checkedMetrics: result.arithmetic.checks?.length };
    console.log(JSON.stringify({ file, ...result, arithmetic }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(`Cannot verify report: ${error.message}`); process.exitCode = 2; }
}
