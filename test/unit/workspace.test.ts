import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeError } from "../../src/errors.js";
import { createBridgeRequest } from "../../src/request.js";
import { WorkspaceManager } from "../../src/workspace.js";
import { sha256 } from "../../src/hash.js";

function artifactContract(name: string) {
  const content = `Review ${name}`;
  return {
    artifactName: name,
    artifactContent: content,
    artifactBytes: Buffer.byteLength(content),
    artifactSha256: sha256(content),
    acceptanceCriteria: ["focused verification passes"],
    testCommands: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-workspace-test-"));
  const target = join(root, "target");
  const runtime = join(root, "runtime");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "a.txt"), "before\n", "utf8");
  await writeFile(join(target, "README.md"), "read-only context\n", "utf8");
  const request = createBridgeRequest(
    {
      question: "repair fixture",
      operation: "review_repair",
      artifactId: "workspace-fixture",
      artifactType: "deliverable",
      ...artifactContract("src/a.txt"),
      targetRoot: target,
      allowedPaths: ["src"],
      round: 1,
      priorRounds: [],
    },
    { origin: "test", target: "codex" },
  );
  return { root, target, runtime, request };
}

test("workspace copies non-allowlisted context while allowing a new allowlisted file", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  await mkdir(join(value.target, ".git"), { recursive: true });
  await writeFile(join(value.target, ".git", "config"), "must stay out\n", "utf8");
  const request = createBridgeRequest(
    {
      question: "create the result after reading project context",
      operation: "review_repair",
      artifactId: "workspace-new-file",
      artifactType: "deliverable",
      ...artifactContract("result.txt"),
      targetRoot: value.target,
      allowedPaths: ["result.txt"],
      round: 1,
      priorRounds: [],
    },
    { origin: "test", target: "codex" },
  );
  try {
    const handle = await manager.prepare(request);
    assert.ok(handle !== undefined);
    assert.equal(await readFile(join(handle.root, "README.md"), "utf8"), "read-only context\n");
    assert.equal(await readFile(join(handle.root, "src", "a.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(handle.root, ".git", "config"), "utf8"), { code: "ENOENT" });
    await writeFile(join(handle.root, "result.txt"), "peer result\n", "utf8");
    const synced = await manager.sync(handle);
    assert.equal(synced.status, "synced");
    assert.deepEqual(synced.changedFiles, ["result.txt"]);
    assert.equal(await readFile(join(value.target, "result.txt"), "utf8"), "peer result\n");
    assert.equal(await readFile(join(value.target, "README.md"), "utf8"), "read-only context\n");
    await manager.release(handle);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace capacity rejects the projected copy before replacing retained material", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime, { maxBytes: 1 });
  try {
    await assert.rejects(
      () => manager.prepare(value.request),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_capacity_reached",
    );
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "before\n");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace syncs ordinary allowlisted additions and updates", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    assert.ok(Date.parse(handle.retainedUntil) - Date.now() > 6 * 24 * 60 * 60 * 1_000);
    await writeFile(join(handle.root, "src", "a.txt"), "after\n", "utf8");
    await writeFile(join(handle.root, "src", "b.txt"), "added\n", "utf8");
    const synced = await manager.sync(handle);
    assert.equal(synced.status, "synced");
    assert.deepEqual(synced.changedFiles, ["src\\a.txt", "src\\b.txt"]);
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(value.target, "src", "b.txt"), "utf8"), "added\n");
    await manager.release(handle);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace rolls back every target path when replacement fails mid-transaction", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime, {
    syncFault: (phase) => {
      if (phase === "after_replace") {
        throw new Error("injected replacement failure");
      }
    },
  });
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    await writeFile(join(handle.root, "src", "a.txt"), "peer update\n", "utf8");
    await writeFile(join(handle.root, "src", "b.txt"), "peer addition\n", "utf8");
    await assert.rejects(
      manager.sync(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_sync_failed",
    );
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(value.target, "src", "b.txt"), "utf8"), { code: "ENOENT" });
    await manager.release(handle);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace fails closed on main-project drift", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    await writeFile(join(value.target, "src", "a.txt"), "author changed\n", "utf8");
    await writeFile(join(handle.root, "src", "a.txt"), "peer changed\n", "utf8");
    await assert.rejects(
      manager.sync(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_baseline_drift",
    );
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "author changed\n");
    await manager.release(handle);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace reports deletions for user authorization and locks overlapping roots", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    await assert.rejects(
      manager.prepare({ ...value.request, artifact_id: "another-artifact" }),
      (error: unknown) => error instanceof BridgeError && error.code === "target_root_conflict",
    );
    await unlink(join(handle.root, "src", "a.txt"));
    const result = await manager.sync(handle);
    assert.equal(result.status, "awaiting_user");
    assert.equal(result.highRisk.length, 1);
    assert.equal(result.highRisk[0]?.action, "delete");
    assert.equal(result.highRisk[0]?.path, "src\\a.txt");
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "before\n");
    await manager.release(handle);
    await assert.rejects(
      manager.approveSync(
        value.request,
        handle.baselineTarget,
        result.resultManifestHash,
        ["0".repeat(64)],
        randomUUID(),
      ),
      (error: unknown) => error instanceof BridgeError && error.code === "sync_approval_mismatch",
    );
    const approved = await manager.approveSync(
      value.request,
      handle.baselineTarget,
      result.resultManifestHash,
      result.highRisk.map((change) => change.id),
      randomUUID(),
    );
    assert.equal(approved.status, "synced");
    await assert.rejects(readFile(join(value.target, "src", "a.txt"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace treats a content-identical move as a rename and fails approval on later drift", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    await rename(join(handle.root, "src", "a.txt"), join(handle.root, "src", "renamed.txt"));
    const result = await manager.sync(handle);
    assert.equal(result.status, "awaiting_user");
    assert.deepEqual(
      result.highRisk.map(({ action, from_path, path }) => ({ action, from_path, path })),
      [{ action: "rename", from_path: "src\\a.txt", path: "src\\renamed.txt" }],
    );
    await manager.release(handle);
    await writeFile(join(value.target, "README.md"), "author drift\n", "utf8");
    await assert.rejects(
      manager.approveSync(
        value.request,
        handle.baselineTarget,
        result.resultManifestHash,
        result.highRisk.map((change) => change.id),
        randomUUID(),
      ),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_baseline_drift",
    );
    assert.equal(await readFile(join(value.target, "src", "a.txt"), "utf8"), "before\n");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace rejects peer writes outside allowlist and author drift outside allowlist", async () => {
  const value = await fixture();
  const manager = new WorkspaceManager(value.runtime);
  try {
    const handle = await manager.prepare(value.request);
    assert.ok(handle !== undefined);
    assert.equal(await readFile(join(handle.root, "README.md"), "utf8"), "read-only context\n");
    await writeFile(join(handle.root, "README.md"), "peer changed context\n", "utf8");
    await assert.rejects(
      manager.sync(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "reviewer_scope_violation",
    );
    await writeFile(join(handle.root, "README.md"), "read-only context\n", "utf8");
    await writeFile(join(handle.root, "outside.txt"), "not allowed\n", "utf8");
    await assert.rejects(
      manager.sync(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "reviewer_scope_violation",
    );
    await rm(join(handle.root, "outside.txt"), { force: true });
    await writeFile(join(value.target, "README.md"), "author changed outside allowlist\n", "utf8");
    await assert.rejects(
      manager.sync(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_baseline_drift",
    );
    await manager.release(handle);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
