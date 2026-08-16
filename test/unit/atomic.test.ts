import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteFile, renameWithTransientRetry } from "../../src/daemon/atomic.js";

test("atomic rename retries transient Windows replacement errors without deleting the target", async () => {
  const waits: number[] = [];
  let calls = 0;
  await renameWithTransientRetry("source.tmp", "target.json", {
    renameFile: async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
      }
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
});

test("atomic rename does not retry non-transient failures", async () => {
  let calls = 0;
  await assert.rejects(
    () => renameWithTransientRetry("source.tmp", "target.json", {
      renameFile: async () => {
        calls += 1;
        throw Object.assign(new Error("source missing"), { code: "ENOENT" });
      },
      wait: async () => {
        throw new Error("wait should not run");
      },
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(calls, 1);
});

test("atomic write replaces an existing temporary runtime file", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-atomic-"));
  const target = join(root, "runtime.json");
  const previousSkipAcl = process.env.BRIDGE_SKIP_ACL;
  delete process.env.BRIDGE_SKIP_ACL;
  try {
    await writeFile(target, "old", "utf8");
    await atomicWriteFile(target, "new", { protect: process.platform === "win32" });
    assert.equal(await readFile(target, "utf8"), "new");
  } finally {
    if (previousSkipAcl === undefined) {
      delete process.env.BRIDGE_SKIP_ACL;
    } else {
      process.env.BRIDGE_SKIP_ACL = previousSkipAcl;
    }
    await rm(root, { recursive: true, force: true });
  }
});
