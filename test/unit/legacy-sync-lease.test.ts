import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { AuditLog } from "../../src/daemon/audit.js";
import { prepareRuntime } from "../../src/daemon/runtime.js";
import { JobScheduler, type HeadlessRunner } from "../../src/daemon/scheduler.js";
import { SessionStore } from "../../src/daemon/sessions.js";
import { JobStore } from "../../src/daemon/store.js";
import { createBridgeRequest } from "../../src/request.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

const inertRunner: HeadlessRunner = {
  async run() {
    throw new Error("This test does not dispatch a peer.");
  },
};

async function awaitingSyncFixture(expiresAt: string) {
  const paths = await temporaryPaths("bridge-v1-sync-lease-");
  await prepareRuntime(paths);
  const store = new JobStore(paths.jobs, new AuditLog(paths.audit));
  await store.load();
  const scheduler = new JobScheduler(store, new SessionStore(paths.sessions), inertRunner);
  const created = await store.create(createBridgeRequest(
    { question: "retained synchronization fixture" },
    { origin: "test", target: "claude" },
  ));
  await store.transition(created.record.job_id, "dispatching");
  await store.transition(created.record.job_id, "needs_attention", {
    sync_status: "awaiting_user",
    sync_approval_expires_at: expiresAt,
    error: {
      code: "high_risk_workspace_change",
      message: "fixture requires a user decision",
      retryable: false,
    },
  });
  return { paths, store, scheduler, jobId: created.record.job_id };
}

test("legacy awaiting synchronization lease expires without applying reviewer changes", async () => {
  const fixture = await awaitingSyncFixture(new Date(Date.now() - 1_000).toISOString());
  try {
    const expired = await fixture.scheduler.expireLegacySyncLeases();
    assert.deepEqual(expired, [fixture.jobId]);
    const result = fixture.store.require(fixture.jobId);
    assert.equal(result.state, "failed");
    assert.equal(result.sync_status, "discarded");
    assert.equal(result.error?.code, "sync_approval_lease_expired");
  } finally {
    await rm(fixture.paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("legacy pending synchronization can be explicitly discarded before its lease expires", async () => {
  const fixture = await awaitingSyncFixture(new Date(Date.now() + 60_000).toISOString());
  try {
    const discarded = await fixture.scheduler.discardSync(fixture.jobId);
    assert.equal(discarded.state, "failed");
    assert.equal(discarded.sync_status, "discarded");
    const result = fixture.store.require(fixture.jobId);
    assert.equal(result.error?.code, "peer_sync_discarded");
  } finally {
    await rm(fixture.paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
