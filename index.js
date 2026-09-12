import { buildReport, scopeReport, resolveInteractiveRoot } from "./core.js";
import { parseCostArgs, saveReportFile } from "./command.js";
import { copyText } from "./export.js";
import { formatCost, formatInt, formatTokens } from "./format.js";
import { CostExplorerView } from "./view.js";
import { createRuntimeObserver } from "./runtime.js";
import { DEFAULT_BASELINE, makeBaseline, saveBaseline, loadBaseline, listBaselines, compareBaseline, loadProfile, saveProfile } from "./baseline.js";

export const COST_OVERLAY_OPTIONS = Object.freeze({ overlay: true,
  overlayOptions: Object.freeze({ anchor: "bottom-center", width: "100%", maxHeight: "52%", margin: 0 }) });
let keyMatcherPromise;
async function loadKeyMatcher() {
  keyMatcherPromise ??= import("@oh-my-pi/pi-tui").then(module => module.matchesKey).catch(() => null);
  return keyMatcherPromise;
}
function compactSummary(report) {
  return `${formatInt(report.total.calls)} 条用量记录 | ${formatTokens(report.total.measuredTokens)} Token | ${formatCost(report.total.costTotal)} API 等价金额` +
    (report.comparison ? `\n基线「${report.comparison.name}」：历史 ${report.comparison.before.calls} 条；新增 ${report.comparison.after.calls} 条。不是受控实验。` : "");
}
export default function costExplorerExtension(pi) {
  const observer = createRuntimeObserver(pi), profiles = new Map(), bookmarks = new Map();
  pi.registerCommand("cost", {
    description: "会话成本、原始 agent 名称、任务总账、运行时诊断与持久化基线",
    handler: async (args, ctx) => {
      let parsed;
      try { parsed = parseCostArgs(args); } catch (error) { ctx.ui.notify(error.message, "error"); return; }
      if (parsed.help) {
        ctx.ui.notify('/cost [refresh] [main|all|active] [model=provider/id] [agent=NAME] [role=NAME] [task=NAME] [phase=NAME] [status=error] [from=ISO] [to=ISO]\n/cost mark="基线名称"\n/cost since="基线名称"\n/cost compare="基线名称"\n/cost baselines\n界面：1..9 / Tab 切页，d 详情，c 复制，b 保存基线，w 查看新增。原始名称直接保留。', "info"); return;
      }
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) { ctx.ui.notify("/cost requires a persisted session. 请先建立已保存会话。", "warning"); return; }
      if (parsed.mark && (parsed.since || parsed.compare)) { ctx.ui.notify("保存基线与读取／比较基线请分别执行。", "error"); return; }
      ctx.ui.setStatus?.("omp-cost", "正在读取会话成本与诊断快照…");
      try {
        await ctx.waitForIdle?.(); await observer.flush();
        const root = await resolveInteractiveRoot(sessionFile);
        if (parsed.baselines) {
          const rows = await listBaselines(root);
          ctx.ui.notify(rows.length ? rows.map(r => `${r.name} · ${r.calls} 条记录 · ${new Date(r.frozenAt).toISOString()}`).join("\n") : "尚未保存基线。使用 /cost mark=名称。", "info"); return;
        }
        if (!profiles.has(root)) profiles.set(root, await loadProfile(root));
        let full = await buildReport(sessionFile, pi, ctx, parsed.refresh);
        const requestedName = parsed.sinceName || parsed.compareName || DEFAULT_BASELINE;
        if (!bookmarks.has(root) || parsed.sinceName || parsed.compareName) {
          const saved = await loadBaseline(root, requestedName, full.sessionId);
          if (saved) bookmarks.set(root, saved);
          else if (parsed.since || parsed.compare) throw new Error(`找不到基线「${requestedName}」。请先使用 /cost mark="${requestedName}"。`);
        }
        const apply = source => {
          const options = { ...parsed.options }, mark = bookmarks.get(root);
          if (parsed.since) {
            if (!mark || mark.sessionId !== source.sessionId) throw new Error("No matching bookmark. 请先保存当前会话基线。");
            options.sinceKeys = mark.callKeys; options.sinceEventKeys = mark.eventKeys; options.sinceRuntimeKeys = mark.runtimeKeys;
          }
          const selected = Object.keys(options).length ? scopeReport(source, options) : source;
          if ((parsed.compare || parsed.since) && mark?.baseline) selected.comparison = compareBaseline(selected, mark.baseline);
          selected.observerStatus = observer.status(); return selected;
        };
        let report = apply(full);
        if (parsed.mark) {
          const mark = await saveBaseline(root, makeBaseline(full, parsed.markName || DEFAULT_BASELINE)); bookmarks.set(root, mark);
          report.comparison = compareBaseline(report, mark.baseline);
          ctx.ui.notify(`基线「${mark.name}」已保存：${mark.callKeys.size} 条记录，重启后仍可读取。这是统计边界，不代表规则已加载。`, "info");
        }
        if (!report.total.calls && !report.events?.length && !report.runtimeEvents?.length && !report.comparison) { ctx.ui.notify("尚未找到已持久化用量记录。", "info"); return; }
        if (!ctx.hasUI || typeof ctx.ui.custom !== "function") { ctx.ui.notify(compactSummary(report), "info"); return; }
        const matchesKey = await loadKeyMatcher();
        await ctx.ui.custom((tui, theme, keybindings, done) => new CostExplorerView(tui, theme, keybindings, report, {
          matchesKey, profile: profiles.get(root), bookmark: bookmarks.get(root),
          onProfile: async profile => { await saveProfile(root, profile); profiles.set(root, profile); },
          onBookmark: async mark => { const saved = await saveBaseline(root, mark.baseline || makeBaseline(full, mark.name || DEFAULT_BASELINE)); bookmarks.set(root, saved); return saved; },
          onSave: (filename, payload) => saveReportFile(filename, payload, ctx.cwd),
          onRefresh: async () => { await observer.flush(); full = await buildReport(sessionFile, pi, ctx, true); report = apply(full); return report; },
          onCopy: async (mode, copyContext) => {
            if (typeof copyContext.payload !== "string") throw new Error("复制内容必须来自冻结预览。");
            const result = await copyText(copyContext.payload);
            ctx.ui.notify?.(`已通过 ${result.method} 复制${mode === "json" ? " JSON" : "中文分析报告"}。`, "info");
            return { message: `已通过 ${result.method} 复制` };
          },
        }, done), COST_OVERLAY_OPTIONS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { pi.logger?.error?.(`omp-session-cost: ${message}`); } catch {}
        ctx.ui.notify(`Unable to calculate session cost: ${message}`, "error");
      } finally { ctx.ui.setStatus?.("omp-cost", undefined); }
    },
  });
}
export { buildReport, CostExplorerView };
