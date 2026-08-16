# Integration Results - 2026-07-11

> Historical evidence only. This record predates the global bidirectional peer-review workflow
> introduced on 2026-08-14. Its references to a plan-review task carrying `--write` describe an
> obsolete workaround and must not be used as current procedure; current requirements are in
> `SKILL.md`, `references/workflow-contract.md`, and `evals/integration-cases.md`.

## Environment

- Claude Code: 2.1.207
- Plugin: `codex@openai-codex` 1.0.6, enabled
- Codex CLI: 0.144.1, authenticated
- Official stop-time review gate: disabled
- Persistent Claude permissions: exact current Plugin companion `task` prefix, exact Skill helper path, and exact read access to the Skill directories

## Passed

- `evals.json` and `trigger-evals.json` parse as JSON.
- Helper script passes `node --check`.
- Helper resolves the installed companion path and fails closed when no Claude session ID is available.
- Simple explanation skips the orchestration Skill and Codex.
- A substantive Skill audit automatically loads `cross-model-orchestration`.
- When child Bash permission is denied, Claude emits a failure report and does not take over.
- Skill-level `allowed-tools` alone does not propagate to `codex:codex-rescue`; user-level permission is required.
- With the exact current Plugin companion permission, one direct `node` command, and a 600000 ms Bash timeout, `codex:codex-rescue` returns a valid `PLAN_REVIEW` without permission denial.
- The sample audit canary produced a read-only `PLAN_REVIEW` and did not modify fixture files.
- A direct agent canary returned `PLAN_REVIEW / 通过` with no permission denials.
- The versioned exact companion `task` permission passed a direct agent canary; broad `Bash(node:*)` is not required.
- No Plugin jobs were left running after the tests.

## Post-Sync Findings

- CC Switch installed the Skill and enabled both Claude and Codex; source, CC Switch, Claude, and Codex runtime hashes match.
- A clean new Claude session automatically loaded the global Skill and read `workflow-contract.md` without falling back to a project copy.
- The first clean post-sync canary stopped before Codex because Claude expanded the helper to a Windows backslash path while the exact permission only matched the forward-slash form. Fixture hashes stayed unchanged. The Skill now requires a resolved forward-slash helper path and forbids PowerShell/settings fallbacks; both exact Windows path forms are covered by user permissions before retest.
- A second clean canary reached `codex:codex-rescue` but the legacy exact companion rule ending in `task:*` did not match a command with a multiline task argument. Claude emitted `CODEX_FAILURE_REPORT`, paused, and did not take over.
- The exact wildcard form `Bash(node "<companionPath>" task *)` passed a direct-agent canary. Codex thread `019f50c9-f49e-7002-91c8-2792b256e31b` returned `PERMISSION_CANARY_OK` without file access.
- A clean full-workflow retest used the synced Skill and passed helper resolution, but the long PLAN_REVIEW task contained literal newlines; Claude Code denied the otherwise exact `task *` rule. Claude paused with a failure report and did not take over. The workflow now serializes plan review, execution, and revision prompts as one-line XML/semicolon arguments with no literal CR/LF.
- The final clean read-only canary completed Claude planning, Codex plan review, a same-thread revised plan review, Codex execution, and independent Claude verification. All Codex turns used thread `019f50dd-6033-7e82-a30c-9dec77a0a390`; resume candidate checks matched before every continuation; fixture hashes stayed unchanged.
- The first one-line XML task exposed Git Bash path conversion for XML closing tags and `C:/` text inside the task argument. The Windows transport now uses one-line `field=value;` text and relative or backslash paths inside task arguments.
- The first write canary proved that Plugin 1.0.6 cannot reliably upgrade a live broker thread from `read-only` to `workspace-write` on resume. Two same-thread turns included `--write`, but Codex turn context remained `read-only` and rejected `apply_patch`; both fixture hashes and the directory membership stayed unchanged. The workflow now creates the initial plan-review thread with `--fresh --wait --write`, keeps review behavior read-only by instruction, and requires a content-level manifest (relative path, byte count, and SHA256 for every ordinary file in scope) before and after review; Git status is additional evidence, not the content check.
- The post-fix write canary confirmed that the initial plan-review turn was created with `workspace-write` while remaining behaviorally read-only. `PLAN_REVIEW` returned `通过`; `acceptance.md` and `artifact.txt` retained their original hashes.
- The first execution turn then failed before writing with `windows sandbox failed: helper_unknown_error: setup refresh had errors`. Claude did not edit either controlled file. `artifact.txt` remained `STATUS=ORIGINAL\n` (16 bytes, SHA256 `8E7618F8191E0F370F9E9D0CA6784353CB486C2AB1546CD5CAC4CECFE38295ED`) and `acceptance.md` remained SHA256 `8672BABB1A329F3EBCF167C85679DBCDCB50FEA2453C24A1F86557C7DCEDD408`.
- That canary also exposed a Claude-side concurrency defect: the same execution phase launched two background Agent calls before the first completed, and the second call received `Task ... is still running`. The job belonged to the same canary and later completed; it was not an unrelated external task. The workflow now requires one foreground Agent call per phase and forbids re-running the helper, candidate check, or Agent while that call is pending.
- Failure handling remained fail-closed: no retry after the sandbox result, no new Codex thread, and no Claude takeover. The full write/revision loop was not reached.
- The sandbox failure was traced to the default `:slash_tmp` write root in `workspace-write`. On Windows it resolved to `C:\tmp` or `D:\tmp`; both directories were owned by `BUILTIN\Administrators`, so the non-elevated refresh could not add the sandbox ACL and returned `SetNamedSecurityInfoW failed: 5`. The Windows Sandbox optional VM feature was unrelated.
- Global Codex config now sets `[sandbox_workspace_write] exclude_slash_tmp = true`. The per-user temporary directory remains available. A direct `workspace-write` probe without command-line overrides wrote successfully, and the sandbox log showed only `errors=[]` refreshes with no `C:\tmp` grant attempt.
- The complete Claude-Codex write canary then passed in a clean Claude Code session. Plan review, DRAFT execution, Claude rejection, and FINAL rework all used Codex thread `019f545a-294b-7b63-871f-de01fb8a3ff8`, with exactly one foreground Agent call per phase. Final `artifact.txt` was 13 bytes, SHA256 `EE2E48FA71FCD8FC6B7366FDA323C01D8DA7A604ED9D964708019EA7BBFDE7DE`; `acceptance.md` stayed at SHA256 `8672BABB1A329F3EBCF167C85679DBCDCB50FEA2453C24A1F86557C7DCEDD408`.

