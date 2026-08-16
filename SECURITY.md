# Security Policy

## Supported Release

Only the latest `0.5.x` build is supported. The release must preserve the
loopback-only, authenticated, fail-closed security model.

## Reporting A Vulnerability

Use a private GitHub security advisory for this repository. Do not open a
public issue with a token, local path, prompt, artifact, raw tool event, job
record, or provider credential. Include a minimal reproduction, the bridge
version and build ID, and an explanation of the affected boundary.

## Security Boundaries

- The daemon accepts loopback traffic only and rejects browser-origin requests.
- Every HTTP route requires its per-user token; protocol-v2 role endpoints use
  distinct Codex and Claude token values.
- The token must never be passed as a command argument or committed to source.
- Review workspaces are copies. Direct writes to the author workspace are not a
  supported review path.
- Protocol-v2 inline review is zero-tool. Workspace repair tests are exact
  bridge-sandboxed executables, not reviewer-provided shell commands.
- A failed model receipt, isolation check, test command, manifest check, or
  synchronization check is a failed job, not a reason to fall back.

Do not run tests in `test/live/` without explicit authorization for the
provider, account, model, and expected cost.
