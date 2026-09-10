import { buildReport, scopeReport } from "./core.js";
import { parseCostArgs, saveReportFile } from "./command.js";
import { copyText } from "./export.js";
import { formatCost, formatInt, formatTokens } from "./format.js";
import { CostExplorerView } from "./view.js";

const COMMAND = "cost";

export const COST_OVERLAY_OPTIONS = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({
    anchor: "bottom-center",
    width: "100%",
    maxHeight: "52%",
    margin: 0,
  }),
});

let keyMatcherPromise;

async function loadKeyMatcher() {
  if (!keyMatcherPromise) {
    keyMatcherPromise = import("@oh-my-pi/pi-tui")
      .then(module => typeof module.matchesKey === "function" ? module.matchesKey : null)
      .catch(() => null);
  }
  return keyMatcherPromise;
}

function compactSummary(report) {
  return `${formatInt(report.total.calls)} LLM calls | ${formatTokens(report.total.measuredTokens)} measured tokens | ${formatCost(report.total.costTotal)} API-equivalent`;
}

export default function costExplorerExtension(pi) {
  // Session-scoped convenience state only; no credential/config/transcript writes.
  const profiles = new Map();
  const bookmarks = new Map();
  pi.registerCommand(COMMAND, {
    description: "Interactive provider/model/agent/advisor cost explorer for the current session tree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.();
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        ctx.ui.notify("/cost requires a persisted session.", "warning");
        return;
      }

      let parsed;
      try { parsed = parseCostArgs(args); }
      catch (error) { ctx.ui.notify(error.message, "error"); return; }
      if (parsed.help) {
        ctx.ui.notify("/cost [refresh] [main|all|active] [from=ISO] [to=ISO] [after=ID] [before=ID] [model=provider/id] [agent=NAME] [mark|since]. In explorer: d details, c preview, f scope, b bookmark, w new records. Preview: g goal, p protected scope, n note, e excerpts, s save.", "info"); return;
      }
      const forceRefresh = parsed.refresh;
      ctx.ui.setStatus?.("omp-cost", forceRefresh ? "Refreshing OMP stats and building cost explorer…" : "Building session cost explorer…");
      try {
        const applyOptions = full => {
          const options = { ...parsed.options };
          const mark = bookmarks.get(sessionFile);
          if (parsed.since) {
            if (!mark || mark.sessionId !== full.sessionId) throw new Error("No matching in-memory bookmark. Use /cost mark or b first.");
            options.sinceKeys = mark.callKeys; options.sinceEventKeys = mark.eventKeys;
          }
          return Object.keys(options).length ? scopeReport(full, options) : full;
        };
        let report = applyOptions(await buildReport(sessionFile, pi, ctx, forceRefresh));
        if (parsed.mark) {
          const scan = report._sourceScan;
          bookmarks.set(sessionFile, { sessionId: report.sessionId, callKeys: new Set(scan.calls.map(c => c.recordKey)), eventKeys: new Set(scan.events.map(e => e.key)), frozenAt: report.snapshot?.frozenAt });
          ctx.ui.notify("Snapshot bookmark stored in memory; /cost since selects newly observed records, not a causal before/after experiment.", "info");
        }
        if (report.total.calls === 0 && !report.events?.length) {
          ctx.ui.notify("No persisted assistant usage was found for this session yet.", "info");
          return;
        }
        if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
          ctx.ui.notify(compactSummary(report), "info");
          return;
        }

        const matchesKey = await loadKeyMatcher();
        await ctx.ui.custom(
          (tui, theme, keybindings, done) => new CostExplorerView(tui, theme, keybindings, report, {
            matchesKey,
            profile: profiles.get(sessionFile),
            bookmark: bookmarks.get(sessionFile),
            onProfile: profile => profiles.set(sessionFile, profile),
            onBookmark: mark => bookmarks.set(sessionFile, mark),
            onSave: (filename, payload) => saveReportFile(filename, payload, ctx.cwd),
            onRefresh: async () => {
              report = applyOptions(await buildReport(sessionFile, pi, ctx, true));
              return report;
            },
            onCopy: async (mode, copyContext) => {
              if (typeof copyContext.payload !== "string") throw new Error("Copy requires a frozen local preview.");
              const result = await copyText(copyContext.payload);
              ctx.ui.notify?.(`Copied ${mode === "brief" ? "AI diagnostic bundle" : mode} via ${result.method}.`, "info");
              return { message: `Copied via ${result.method}` };
            },
          }, done),
          COST_OVERLAY_OPTIONS,
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
