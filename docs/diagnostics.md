# Diagnostic report contract (v0.6.0 / schema 2)

The plugin is an offline observer. It reads the current artifact tree and OMP's local pricing database. It does not invoke a model, execute transcript code, change model roles, compact a conversation, or assess whether engineering work was necessary.

## What a snapshot means

File discovery is followed by a **sequential capture of each file's byte length**. Parsing reads no bytes beyond those limits. Later appends and files created after discovery are not included. This is a bounded append-only-prefix view, **not an atomic cross-file transaction**. A record must end with a newline. Invalid JSON, nonobjects, incomplete tails, over-16-MiB lines, unreadable files, and detected rewrites have separate coverage counters. Do not present the known subtotal as complete when coverage is degraded.

Plain JSONL and gzip JSONL, with or without OMP's title slot, are supported. The title is not historical configuration. A gzip prefix may be incomplete; only complete decompressed JSONL lines are indexed. In-place rewrites while appending cannot be ruled out without writer cooperation.

The default recorded-spend view includes recorded abandoned paths within the current artifact tree, but preserves the previous incremental-fork convention: inherited entries older than a fork header's timestamp are excluded. It does not traverse another parent session's tree. `active` follows an actual runtime main leaf through `parentId`; it never guesses that the last line is the active branch. Descendants are excluded in that mode because their active-branch association is not proven.

Session-qualified IDs and exact line digests prevent arbitrary cross-session message-ID collisions from being merged. Identical records in copies with the **same session identity** are deduplicated, preferring the shallower file. Copies with different unproven identities are kept rather than silently losing spend. Records without IDs get file/line-derived identities and are not heuristically collapsed.

Exports include a pseudonymous call manifest and its SHA-256, per-file prefix digests, local file aliases and line numbers, source counts, selected time boundaries, and explicit scope. Public `scope.manifestDigest` is SHA-256 of `JSON.stringify(sortedPublicCallRefs)`. `sourceManifestDigest` is the local internal-identity digest, for local snapshot comparison. `generatedAt` is not the data cutoff. Local file aliases can be resolved in the Details tab; absolute paths are not copied.

## Usage and price semantics

- `usageRecords` means assistant records carrying an OMP usage object. It does not mean independently verified completed supplier requests.
- `nonzeroUsageRecords`, canonical known-zero records, incomplete zero-like records, missing-usage assistant responses, response/request-ID coverage, interruption/error/success/unknown states, and missing prices are separate.
- OMP's canonical `input`, `cacheRead`, `cacheWrite`, and `output` fields are disjoint. Raw provider `input_tokens` alone is not interpreted as canonical OMP input. Incomplete fields remain `null` in diagnostic facts. Rollups of partial values are known subtotals, not evidence of zero.
- `reasoningTokens` is a recorded output sub-detail, not added again to tokens or cost. Missing detail does not mean no reasoning. Total-token consistency compares the four base fields; orchestration is displayed separately.
- Input distributions use nonzero records with complete canonical input categories. P50/P95 use linear interpolation between sorted samples. The whole-tree cache share is never substituted for a subject's input-side cache ratio.
- Each call preserves `price.transcript`, `price.statsDb`, and `price.adopted`, plus provenance. Valid matched `stats.db` totals have adoption priority; malformed/missing DB totals do not erase a historical price. Both estimates remain visible when they differ. A recorded zero is **not proof of free usage**.
- Prices are API-equivalent estimates, not subscription charges, remaining quota, or verified current official prices. Implied $/million uses recorded priced categories, including associated orchestration tokens, and is explicitly a historical/blended ratio, not a pricing catalog.
- The database is opened read-only. `/cost refresh` may invoke the existing official `omp stats --json` refresh pipeline; it does not invoke an analysis model. No authentication files or full configuration files are exported.

## History, current context, and scope

Historical `thinking_level_change` and `model_change` events follow each entry's actual parent chain; a setting on an abandoned sibling does not contaminate the retained branch. The responding model comes from the assistant record. Per-request effort is shown only when the message explicitly stores `requestParameters.reasoning.effort` or `requestMetadata.reasoningEffort`. A historical `medium` setting with no later change is not proof of provider execution effort.

Current model and `getThinkingLevel()` are shown separately as **export-time-only** context. They are never used to fill missing historical settings. No historical routing role, fallback behavior, subscription plan, or provider capability is guessed.

`from=ISO` is inclusive and `to=ISO` exclusive. `after=ID` and `before=ID` must resolve one timestamped event. They use exclusive entry order in that transcript and timestamp boundaries across files, not a claimed global causal ordering. Missing-time exclusions are counted. Model/agent/actor/provider scopes and the TUI derive from the same selected call set; all displayed percentages use that selected denominator. Unfiltered actor totals appear only as clearly labeled background, not an additional cost category or an invitation to optimize protected actors.

Advisor cards live in the owner's transcript, so a scoped advisor view retains time-matched owner deliveries and narrow direct primary follow-up counts as **related activity**, not additional advisor usage. Under a model filter, those delivery counts are advisor-level related activity; the originating model for every delivered note is not always proven. They are never labeled adoption rates.

Bookmarks are in-memory record/event sets per session. `b` or `/cost mark` records the captured snapshot. `w` or `/cost since` selects newly observed identities after a refresh. Existing records repriced by `stats.db` are not new calls. This is not a controlled before/after experiment or a subtraction of wall-clock elapsed time. Bookmarks and analysis context are lost on process restart.

