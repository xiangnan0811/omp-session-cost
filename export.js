import { spawn } from "node:child_process";
import {
  costIntensity,
  finite,
  formatCost,
  formatInt,
  formatPercent,
  formatRatio,
  formatTokens,
  percent,
} from "./format.js";

const COPY_OPTIONS = Object.freeze([
  { id: "brief", label: "AI analysis brief", description: "Self-explaining Markdown with definitions, rollups, advisors, and observations" },
  { id: "selection", label: "Current selection", description: "The focused provider, model, agent, or advisor and its children" },
  { id: "tab", label: "Current tab", description: "Markdown for the active explorer tab" },
  { id: "markdown", label: "Full Markdown report", description: "All aggregate dimensions without transcript content or local paths" },
  { id: "json", label: "Full JSON", description: "Machine-readable aggregate data with sensitive local metadata removed" },
]);

export function copyOptions() {
  return COPY_OPTIONS.map(option => ({ ...option }));
}

function metricDefinitions() {
  return [
    "- **LLM calls**: assistant/provider calls with persisted usage metadata; not user prompts or task count.",
    "- **Call share**: percentage of all measured LLM calls in this session tree.",
    "- **Token share**: percentage of measured input, output, cache, and orchestration tokens.",
    "- **Cost share**: percentage of API-equivalent cost. OAuth/subscription billing can differ.",
    "- **Review updates**: synthetic agent-attributed user deltas persisted in an advisor transcript.",
    "- **Primary follow-up calls**: primary LLM calls whose direct parent is an advisor card. This is deliberately narrower than all work occurring after advice.",
    "- **Cost intensity**: cost share divided by token share. `1.00×` equals the session average cost per measured token.",
  ].join("\n");
}

function rowLine(row, total, parentTotal = total) {
  return `- ${row.name}: ${formatInt(row.calls)} calls (${formatPercent(percent(row.calls, parentTotal.calls))}), ${formatTokens(row.measuredTokens)} tokens (${formatPercent(percent(row.measuredTokens, parentTotal.measuredTokens))}), ${formatCost(row.costTotal)} (${formatPercent(percent(row.costTotal, parentTotal.costTotal))})`;
}

function table(rows, total, name = "Name", limit = Infinity) {
  const source = rows.slice(0, limit);
  const lines = [
    `| ${name} | Calls | Call% | Tokens | Token% | Cost | Cost% | Intensity |`,
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of source) {
    lines.push(`| ${String(row.name).replaceAll("|", "\\|")} | ${formatInt(row.calls)} | ${formatPercent(percent(row.calls, total.calls))} | ${formatTokens(row.measuredTokens)} | ${formatPercent(percent(row.measuredTokens, total.measuredTokens))} | ${formatCost(row.costTotal)} | ${formatPercent(percent(row.costTotal, total.costTotal))} | ${formatRatio(costIntensity(row, total))} |`);
  }
  if (rows.length > source.length) lines.push(`\n_${rows.length - source.length} additional row(s) omitted from this compact section._`);
  return lines.join("\n");
}

