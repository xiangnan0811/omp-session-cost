# omp-session-cost v0.6.0

## Diagnostic reports that travel with their evidence

The default copied bundle now explains the selected scope, historical configuration, input/output/cache cost composition, price provenance, measurement coverage, observed work segments and diagnostic limits. A selected main/model/agent report receives the same complete semantics, rather than only aggregate totals.

### Included

- Historical model/thinking events, recorded request-effort coverage and separate current context.
- Nonzero/known-zero/missing-usage distinctions, interruption/error counts, reasoning-as-output detail and input distributions.
- Preserved transcript and database cost estimates alongside adopted values.
- Frozen per-file prefix snapshots, call/event manifests, time/event/actor/model filters, active-main-path mode and in-memory bookmarks.
- Strict repeated-status candidates, incoming-to-next-main-record intervals and observed compaction inputs, with explicit evidence and no guaranteed-savings or causal claims.
- User question/protected scopes, local copy preview, optional reviewed redacted excerpts, complete schema-2 JSON/Markdown and save fallback.
- Existing bottom-anchored 52% six-tab explorer, theme focus and keyboard behavior retained; `d` opens full subject diagnostics.

### Update

```sh
omp plugin install github:xiangnan0811/omp-session-cost
```

Restart OMP. Use `/cost main`, press `d` for subject details, or `c` then Enter to preview a bundle. Enter again copies. In preview: `g` question, `p` protected scopes, `e` excerpts, `s` save.

### Compatibility and limits

JSON schema is now **2**. Bookmarks and analysis context are session/process memory only. Prices remain API-equivalent estimates, not subscription charges or quota. Missing historical fields remain unknown. Snapshots are sequential file prefixes, not atomic transactions. Evidence redaction requires review; oversized excerpt payloads must be saved for full inspection. No analysis model, new runtime dependency or eager OMP/native import is introduced.

The attached examples are entirely synthetic. Offline/unit/packaging checks do not claim live validation on every OMP version or terminal, actual provider effort, or the engineering value of a user's work.
