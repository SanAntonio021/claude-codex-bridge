import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AuditLog } from "../../src/daemon/audit.js";
import { cleanupRuntime } from "../../src/daemon/cleanup.js";
import { sha256 } from "../../src/hash.js";
import { prepareRuntime } from "../../src/daemon/runtime.js";
import { JobStore } from "../../src/daemon/store.js";
import { createBridgeRequest } from "../../src/request.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

test("cleanup is dry-run by default and writes only a minimal tombstone on explicit execution", async () => {
  const paths = await temporaryPaths("bridge-cleanup-");
  await prepareRuntime(paths);
  const audit = new AuditLog(paths.audit);
  const initial = new JobStore(paths.jobs, audit);
  const created = await initial.create(
    createBridgeRequest({ question: "expired record" }, { origin: "cleanup-test", target: "claude" }),
  );
  await initial.transition(created.record.job_id, "dispatching");
  await initial.transition(created.record.job_id, "transport_delivered");
  await initial.transition(created.record.job_id, "running");
  await initial.transition(created.record.job_id, "succeeded", { result: "retained private result" });
  const jobPath = join(paths.jobs, `${created.record.job_id}.json`);
  const persisted = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
  persisted.updated_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");

  const store = new JobStore(paths.jobs, audit);
  await store.load();
  try {
    const dryRun = await cleanupRuntime(paths, store, audit, { includeJobs: true });
    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.job_candidates.length, 1);
    assert.equal(await readFile(jobPath, "utf8").then(() => true), true);

    const executed = await cleanupRuntime(paths, store, audit, { includeJobs: true, execute: true });
    assert.equal(executed.dry_run, false);
    assert.equal(executed.deleted_jobs, 1);
    await assert.rejects(readFile(jobPath, "utf8"));
    const tombstone = await readFile(join(paths.tombstones, `${created.record.job_id}.json`), "utf8");
    assert.match(tombstone, /"schema_version": 1/u);
    assert.match(tombstone, new RegExp(created.record.job_id, "u"));
    assert.doesNotMatch(tombstone, /retained private result/u);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("cleanup keeps awaiting-user and locked review workspaces", async () => {
  const paths = await temporaryPaths("bridge-cleanup-retained-");
  await prepareRuntime(paths);
  const audit = new AuditLog(paths.audit);
  const initial = new JobStore(paths.jobs, audit);
  try {
    const awaiting = await initial.create(
      createBridgeRequest({ question: "awaiting user" }, { origin: "cleanup-test", target: "claude" }),
    );
    await initial.transition(awaiting.record.job_id, "dispatching");
    await initial.transition(awaiting.record.job_id, "transport_delivered");
    await initial.transition(awaiting.record.job_id, "running");
    await initial.transition(awaiting.record.job_id, "needs_attention", {
      sync_status: "awaiting_user",
    });

    const artifactContent = "locked review fixture";
    const locked = await initial.create(
      createBridgeRequest(
        {
          question: "locked workspace",
          operation: "review_repair",
          artifactId: "locked-cleanup-fixture",
          artifactType: "deliverable",
          artifactName: "review.md",
          artifactContent,
          artifactBytes: Buffer.byteLength(artifactContent),
          artifactSha256: sha256(artifactContent),
          targetRoot: paths.root,
          allowedPaths: ["review.md"],
          round: 1,
          acceptanceCriteria: ["review workspace remains retained"],
          testCommands: [],
        },
        { origin: "cleanup-test", target: "claude" },
      ),
    );
    await initial.transition(locked.record.job_id, "dispatching");
    await initial.transition(locked.record.job_id, "transport_delivered");
    await initial.transition(locked.record.job_id, "running");
    await initial.transition(locked.record.job_id, "succeeded", { result: "retained" });

    for (const jobId of [awaiting.record.job_id, locked.record.job_id]) {
      const jobPath = join(paths.jobs, `${jobId}.json`);
      const persisted = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
      persisted.updated_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");
    }
    const workspaceKey = sha256(
      `${locked.record.request.artifact_id}\0${resolve(locked.record.request.target_root ?? "")}`,
    ).slice(0, 32);
    await mkdir(paths.artifactLocks, { recursive: true });
    await writeFile(join(paths.artifactLocks, `${workspaceKey}.lock`), "locked\n", "utf8");

    const store = new JobStore(paths.jobs, audit);
    await store.load();
    const result = await cleanupRuntime(paths, store, audit, { includeJobs: true });
    assert.deepEqual(result.job_candidates, []);
    assert.deepEqual(
      result.skipped.sort((left, right) => left.job_id.localeCompare(right.job_id)),
      [
        { job_id: awaiting.record.job_id, reason: "non_terminal_or_awaiting_user" },
        { job_id: locked.record.job_id, reason: "workspace_locked" },
      ].sort((left, right) => left.job_id.localeCompare(right.job_id)),
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
