# Changelog

## 0.7.0 - 2026-09-11

- 直接保留原始 agent、角色、任务、阶段、模型与会话名称；不再使用匿名代理编号。
- 新增任务含后代总账、独立时间窗口、角色 × 模型／实例成本分项与上下文分布，支持 model_usage 辅助调用。
- 新增持久化命名基线、重启恢复、增量／前后对比与分析档案，保留历史价格。
- 新增被动请求、首个输出、工具、原生等待、审批、重试和压缩观察；同名子代理、重复 ID、并行区间均显式处理。
- 新增 Advisor 产生／交付／请求／明确处置／动作链，区分接受与 blocker 解决；支持结构化审查轮次、finding 与验收证据。
- 默认中文自包含报告与格式 v3，原始证据可追溯；全量汇总与明细抽样分开，完整导出不裁剪。
- 保留半屏和原有交互，增加任务／时序／对比页面；支持未变化的标准化快照复用并重新读取价格。
- 通过正常 GitHub 插件渠道升级；不再将压缩包作为 Release 升级附件。


## 0.6.0 - 2026-09-10

### Added
- Self-contained AI diagnostic bundle, full call/event manifests and schema-2 JSON.
- Per-subject price components, input distributions, usage/price coverage and historical configuration provenance.
- Conservative repeated-status evidence, incoming-to-next-main-record intervals and compaction input observations.
- Frozen byte-prefix snapshots, event/time/subject filters, active-main-path selection and in-memory new-record bookmarks.
- Subject detail panel, scoped copy preview, user analysis/protected context, reviewed redacted excerpts and full-size save fallback.

### Changed
- Preserve transcript, stats.db and adopted estimates instead of overwriting price provenance.
- Copying now previews first; native clipboard transports precede size-bounded OSC 52.
- Cross-file deduplication requires shared session identity rather than coincident message IDs alone.
- Default exports pseudonymize agent/session/call identifiers and distinguish unknowns from recorded zeros.

### Preserved
- Lower-half six-tab TUI, provider/model/agent attribution, Advisor metrics, theme-aware focus and Escape behavior.
- No analysis-model calls, third-party runtime dependencies, eager native imports or model/workflow configuration changes.


All notable changes to this project are documented here.

## [0.5.2] - 2026-09-03

TUI layout, contrast, and keyboard hotfix for OMP 18.1.5.

### Fixed

- Anchor the explorer at the bottom of the terminal and cap it at 52% of terminal height instead of occupying the full screen.
- Stop padding short views with a full page of blank rows; short Overview and modal views now use only the height they need.
- Resolve selected-row foreground through `fgOnBg` before applying `selectedBg`, preventing white-on-light selection rows.
- Recognize OMP/Kitty keyboard sequences through the runtime `matchesKey` helper, with legacy and CSI-u fallbacks.
- Make Escape close Help and Copy panels reliably before affecting the underlying explorer.
- Replace the distant, truncated row suffix with explicit `CALLS`, `TOKENS`, `COST`, active-share, and `DISTRIBUTION` columns on wide terminals.
- Add responsive active-metric columns on medium and narrow terminals.
- Include terminal height in the render cache key so resizing updates the viewport immediately.
- Compact Help and Copy content so their controls remain visible inside the lower-half panel.

### Tests

- Added lower-half overlay contract, selected-row contrast, Kitty Escape, responsive column-transition, metric-header, and terminal-height cache coverage.

## [0.5.1] - 2026-09-03

OMP 18 session-format compatibility hotfix.

### Fixed

- Accept current OMP session files that physically begin with the fixed-width `type: "title"` slot before the logical `type: "session"` header.
- Fold the title slot's current title and title source into the parsed session header, matching OMP's logical session view.
- Preserve support for legacy transcripts that begin directly with the session header.
- Apply the same compatibility handling to root sessions, recursive subagent/advisor transcripts, and `.jsonl.gz` files.

### Tests

- Added exact 256-byte title-slot fixtures modeled on OMP 18.1.5.
- Added root, recursive transcript, gzip, legacy-format, and malformed-prefix coverage.

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
