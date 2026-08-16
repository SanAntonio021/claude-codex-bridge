# Contributor Automation Rules

Read this file before changing the repository.

- Change source under `src/`, tests under `test/`, and public plugin material
  under `plugins/`. Do not edit generated client configuration or local runtime
  directories from this repository.
- Preserve loopback-only HTTP, token authentication, request limits, isolated
  workspaces, strict model routing, and fail-closed synchronization.
- Keep prompts, tokens, user artifacts, raw model events, and local job data
  out of Git, command arguments, standard logs, and test fixtures.
- Run deterministic unit and integration tests for relevant changes. Live tests
  require a separate, explicit provider authorization.
- `src/v2/` is the approved 0.5 protocol migration; keep its role endpoints, CAS series fields,
  structured test commands, and zero-tool isolation behavior covered by deterministic tests.
- Release artifacts belong in ignored `artifacts/`; never commit `node_modules`,
  `dist`, `.bridge-runtime`, or local installation data.
