# Claude Codex Bridge

`claude-codex-bridge` 是一个本地认证 MCP bridge，用于让 Claude Code 与
Codex 在隔离产物或固定工作区副本中互相审查。审查者没有作者主工作区的直接写入
路径；所有写回都经过 manifest、路径和基线检查。

当前版本是 `0.5.0`，协议版本是 `2`。认证、模型路由、隔离、测试或同步证据缺失时
都会失败关闭，不会静默换模型或降级。英文文档见 [README.md](README.md)。

## 角色端点

协议 v2 为两个作者角色使用独立认证端点。端点本身推导对方审查者，因此调用方不能
伪造 `target`、`owner`、`operation` 或轮次。

| 当前作者 | MCP URL | 认证环境变量 | bridge 推导的审查者 |
| --- | --- | --- | --- |
| Codex Desktop / Codex CLI | `http://127.0.0.1:43123/mcp/codex` | `CLAUDE_CODEX_BRIDGE_CODEX_TOKEN` | Claude |
| Claude Code CLI | `http://127.0.0.1:43123/mcp/claude` | `CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN` | Codex |

旧的 `/mcp` 和 `submit_peer` 只保留为 protocol-v1 兼容入口。新的正式互审不能登记或
调用这些兼容入口。

## 核心能力

- 单个本地 Streamable HTTP daemon，严格监听 `127.0.0.1:43123`。
- 每个角色各有一个 token，另保留一个 legacy token；它们只保存在当前用户受保护的
  本地运行目录和用户环境变量，不进入命令行或普通日志。
- `review_peer` 固定为 inline、只读、zero-tool 审查。
- `review_repair_peer` 有两种明确模式：
  - `inline`：zero-tool，结果返回完整 `repairedArtifact`。
  - `workspace`：固定副本、显式 `repairTargets`、manifest 同步门和 bridge 执行的
    结构化测试。
- 基于 CAS 的审查系列，最多接受三轮。
- 严格模型路由且没有回退；默认是 `claude-opus-5/max` 和 `gpt-5.6-sol/max`。

## 安全边界

- daemon 只接受回环流量，拒绝所有带 `Origin` 的请求，每个路由都认证，请求体上限
  为 1 MiB。
- v2 的 `review_peer` 和 inline `review_repair_peer` 不向模型开放任何工具。
  workspace 修复使用固定副本内的原生文件变更；测试是由 bridge sandbox 执行的精确
  `.exe`，不是 Claude Bash。
- 工作区会检查路径穿越、链接、`.git`、越界变更和作者侧基线漂移。删除、重命名、
  权限变化或目录替换需要单独的显式同步批准。
- 公开失败信息只含脱敏摘要；原始事件、prompt、正文和结果只留在当前用户受保护的
  job 详情中。

legacy v1 的隔离修复仅为兼容保留。它在 `testCommands=[]` 时只开放
`Read,Edit,Write`，不开放 Bash；非空列表也只能使用精确验证过的命令。新的集成必须
使用 protocol v2。

部署前请阅读 [SECURITY.md](SECURITY.md) 和 [PRIVACY.md](PRIVACY.md)。

## 要求与安装

- Windows 10 或更高版本。
- Node.js 24.x。
- 已配置且有目标模型访问权的 Claude Code 和/或 Codex host。
- 支持环境变量 HTTP header 的 MCP host。

bridge 不会直接修改 CC Switch、Claude、Codex 或 provider 配置；应通过对应客户端的
管理入口登记。

在源码中执行确定性验证和打包：

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package:release
```

不要在普通 CI 或未明确同意 provider 成本时运行 `test:live*`。发布 ZIP、SBOM、
provenance 和 SHA-256 manifest 会写入 `artifacts/`。

解压发布包后，为当前 Windows 用户安装：

```powershell
.\scripts\Install-Bridge.ps1
.\scripts\Invoke-BridgeLauncher.ps1 doctor
.\scripts\Invoke-BridgeLauncher.ps1 install-daemon-task
```

安装器在 `%LOCALAPPDATA%` 创建不可变版本目录，并更新受保护的 `current.json` 指针。
首次启动会生成 legacy 和角色 token。安装、更新、回滚或 token 轮换后，必须重启两个
MCP 客户端。

```powershell
.\scripts\Invoke-BridgeLauncher.ps1 auth rotate-token
.\scripts\Rollback-Bridge.ps1
```

存在活跃、排队或等待同步的 job 时，轮换 token 和回滚都会拒绝执行。

## MCP 登记

只登记与当前客户端对应的条目。插件中的
[`plugins/claude-codex-bridge/.mcp.json`](plugins/claude-codex-bridge/.mcp.json)
包含两个模板。

Codex 使用：

```json
{
  "type": "http",
  "url": "http://127.0.0.1:43123/mcp/codex",
  "headers": {
    "X-Bridge-Token": "${CLAUDE_CODEX_BRIDGE_CODEX_TOKEN}"
  },
  "env_http_headers": {
    "X-Bridge-Token": "CLAUDE_CODEX_BRIDGE_CODEX_TOKEN"
  }
}
```

Claude 使用：

```json
{
  "type": "http",
  "url": "http://127.0.0.1:43123/mcp/claude",
  "headers": {
    "X-Bridge-Token": "${CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN}"
  },
  "env_http_headers": {
    "X-Bridge-Token": "CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN"
  }
}
```

只能使用 MCP host 实际支持的 header 形式，或同时发送相同值的两种形式。不要把真实
token 放进 Git、命令参数或共享配置。

## 互审契约

每个 v2 请求都提供最终 `artifactContent`、当轮重新计算的 UTF-8 字节数和 SHA-256、
`artifactId`、产物元数据、非空 `acceptanceCriteria` 和可选模型路由字段。续轮还要
带上上一轮的 `seriesVersion` 和 `latestJobId`；调用方不传轮次。

`review_peer` 永远是 inline + zero-tool。`review_repair_peer` 必须明确给出
`artifactMode`：

- `inline` 禁止工作区和测试字段，返回完整 `repairedArtifact`。
- `workspace` 需要绝对 `targetRoot`、非空 `repairTargets`，以及需要测试时的
  `{program, programBytes, programSha256, args, timeoutMs}` 结构化命令。

完整字段见插件中的
[workflow-contract.md](plugins/claude-codex-bridge/skills/cross-model-orchestration/references/workflow-contract.md)。

## 运维与开发

```text
bridge doctor
bridge start
bridge status
bridge auth rotate-token
bridge config show
bridge cleanup --include-jobs
```

调度器最多 3 个活跃 job、20 个排队 job；同一 bridge thread 串行，独立 thread 可以并发。
health、status 和 job 证据都会报告版本、build ID 和协议版本。

开发时只运行确定性测试：

```powershell
npm.cmd run test:unit
npm.cmd run test:integration
node --test plugins/claude-codex-bridge/skills/cross-model-orchestration/test/public-skill.test.mjs
node --test plugins/claude-codex-bridge/skills/cross-model-orchestration/tests/orchestration-control.test.mjs
```

这个项目不提供 provider 账号、云端 relay、隐藏回退，也不会在安装、打包或 CI 中自动创建真实
peer job。
