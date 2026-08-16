import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { AuditLog, summarizePermissionDenials } from "../../src/daemon/audit.js";
import { JobStore } from "../../src/daemon/store.js";
import { SessionStore } from "../../src/daemon/sessions.js";
import { BridgeError } from "../../src/errors.js";
import { temporaryPaths, testRequest } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

test("job store persists atomically, redacts audit, and recovers uncertain work", async () => {
  const paths = await temporaryPaths();
  try {
    const audit = new AuditLog(paths.audit);
    const store = new JobStore(paths.jobs, audit);
    const request = testRequest({
      question: "PROMPT_SECRET",
      context: "CONTEXT_SECRET",
      idempotency_key: "same-key",
    });
    const created = await store.create(request);
    await store.transition(created.record.job_id, "dispatching");
    await store.transition(created.record.job_id, "transport_delivered");
    await store.transition(created.record.job_id, "running", {
      adapter_details: {
        exit_code: null,
        stderr: "RAW_STDERR_SECRET",
        complete_stdout_lines: ["RAW_RESULT_SECRET"],
        permission_denials: [
          { tool_name: "Write", tool_use_id: "tool-1", tool_input: "RAW_TOOL_INPUT_SECRET" },
        ],
      },
    });

    await store.patch(created.record.job_id, {
      child_pid: 4242,
      claude_session_id: "22222222-2222-4222-8222-222222222222",
    });
    const patchAudit = (await readFile(paths.audit, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event["event"] === "job_patched");
    assert.equal(patchAudit.length, 1);
    const patchMetadata = patchAudit[0]?.["metadata"] as Record<string, unknown>;
    assert.equal(patchMetadata["child_pid"], 4242);
    assert.match(String(patchMetadata["claude_session_id_hash"]), /^[0-9a-f]{64}$/u);
    assert.equal(patchMetadata["claude_session_id"], undefined);
    await store.patch(created.record.job_id, { child_pid: 4242 });
    const unchangedPatchCount = (await readFile(paths.audit, "utf8"))
      .split("\n")
      .filter((line) => line.includes("job_patched")).length;
    assert.equal(unchangedPatchCount, 1);

    const reloaded = new JobStore(paths.jobs, audit);
    await reloaded.load();
    const recovered = await reloaded.recoverUncertain();
    assert.equal(recovered[0]?.state, "needs_attention");

    const auditText = await readFile(paths.audit, "utf8");
    assert.doesNotMatch(auditText, /PROMPT_SECRET|CONTEXT_SECRET|RAW_TOOL_INPUT_SECRET|RAW_RESULT_SECRET/u);
    assert.match(auditText, /tool_input_sha256/u);
    const detailText = await readFile(`${paths.jobs}\\${created.record.job_id}.json`, "utf8");
    assert.match(detailText, /PROMPT_SECRET/u);
    assert.match(detailText, /RAW_TOOL_INPUT_SECRET/u);

    const same = await reloaded.create(request);
    assert.equal(same.created, false);
    assert.equal(same.record.job_id, created.record.job_id);
    await assert.rejects(
      () => reloaded.create({ ...request, question: "different" }),
      (error: unknown) => error instanceof BridgeError && error.code === "idempotency_conflict",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
test("permission denial summary contains only metadata, SHA256, and length", () => {
  const summaries = summarizePermissionDenials(
    [{ tool_name: "Bash", tool_use_id: "id-1", tool_input: { command: "SECRET_COMMAND" } }],
    "2026-08-09T00:00:00.000Z",
  );
  assert.equal(summaries?.[0]?.tool_name, "Bash");
  assert.equal(typeof summaries?.[0]?.tool_input_sha256, "string");
  assert.ok((summaries?.[0]?.tool_input_length ?? 0) > 0);
  assert.doesNotMatch(JSON.stringify(summaries), /SECRET_COMMAND/u);
});

test("audit metadata retention prunes only entries older than the configured window", async () => {
  const paths = await temporaryPaths();
  try {
    const audit = new AuditLog(paths.audit);
    await audit.append({ at: "2000-01-01T00:00:00.000Z", event: "old" });
    await audit.append({ at: new Date().toISOString(), event: "current" });
    await audit.prune(60_000);
    const text = await readFile(paths.audit, "utf8");
    assert.doesNotMatch(text, /"old"/u);
    assert.match(text, /"current"/u);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("session store enforces one-to-one thread ownership", async () => {
  const paths = await temporaryPaths();
  try {
    const sessions = new SessionStore(paths.sessions);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    await sessions.assign("thread-a", sessionId);
    await assert.rejects(
      () => sessions.assignPeer("thread-a", sessionId, "codex"),
      (error: unknown) => error instanceof BridgeError && error.code === "session_target_mismatch",
    );
    await assert.rejects(
      () => sessions.assign("thread-b", sessionId),
      (error: unknown) => error instanceof BridgeError && error.code === "session_mapping_conflict",
    );
    const loaded = new SessionStore(paths.sessions);
    await loaded.load();
    assert.equal(loaded.get("thread-a")?.owner, "daemon");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("session store serializes concurrent persistence without losing records", async () => {
  const paths = await temporaryPaths();
  try {
    const sessions = new SessionStore(paths.sessions);
    const entries = Array.from({ length: 24 }, (_, index) => ({
      threadId: `parallel-thread-${index}`,
      sessionId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    }));

    await Promise.all(entries.map(({ threadId, sessionId }) => sessions.assign(threadId, sessionId)));
    await Promise.all(
      entries.map(({ threadId }, index) =>
        sessions.setStatus(threadId, index % 2 === 0 ? "needs_attention" : "idle"),
      ),
    );

    const loaded = new SessionStore(paths.sessions);
    await loaded.load();
    assert.equal(loaded.list().length, entries.length);
    for (const [index, entry] of entries.entries()) {
      assert.equal(loaded.get(entry.threadId)?.claude_session_id, entry.sessionId);
      assert.equal(
        loaded.get(entry.threadId)?.status,
        index % 2 === 0 ? "needs_attention" : "idle",
      );
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