function advisorSection(advisors, total) {
  if (!advisors.length) return "No advisor activity was recorded.";
  const lines = [];
  for (const advisor of advisors) {
    lines.push(`### ${advisor.ownerAgent} › advisor${advisor.advisorSlug ? `:${advisor.advisorSlug}` : ""}`);
    lines.push("");
    lines.push(`- Scope: ${advisor.scope === "main" ? "main session" : "subagent"}`);
    lines.push(`- Dominant model: ${advisor.dominantModel}`);
    lines.push(`- LLM calls: ${formatInt(advisor.calls)} (${formatPercent(percent(advisor.calls, total.calls))} of session)`);
    lines.push(`- Measured tokens: ${formatTokens(advisor.measuredTokens)} (${formatPercent(percent(advisor.measuredTokens, total.measuredTokens))} of session)`);
    lines.push(`- API-equivalent cost: ${formatCost(advisor.costTotal)} (${formatPercent(percent(advisor.costTotal, total.costTotal))} of session)`);
    lines.push(`- Cost intensity: ${formatRatio(costIntensity(advisor, total))}`);
    lines.push(`- Review updates: ${formatInt(advisor.reviewUpdates)}`);
    lines.push(`- Calls / review: ${advisor.reviewUpdates ? (advisor.calls / advisor.reviewUpdates).toFixed(2) : "n/a"}`);
    lines.push(`- Tokens / review: ${advisor.reviewUpdates ? formatTokens(advisor.measuredTokens / advisor.reviewUpdates) : "n/a"}`);
    lines.push(`- Cost / review: ${advisor.reviewUpdates ? formatCost(advisor.costTotal / advisor.reviewUpdates) : "n/a"}`);
    lines.push(`- Advise tool calls: ${formatInt(advisor.adviseCalls)}`);
    lines.push(`- Other tool calls: ${formatInt(advisor.otherToolCalls)}`);
    lines.push(`- Delivered notes: ${formatInt(advisor.deliveredNotes)} across ${formatInt(advisor.deliveredCards)} card(s)`);
    lines.push(`- Direct primary follow-up calls: ${formatInt(advisor.primaryFollowupCalls)}`);
    if (advisor.models.length) {
      lines.push("- Models:");
      for (const model of advisor.models) lines.push(`  ${rowLine(model, total, advisor)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function deterministicObservations(report) {
  const { total } = report;
  const lines = [];
  const topProvider = report.providers[0];
  const topModel = report.models[0];
  const advisorActor = report.actorTypes.find(row => row.actorType === "advisor");

  if (topProvider) {
    lines.push(`- ${topProvider.name} is the largest provider by API-equivalent cost at ${formatPercent(percent(topProvider.costTotal, total.costTotal))} of session cost.`);
  }
  if (topModel) {
    lines.push(`- ${topModel.name} is the largest model by API-equivalent cost at ${formatPercent(percent(topModel.costTotal, total.costTotal))} of cost and ${formatPercent(percent(topModel.measuredTokens, total.measuredTokens))} of measured tokens.`);
  }
  if (advisorActor) {
    const costShare = percent(advisorActor.costTotal, total.costTotal);
    const tokenShare = percent(advisorActor.measuredTokens, total.measuredTokens);
    const delta = costShare - tokenShare;
    lines.push(`- Advisors account for ${formatPercent(costShare)} of cost and ${formatPercent(tokenShare)} of tokens, a ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} percentage-point cost/token-share difference.`);
  }
  const intense = report.models
    .filter(row => percent(row.measuredTokens, total.measuredTokens) >= 1)
    .map(row => ({ row, intensity: costIntensity(row, total) }))
    .sort((a, b) => b.intensity - a.intensity)[0];
  if (intense) lines.push(`- ${intense.row.name} has the highest cost intensity among models with at least 1% of tokens: ${formatRatio(intense.intensity)}.`);
  const cacheRatio = percent(total.cacheRead, total.measuredTokens);
  lines.push(`- Cache-read tokens represent ${formatPercent(cacheRatio)} of measured tokens.`);
  if (total.failed) lines.push(`- ${formatInt(total.failed)} of ${formatInt(total.calls)} measured LLM calls are marked failed.`);
  return lines.join("\n");
}

export function buildAiBrief(report) {
  const t = report.total;
  const lines = [
    "# OMP Session Cost Analysis Bundle",
    "",
    `Generated by: omp-session-cost ${report.version}`,
    `Generated at: ${new Date(report.generatedAt).toISOString()}`,
    "Pricing: API-equivalent estimates; subscription and OAuth billing can differ.",
    "",
    "## Metric definitions",
    metricDefinitions(),
    "",
    "## Totals",
    `- LLM calls: ${formatInt(t.calls)}`,
    `- Failed calls: ${formatInt(t.failed)}`,
    `- Measured tokens: ${formatTokens(t.measuredTokens)}`,
    `- API-equivalent cost: ${formatCost(t.costTotal)}`,
    `- Input: ${formatTokens(t.input)} / ${formatCost(t.costInput)}`,
    `- Output: ${formatTokens(t.output)} / ${formatCost(t.costOutput)}`,
    `- Cache read: ${formatTokens(t.cacheRead)} / ${formatCost(t.costCacheRead)}`,
    `- Cache write: ${formatTokens(t.cacheWrite)} / ${formatCost(t.costCacheWrite)}`,
    "",
    "## Actor types",
    table(report.actorTypes, t, "Actor type"),
    "",
    "## Providers",
    table(report.providers, t, "Provider"),
    "",
    "## Models",
    table(report.models, t, "Model"),
    "",
    "## Top primary agents",
    table(report.primaryAgents, t, "Agent", 25),
    "",
    "## Advisors",
    advisorSection(report.advisors, t),
    "",
    "## Deterministic observations",
    deterministicObservations(report),
  ];
  return lines.join("\n").trimEnd() + "\n";
}

function markdownForRow(row, total, kind = "Selection") {
  const lines = [
    `# OMP Session Cost: ${kind}`,
    "",
    `## ${row.name}`,
    "",
    `- Calls: ${formatInt(row.calls)} (${formatPercent(percent(row.calls, total.calls))} of session)` ,
    `- Measured tokens: ${formatTokens(row.measuredTokens)} (${formatPercent(percent(row.measuredTokens, total.measuredTokens))} of session)`,
    `- API-equivalent cost: ${formatCost(row.costTotal)} (${formatPercent(percent(row.costTotal, total.costTotal))} of session)`,
    `- Cost intensity: ${formatRatio(costIntensity(row, total))}`,
  ];
  if (row.ownerAgent) lines.push(`- Owner: ${row.ownerAgent}`);
  if (row.dominantModel) lines.push(`- Dominant model: ${row.dominantModel}`);
  if (row.models?.length) {
    lines.push("", "## Models", table(row.models, row, "Model"));
  }
  if (row.agents?.length) {
    lines.push("", "## Agents", table(row.agents, row, "Agent"));
  }
  if (row.reviewUpdates !== undefined) {
    lines.push(
      "",
      "## Advisor behavior",
      `- Review updates: ${formatInt(row.reviewUpdates)}`,
      `- Advise tool calls: ${formatInt(row.adviseCalls)}`,
      `- Other tool calls: ${formatInt(row.otherToolCalls)}`,
      `- Delivered notes: ${formatInt(row.deliveredNotes)}`,
      `- Delivered cards: ${formatInt(row.deliveredCards)}`,
      `- Direct primary follow-up calls: ${formatInt(row.primaryFollowupCalls)}`,
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function buildSelectionMarkdown(report, selection) {
  if (!selection?.row) return buildAiBrief(report);
  return markdownForRow(selection.row, report.total, selection.kind || "Selection");
}

export function buildTabMarkdown(report, tabId) {
  const t = report.total;
  if (tabId === "providers") return `# OMP Session Cost: Providers\n\n${table(report.providers, t, "Provider")}\n`;
  if (tabId === "models") return `# OMP Session Cost: Models\n\n${table(report.models, t, "Model")}\n`;
  if (tabId === "agents") return `# OMP Session Cost: Agents\n\n${table(report.primaryAgents, t, "Agent")}\n`;
  if (tabId === "advisors") return `# OMP Session Cost: Advisors\n\n${advisorSection(report.advisors, t)}\n`;
  if (tabId === "details") {
    const m = report.metadata;
    return [
      "# OMP Session Cost: Details",
      "",
      `- Session ID: ${report.sessionId}`,
      `- Files discovered: ${formatInt(m.filesDiscovered)}`,
      `- Valid files scanned: ${formatInt(m.filesScanned)}`,
      `- Invalid transcript-like files skipped: ${formatInt(m.skippedInvalidFiles)}`,
      `- Fork-aware incremental view: ${m.forkAware ? "yes" : "no"}`,
      `- Inherited calls excluded: ${formatInt(m.excludedInheritedCalls)}`,
      `- Duplicate calls removed: ${formatInt(m.duplicateCallsRemoved)}`,
      "",
    ].join("\n");
  }
  return buildAiBrief(report);
}

export function buildFullMarkdown(report) {
  const t = report.total;
  return [
    buildAiBrief(report).trimEnd(),
    "",
    "## All primary agents",
    table(report.primaryAgents, t, "Agent"),
    "",
    "## Model → agent attribution",
    ...report.models.flatMap(model => [
      `### ${model.name}`,
      "",
      table(model.agents ?? [], model, "Agent"),
      "",
    ]),
  ].join("\n").trimEnd() + "\n";
}

function publicRow(row) {
  const copy = {};
  for (const [key, value] of Object.entries(row)) {
    if (["rootSessionFile", "file", "dbPath", "dbError"].includes(key)) continue;
    if (Array.isArray(value)) copy[key] = value.map(publicRow);
    else if (value && typeof value === "object") copy[key] = { ...value };
    else copy[key] = value;
  }
  return copy;
}

export function buildPublicJson(report) {
  return JSON.stringify({
    schemaVersion: 1,
    generatedBy: `omp-session-cost ${report.version}`,
    generatedAt: new Date(report.generatedAt).toISOString(),
    pricingSemantics: "API-equivalent; subscription/OAuth billing can differ",
    sessionId: report.sessionId,
    total: publicRow(report.total),
    actorTypes: report.actorTypes.map(publicRow),
    providers: report.providers.map(publicRow),
    models: report.models.map(publicRow),
    primaryAgents: report.primaryAgents.map(publicRow),
    advisors: report.advisors.map(publicRow),
    metadata: { ...report.metadata, cutoffMs: report.metadata.cutoffMs || 0 },
    pricing: {
      dbMatched: finite(report.pricing?.dbMatched),
      sync: report.pricing?.sync ? { ...report.pricing.sync, error: report.pricing.sync.ok ? null : "stats refresh failed" } : null,
      sourceCounts: { ...(report.pricing?.sourceCounts ?? {}) },
    },
  }, null, 2) + "\n";
}

export function buildCopyPayload(report, mode, context = {}) {
  if (mode === "selection") return buildSelectionMarkdown(report, context.selection);
  if (mode === "tab") return buildTabMarkdown(report, context.tabId);
  if (mode === "markdown") return buildFullMarkdown(report);
  if (mode === "json") return buildPublicJson(report);
  return buildAiBrief(report);
}

function spawnInput(command, args, text, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

function emitOsc52(text) {
  if (!process.stdout?.isTTY) return false;
  try {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${encoded}\x07`);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text) {
  const source = String(text);
  const osc = emitOsc52(source);
  const candidates = [];
  if (process.platform === "darwin") candidates.push(["pbcopy", []]);
  else if (process.platform === "win32") candidates.push(["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]);
  else {
    if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-copy", []]);
    if (process.env.DISPLAY) {
      candidates.push(["xclip", ["-selection", "clipboard"]]);
      candidates.push(["xsel", ["--clipboard", "--input"]]);
    }
    if (process.env.WSL_DISTRO_NAME) candidates.push(["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]);
  }
  for (const [command, args] of candidates) {
    try {
      await spawnInput(command, args, source);
      return { method: command };
    } catch {}
  }
  if (osc) return { method: "OSC 52" };
  throw new Error("No clipboard transport is available (tried native tools and OSC 52)");
}
