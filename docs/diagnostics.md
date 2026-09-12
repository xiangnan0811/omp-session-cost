# 诊断格式 v3

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

关闭 blocker 必须再记录明确终态，例如 `resolved/closed/dismissed/rejected/obsolete/superseded`。字段没有证据时省略，不能填推测值。该协议不改变三审独立性、freeze、finding ledger、批量修复或验收规则。

## 压缩、基线与缺失

压缩观察窗口是前后最多五条非辅助用量记录，在相邻压缩和选定范围内截断。只有明确 compaction purpose 且位于可观测压缩区间的辅助调用才关联自身费用。否则在辅助调用表显示但不强行关联。`netSavings` 为 null，质量影响未测量。

基线保存在 `<root>.cost-state/baselines/<name-hash>.json`，原名存入内容，文件名哈希不用于匿名化报告。保存采用临时文件、同步和原子 rename。基线保存历史价格与记录身份；对比侧为当前范围内新增记录，不是两段工作量相等的实验。

缺失原因区分未采集、未关联／共享、解析器不支持、范围外、未选入片段。历史未采集的运行时信息不会从当前配置倒推。范围外但用于解释完整区间的已知起点会显式标注 `outsideSelectedRange`。
