import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HeadlessOutcome } from "../../src/adapter/claude.js";
import { createV2BridgeMcpServer } from "../../src/v2/mcp.js";
import { V2ReviewService } from "../../src/v2/service.js";
import type { V2ReviewRequest } from "../../src/v2/types.js";
import { sha256 } from "../../src/hash.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

function reviewArtifact(content = "# Reviewed plan\n") {
  return {
    artifactContent: content,
    artifactBytes: Buffer.byteLength(content, "utf8"),
    artifactSha256: sha256(content),
  };
}

class FixedRunner {
  async run(request: V2ReviewRequest): Promise<HeadlessOutcome> {
    return {
      classification: "success",
      is_error: false,
      result: JSON.stringify({
        kind: "final_review",
        verdict: "pass",
        confirmed: ["The plan has one objective acceptance criterion."],
        findings: [],
        requiredChanges: [],
        risks: [],
      }),
      details: {
        exit_code: 0,
        stderr: "",
        complete_stdout_lines: [],
        requested_model: request.model,
        requested_reasoning_effort: request.reasoningEffort,
        ...(request.target === "claude" ? { reported_model: request.model } : {}),
      },
    };
  }
}

test("v2 MCP derives peer target from endpoint owner and rejects caller role overrides", async () => {
  const paths = await temporaryPaths("bridge-v2-mcp-");
  const service = new V2ReviewService({
    runtimeRoot: paths.root,
    runner: new FixedRunner(),
    probe: async () => ({
      at: new Date().toISOString(),
      v2WorkspaceTests: true,
      workspaceWrite: true,
      externalWriteDenied: true,
      loopbackDenied: true,
      internetDenied: true,
      childInheritanceDenied: true,
      childTreeTerminated: true,
    }),
  });
  await service.initialize({ probe: true });
  const server = createV2BridgeMcpServer({ paths, owner: "codex", service });
  const client = new Client({ name: "bridge-v2-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["adjudicate_peer_series", "await_peer", "peer_result", "peer_status", "review_peer", "review_repair_peer"],
    );
    const invalid = await client.callTool({
      name: "review_peer",
      arguments: {
        target: "codex",
        question: "Review it.",
        artifactId: "v2-mcp-plan",
        artifactType: "plan",
        artifactName: "plan.md",
        artifactPath: "plan.md",
        ...reviewArtifact(),
        acceptanceCriteria: ["The plan is coherent."],
      },
    });
    assert.equal(invalid.isError, true);
    const submitted = await client.callTool({
      name: "review_peer",
      arguments: {
        question: "Review it.",
        artifactId: "v2-mcp-plan",
        artifactType: "plan",
        artifactName: "plan.md",
        artifactPath: "plan.md",
        ...reviewArtifact(),
        acceptanceCriteria: ["The plan is coherent."],
        constraints: ["No files may be written."],
      },
    });
    assert.equal(submitted.isError, undefined);
    const jobId = (submitted.structuredContent as { job_id?: string } | undefined)?.job_id;
    assert.match(jobId ?? "", /^[0-9a-f-]{36}$/u);
    const waited = await client.callTool({
      name: "await_peer",
      arguments: { job_id: jobId, timeout_ms: 2_000 },
    });
    assert.equal(waited.isError, undefined);
    const job = (waited.structuredContent as {
      job?: { target?: string; operation?: string; artifact_mode?: string; result?: string };
    } | undefined)?.job;
    assert.equal(job?.target, "claude");
    assert.equal(job?.operation, "review_only");
    assert.equal(job?.artifact_mode, "inline");
    assert.match(job?.result ?? "", /^PLAN_REVIEW/mu);
  } finally {
    await client.close();
    await server.close();
    await rm(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
