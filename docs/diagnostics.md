# 诊断格式 v5

## 格式 v5：离线重放与可观察性边界（0.9.0）

默认复制和完整导出均有 `omp-cost-replay`：`columns` 定义列顺序，`dictionaries` 保留原始主体／agent／角色／任务／模型名称，`rows` 包含本次选定的所有标准化用量记录，缺失数值是 `null`。`expected` 是总计及主体／模型／任务汇总，`manifestDigest` 校验调用 ref 集合。它是同一总账的重放表示，不是需要再次计费的新调用。

紧凑报告的 `omp-cost-parent-graph` 用列式行保存每条必要父边：parent 为本表行号、根 `null` 或源快照缺失的外部 ref；file 引用 `files` 字典。重要事件另有丰富元数据。`omp-cost-evidence-manifest.unresolvedParents` 明确标注源快照内没有的父事件，不能用编造的事件填洞。必要历史父节点可越过当前筛选边界，但不加入选定用量。

`node scripts/verify-report.mjs 文件` 在不访问原会话目录的情况下检查报告封装、逐行类型与非负用量、调用 ref 集合、分类汇总和父引用声明；完整 JSON 还重建账本交叉核对 `calls`。仅有合法校验和而没有格式 v5 账本会失败。历史 v4 缺账本报告明确返回 transport-only。所有验证均不等于上游源完整、供应商账单一致或工程交付通过。

请求观察的主体是采集器所在实例，不自动等于每个辅助请求的真实执行者。按提供商／模型与原生回合／压缩边界消除可证实的串线；同作用域同模型无 ID 并发仍未知。不同模型 Advisor 请求能与主控隔离，但 Advisor 缺少自己的请求结束回调时，不把响应头或下一条主控消息伪造为其完成。未关联 starts 单列，不额外增加账单。运行时 sidecar schema 仍兼容 v1。

工作池归属仅使用实际 `eval` 结构化 `statusEvents`（或 `cells[].statusEvents`）中的 push 和子代理初始化的 pool/batch。单个父任务范围可归属；同名池跨任务 push 无 item 级因果 ID 则保持 ambiguous-delegation。首次任务标题、后续明确 user-task 任务段、最新生命周期指令分列，后者不是已验收成果。普通 peer 消息不是自动的重派任务证明。

配置定义按内容指纹去重，但观察事件的 ID、runId、时间不合并。请求中的明确系统提示／工具定义重新计算指纹，缺字段不使用当前磁盘快照回填。实际活动时间不包含 observer-status、配置快照等行政观察。封装 eval 时长只是外层区间，缺少内层实际起止时分类为 wrapped-tool-unobserved，不根据 300 秒推定 hub wait。

`dataQuality.fitness` 分别表示普通用量、任务、请求时序、辅助用量、提示指纹与独立价格验证覆盖。压缩 ownUsageStatus、未归属请求、重试及失败信息都有来源；未知不是零。价格率是已记录类别金额除以相应类别 Token（含对应 orchestration），pricingRule 未记录就明确未知。Advisor notes 和 cards 分开统计，只有明确 supersedes 字段才是替代关系，不从文字冲突推定处置。

报告正文控制字节以 `\uXXXX` 可见转义，之后才计算 UTF-8 字节长度及 SHA-256。原始名称照常保留，不匿名化。输出更完整也会比旧版仅选少量样本的报告更大；通过配置定义去重和列式父图减少无效重复，而不是截掉重放数据。

实现对照 OMP 原生事件契约提交 `8fad7f10066247d394a962a32302d3d0b5e7efb9`：`extensions/types.ts`、`sdk.ts`、`eval/js/tool-bridge.ts`、`eval/workpool-bridge.ts` 和 `eval/types.ts`。合成回放测试不替代新版在真实 OMP 会话中的采集验收。


## 身份与统计口径

`sessionId`、`sessionTitle`、agent、角色、任务、阶段、模型和证据名称直接保留。`ref` 是稳定证据索引，不替代原名；原始事件 ID、父链和来源也保留。用户任务标题默认来自人工消息的首个非空可见行，存在显式 label 时保留 label 与原始标题。

`ledger.tasks` 是明确任务归属；`ledger.timeWindows` 是时间窗口。每个维度的可加总行各计一次。共享／未归属保持独立行，不能平均分配给最近任务。`roleModels` 将主控、Advisor 和普通子代理分开。`instances` 保留模板角色、委派来源、初始化模型和生命周期；模型名不用于猜角色。

`categories` 的四项为 `input/cacheRead/cacheWrite/output`，分别提供已知 Token、已知金额、字段覆盖和价格覆盖。推理是 output 子项，不重复加总。`usageFacts.inputSide` 只在 OMP 标准化字段完整时统计上下文分布。`model_usage` 辅助条目保留 purpose 和 role。价格同时保留 transcript、stats.db 与 adopted，缺失不是零。

