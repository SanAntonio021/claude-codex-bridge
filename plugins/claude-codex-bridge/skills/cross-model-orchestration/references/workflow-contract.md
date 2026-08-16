# 工作流契约

## 基本约束

本契约用于同一个 `claude-codex-bridge` MCP 的两个方向：`Codex -> Claude` 和
`Claude -> Codex`。每一轮的作者、审查者、产物、哈希、bridge job ID 和同步状态都必须可追溯。

全局自动入口只适用于准备提交给用户确认的正式计划，自动请求必须使用 `artifactType=plan`。
内部 Todo、执行清单、状态更新、普通读取/分析/修改/测试/提交/交付都不自动创建复核 job。用户明确
要求对方执行，或已确认计划明确约定异族执行者时，可以显式使用兼容的 v1 task 路径；v2 正式审查
仍只使用角色端点和 `review_peer`/`review_repair_peer`，任务完成后不自动追加审查。
`artifactType=deliverable` 继续作为显式能力保留，只能由用户明确要求，或由用户明确启用的专用
跨模型循环发起，不能因为任务复杂或交付物重要而自动触发。

- 每个 `seriesId` 最多三次 accepted round，轮次由 bridge 根据 `seriesVersion`/`latestJobId` CAS 推导；调用方不传 `round` 或 `maxRounds`。每轮最多两次尝试。
- 已有活动 job 时只能查询该 job；不得重发、猜测最新线程、使用 `--resume-last` 或绕过 bridge。
- `review_peer` 是 inline、zero-tool 的只读调用；`review_repair_peer` 是一次调用：审查者在固定副本
  中检查并按 `artifactMode` 返回完整 artifact 或受控文件变更，测试由 bridge 负责；作者主项目不直接暴露。
- 审查结果不是执行授权。正式计划通过互审后仍须用户明确确认。
- 通道异常、模型不匹配、格式错误、越界写入、基线漂移、超时或取消立即失败关闭，不算“需修改”。
- `review_repair` 的结果在 bridge 同步前必须包含对应的 `PLAN_REVIEW` 或 `DELIVERABLE_REVIEW`
  标记和明确的 `结论`（`通过`、`需修改` 或 `实质分歧`）。模型明确报告阻塞/未完成、认证或权限失败，
  或把失败测试/未满足验收写成“通过”时，job 进入 `failed`，错误码为 `peer_contract_error`，并返回
  `PEER_REVIEW_FAILURE_REPORT`；审查副本的变更不得同步回作者主项目。

## 审查包

每轮通过角色端点的 `review_peer` 或 `review_repair_peer` 发送如下对象（bridge 从端点推导 owner/target，
并固定 operation、权限和轮次上限，调用方不能覆盖）：

```json
{
  "question": "review, repair when requested, and return the protocol-v2 JSON result",
  "artifactId": "stable-logical-artifact-id",
  "artifactType": "plan | deliverable",
  "taskProfile": "quality | writing | creative_writing | coding | research | knowledge_work | balanced | high_volume",
  "model": "optional allowlisted target model",
  "reasoningEffort": "optional supported effort",
  "artifactName": "logical name or relative file name",
  "artifactBytes": 0,
  "artifactSha256": "64 lower-case hex characters",
  "artifactContent": "full reviewable content and evidence",
  "artifactPath": "optional forward-slash relative path",
  "acceptanceCriteria": ["objective criterion"],
  "constraints": ["scope or safety boundary"],
  "seriesId": "optional stable series id",
  "seriesVersion": 0,
  "latestJobId": "uuid from the previous round"
}
```

先固定本轮完整 `artifactContent`，再立即按它的 UTF-8 编码重新计算 `artifactBytes` 和
`artifactSha256`；不得复用旧轮次或文件元数据中的值。`review_peer` 的 `artifactMode` 和工作区字段
由工具固定。`review_repair_peer` 必须显式提供 `artifactMode`；workspace 模式要求绝对 `targetRoot`
和非空 `repairTargets`，plan 只能有一个与 `artifactPath` 相同的 `modify` 目标；inline 模式禁止
工作区和测试字段并要求模型返回完整 `repairedArtifact`。无测试时 workspace 传 `testCommands=[]`；
不向 Claude 暴露 Bash。需要测试时逐条提供 `{program, programBytes, programSha256, args, timeoutMs}`，
其中 program 必须是未链接的绝对 `.exe`，由 bridge 的 Codex sandbox 在固定副本内执行。

## 发起与快照

两端统一调用（URL 由作者角色决定）：

```text
review_peer(complete inline envelope) 或 review_repair_peer(artifactMode + complete envelope)
await_peer(job_id, timeout_ms <= 45000)
peer_result(job_id)
```

