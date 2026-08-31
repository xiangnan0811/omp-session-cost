# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-08-31

Visual-design release.

### Added

- OMP theme-aware colors and typography using the theme object supplied to custom UI extensions.
- Stable model color identities shared across Models, Agents, and Agent × Model.
- Cost-share bars for fast visual comparison.
- Dominant-model badges on the Agents tab.
- Agent-grouped model hierarchy on Agent × Model, sorted by cost within each agent.
- Theme-aware borders, headings, metrics, warnings, paths, and footer text.
- ANSI-aware truncation so styled content remains aligned inside the overlay.
- Monochrome-safe structural markers (`▸`, `◆`, `●`, and tree branches).

### Changed

- Replaced the flat `agent @ model` list with an explicit agent → model hierarchy.
- Active tab emphasis now follows the current OMP accent theme.

## [0.3.0] - 2026-08-31

Tabbed TUI navigation for faster session-cost exploration.

### Added

- Five report tabs: Overview, Models, Agents, Agent × Model, and Details.
- Tab switching with `Tab`, `Shift+Tab`, Left/Right arrows, or number keys `1`-`5`.
- Independent scroll position for every tab.
- Dedicated Details tab for low-priority session/root paths, files scanned, fork/dedup metadata, `stats.db`, sync state, and pricing-source information.
- Tests for tab organization, keyboard navigation, and per-tab scroll-state preservation.

### Changed

- `/cost` now opens on a compact Overview instead of one long vertically stacked report.
- Model, agent, and agent × model breakdowns are isolated into focused views, substantially reducing routine scrolling.
- Public extension entry moved to `tabbed.js`; the existing `index.js` remains the native-safe report core.

## [0.2.0] - 2026-08-31

First public release.

### Added

- `/cost` session report with main-agent, recursive subagent, and advisor usage.
- Token breakdown for input, output, cache read, cache write, and orchestration usage.
- API-equivalent cost totals and cost-component breakdowns.
- Grouping by agent type, model, agent, and agent × model.
- Recursive JSONL transcript discovery.
- Fork-aware inherited-request filtering and duplicate suppression.
- Optional OMP stats refresh with `/cost refresh`.
- Scrollable terminal overlay that does not inject the report into model context.

### Compatibility

- Extension load path uses Node built-ins only and does not import OMP internal runtime packages.
- Pricing enrichment is deferred until `/cost` runs, avoiding eager `pi_natives` loading on packaged Linux builds.
