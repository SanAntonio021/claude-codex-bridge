import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeMcpServer, preservedResumeRoute } from "../../src/mcp/main.js";
import { BridgeError } from "../../src/errors.js";
import { temporaryPaths } from "../helpers.js";
import { BridgeDaemon } from "../../src/daemon/server.js";

test("resume preserves the recorded model route and rejects overrides", () => {
  const previous = {
    target: "codex" as const,
    requested_model: "gpt-5.6-terra",
    requested_reasoning_effort: "max",
    task_profile: "balanced",
    routing_source: "profile",
    routing_rule_id: "codex-balanced-2026-08-15",
  };
  const input = {
    job_id: "11111111-1111-4111-8111-111111111111",
    question: "resume",
  };
  assert.deepEqual(preservedResumeRoute(previous, input), {
    target: "codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    taskProfile: "balanced",
    selectionSource: "profile",
    ruleId: "codex-balanced-2026-08-15",
  });
  assert.throws(
    () => preservedResumeRoute(previous, { ...input, model: "gpt-5.6-sol" }),
    (error: unknown) => error instanceof BridgeError && error.code === "resume_model_mismatch",
  );
});

test("MCP server exposes symmetric peer tools plus stable Claude aliases", async () => {
  const previous = process.env.BRIDGE_CHILD;
  delete process.env.BRIDGE_CHILD;
  const server = createBridgeMcpServer();
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "approve_peer_sync",
        "ask_claude",
        "await_claude",
        "await_peer",
        "bridge_status",
        "cancel_bridge_job",
        "cancel_peer",
        "claude_result",
        "discard_peer_sync",
        "list_peer_sessions",
        "peer_result",
        "peer_status",
        "resume_peer",
        "review_repair_peer",
        "submit_claude",
        "submit_peer",
      ],
    );
    const submitPeer = listed.tools.find((tool) => tool.name === "submit_peer");
    const properties = (submitPeer?.inputSchema as { properties?: Record<string, unknown> })
      .properties ?? {};
    assert.equal("taskProfile" in properties, true);
    assert.equal("model" in properties, true);
    assert.equal("reasoningEffort" in properties, true);
    const reviewRepair = listed.tools.find((tool) => tool.name === "review_repair_peer");
    const reviewSchema = reviewRepair?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    assert.equal("operation" in (reviewSchema.properties ?? {}), false);
    assert.equal("reviewerAccess" in (reviewSchema.properties ?? {}), false);
    assert.equal("maxRounds" in (reviewSchema.properties ?? {}), false);
    assert.equal(reviewSchema.additionalProperties, false);
    for (const field of [
      "target", "question", "artifactId", "artifactType", "artifactName",
      "artifactContent", "artifactBytes", "artifactSha256", "targetRoot",
      "allowedPaths", "round", "acceptanceCriteria", "testCommands",
    ]) {
      assert.equal(reviewSchema.required?.includes(field), true, field);
    }
    const live = await client.callTool({
      name: "submit_claude",
      arguments: { question: "x", route: "live" },
    });
    assert.equal(live.isError, true);
    assert.equal(
      (live.structuredContent as { structured_error?: { code?: string } } | undefined)
        ?.structured_error?.code,
      "live_unavailable",
    );
    const peerLive = await client.callTool({
      name: "submit_peer",
      arguments: { target: "codex", operation: "ask", question: "x", route: "live" },
    });
    assert.equal(peerLive.isError, true);
    assert.equal(
      (peerLive.structuredContent as { structured_error?: { code?: string } } | undefined)
        ?.structured_error?.code,
      "live_unavailable",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BRIDGE_CHILD;
    } else {
      process.env.BRIDGE_CHILD = previous;
    }
    await client.close();
    await server.close();
  }
});

