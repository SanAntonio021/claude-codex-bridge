# Privacy

The bridge is designed for local execution. It has no telemetry endpoint and
does not upload data to a bridge-operated service.

When a user submits a peer job, the selected local Claude Code or Codex client
may send the supplied prompt and isolated workspace material to its configured
model provider. That provider relationship is controlled by the user's own
client and account settings, not by this repository.

The local runtime stores legacy and role-specific tokens, protected job details,
retained workspaces, and metadata needed for recovery and synchronization.
Ordinary audit records are metadata-only and intentionally exclude prompts,
artifact content, tokens, raw tool input, and model results. Retention defaults
are documented in the README and may be cleaned through the explicit CLI
workflow.

Never commit local runtime directories, tokens, job records, extracted provider
logs, or copied user artifacts to this repository.