Codex 连接 `/mcp/codex`，Claude 连接 `/mcp/claude`；不得直接把 `target` 或另一角色 token 写入工具参数。
旧 `submit_peer(operation=review_repair)` 只保留兼容周期；字段不完整时返回 `missing_fields`，且不得
创建 job。新的正式互审不得继续使用该兼容入口。

workspace 模式发起前记录目标根内普通文件的相对路径、字节数、SHA-256 和 Git 状态；bridge 把完整
目标根复制到固定副本供审查者读取（排除 `.git`），并保存 baseline/result manifest。`repairTargets`
只约束可变更文件，不缩小可读上下文。job 终态后比较整个文件集合和全部哈希。审查者写入副本以外、
作者主项目在审查期间漂移、出现符号链接、路径穿越或 `.git` 都直接生成 `PEER_REVIEW_FAILURE_REPORT`。

同一 `owner + seriesId` 使用一个 v2 series 和持久状态。下一轮先核对作者当前主项目，再用上一轮的
`seriesVersion` 与 `latestJobId` 做 CAS；不另开逻辑产物，不猜测最新 job。恢复或重试必须沿用已记录的
model、reasoning effort、task profile、routing source 和 rule ID；任一缺失或调用方试图覆盖时停止。
需要换路由时建立新的 `seriesId`，不能在旧 series 中切换。

## 模型解析

`taskProfile`、`model` 和 `reasoningEffort` 都可省略。bridge 按“显式模型/强度 > 显式 profile >
质量默认”解析，并把 `requested_model`、`requested_reasoning_effort`、`task_profile`、
`routing_source`、`routing_rule_id` 写入 job。调用方必须按这些解析结果验收，不能继续使用硬编码常量。

质量默认是 Claude `claude-opus-5` / `max` 和 Codex `gpt-5.6-sol` / `max`。profile 路由和依据见
[model-routing.md](model-routing.md)。`writing` 与 `creative_writing` 仍默认 Opus 5；Opus 4.6 只允许
显式选择。bridge 不改变 `target`，不提供 fallback，也不在失败时自动降档。

## Codex -> Claude

Codex 使用 `/mcp/codex`；调用方可以通过公开路由字段选择白名单模型和强度，但不能传入原始 CLI
参数或覆盖工具、权限参数。bridge 固定并验证：

```text
endpoint owner = codex; derived target = claude
--model <resolved selected model>
--effort <resolved selected effort>
review_peer: review_only + inline + zero tools
review_repair_peer + artifactMode=inline: zero tools; complete repairedArtifact required
review_repair_peer + artifactMode=workspace: acceptEdits + native file changes only; no Bash
system/init.model == resolved selected model
workspace cwd and --add-dir == the fixed bridge workspace
public reported model == resolved selected model
```

`--model`/`--effort` 缺失、重复或与解析结果不同，出现 alternate/fallback 参数，init 回执缺失或
实际模型不是所选模型，工具模式或 JSON schema 不匹配，均停止；没有 fallback model。只有终态
`succeeded`、结果契约合法且模型证据精确匹配时才接受。workspace 的结构化测试由 bridge 的 Codex
sandbox 运行，超时、退出码非零、程序哈希变化或漏测都是失败证据，不能被模型正文的“通过”覆盖。

## Claude -> Codex

Claude 使用 `/mcp/claude`；此方向也只能使用 bridge 端点推导的 Codex reviewer，不直接运行 `codex exec`、
旧 companion 或控制脚本。
bridge 必须记录并返回：

```text
requested model = resolved selected Codex model (default gpt-5.6-sol)
requested reasoning effort = resolved selected effort (default max)
sandbox = workspace-write
approvalPolicy = never
network = disabled
web/search = disabled
additional directories = none
requested model, requested reasoning effort, CLI version, and recorded thread ID
```

`requested_model` 或 `requested_reasoning_effort` 与本 job 的解析结果不同时停止。
SDK 没有独立运行时模型回执时，`requested_model` 仍只能表示请求参数，不能写成“已验证模型”。
workspace `review_repair_peer` 的 Codex 审查者可在固定副本中修复，主项目只由 `repairTargets`、manifest、基线漂移和
哈希同步门控制。

Codex 的 inline `review_peer` 使用专用空只读目录，不以作者项目、daemon 状态、token 目录或保留 workspace 为 cwd。
SDK 的 `requested_sandbox_mode` 只证明 bridge 请求了相应模式；外层宿主仍可能进一步收紧权限，写入
是否真实生效必须由隔离材料和同步哈希证明。

