import fs from "node:fs/promises";
import path from "node:path";

export function parseCostArgs(text = "") {
  const result = { refresh: false, mark: false, since: false, help: false, options: {} };
  // This is a command-option parser, not a shell. No expansion or code execution.
  const tokens = String(text).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/"([^\"]*)"|'([^']*)'/g, (_, a, b) => a ?? b);
    if (["refresh", "mark", "since", "help"].includes(token)) result[token] = true;
    else if (token === "main") result.options.actorType = "main";
    else if (token === "active") result.options.branch = "active-main-path";
    else if (token === "all") result.options.branch = "recorded-spend";
    else {
      const index = token.indexOf("=");
      const key = token.slice(0, index), value = token.slice(index + 1);
      const fields = { from: "from", to: "to", after: "afterEvent", before: "beforeEvent", model: "modelId", provider: "provider", agent: "agent", actor: "actorType" };
      if (index <= 0 || !value || !fields[key]) throw new Error("Unknown /cost option. Use: refresh, main, all, active, mark, since, from=ISO, to=ISO, after=ID, before=ID, model=provider/id, provider=ID, agent=NAME.");
      if (key === "actor" && !["main", "subagent", "advisor"].includes(value)) throw new Error("actor must be main, subagent or advisor");
      result.options[fields[key]] = value;
    }
  }
  return result;
}

export async function saveReportFile(filename, payload, cwd = process.cwd()) {
  if (typeof filename !== "string" || !filename.trim() || /[\x00-\x1f]/.test(filename)) throw new Error("A valid new file path is required.");
  if (typeof payload !== "string") throw new TypeError("Report payload must be text.");
  const target = path.resolve(cwd, filename.trim());
  const handle = await fs.open(target, "wx", 0o600);
  try { await handle.writeFile(payload, "utf8"); }
  finally { await handle.close(); }
  return { message: `Saved ${Buffer.byteLength(payload, "utf8")} bytes to ${target}; file mode 0600`, path: target };
}
