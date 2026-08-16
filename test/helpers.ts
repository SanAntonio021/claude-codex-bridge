import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDaemonPaths, type DaemonPaths } from "../src/config.js";
import { createBridgeRequest } from "../src/request.js";
import type { BridgeRequest } from "../src/types.js";

export async function temporaryPaths(prefix = "claude-codex-bridge-test-"): Promise<DaemonPaths> {
  return getDaemonPaths(await mkdtemp(join(tmpdir(), prefix)));
}
export function testRequest(
  overrides: Record<string, unknown> = {},
  origin = "test",
): BridgeRequest {
  return createBridgeRequest(
    {
      question: "test question",
      bridge_thread_id: `thread-${randomUUID()}`,
      ...overrides,
    },
    { origin, target: "claude" },
  );
}