Windows bridge 子进程固定 `include_environment_context=true` 和
`windows.sandbox="unelevated"`，因为只启用环境上下文仍可能被用户级 elevated sandbox 忽略 cwd；
这些参数不得改写用户全局 Codex 配置。Codex 原生补丁工具明确失败后，才允许用本地 shell 写入
固定副本中的 `repairTargets`，其他路径仍由 manifest 与同步门拒绝。同一结构化命令的所有执行事件都
保留，但终态测试证据按最后一次执行计算；后来通过只覆盖该命令此前的失败，未复测或最终失败仍
产生 `peer_contract_error`。

## 三轮与用户确认

1. 作者通过对应角色端点发起第 1 轮，保存 job ID、`seriesVersion` 和 manifest。
2. `通过`：正式计划进入用户确认门；显式交付物审查返回原作者独立验收。
3. `需修改`：作者检查同步结果并修订，更新内容、哈希，并把前轮 findings 和 open items 放入新一轮
   `question`、`constraints` 或 `artifactContent`，携带上一轮 `seriesVersion`/`latestJobId` 再发第 2/3 轮。
4. 第 3 轮仍需修改，或出现无法由新证据消除的冲突：停止并输出 `DISAGREEMENT_REPORT`。
5. 不发第 4 轮。计划互审通过不代表用户已授权执行。

执行和交付阶段不自动再次调用对方模型。用户明确启用的跨模型执行工作流可以保留最多三次
“返工 -> 独立验收”循环；每次不通过必须指出文件、证据和通过判据，第三次仍不通过时停止并等待
用户决定。审查通道失败不能伪装成普通验收失败。

## 同步授权

普通新增/修改在主项目基线未漂移、结果格式正确且仍在 `repairTargets` 内时自动同步。删除、重命名、权限
变化、类型替换或整目录覆盖进入：

```text
state = needs_attention
sync_status = awaiting_user
pending_high_risk = [{ id, action, path, ... }]
```

用户明确接受完整且精确的 `pending_high_risk[].id` 集合后，才调用 `approve_peer_sync`。该调用创建
新的 `sync_request_id`，重新验证主项目 baseline 和保留副本 result manifest，然后只做原子同步，不再
唤起模型。ID 不匹配、工作区被改动、主项目漂移、超出 `repairTargets` 或同步故障均停止；不得生成纯文本
补丁或覆盖作者的新改动。

`awaiting_user` 期间固定副本和锁继续占用目标根；任何活动任务或新的重叠目标根请求都以
`retained_workspace_conflict` 停止，直到原高风险变更被明确授权同步或按记录处理。

## 输出格式

### PLAN_REVIEW

保留五段结构以兼容既有调用：

```text
PLAN_REVIEW
结论：通过 | 需修改 | 实质分歧
已确认事项：
- ...
问题与理由：
- <问题；理由；证据或待核事实>
必须修改：
- <作者可执行的修订>
剩余风险：
- ...
```

### DELIVERABLE_REVIEW

这是用户明确请求或专用跨模型工作流使用的显式格式，不是默认交付门。它与 `PLAN_REVIEW` 同构，
但必须具体到文件、结果、测试和验收标准：

```text
DELIVERABLE_REVIEW
结论：通过 | 需修改 | 实质分歧
已确认事项：
- ...
问题与理由：
- <问题；理由；文件或证据>
必须修改：
- <作者可执行的修订>
剩余风险：
- ...
```

### DISAGREEMENT_REPORT

只整理双方已有判断和证据，不推荐折中方案：

```text
DISAGREEMENT_REPORT
产物：<artifactId / 名称>
阶段：计划复核 | 交付物复核
轮次：<1 | 2 | 3>
共识：<已确认事项>
作者判断：<角色、模型、结论、理由和证据>
审查者判断：<角色、模型、结论、理由和证据>
待用户裁决：<一个明确问题>
```

### PEER_REVIEW_FAILURE_REPORT

```text
PEER_REVIEW_FAILURE_REPORT
方向：Codex -> Claude (<selected model>) | Claude -> Codex (<selected model>)
阶段：计划复核 | 交付物复核 | 同步
jobId：<bridge job id or unavailable>
请求模型：<model or unavailable>
实际模型：<reported model or unavailable>
decisiveError：<model_mismatch | timeout | reviewer_write_detected | baseline_drift | ...>
已完成：<审查包、快照和已保留证据>
未完成：<未执行的修订、同步或验收>
恢复条件：<用户需重新提交、授权或创建新 artifactId 的条件>
```

`peer_contract_error` 属于格式/完成状态失败，不得改写成普通“需修改”。错误、失败报告和用户已裁决的分歧报告不再递归触发互审。任何模型不可用或身份不匹配都暂停，
不得选择 fallback。
