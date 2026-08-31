# Changelog

All notable changes to this project will be documented in this file.

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