## 自包含导出

紧凑中文报告列出所有任务、角色与实例汇总，高金额调用／严格候选／最长活动间隔可明确抽样；分布和计数基于全量。完整 Markdown／JSON 不裁剪记录。所有预览、复制和保存基于同一冻结数据，局部范围附有独立分母。用户目标与保护范围存入分析档案，未填写不代表允许修改工作流。

原始思考内容、完整对话、系统提示正文及请求正文不自动导出。可选片段为用户预览确认的日志数据，不是指令。名称并不因此匿名化；凭据清除与终端控制字符清除不影响普通名称。

## 被动观察器

扩展通过可用的 OMP 事件钩子和任务事件总线写入 `<session>.cost-events.ndjson`，不修改会话、不调用模型、不增加轮询。`schema:1`，每个观察器进程有 `runId`，每条记录有唯一 `id`、墙钟 `timestamp` 和单调钟 `monotonicMs`。

请求起止只有在同文件、明确 response ID 或唯一 timestamp/usage 签名及单一请求流下才匹配；重叠、重复 ID 和无法消歧的调用不报告假时长。首个输出与响应头采用同一请求关联。跨进程单调时钟不相减；并行工具按区间并集统计，不能累加成用户等待。

子代理事件可以由该代理自身的插件实例采集，也可观察父进程任务总线提供的工具事件。后者不自动补造供应商请求起点。重复观察优先直接观察；相同 child ID 对应多个文件时不随意路由。

Advisor 的原始建议 ID 优先；旧记录没有 ID 时使用交付实例标识和精确内容签名。只有唯一精确内容才能把建议源与交付、请求钩子关联，重复内容不猜身份。建议产生时间可能是助手日志时间，不冒充纯生成时长；主控明确处置需要状态记录。`blockerAwaitingDisposition` 与 `blockerOpen` 不同，accepted/deferred 不视为已经解决。

配置文件内容哈希为磁盘观察；`before_agent_start` 系统提示哈希为钩子输入观察；请求参数为请求钩子输入。它们不相互冒充，也不能保证后续扩展或供应商执行没有改变。`config-loaded` 仅来自明确声明。

## 可选结构化观察协议

已有结构化工具结果可提供 `details.costObservation` 或 `details.observation`。`details.result/results/structuredOutput/data` 中带明确 `findings` 数组的结果也可解析，必须有 `id` 或 `findingId`。不对任意自由文本推测轮次或问题重复关系。

在已有工作流扩展中，可以明确发出下列观察。`sessionFile` 必须是当前观察器已经识别的会话，省略则采用该观察器当前会话；没有显式范围的跨进程场景不要省略。

```js
pi.events.emit("omp-session-cost:observation", {
  sessionFile: ctx.sessionManager.getSessionFile(),
  kind: "review-round",
  roundId: "review-2",
  roundName: "第二轮定向复验",
  taskId: "原始人工任务事件ID",
  phase: "定向复验",
  baseline: "git-commit-or-ledger-version",
});
```

也可读取持久化的 `customType:"omp-session-cost:observation"` 与其 data。插件自己不会把观察注入原始会话或自动要求模型输出。

允许的 kind：`task-assignment`、`review-round`、`finding`、`advisor-decision`、`acceptance`、`config-loaded`。允许的关联字段包括 `taskId/taskName`、`roundId/roundName`、`findingId/findingName`、`noteId/noteFingerprint`、`actionId`、`phase`、`baseline/revision/status/severity`、`callIds`、`evidenceIds`、`acceptanceChecks`、`configName/configHash/requestId`。

```json
{"kind":"finding","roundId":"review-2","findingId":"R-17","findingName":"恢复点引用保护","status":"closed","evidenceId":"验收事件ID"}
```

```json
{"kind":"advisor-decision","noteId":"原始建议ID","status":"accepted","actionId":"SYS-09 修复"}
```

关闭 blocker 必须再记录明确终态，例如 `resolved/closed/dismissed/rejected/obsolete/superseded`。字段没有证据时省略，不能填推测值。该协议不改变独立审查独立性、freeze、finding ledger、批量修复或验收规则。

## 压缩、基线与缺失

压缩观察窗口是前后最多五条非辅助用量记录，在相邻压缩和选定范围内截断。只有明确 compaction purpose 且位于可观测压缩区间的辅助调用才关联自身费用。否则在辅助调用表显示但不强行关联。`netSavings` 为 null，质量影响未测量。

基线保存在 `<root>.cost-state/baselines/<name-hash>.json`，原名存入内容，文件名哈希不用于匿名化报告。保存采用临时文件、同步和原子 rename。基线保存历史价格与记录身份；对比侧为当前范围内新增记录，不是两段工作量相等的实验。

