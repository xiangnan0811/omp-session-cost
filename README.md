# omp-session-cost

`omp-session-cost` adds `/cost`, an interactive current-session cost explorer for multi-provider, multi-model, and multi-agent oh-my-pi workflows.

It scans the persisted root session plus recursive subagent and advisor transcripts, enriches costs through OMP's `stats.db` when available, and opens a theme-aware TUI without injecting report text into the model context.

## v0.5 highlights

- Bottom-anchored explorer capped at 52% of terminal height, leaving the active conversation visible above it.
- Six views: **Overview**, **Providers**, **Models**, **Agents**, **Advisors**, and **Details**.
- Keyboard selection and expandable drill-down instead of one static report.
- Provider → model → agent and model → agent attribution.
- Agent → model attribution with Main/Subagent grouping.
- Dedicated advisor analysis with owner/scope, review updates, calls per review, model mix, advise calls, delivered notes/cards, severity counts, tool activity, and direct primary follow-up calls.
- Explicit `CALL%`, `TOK%`, and `COST%` headings in Overview.
- Wide lists use explicit `CALLS`, `TOKENS`, `COST`, active-share, and `DISTRIBUTION` columns; medium and narrow layouts retain a labeled active metric.
- Metric mode: **Cost**, **Tokens**, or **Calls**.
- Sort mode: current metric or name.
- OMP/Kitty-aware key handling, including reliable Escape behavior in Help and Copy panels.
- One-key copy menu for an AI analysis brief, current selection, current tab, full Markdown, or full JSON.
- Clipboard exports omit transcript text and absolute local paths.
- `.jsonl` and `.jsonl.gz` transcript support.
- Fork-aware filtering, duplicate suppression, invalid transcript-shaped file skipping, and lazy `stats.db` pricing.
- Zero third-party runtime dependencies and no eager OMP runtime imports.

## Install or update

```bash
omp plugin install github:xiangnan0811/omp-session-cost
```

Restart OMP after installation or update.

## Usage

```text
/cost
```

Force OMP's official stats pipeline to refresh first:

```text
/cost refresh
```

## Views

### Overview

Shows session totals and actor-type attribution. Wide terminals display labeled columns:

```text
TYPE          CALLS   CALL%    TOKENS    TOK%      COST    COST%
Subagents     1,948    64.2%    220.1M    62.5%    $47.16    41.5%
Advisors        764    25.2%     86.7M    24.6%    $41.69    36.7%
Main            324    10.7%     45.5M    12.9%    $24.67    21.7%
```

### Providers and Models

Providers expand into models; models expand into agents. Percentages on child rows use the visible parent as denominator.

On wide terminals, every list row uses the same explicit columns:

```text
NAME                         CALLS      TOKENS       COST    COST%  DISTRIBUTION
openai-codex                 1,765      190.0M     $28.61    55.4%  ━━━━━━━━━━━──
```

The percentage column follows the active metric, so it becomes `TOK%` or `CALL%` after pressing `m`.

### Agents

Main and task subagents are grouped separately. Expand an agent to inspect its model mix.

### Advisors

Main-session and subagent advisors are grouped separately. Each advisor can expose:

- owning primary agent and scope
- review updates
- LLM calls, tokens, and API-equivalent cost per review
- advise tool calls and requested severity
- other investigative tool calls
- delivered notes/cards observed in the owning primary transcript
- delivered severity
- direct primary calls parented by an advisor card
- model distribution and cost intensity

`Direct primary follow-up` is intentionally narrow. It is an attribution clue, not proof that the advisor caused all later work.

## Controls

```text
Tab / Shift+Tab      switch views
1 .. 6               jump to a view
Up / Down, j / k     move selection
PgUp / PgDn          move by a page
Home / End           first / last item
Enter / Right        expand
Left / Esc           collapse or return to parent
m                    Cost → Tokens → Calls
s                    sort by current metric / name
c                    copy menu
r                    rebuild and refresh official stats
? / h                help
q                    close
Esc                  close Help/Copy first; otherwise collapse, then close
```

Every view remembers its own selection, scroll position, and expanded rows while the explorer is open. Refresh preserves this state where possible.

## Copy menu

Press `c` and choose:

- **AI analysis brief**: self-explaining Markdown with metric definitions, totals, provider/model/agent/advisor attribution, and deterministic observations.
- **Current selection**: focused statistics for the selected row.
- **Current tab**: compact export of the active view.
- **Full Markdown report**.
- **Full JSON**.

Exports contain aggregate usage only. Transcript content, absolute transcript paths, `stats.db` paths, and local error details are omitted.

## Metric semantics

- **Calls**: assistant/provider calls carrying usage metadata.
- **Measured tokens**: input, output, cache-read, cache-write, and orchestration token categories present in transcripts.
- **API-equivalent cost**: catalog-equivalent pricing from transcript usage or OMP `stats.db`; it is not necessarily subscription/OAuth billing.
- **Cost intensity**: cost share divided by token share. `1.00×` is the session average.
- **Review update**: a synthetic, agent-attributed user delta persisted in an advisor transcript.
- **Advise call**: an invocation of the advisor's `advise` tool. It does not prove delivery or adoption.
- **Delivered note/card**: advisor data observed in the owning primary transcript.

## What is scanned

```text
<session>.jsonl                     main
<session>/backend-engineer.jsonl    subagent
<session>/task-a/reviewer.jsonl     nested subagent
<session>/__advisor.jsonl           main default advisor
<session>/__advisor.security.jsonl  main named advisor
<session>/Sub1/__advisor.jsonl      subagent advisor
```

## Development

```bash
git clone https://github.com/xiangnan0811/omp-session-cost
cd omp-session-cost
npm run check
npm pack --dry-run
```

For local OMP development:

```bash
omp plugin link .
```

## License

MIT