## Local diagnostic rules

### repeated-status-v1

A candidate requires adjacent same-model metered calls on the same parent chain, complete recognized read-only status paths, an empty inbox, and unchanged normalized results. Intervening human messages, notifications, incoming messages, unmetered assistant records, unknown custom entries, settings changes and compaction prevent a match. Explicit heartbeat-age fields may be ignored; other changing state is retained.

Supported paths are native `hub`/`irc`/`job` inbox/list/jobs/wait operations and a deliberately small literal `eval` grammar using `display`/`print` of `await tool.hub/irc/job({...})`. Recognized numeric `Bun.sleep`, `asyncio.sleep` and simple `setTimeout` waits may accompany those paths. Computed arguments, arbitrary shell commands, variables, dynamic code, mutating operations, errors, mixed/image results, truncated results and absent results are excluded. The plugin never evaluates source code.

A match reports the subsequent call, preceding call, evidence refs, rule version and overlapping record set. Historical/adopted **gross attributed cost** is not guaranteed net savings. Candidate costs must not be added again to the wider status-call category. A health check may still be justified. Unsupported spellings reduce detection coverage; absence of candidates is not proof of efficiency.

### Incoming-message activity

Known incoming/advisor/synthetic update records in main are linked to the next main **usage record**, using transcript timestamps. The interval is not request latency, active inference duration, proof of handling, or adjudication delay. `adjudicationAt` remains unknown. Side replies or other unmetered channels can exist. The plugin does not assign elapsed hours a cost.

### Compaction and task segments

Known compaction records link neighboring measured input sizes in the same transcript. Provider-native replacement payloads are never read/exported as content. The report states whether the neighboring models match, how many entries intervened, and that separate compaction costs, subsequent rereads and quality effects are unknown. It does not claim a controlled reduction or estimate net savings.

Genuine human-message boundaries become U1, U2, etc. Synthetic agent updates do not start human tasks. A boundary outside a selected time range can be included as labeled context when selected calls refer to it. These are recorded segments, not guessed engineering phases or necessity scores. Optional user annotations can describe milestones; they remain user-provided, not plugin-verified.

## Copying, evidence and privacy

`c` opens five formats: AI diagnostic bundle, current selection, current tab, Full Markdown and Full JSON. Enter first opens a **local preview**, then Enter copies exactly that frozen payload. All formats carry scope, measurement semantics, history, cost provenance, evidence boundaries and unknowns. Full JSON uses schema 2; this is a deliberate migration from aggregate-only schema 1.

Preview controls: `f` scope, `g` analysis question, `p` protected/do-not-optimize scopes, `n` annotation, `e` evidence, `s` save. Questions/protected scopes persist only in this process/session. Empty values use neutral defaults, not an assumed user preference. The default is a factual metadata export with pseudonymous agent names, call refs and session ID. It contains no transcript excerpts, source code, raw tool arguments, session titles, absolute paths, database errors, auth data, or thinking content.

Evidence mode adds bounded **redacted visible-text excerpts** and reviewed agent labels. Samples include task context, repeated-status evidence, incoming/follow-up events, compaction neighbors and final events rather than only the most expensive calls. Full Markdown/JSON retains all indexed 320-character excerpts, never complete logs. Automatic redaction is best effort, not a guarantee. Review before sharing. Excerpts are explicitly untrusted data, not instructions to an external model. Redaction cannot provide a complete semantic audit.

The TUI preview is bounded to its first 100,000 characters / 5,000 wrapped rows and announces omitted preview content. The full payload is **not** truncated. When an excerpt payload exceeds this preview, clipboard copying is disabled: save locally for full review. Metadata-only payloads can still use native clipboard tools. Large payloads are never silently sent through an undersized terminal clipboard: native transports are attempted first; OSC 52 is limited to 75,000 UTF-8 bytes and cannot acknowledge successful receipt. Save writes a new file with mode 0600 and refuses to overwrite an existing path.

## UI and compatibility

The six original tabs, theme-aware focus colors, provider/model/agent intersections and bottom-anchored 52% overlay remain. `d` opens a subject's cost/history summary followed by the shared diagnostic report. Details/Help/Preview support arrows, PgUp/PgDn, Home/End; Esc returns through modal layers before closing the explorer. `f` in the explorer cycles original selection scope, main and all actors while preserving time/branch bounds. `r` explicitly refreshes the snapshot.

The parser supports canonical OMP session version-3 records and gracefully exposes unknown fields rather than inventing them. Node >=22 and Bun-compatible module loading are supported; no third-party runtime dependency or eager OMP/native import is added. Some current OMP runtime fields are unavailable in old sessions. Native TUI behavior on an actual user's terminal, subscription consumption, and correctness of engineering judgments are outside offline test claims.

## Development verification

```sh
npm run check
node scripts/benchmark.mjs 20000
node scripts/example.mjs dist
npm pack --pack-destination dist
node scripts/verify-package.mjs dist/omp-session-cost-0.6.0.tgz
```

Unit tests use synthetic data only. The benchmark measures a generated transcript, checks complete candidate/record counts and exports, and reports environment-specific time/RSS. It is not a production performance guarantee. Indexing memory is proportional to call/event metadata; full JSON can be large and should be saved rather than copied into a chat wholesale.
