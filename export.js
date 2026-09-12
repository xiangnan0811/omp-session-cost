import { sealMarkdown, verifyMarkdown, sealJson } from "./report-contract.js";
export { copyText } from "./clipboard.js";
import { buildDiagnosticData, diagnosticMarkdown } from "./diagnostic-export.js";
import { scopeReport, selectionFilter } from "./core.js";

const COPY_OPTIONS = Object.freeze([
  { id: "brief", label: "全面诊断报告", description: "先核验数据质量，再分析任务、协作、时序与成本" },
  { id: "selection", label: "当前主体", description: "当前主体的自包含分析报告" },
  { id: "tab", label: "当前标签页", description: "当前标签页，保留统计范围与指标定义" },
  { id: "markdown", label: "完整 Markdown 报告", description: "全部调用、事件与运行时证据，不静默截断" },
  { id: "json", label: "完整 JSON", description: "格式 v4：完整事实、归因、历史、时序与证据" },
]);
export function copyOptions() { return COPY_OPTIONS.map(option => ({ ...option })); }
export function buildAiBrief(report, options = {}) { return diagnosticMarkdown(buildDiagnosticData(report, options), options); }
export function buildSelectionMarkdown(report, selection, options = {}) {
  const selected = scopeReport(report, selectionFilter(selection));
  return diagnosticMarkdown(buildDiagnosticData(selected, options), options);
}
export function buildTabMarkdown(report, tabId, options = {}) {
  return sealMarkdown(`<!-- 当前标签页：${["overview", "providers", "models", "agents", "advisors", "details", "tasks", "runtime", "compare"].includes(tabId) ? tabId : "overview"} -->\n` + verifyMarkdown(buildAiBrief(report, options)).body);
}
export function buildFullMarkdown(report, options = {}) { return diagnosticMarkdown(buildDiagnosticData(report, options), { ...options, full: true }); }
export function buildPublicJson(report, options = {}) { return sealJson(buildDiagnosticData(report, options), options.pretty); }
export function buildCopyPayload(report, mode, context = {}) {
  if (mode === "selection") return buildSelectionMarkdown(report, context.selection, context);
  if (mode === "tab") return buildTabMarkdown(report, context.tabId, context);
  if (mode === "markdown") return buildFullMarkdown(report, context);
  if (mode === "json") return buildPublicJson(report, context);
  return buildAiBrief(report, context);
}