test("legacy submit_peer reports exact missing review fields without creating a job", async () => {
  const paths = await temporaryPaths("bridge-mcp-missing-fields-");
  const previous = process.env.BRIDGE_CHILD;
  delete process.env.BRIDGE_CHILD;
  const server = createBridgeMcpServer(paths);
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "submit_peer",
      arguments: {
        target: "claude",
        operation: "review_repair",
        question: "review the supplied plan",
        artifactId: "missing-content",
        artifactType: "plan",
        artifactName: "plan.md",
        artifactBytes: 12,
        artifactSha256: "0".repeat(64),
        targetRoot: paths.root,
        allowedPaths: ["plan.md"],
        round: 1,
        acceptanceCriteria: ["review completes"],
      },
    });
    assert.equal(result.isError, true);
    const structured = result.structuredContent as {
      structured_error?: { code?: string; details?: { missing_fields?: string[] } };
    } | undefined;
    assert.equal(structured?.structured_error?.code, "missing_fields");
    assert.deepEqual(
      structured?.structured_error?.details?.missing_fields,
      ["artifactContent", "testCommands"],
    );
    const strictResult = await client.callTool({
      name: "review_repair_peer",
      arguments: {
        target: "claude",
        question: "review the supplied plan",
        artifactId: "fixed-field-override",
        artifactType: "plan",
        artifactName: "plan.md",
        artifactContent: "review fixture",
        artifactBytes: 14,
        artifactSha256: "dd7a0625d387f7e11b5ddddc4840180320ee4eee449a715fc8681c8268f9bfc6",
        targetRoot: paths.root,
        allowedPaths: ["plan.md"],
        round: 1,
        acceptanceCriteria: ["review completes"],
        testCommands: [],
        reviewerAccess: "read_only",
      },
    });
    assert.equal(strictResult.isError, true);
    const jobs = await readdir(paths.jobs).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    assert.deepEqual(jobs, []);
  } finally {
    if (previous === undefined) {
      delete process.env.BRIDGE_CHILD;
    } else {
      process.env.BRIDGE_CHILD = previous;
    }
    await client.close();
    await server.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("MCP hop guard rejects bridge children before daemon startup", async () => {
  const previous = process.env.BRIDGE_CHILD;
  process.env.BRIDGE_CHILD = "1";
  const server = createBridgeMcpServer();
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "bridge_status",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { structured_error?: { code?: string } } | undefined)
        ?.structured_error?.code,
      "recursive_bridge_call",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BRIDGE_CHILD;
    } else {
      process.env.BRIDGE_CHILD = previous;
    }
    await client.close();
    await server.close();
  }
});

async function initializeStdio(child: ChildProcessWithoutNullStreams): Promise<void> {
  let stdout = "";
  const response = new Promise<void>((resolveResponse, rejectResponse) => {
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("\n")) {
        child.stdout.off("data", onData);
        resolveResponse();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", rejectResponse);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-lifecycle-test", version: "1.0.0" },
    },
  })}\n`);
  await response;
  assert.match(stdout, /"result"/u);
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "close").then(() => undefined),
    new Promise<never>((_resolve, rejectTimeout) => {
      const timer = setTimeout(() => rejectTimeout(new Error("stdio wrapper did not exit")), 5_000);
      timer.unref();
    }),
  ]);
}

test("retained stdio entry cleans up on EOF, SIGINT, and SIGTERM", async () => {
  const paths = await temporaryPaths("bridge-stdio-lifecycle-");
  const daemon = new BridgeDaemon({
    paths,
    port: 0,
    tokenEnvironmentWriter: async () => undefined,
  });
  await daemon.start();
  const mcpMain = fileURLToPath(new URL("../../src/mcp/main.js", import.meta.url));
  try {
    for (const ending of ["EOF", "SIGINT", "SIGTERM"] as const) {
      const child = spawn(process.execPath, [mcpMain], {
        env: {
          ...process.env,
          BRIDGE_SKIP_ACL: "1",
          CLAUDE_CODEX_BRIDGE_HOME: paths.root,
        },
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        await initializeStdio(child);
        if (ending === "EOF") {
          child.stdin.end();
        } else {
          assert.equal(child.kill(ending), true);
        }
        await waitForChildExit(child);
        assert.equal(child.exitCode === 0 || child.signalCode === ending, true, ending);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
    }
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});
