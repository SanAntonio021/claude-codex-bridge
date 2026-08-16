# Contributing

## Development Rules

- Keep the bridge local, loopback-only, authenticated, and fail-closed.
- Preserve the symmetric Claude/Codex job model and compatibility aliases
  through the advertised compatibility cycle.
- Do not add tokens, provider credentials, private artifacts, or runtime state
  to source, fixtures, snapshots, logs, or command arguments.
- Do not widen Bash or file permissions to make a test pass.
- Treat `src/v2/` as the supported protocol-v2 surface. Keep role endpoints,
  CAS series fields, zero-tool review modes, structured test commands, and
  workspace synchronization gates covered by deterministic tests.

## Verification

```powershell
npm.cmd ci
npm.cmd run test:unit
npm.cmd run test:integration
```

Run `npm.cmd test` before a pull request. Do not run `test:live*` in CI. Add a
deterministic regression test for every security, lifecycle, routing, or
synchronization defect.

## Pull Requests

Describe the boundary affected, the expected failure mode, the tests run, and
whether the change changes the public MCP schema, persistent state, release
layout, or skill contract. Keep unrelated generated output and local runtime
files out of the change.
