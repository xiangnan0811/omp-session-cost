import { spawn } from "node:child_process";
import { buildDiagnosticData, diagnosticMarkdown } from "./diagnostic-export.js";
import { scopeReport, selectionFilter } from "./core.js";

const COPY_OPTIONS = Object.freeze([
  { id: "brief", label: "中文分析报告", description: "原始名称、任务归属、价格、时序与证据" },
  { id: "selection", label: "当前主体", description: "当前主体的自包含分析报告" },
  { id: "tab", label: "当前标签页", description: "当前标签页，保留统计范围与指标定义" },
  { id: "markdown", label: "完整 Markdown 报告", description: "全部调用、事件与运行时证据，不静默截断" },
  { id: "json", label: "完整 JSON", description: "格式 v3：完整事实、归因、历史、时序与证据" },
]);
export function copyOptions() { return COPY_OPTIONS.map(option => ({ ...option })); }
export function buildAiBrief(report, options = {}) { return diagnosticMarkdown(buildDiagnosticData(report, options), options); }
export function buildSelectionMarkdown(report, selection, options = {}) {
  const selected = scopeReport(report, selectionFilter(selection));
  return diagnosticMarkdown(buildDiagnosticData(selected, options), options);
}
export function buildTabMarkdown(report, tabId, options = {}) {
  return `<!-- 当前标签页：${["overview", "providers", "models", "agents", "advisors", "details", "tasks", "runtime", "compare"].includes(tabId) ? tabId : "overview"} -->\n` + buildAiBrief(report, options);
}
export function buildFullMarkdown(report, options = {}) { return diagnosticMarkdown(buildDiagnosticData(report, options), { ...options, full: true }); }
export function buildPublicJson(report, options = {}) { return JSON.stringify(buildDiagnosticData(report, options), null, options.pretty ? 2 : 0) + "\n"; }
export function buildCopyPayload(report, mode, context = {}) {
  if (mode === "selection") return buildSelectionMarkdown(report, context.selection, context);
  if (mode === "tab") return buildTabMarkdown(report, context.tabId, context);
  if (mode === "markdown") return buildFullMarkdown(report, context);
  if (mode === "json") return buildPublicJson(report, context);
  return buildAiBrief(report, context);
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
  const bytes = Buffer.byteLength(source, "utf8");
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
  if (bytes > 75000) throw new Error("Payload exceeds safe terminal clipboard size; use Save from the preview. Nothing was truncated.");
  if (emitOsc52(source)) return { method: "OSC 52 (sent; terminal acknowledgment unavailable)" };
  throw new Error("No clipboard transport is available (tried native tools and OSC 52)");
}