缺失原因区分未采集、未关联／共享、解析器不支持、范围外、未选入片段。历史未采集的运行时信息不会从当前配置倒推。范围外但用于解释完整区间的已知起点会显式标注 `outsideSelectedRange`。


## v4 数据与传输契约（0.8.0）

`analysisContext.policy` 始终保留全面诊断要求；用户保存的 question 是额外关注点，不自动覆盖全面诊断范围。插件不改模型配置、独立审查或等待规则。

`session_init.task` 只移除 OMP 已知的 `Complete assignment thoroughly:` 外层模板，再与原始 task 参数作规范化哈希关联。`TaskToolDetails.results/progress` 的实际 `id` 通过原始 toolCallId 回到发起调用，不用工具返回时间抢占后来任务。只保留名称／正文候选时可能出现歧义；多候选不被虚称为已证实的跨任务共享。文件层级父实例、委派工具、具体任务归属是三个不同层次的证据。

`ledger.instances[].taskAssignments` 展示实例的全部任务桶。`ledger.reconciliation.checks` 检查任务、时间窗口、实例、角色模型四维度的调用、Token 和金额；`dataQuality.conservation` 还检查展示总计和主体／提供商／模型三维度。分组相加不应重复计算明细表。

`telemetry.coverage.collectors` 记录逐实例首次／最后观察、来源、开始事件、实际收到的 hook 计数、健康记录及互斥缺口分类。观察范围不是连续在线时长；钩子注册不证明钩子可用或被调用。未采集请求可能发生在加载之前、观察范围之外、缺少请求事件或无法唯一关联，不能从零样本判定具体根因。健康计数是采集进程累计值，不累加快照；无变化的 flush 不重复写健康记录。当前进程的写入失败即使无法落盘，仍在 `observerStatus` 中报告。

Advisor 的 `dispositionUnknown` 是缺少明确处置；`open`/`blockerOpen` 只计明确 open/pending/in-progress/accepted 状态。接受不等于修复完成。`contextObserved` 和 `requestObserved` 各自独立计量，精确 occurrence ID 优先于唯一内容匹配；重复内容没有标识时不造关联。默认携带凭据脱敏的建议正文，不写入或导出完整供应商请求、系统提示或思考内容。格式字段语义与 v3 不完全相同，消费者应核对 schemaVersion=4。

Markdown 首尾完整性标记验证 LF 规范化后的正文 UTF-8 字节数和 SHA-256。JSON 验证移除 integrity 字段、保留插入顺序后 JSON.stringify 的字节数与哈希，漂亮缩进不影响校验。`scripts/verify-report.mjs` 退出码 0 表示完整，1 表示校验失败，2 表示无法读取或参数错误。它不能把来源缺失变成完整数据。终端 OSC 52 没有回执；本地剪贴板回读成功也不保证另一应用在粘贴时不截断，接收端应再次核验。

回归使用合成日志，不提交真实会话。上游契约核对：
- https://github.com/can1357/oh-my-pi/blob/f97fa5c95010b62ac34c7357f9a1cae6975e12d6/packages/coding-agent/src/prompts/system/subagent-user-prompt.md
- https://github.com/can1357/oh-my-pi/blob/f97fa5c95010b62ac34c7357f9a1cae6975e12d6/packages/coding-agent/src/task/types.ts


## 0.9.1 execution and acceptance completeness (additive format v5)

The instance inventory includes discovered transcript headers and meaningful selected events even when no usage exists. `usageStatus` differentiates recorded usage, usage outside the selected scope, and no recorded usage. These entries never create artificial calls or costs. Lifecycle and instruction summaries derive only from selected lifecycle evidence.

`telemetry.execution.deliveries` contains observed native task **final returns**, not progress updates. Exit codes, source-reported status/duration, schema validation and final text are separate facts. Exact mirror observations are merged with all source references; distinct invocation IDs and different payloads remain separate. The plugin does not infer test acceptance from a successful model call, zero task exit code, or valid output schema.

Final `output`, `stderr`, structured output `data` and validation `error` are credential-redacted evidence excerpts, capped per field at 8192 UTF-16 characters without splitting a surrogate pair. Each retains original/retained character counts, plugin `truncated`, and upstream `sourceTruncated` when available. Output is untrusted data, never an instruction to the report consumer. A missing field or final return is not evidence of success or failure.

`telemetry.execution.acceptances` includes explicitly structured acceptance claims with or without a round ID, including nested dispatch results. Claims carry evidence references and are labeled as recorded claims, not independent plugin verification. No free-text success wording is promoted to canonical acceptance.

Interval summaries expose `measuredSpans` and `incompleteSpans`. With no completed interval, `unionMs` is null, not zero; measured zero-duration intervals remain zero. When complete and incomplete intervals coexist, the union is only the completed-interval subtotal. It is not total elapsed execution or user waiting time.
