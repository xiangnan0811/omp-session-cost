import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const file of readdirSync(".").filter(f => f.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
