import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import type { HeadlessOutcome } from "../../src/adapter/claude.js";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/constants.js";
import { readEndpoint, readToken } from "../../src/daemon/runtime.js";
import { BridgeDaemon } from "../../src/daemon/server.js";
import { V2ReviewService } from "../../src/v2/service.js";
import type { V2ReviewRequest } from "../../src/v2/types.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

class FixedRunner {
  async run(request: V2ReviewRequest): Promise<HeadlessOutcome> {
    return {
      classification: "success",
      is_error: false,
      result: JSON.stringify({
        kind: "final_review",
        verdict: "pass",
        confirmed: ["fixed runner"],
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

async function mcpRequest(
  endpoint: { host: string; port: number },
  path: string,
  token: string,
): Promise<number> {
  const body = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "v2-endpoint-test", version: "1.0.0" },
    },
  }));
  return new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest({
      host: endpoint.host,
      port: endpoint.port,
      path,
      method: "POST",
      headers: {
        "X-Bridge-Token": token,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("daemon exposes independently authenticated protocol-v2 role endpoints", async () => {
  const paths = await temporaryPaths("bridge-v2-daemon-");
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
  const daemon = new BridgeDaemon({
    paths,
    port: 0,
    tokenEnvironmentWriter: async () => undefined,
    v2Service: service,
  });
  await daemon.start();
  try {
    const endpoint = await readEndpoint(paths.endpoint);
    const [legacy, codex, claude] = await Promise.all([
      readToken(paths.token),
      readToken(paths.codexToken),
      readToken(paths.claudeToken),
    ]);
    assert.notEqual(legacy, codex);
    assert.notEqual(codex, claude);
    assert.equal(endpoint.protocol_version, BRIDGE_PROTOCOL_VERSION);
    assert.deepEqual(endpoint.supported_protocols, [1, 2]);
    assert.match(endpoint.role_mcp_urls?.codex ?? "", /\/mcp\/codex$/u);
    assert.match(endpoint.role_mcp_urls?.claude ?? "", /\/mcp\/claude$/u);
    assert.equal(await mcpRequest(endpoint, "/mcp/codex", legacy), 401);
    assert.equal(await mcpRequest(endpoint, "/mcp/codex", claude), 401);
    assert.equal(await mcpRequest(endpoint, "/mcp/codex", codex), 200);
    assert.equal(await mcpRequest(endpoint, "/mcp/claude", codex), 401);
    assert.equal(await mcpRequest(endpoint, "/mcp/claude", claude), 200);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
