# 集成验收清单

以下验收在源码提交、定向同步和相关客户端重启后进行。默认只使用可丢弃的合成材料和确定性测试，
不运行 live/Opus 测试，不把真实用户计划提交给 bridge。

## 角色端点与宿主

- Codex Desktop/CLI 使用 `http://127.0.0.1:43123/mcp/codex` 和
  `CLAUDE_CODEX_BRIDGE_CODEX_TOKEN`；Claude Code CLI 使用 `/mcp/claude` 和
  `CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN`。端点 owner 分别为 `codex`、`claude`，reviewer 由 bridge
  推导，不在工具参数中传 `target` 或 `owner`。
- 两端都只调用同一个 Streamable HTTP daemon；不调用 `/mcp` 兼容端点、stdio wrapper、
  `codex exec`、`claude -p`、`codex@openai-codex` 或隐藏 Hook。
- endpoint、health、`peer_status` 和 job 证据都报告相同的当前 `version`、`build_id` 和
  `protocol_version=2`；未注册 MCP 的宿主必须失败关闭并输出 `PEER_REVIEW_FAILURE_REPORT`。
- 正式计划自动触发；普通读取/分析/代码修改/测试/提交、内部 Todo/`update_plan`、已确认计划执行和
  最终汇报都不创建 job；用户明确点名 Opus/Codex 或交付物审查时才显式进入。

## v2 工具契约

- `review_peer` 固定 `review_only + inline + zero tools`，不接受 `artifactMode`、`targetRoot`、
  `repairTargets` 或 `testCommands`。
- `review_repair_peer` 必须显式传 `artifactMode=inline|workspace`。inline 不接受工作区/测试字段，
  并要求完整 `repairedArtifact`；workspace 要求绝对 `targetRoot` 和非空 `{path, action}` 数组。
  plan 只能有一个与 `artifactPath` 相同的 `modify` target。
- 首次进入和每次选择 workspace 前读取 `peer_status`。`active=true` 与 `inlineReviews=true` 即可进行
  零工具 inline 审查；workspace 还必须是 `workspaceRepairs=true`、`workspaceProbeState=available`。
  `pending`/`unavailable` 时不得提交 workspace 请求或创建 job；纯审查继续用 `review_peer`，显式
  workspace 需求输出 `v2_workspace_capability_unavailable` 失败报告，不能静默降级。
- 发起前从完整 `artifactContent` 重新计算 UTF-8 `artifactBytes` 和 SHA-256；正文缺失、身份不匹配、
  空验收标准、相对路径非法或携带旧 `target/operation/round/allowedPaths` 字段时不创建 job。
- workspace `testCommands` 只能是最多 16 项结构化命令：绝对普通 `.exe`、程序字节数、SHA-256、
  参数数组和 100..900000 ms 超时；bridge 的 Codex sandbox 在固定副本内执行，网络关闭，不向 Claude
  暴露 Bash。空数组与省略都不产生 Bash allowlist。
- `seriesId` 默认取 `artifactId`；续轮只携带上轮返回的 `seriesVersion` 和 `latestJobId`，两者必须成对，
  不传 `round`、`maxRounds`、`priorRounds` 或 `previousJobId`。同一 series 最多三次 accepted round，
  每轮最多两次尝试。

## 隔离与同步

- workspace 固定副本包含完整目标根上下文但排除 `.git`；manifest、路径/链接检查和主项目 baseline
  防止越界、删除、重命名、类型/权限变化及基线漂移。
- `repairTargets` 之外的任何写入、符号链接、路径穿越、`.git` 或目标根漂移都生成不可重试的
  `isolation_breach`/`reviewer_scope_violation` 证据，不同步主项目。
- 正常新增/修改只在 baseline 未漂移且仍在 `repairTargets` 内时原子同步；高风险变化进入
  `awaiting_user`，列出稳定 ID，用户明确接受完整 ID 集合后才调用 `approve_peer_sync`，且不重新调用模型。
- `awaiting_user` 的保留副本和锁阻止同一目标根的新 series；不得用新 artifactId 绕过。
- 公共 `isolation_violation` 只含事件序号、工具、原因码和最多 256 字符脱敏预览；工作区绝对路径替换为
  `<workspace>`，控制字符转义；完整原始事件只写受保护 job 详情。

## 路由、模型与 Codex sandbox

- 默认质量路由为 Claude `claude-opus-5/max`、Codex `gpt-5.6-sol/max`；profile/显式路由必须与
  `requested_model`、`requested_reasoning_effort`、`task_profile`、`routing_source` 和 rule ID 一致，
  不可 fallback 或降档。
- Codex -> Claude 只接受 init 模型回执精确匹配、inline 零工具或 workspace 原生文件变更模式；
  Claude -> Codex 记录 `workspace-write`、`approvalPolicy=never`、网络/搜索关闭、无额外目录，
  SDK 没有运行时模型回执时不得写成“已验证模型”。
- Windows Codex 子进程固定 `include_environment_context=true` 与 `windows.sandbox="unelevated"`，
  不修改用户全局配置；结构化测试超时、非零退出、程序身份变化或漏测优先于模型的“通过”。
- 通道不可用、超时、取消、认证/权限/sandbox 错误、模型或 schema 不匹配都输出
  `PEER_REVIEW_FAILURE_REPORT`，不改写成普通“需修改”，不换模型、不重发、不静默跳过。

## 结果、三轮与用户门

- bridge 渲染 `PLAN_REVIEW`/`DELIVERABLE_REVIEW` 五段结果：结论、已确认事项、问题与理由、必须修改、
  剩余风险；缺段、blocked/incomplete、失败测试写成通过或 JSON schema 错误都以 `peer_contract_error`
  失败关闭。
- 第 1/2 轮需修改时，inline 由作者自行修订主项目、workspace 才检查同步后的主项目；更新正文和身份
  后用 CAS 发下一轮；第 3 轮仍不通过或
  实质分歧时只输出 `DISAGREEMENT_REPORT`，不发第 4 轮。通过后仍停在用户执行确认门。
- 仅原作者签收同步后的文件、测试和验收；执行、返工和最终交付不自动追加相反方向互审。

## 确定性运行与发布

- 运行 Skill 的 JSON 校验、`skill-creator` 快速检查、`orchestration-control` 测试和 Bridge 全量单元/集成
  测试；不运行 live/Opus、生产 daemon 或真实用户文件写入。测试临时目录中的受控 daemon 允许启动。
- Skill 与 Bridge 两个仓库分别精确暂存本任务路径，保留无关 dirty/untracked 文件；Skill 推送后用
  `Invoke-CcSwitchSkillSync.ps1` 传入精确 Skill 名和 40 位远端 SHA 定向同步，不直接改运行时目录或数据库。
- 同步验收逐个比较 source、CC Switch、Claude、Codex 四层全部已提交 Skill 文件；任一层不一致只能报告
  “源码已推送，运行时未生效”。激活后只做 health、`peer_status` 和两端连接探针，确认只有一个 daemon、
  无 stdio wrapper、无新 job。
