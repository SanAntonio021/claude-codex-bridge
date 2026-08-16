# Changelog

## 0.5.0 - 2026-08-16

- Promoted protocol v2 to the supported runtime surface with independently
  authenticated `/mcp/codex` and `/mcp/claude` role endpoints.
- Added endpoint-derived reviewer identity, CAS-based three-round series state,
  inline and workspace repair modes, structured sandbox test commands, and
  protected evidence gates.
- Updated the bundled cross-model skill, public plugin metadata, release
  documentation, and deterministic CI coverage for protocol v2.
- Retained the v1 `/mcp` and `submit_peer` paths as compatibility-only
  interfaces.

## 0.4.0-preview.1 - 2026-08-16

- Replaced per-client stdio process growth with one authenticated Streamable HTTP daemon on
  `127.0.0.1:43123` while retaining the stdio entry for one compatibility cycle.
- Added persistent user-scoped token storage, explicit rotation, child-environment stripping, and a
  limited-privilege login task.
- Added deterministic build identity and mismatch-aware daemon replacement.
- Extended protected daemon activation to 60 seconds to avoid false cold-start timeouts.
- Added `review_repair_peer` and complete legacy-envelope validation before job creation.
- Removed Claude Bash access when `testCommands=[]`; non-empty commands remain exact allowlist only.
- Added redacted public isolation-violation evidence and protected raw-event retention.
