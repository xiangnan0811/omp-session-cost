# omp-session-cost 0.9.2

## OMP 18.3 coordination protocol compatibility

Native `wait {}` is now a status call and its observed runtime interval is `native-wait`. Existing v0.9.1 sidecars carrying `name: "wait"` with a null operation are reclassified on refresh; missing endpoints remain unknown.

`read proc://` and `read proc://<id>` are recognized as status checks. Direct and broadcast peer messages (`write agent://<id>` / `agent://all`), cancellation (`write proc://<id>/kill`), service stdin and `/mode` are no longer classified as filesystem writes. Original target and agent names are preserved.

## Evidence-based repeated-status candidates

`repeated-status-v2` validates the actual wait/proc result shapes and compares stable state. It excludes message delivery, completed/failed task results returned by wait, steering interrupts, service-completion wakes, errors, truncated results and unknown shapes. Running-job elapsed time and agent age are ignored; logs, readiness, terminal durations and task output remain significant.

Literal Eval wrappers are classified without executing transcript code. Neither selected printed output nor an outer Eval duration proves what happened inside. Partial/batch proc results without a verified complete mapping are classified but do not produce repeat candidates. A candidate is not proof that a health check or long blocking wait was unnecessary, and its gross response cost is not guaranteed net savings.

## Compatibility and verification

- Historical `hub/irc/job` calls and both `irc:incoming` / `hub:incoming` events remain supported. Ordinary file IO, task attribution and usage aggregation are unchanged.
- Diagnostic format remains v5; rule version is 1.3.0. New protocol fields are additive. The package remains dependency-free.
- 44 added regressions use constructed JSONL/sidecar fixtures whose output contracts were checked against OMP `v18.3.0`, commit `62bc57be1b03ef0802a33cf7f5f530e534527531`. They are not captured user sessions and do not constitute a live OMP/TUI end-to-end acceptance test.
- The release workflow runs the full Node suite, Bun SQLite/registration checks, a 20,000-call synthetic scan, offline Markdown/JSON verification and an isolated package import before publication.

## 安装或升级

```sh
omp plugin install "github:xiangnan0811/omp-session-cost#v0.9.2"
```

重启需要使用新版的 OMP 进程，执行 `/cost` 核对版本并刷新报告。无需修改 OMP 配置，也不需要手工覆盖 node_modules。
