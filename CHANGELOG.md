# Changelog

All notable changes to this project are documented here.

## [0.5.0] - 2026-09-03

Interactive cost-explorer release.

### Added

- Six-view TUI: Overview, Providers, Models, Agents, Advisors, and Details.
- Row focus, selection highlighting, expandable drill-down, parent navigation, and per-view state memory.
- Provider → model → agent, model → agent, and agent → model attribution.
- Cost/Tokens/Calls metric switching and current-metric/name sorting.
- Explicit `CALL%`, `TOK%`, and `COST%` headings in Overview.
- Dedicated advisor ownership and behavior analytics: main/subagent scope, review updates, calls/tokens/cost per review, advise calls, severity, delivered notes/cards, direct primary follow-ups, tools, failures, model mix, and cost intensity.
- Copy menu for AI analysis brief, current selection, current view, full Markdown, and full JSON.
- Privacy-safe aggregate exports that omit transcript text and absolute local paths.
- `.jsonl.gz` transcript support and validation of transcript headers.
- Invalid transcript-shaped file counts in Details and exports.
- Responsive layouts for narrow and wide terminals.

### Changed

- Replaced the text-report → regex-reparse rendering pipeline with structured core, aggregation, export, and view modules.
- Renamed ambiguous request counts in the UI to LLM calls.
- Removed the standalone Agent × Model view; its data now appears as bidirectional drill-down in Models and Agents.
- Public extension entry is now `index.js`; `styled.js` and `tabbed.js` remain compatibility entries.

### Compatibility

- No third-party runtime dependencies.
- No eager imports from OMP runtime/native packages.
- Clipboard transports are activated only when the user performs a copy action.

## [0.4.0] - 2026-08-31

Visual-design release with OMP theme-aware colors, stable model color identities, cost-share bars, dominant-model badges, and agent-grouped model hierarchy.

## [0.3.0] - 2026-08-31

Tabbed TUI release with Overview, Models, Agents, Agent × Model, and Details.

## [0.2.0] - 2026-08-31

First public release with recursive main/subagent/advisor token and API-equivalent cost accounting.
