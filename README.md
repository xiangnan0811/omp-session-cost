# omp-session-cost

A lightweight [`oh-my-pi`](https://github.com/can1357/oh-my-pi) extension that adds `/cost`: a current-session token and API-equivalent cost report covering the **main agent, recursive subagents, and advisors**.

It is built for multi-agent OMP workflows where the main status line tells only a small part of the story.

## Highlights

- Main agent + recursive task subagents + advisors
- Input / output / cache-read / cache-write token accounting
- Orchestration-token accounting when present in OMP transcripts
- API-equivalent cost breakdown
- Grouping by agent type, model, agent, and agent × model
- Five-tab TUI: Overview, Models, Agents, Agent × Model, and Details
- Theme-aware colors and typography that follow the active OMP theme
- Stable model color identities across Models, Agents, and Agent × Model
- Dominant-model badges and agent-grouped model hierarchy
- Tab / Shift+Tab / Left / Right navigation with per-tab scroll-position memory
- Fork-aware filtering and duplicate suppression
- TUI overlay with no report text injected into LLM context
- Native-safe extension loading: no eager `@oh-my-pi/*` runtime imports
- Zero third-party package dependencies

## Install

### Recommended: OMP plugin manager

```bash
omp plugin install github:xiangnan0811/omp-session-cost
```

Restart OMP after installation so the extension module is loaded.

### Manual user extension

```bash
git clone https://github.com/xiangnan0811/omp-session-cost \
  ~/.omp/agent/extensions/omp-session-cost
```

Then restart OMP. For local-development changes, `/reload-plugins` may also be useful.

## Usage

Run inside a persisted OMP session:

```text
/cost
```

`/cost` reads the current root session transcript plus its recursive agent-artifact tree and opens a tabbed TUI report. The default **Overview** keeps the high-value totals on one screen, while detailed breakdowns live in focused tabs.

To force OMP's official stats pipeline to refresh before pricing enrichment:

```text
/cost refresh
```

### TUI layout

```text
SESSION COST  main + recursive subagents + advisors
[Overview]   Models   Agents   Agent × Model   Details

SUMMARY
Requests                     2107
Failed requests                  0
Measured tokens            285.5M
API-equivalent cost        $108.20
Input                        6.83M
Output                      733.0K
Cache read                  278.0M

BY AGENT TYPE
subagent   1989 req   270.1M tok   94.6%   $97.16   89.8%
main        118 req    15.4M tok    5.4%   $11.03   10.2%
```

The tabs are ordered by day-to-day usefulness:

1. **Overview** — request totals, token usage, cost components, and agent-type split.
2. **Models** — per-provider/model token and cost breakdown.
3. **Agents** — per-agent breakdown plus the dominant model for each agent, ranked by API-equivalent cost.
4. **Agent × Model** — agent-grouped model attribution, sorted by cost within each agent.
5. **Details** — session/root paths, files scanned, fork/dedup information, `stats.db`, sync state, and pricing sources.

The exact values depend on your models, providers, session tree, and OMP pricing catalog.

## What gets counted

For the active root session, the extension scans:

```text
<session>.jsonl                 main agent
<session>/
  backend-engineer.jsonl        subagent
  frontend-engineer.jsonl       subagent
  task-a/
    nested-reviewer.jsonl       nested subagent
  __advisor.jsonl               advisor
```

Assistant messages with OMP usage metadata are aggregated across the tree.

The report includes:

- requests and failed requests
- input tokens
- output tokens
- cache-read tokens
- cache-write tokens
- orchestration input/output/cache-read tokens when available
- premium requests when available
- total and component API-equivalent costs

## Pricing semantics

Dollar amounts are **API-equivalent estimates** when OMP has catalog pricing. They are not necessarily the amount charged to a subscription or OAuth-backed account.

The extension uses this order:

1. Usage cost already persisted in the session transcript.
2. Matching rows in OMP's `stats.db`.
3. If measured requests remain unpriced, run `omp stats --json` from the `/cost` command handler and re-read `stats.db`.

This keeps extension loading independent from OMP's native addons while still reusing OMP's own pricing pipeline when necessary.

## Why no OMP runtime imports?

A previous local prototype imported OMP stats/catalog/TUI packages at extension module load time. On some packaged Linux builds, that dependency chain eagerly loaded `pi_natives` and prevented the extension from registering.

The public entry imports only local extension modules, while the report core imports Node built-ins only. No `@oh-my-pi/*` runtime package is imported during extension loading. OMP APIs are received through the extension factory, and Bun SQLite is loaded lazily only when `/cost` needs `stats.db` pricing data.

## Controls

Inside the report overlay:

```text
Tab / Right        next tab
Shift+Tab / Left   previous tab
1 .. 5             jump directly to a tab
Up / Down          scroll one line within the active tab
j / k              scroll one line within the active tab
PgUp / PgDn        scroll one page
Home / End         jump to top / bottom of the active tab
q / Esc            close
```

Each tab remembers its own scroll position while the report is open, so switching views does not lose your place.

## Visual design

The report uses the theme object supplied by OMP's custom-UI API rather than hard-coded ANSI colors. This means borders, accents, warnings, muted text, model badges, and headings follow the user's current OMP theme.

Model colors are assigned consistently within a report. The same model keeps the same visual identity in **Models**, **Agents**, and **Agent × Model**. The **Agents** tab shows each agent's dominant model by API-equivalent cost, while **Agent × Model** groups models under their agent and sorts them by cost within that agent.

The hierarchy remains readable when colors are disabled: active tabs stay bracketed, models use `●`, agents use `◆`, and agent/model relationships use tree branches.

## Troubleshooting

### `/cost` is missing

Check that the manifest points to the styled public entry:

```bash
cat ~/.omp/plugins/node_modules/omp-session-cost/package.json
```

or, for a manual install:

```bash
cat ~/.omp/agent/extensions/omp-session-cost/package.json
```

The manifest should contain:

```json
{
  "omp": {
    "extensions": ["./styled.js"]
  }
}
```

For full extension-load diagnostics, inspect OMP logs:

```bash
ls -1t ~/.omp/logs/omp.*.log | head -1 | xargs tail -n 200
```

### Cost differs from subscription billing

Expected. `/cost` reports API-equivalent pricing where OMP can price a request. Subscription plans, OAuth quotas, bundled access, and provider-specific billing can differ.

### A background agent is still running

`/cost` is a snapshot of usage already persisted to transcripts. Run it again after background work completes for the final total.

## Privacy

The extension reads session transcripts locally. It does not upload transcript content anywhere.

`/cost refresh` invokes the local `omp stats --json` command so OMP can update its own stats database.

## Development

```bash
git clone https://github.com/xiangnan0811/omp-session-cost
cd omp-session-cost
npm run check
```

For local OMP development:

```bash
omp plugin link .
```

Restart OMP after linking.

## License

MIT
