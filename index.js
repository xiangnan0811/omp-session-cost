import { buildReport } from "./core.js";
import { buildCopyPayload, copyText } from "./export.js";
import { formatCost, formatInt, formatTokens } from "./format.js";
import { CostExplorerView } from "./view.js";

const COMMAND = "cost";

function compactSummary(report) {
  return `${formatInt(report.total.calls)} LLM calls | ${formatTokens(report.total.measuredTokens)} measured tokens | ${formatCost(report.total.costTotal)} API-equivalent`;
}

export default function costExplorerExtension(pi) {
  pi.registerCommand(COMMAND, {
    description: "Interactive provider/model/agent/advisor cost explorer for the current session tree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.();
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        ctx.ui.notify("/cost requires a persisted session.", "warning");
        return;
      }

      const forceRefresh = String(args ?? "").trim().toLowerCase() === "refresh";
      ctx.ui.setStatus?.("omp-cost", forceRefresh ? "Refreshing OMP stats and building cost explorer…" : "Building session cost explorer…");
      try {
        let report = await buildReport(sessionFile, pi, ctx, forceRefresh);
        if (report.total.calls === 0) {
          ctx.ui.notify("No persisted assistant usage was found for this session yet.", "info");
          return;
        }
        if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
          ctx.ui.notify(compactSummary(report), "info");
          return;
        }

        await ctx.ui.custom(
          (tui, theme, keybindings, done) => new CostExplorerView(tui, theme, keybindings, report, {
            onRefresh: async () => {
              report = await buildReport(sessionFile, pi, ctx, true);
              return report;
            },
            onCopy: async (mode, copyContext) => {
              const payload = buildCopyPayload(report, mode, copyContext);
              const result = await copyText(payload);
              ctx.ui.notify?.(`Copied ${mode === "brief" ? "AI analysis brief" : mode} via ${result.method}.`, "info");
              return { message: `Copied via ${result.method}` };
            },
          }, done),
          { overlay: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { pi.logger?.error?.(`omp-session-cost: ${message}`); } catch {}
        ctx.ui.notify(`Unable to calculate session cost: ${message}`, "error");
      } finally {
        ctx.ui.setStatus?.("omp-cost", undefined);
      }
    },
  });
}

export { buildReport, CostExplorerView };
