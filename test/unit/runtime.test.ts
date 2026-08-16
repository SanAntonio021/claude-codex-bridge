import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensurePersistentToken,
  readToken,
  rotatePersistentToken,
} from "../../src/daemon/runtime.js";
import { daemonActivationTimeoutMs } from "../../src/daemon/ensure.js";
import {
  installDaemonScheduledTask,
  scheduledTaskPowerShellArgs,
} from "../../src/daemon/scheduled-task.js";
import { BridgeError } from "../../src/errors.js";

process.env.BRIDGE_SKIP_ACL = "1";

test("daemon activation allows protected production startup beyond the legacy timeout", () => {
  assert.equal(daemonActivationTimeoutMs({}), 60_000);
  assert.equal(daemonActivationTimeoutMs({ BRIDGE_SKIP_ACL: "1" }), 3_000);
});

test("bridge token persists across starts and changes only on explicit rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-token-test-"));
  const path = join(root, "token");
  const mirrored: string[] = [];
  const mirror = async (token: string): Promise<void> => {
    mirrored.push(token);
  };
  try {
    const first = await ensurePersistentToken(path, mirror);
    const second = await ensurePersistentToken(path, mirror);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.token, first.token);
    assert.equal(await readToken(path), first.token);
    const rotated = await rotatePersistentToken(path, mirror);
    assert.notEqual(rotated, first.token);
    assert.equal(await readToken(path), rotated);
    assert.deepEqual(mirrored, [first.token, first.token, rotated]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled task arguments contain lifecycle paths but no bridge token", () => {
  const args = scheduledTaskPowerShellArgs(
    "C:\\bridge\\Register.ps1",
    "C:\\node\\node.exe",
    "C:\\bridge\\daemon.js",
    "C:\\bridge",
  );
  assert.equal(args.includes("-NonInteractive"), true);
  assert.equal(args.includes("C:\\bridge\\daemon.js"), true);
  assert.doesNotMatch(args.join(" "), /CLAUDE_CODEX_BRIDGE_TOKEN|X-Bridge-Token/u);
});

test(
  "scheduled task launch failures return a stable bridge error",
  { skip: process.platform !== "win32" },
  async () => {
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\definitely-missing-bridge-system-root";
    try {
      await assert.rejects(
        installDaemonScheduledTask(
          "C:\\bridge\\Register.ps1",
          "C:\\node\\node.exe",
          "C:\\bridge\\daemon.js",
          "C:\\bridge",
        ),
        (error: unknown) =>
          error instanceof BridgeError && error.code === "scheduled_task_install_failed",
      );
    } finally {
      if (previousSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = previousSystemRoot;
      }
    }
  },
);
