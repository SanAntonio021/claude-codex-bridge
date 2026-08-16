# Claude Codex Bridge

`claude-codex-bridge` is a local, authenticated MCP bridge for bounded
cross-model review between Claude Code and Codex. It gives the reviewer an
isolated artifact or a fixed workspace copy; it never gives the reviewer a
direct write path to the author's working tree.

This is version `0.5.2`, with protocol version `2`. It fails closed when
authentication, model routing, isolation, test, or synchronization evidence is
incomplete. Chinese documentation: [README.zh-CN.md](README.zh-CN.md).

## Role Endpoints

Protocol v2 uses a different authenticated endpoint for each author role. The
endpoint derives the opposite reviewer, so callers cannot forge `target`,
`owner`, `operation`, or review round fields.

| Current author | URL | Environment token | Derived reviewer |
| --- | --- | --- | --- |
| Codex Desktop / CLI | `http://127.0.0.1:43123/mcp/codex` | `CLAUDE_CODEX_BRIDGE_CODEX_TOKEN` | Claude |
| Claude Code CLI | `http://127.0.0.1:43123/mcp/claude` | `CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN` | Codex |

The old `/mcp` endpoint and `submit_peer` interface remain protocol-v1
compatibility paths only. Do not register them for a protocol-v2 review flow.

## What It Provides

- One loopback-only Streamable HTTP daemon on `127.0.0.1:43123`.
- Independent per-role tokens, plus a legacy compatibility token. Tokens are
  stored only in the current user's protected runtime directory and user
  environment; they are not passed in argv or written to ordinary logs.
- `review_peer` for inline, read-only, zero-tool review.
- `review_repair_peer` with two explicit modes:
  - `inline`: zero tools and a complete `repairedArtifact` in the result.
  - `workspace`: a fixed copy, explicit `repairTargets`, manifest-gated sync,
    and bridge-executed structured tests.
- Inline review is available as soon as the daemon starts. Workspace repair is
  separately enabled only after the current process proves its Windows sandbox
  boundary; `peer_status` reports `inlineReviews`, `workspaceRepairs`, and
  `workspaceProbeState`.
- A CAS-protected review series with at most three accepted rounds.
- Exact allowlisted model routing with no fallback. Defaults are
  `claude-opus-5/max` and `gpt-5.6-sol/max`.

## Security Model

- The daemon binds only to `127.0.0.1`, rejects every request carrying an
  `Origin` header, authenticates every route, and limits request bodies to
  1 MiB.
- Protocol-v2 `review_peer` and inline `review_repair_peer` expose zero model
  tools. Workspace repair uses native file changes in the fixed copy; its tests
  are exact `.exe` invocations run by the bridge sandbox, not Claude Bash.
- A pending or failed workspace probe never enables workspace repair, tests, or
  synchronization. It does not disable the separate zero-tool inline path.
- Workspaces are checked for path traversal, links, `.git`, out-of-scope
  changes, and author-side baseline drift. Deletion, rename, mode changes, and
  directory replacement require a separate explicit synchronization approval.
- Public failure data is redacted. Raw events, prompts, artifact content, and
  results remain only in owner-protected local job details.

Legacy v1 isolated repair is retained only for compatibility. Its empty
`testCommands` list grants `Read`, `Edit`, and `Write` but no Bash; a non-empty
legacy list may grant only exact validated commands. New integrations must use
protocol v2 instead.

Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before deployment.

## Requirements

- Windows 10 or later.
- Node.js 24.x.
- A configured Claude Code and/or Codex host with access to the intended model.
- An MCP host that supports environment-backed HTTP headers.

The bridge does not edit CC Switch, Claude, Codex, or provider configuration.
Register it through the supported management surface of the chosen host.

## Build And Install

For contributors:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package:release
```

Do not run `test:live*` in ordinary CI or before an explicit provider-cost
decision. The release ZIP, SBOM, provenance record, and SHA-256 manifest are
written to `artifacts/`.

To install an extracted release for the current Windows user:

```powershell
.\scripts\Install-Bridge.ps1
.\scripts\Invoke-BridgeLauncher.ps1 doctor
.\scripts\Invoke-BridgeLauncher.ps1 install-daemon-task
```

The installer creates an immutable release directory under `%LOCALAPPDATA%`,
updates an owner-protected `current.json` pointer, and installs locked
dependencies. First activation generates the legacy and role-specific tokens.
After token rotation, installation, update, or rollback, restart both MCP
clients.

```powershell
.\scripts\Invoke-BridgeLauncher.ps1 auth rotate-token
.\scripts\Rollback-Bridge.ps1
```

Rollback and token rotation are refused while jobs are active, queued, or
awaiting synchronization.

## MCP Registration

Register only the entry matching the current client. The bundled
[`plugins/claude-codex-bridge/.mcp.json`](plugins/claude-codex-bridge/.mcp.json)
contains both templates.

Codex registration:

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

Claude registration:

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

Use only the header form supported by the MCP host, or send matching values for
both. Never place a literal token in Git, a command argument, or a shared
configuration file.

## Review Contract

Every v2 request supplies the final `artifactContent`, its newly calculated
UTF-8 byte count and SHA-256, an `artifactId`, artifact metadata, a non-empty
`acceptanceCriteria` array, and optional routing fields. A subsequent round
also supplies the previous `seriesVersion` and `latestJobId`; callers do not
choose the round number.

`review_peer` is always inline and zero-tool. `review_repair_peer` requires an
explicit `artifactMode`:

- `inline` forbids workspace and test fields and returns a complete
  `repairedArtifact`.
- `workspace` requires an absolute `targetRoot`, non-empty `repairTargets`,
  and (when tests are needed) structured entries of
  `{program, programBytes, programSha256, args, timeoutMs}`.

Before choosing `workspace`, read `peer_status`: it requires
`workspaceRepairs=true` and `workspaceProbeState=available`. Otherwise the
bridge rejects the request before creating a job with
`v2_workspace_capability_unavailable`. Use `review_peer` for a review-only
artifact; never silently substitute an inline repair for an explicit workspace
request.

The complete contract is bundled at
[workflow-contract.md](plugins/claude-codex-bridge/skills/cross-model-orchestration/references/workflow-contract.md).

## Operations

```text
bridge doctor
bridge start
bridge status
bridge auth rotate-token
bridge config show
bridge cleanup --include-jobs
```

The scheduler allows at most three active and twenty queued jobs. Work in the
same bridge thread is serialized; independent threads may run concurrently.
The daemon reports its version, build ID, and protocol version through health,
status, and job evidence.

## Development

Run deterministic tests while working on the bridge:

```powershell
npm.cmd run test:unit
npm.cmd run test:integration
node --test plugins/claude-codex-bridge/skills/cross-model-orchestration/test/public-skill.test.mjs
node --test plugins/claude-codex-bridge/skills/cross-model-orchestration/tests/orchestration-control.test.mjs
```

When a local daemon keeps `dist` open, build a separate verification tree:

```powershell
$env:BRIDGE_BUILD_OUTPUT = '.bridge-runtime\verify-local'
node .\scripts\build.mjs
node --test .bridge-runtime\verify-local\test\unit\*.test.js
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). This project
does not supply a provider account, cloud relay, hidden fallback, or automatic
live review during installation, package verification, or CI.
