// Compatibility entry retained for installations that previously referenced tabbed.js.
export { CostExplorerView as TabbedCostReportView, TABS } from "./view.js";
export { default } from "./index.js";

export function splitReportLines(lines) {
  return [{ id: "overview", label: "Overview", shortLabel: "Overview", lines: Array.isArray(lines) ? lines.map(String) : [] }];
}