## Quality and Contract Evals

- The Skill description was evaluated with 20 realistic trigger/non-trigger queries, three runs each, using an isolated `CLAUDE_CONFIG_DIR` and no Codex Plugin. The previous description passed 18/20 query labels: substantive-task invocation was 21/30 (70%) and exemption false positives were 0/30.
- A shorter description that leads with the routing rule passed all 20/20 query labels across 60 runs: substantive-task invocation was 30/30 (100%) and exemption false positives were 0/30. No evaluation `claude.exe` processes remained after completion.
- The no-Skill baseline has 0/30 substantive-task invocations and 0/30 exemption false positives. This is only a routing reference because an absent candidate cannot be invoked; it does not compare task-output quality.
- `skill-creator` benchmark data and a static review viewer were generated under the implementation workspace. The viewer includes final routing results, the no-Skill reference, the previous description, and failure/disagreement contract outputs.
- An isolated `CODEX_HOME` produced the real precondition result `codex login status` exit code 1 with `Not logged in`. Claude then emitted a complete `CODEX_FAILURE_REPORT`, paused, did not retry, and did not take over.
- Timeout and thread-mismatch contract cases emitted complete failure reports with the provided job/thread IDs and paused without retry or takeover. The timeout case used an injected error report, not a live 600-second wait.
- The substantive-disagreement contract case initially added a recommendation after the required report. The contract now forbids recommending, selecting, or inventing compromise options; the rerun produced only the two existing choices and their effects, then paused for user judgment.
- In both a Git repository and a non-Git directory, the helper resolved the same Plugin 1.0.6 companion path. With no live Claude session ID it exited nonzero and refused a workspace-wide resume candidate.
- CC Switch was stopped before the persistent permission repair, the database was backed up, and only the current Claude provider's `permissions.allow` was updated. After restart, all 8/8 Claude providers and the rendered `settings.json` contain exactly one `Skill(cross-model-orchestration)` entry; `PRAGMA integrity_check` is `ok`, and `codex@openai-codex` remains enabled.

## Remaining Rollout Gates

- Git-repository full write workflow comparison; the non-Git full write/revision canary passed.
- A live 600-second timeout injection; the report contract passed.
- A live Plugin task with isolated unauthenticated Codex state; the real login precondition and report contract passed separately.

The core disposable write/revision rollout gate is cleared. The remaining items are resilience coverage and do not block supervised use on ordinary tasks.
