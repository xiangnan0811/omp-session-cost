# omp-session-cost

`omp-session-cost` adds `/cost`, a theme-aware, lower-half terminal explorer and self-contained diagnostic export for **oh-my-pi** sessions with multiple providers, models, subagents and advisors.

It reads the persisted current artifact tree and local OMP pricing records. Opening the explorer or building a diagnostic report does not call a model or inject the report into model context.

## Install or update

```sh
omp plugin install github:xiangnan0811/omp-session-cost
```

Restart OMP after installing/updating. Requires Node >=22; no third-party runtime dependencies.

## v0.6.0: from aggregate totals to diagnostic evidence

- Per-subject input/output/cache cost breakdowns, nonzero/known-zero/missing-usage distinctions, price coverage and input P50/P95/max.
- Historical model/thinking events with parent-chain provenance, recorded request effort when available, and a **separate** export-time context. Current settings never replace missing history.
- Historical transcript cost **and** matched `stats.db` cost preserved next to the adopted estimate.
- Frozen per-file byte-prefix snapshots, coverage warnings, call/event manifests, scoped time/agent/model/branch views and in-memory new-record bookmarks.
- Conservative repeated-status candidates, incoming-message-to-next-main-record intervals, observed compaction inputs and genuine user-task segments. No invented savings, adjudication, necessity or adoption scores.
- Self-contained default AI diagnostic bundle and schema-2 JSON; selected subjects get the same context and evidence, not a stripped-down total.
- Local copy preview with user question/protected scopes, optional reviewed redacted excerpts, full-size save fallback and no silent clipboard truncation.
- Original six tabs, theme-aware selection, attribution drill-down and bottom-anchored 52% height retained.

**Costs are API-equivalent estimates, not subscription charges or remaining quota. A high share is not proof of waste. Missing information is explicitly unknown.**

## Usage

```text
/cost
/cost refresh
/cost main
/cost main from=2026-09-01T00:00:00Z to=2026-09-02T00:00:00Z
/cost model=openai-codex/gpt-6-astra
/cost after=ENTRY_ID before=OTHER_ENTRY_ID
/cost active
/cost mark
/cost since
/cost help
```

`active` requires the actual runtime main leaf and conservatively excludes descendants with unproven branch linkage. The default retains recorded abandoned paths inside this artifact tree, while excluding pre-fork inherited usage. `mark`/`since` are per-process, per-session record-set comparisons, not causal before/after experiments.

## Explorer

The top level stays compact: **Overview**, **Providers**, **Models**, **Agents**, **Advisors**, **Details**. Enter expands provider/model/agent attribution. `d` opens the selected subject's cost/history summary and full diagnostics. Percentages use the selected scope as denominator; background source totals are separately labeled.

```text
Tab / Shift+Tab       switch tabs
1 .. 6                jump to a tab
Up / Down, j / k      select or scroll
PgUp / PgDn           page
Home / End            first / last
Enter / Right         expand attribution
Left / Esc            collapse or return
m                     Cost → Tokens → Calls
s                     metric/name sort (explorer)
d                     selected subject diagnostics
f                     scope: original / main / all actors
b                     mark snapshot in memory
w                     toggle newly observed records since bookmark
c                     copy-format menu, then local preview
r                     refresh transcripts and official pricing
? / h                 help
q                     return / close
Esc                   return through modal layers before closing
```

## Copy preview

Choose **AI diagnostic bundle**, **Current selection**, **Current tab**, **Full Markdown**, or **Full JSON**. Enter opens the preview. A second Enter copies exactly the previewed payload; nothing is copied on the first Enter.

```text
f                     preview scope: current / main / all / selection
g                     edit analysis question
p                     edit protected / do-not-optimize scopes
n                     edit user annotation (not plugin-verified)
e                     toggle reviewed redacted excerpts
Enter / c             copy the exact preview
s                     save the complete payload to a NEW file
Up/Down, PgUp/PgDn     scroll preview
Home / End            start / end
Esc                   back without copying
```

For a main-only analysis, select main with `f` or `/cost main` and set protected scopes, for example `Advisor, subagents and independent reviews; preserve acceptance checks`. This is optional user context, not a hardcoded policy. The plugin remembers it in memory for that session, not across process restarts.

Default exports include structured facts, scope, historical configuration, pricing provenance, diagnostic candidate evidence and unknowns. They omit conversation text, thinking content, credentials, session titles and absolute paths; agent names are pseudonymized. Optional evidence adds only bounded, redacted visible-text excerpts and reviewed labels. **Automatic redaction is not guaranteed. Review before sharing.**

Very large previews are explicitly limited, but the exported payload is not truncated. Excerpt-mode copying is disabled when the entire indexed excerpt payload exceeds the preview; save it for full local review. Saves use mode 0600 and never overwrite an existing file. Native clipboard tools are preferred; large payloads do not fall back to undersized OSC 52, whose receipt cannot be acknowledged.

## Diagnostic boundaries

A repeated empty-status result is a **candidate**, not guaranteed waste or net savings. A six-hour message-to-record gap is not six hours of model inference or billing. Compaction before/after inputs are observations, not controlled quality-neutral savings. Historical thinking settings are not proof of the provider's actual request effort. Unknown tool spellings and missing metadata remain unknown.

The snapshot freezes file byte limits sequentially; it is **not atomic across files**. Incomplete tails and malformed/unavailable records are counted. The detailed contract, schemas, privacy policy, supported detection grammar and exact filtering semantics are in [docs/diagnostics.md](docs/diagnostics.md).

## Development

```sh
git clone https://github.com/xiangnan0811/omp-session-cost
cd omp-session-cost
npm run check
npm run check:large
node scripts/example.mjs dist
npm pack --pack-destination dist
node scripts/verify-package.mjs dist/omp-session-cost-0.6.0.tgz
```

For local OMP development:

```sh
omp plugin link .
```

Tests and public example reports use synthetic fixtures only. The GitHub release includes the validated package and synthetic diagnostic examples, not user transcripts. GitHub installation does not require npm-registry publication.

## License

MIT
