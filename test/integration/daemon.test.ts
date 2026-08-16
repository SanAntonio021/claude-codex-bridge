import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  cancelJob,
  getBridgeStatus,
  getJobResult,
  getJobStatus,
  listSessions,
  rotateBridgeToken,
  submitJob,
  waitJob,
} from "../../src/api.js";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_LEGACY_PROTOCOL_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  LIMITS,
} from "../../src/constants.js";
import { requestDaemon } from "../../src/daemon/client.js";
import { ensureDaemon } from "../../src/daemon/ensure.js";
import { BridgeDaemon } from "../../src/daemon/server.js";
import {
  prepareRuntime,
  readEndpoint,
  readToken,
  writeEndpoint,
} from "../../src/daemon/runtime.js";
import type { HeadlessRunner } from "../../src/daemon/scheduler.js";
import {
  REQUIRED_CLAUDE_MODEL,
  type HeadlessOutcome,
  type HeadlessRunOptions,
} from "../../src/adapter/claude.js";
import { BridgeError } from "../../src/errors.js";
import { createBridgeRequest } from "../../src/request.js";
import type { DaemonPaths } from "../../src/config.js";
import { AuditLog } from "../../src/daemon/audit.js";
import { JobStore } from "../../src/daemon/store.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

function questionFromPrompt(prompt: string): string {
  const marker = "\n\nQuestion:\n";
  const index = prompt.lastIndexOf(marker);
  return index < 0 ? prompt : prompt.slice(index + marker.length);
}

class FakeRunner implements HeadlessRunner {
  active = 0;
  maxActive = 0;
  serialActive = 0;
  maxSerialActive = 0;
  readonly calls: Array<{ question: string; sessionId?: string }> = [];
  readonly failResumeQuestions = new Set<string>();
  readonly isolationResumeQuestions = new Set<string>();
  readonly modelMismatchResumeQuestions = new Set<string>();

  async run(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
    await options.hooks?.onTransportDelivered?.();
    await options.hooks?.onRunning?.();
    const question = questionFromPrompt(options.prompt);
    this.calls.push({
      question,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (question.startsWith("serial-")) {
      this.serialActive += 1;
      this.maxSerialActive = Math.max(this.maxSerialActive, this.serialActive);
    }
    const delay = question.startsWith("slow-") || question.startsWith("queue-block-") ? 5_000 : 80;
    const aborted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), delay);
      const abort = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      if (options.signal?.aborted === true) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }
    });
    this.active -= 1;
    if (question.startsWith("serial-")) {
      this.serialActive -= 1;
    }
    const sessionId = options.sessionId ?? randomUUID();
    const permissionDenials = question === "AUDIT_PROMPT_SECRET"
      ? [
          {
            tool_name: "Write",
            tool_use_id: "audit-tool",
            tool_input: { path: "RAW_TOOL_INPUT_SECRET" },
          },
        ]
      : [];
    if (
      !aborted &&
      options.sessionId !== undefined &&
      this.isolationResumeQuestions.has(question)
    ) {
      return {
        classification: "isolation_breach",
        is_error: true,
        session_id: options.sessionId,
        details: {
          exit_code: 1,
          stderr: "",
          complete_stdout_lines: [
            '{"type":"system","subtype":"init","tools":["Read"]}',
          ],
          isolation_violation: {
            event_index: 2,
            tool_name: "Bash",
            reason_code: "bash_command_not_allowed",
            preview: "type <arguments>",
          },
          isolation_violation_raw: {
            event_index: 2,
            raw_event: {
              type: "assistant",
              command: "type C:\\protected\\RAW_ISOLATION_SECRET.txt",
            },
          },
        },
      };
    }
    if (
      !aborted &&
      options.sessionId !== undefined &&
      this.modelMismatchResumeQuestions.has(question)
    ) {
      return {
        classification: "model_mismatch",
        is_error: true,
        session_id: options.sessionId,
        details: {
          exit_code: 1,
          stderr: "",
          complete_stdout_lines: [
            '{"type":"system","subtype":"init","model":"claude-sonnet-5","tools":[]}',
          ],
          reported_model: "claude-sonnet-5",
        },
      };
    }
    if (
      !aborted &&
      options.sessionId !== undefined &&
      this.failResumeQuestions.has(question)
    ) {
      return {
        classification: "stream_interrupted",
        is_error: true,
        session_id: options.sessionId,
        details: {
          exit_code: 1,
          stderr: "",
          complete_stdout_lines: ['{"type":"system","subtype":"init","tools":[]}'],
        },
      };
    }
    return aborted
      ? {
          classification: "cancelled",
          is_error: true,
          details: { exit_code: 1, stderr: "", complete_stdout_lines: [] },
        }
      : {
          classification: "success",
          is_error: false,
          result: question === "AUDIT_PROMPT_SECRET" ? "AUDIT_RESULT_SECRET" : `fake:${question}`,
          session_id: sessionId,
          details: {
            exit_code: 0,
          stderr: "",
          complete_stdout_lines: [],
          reported_model: REQUIRED_CLAUDE_MODEL,
          permission_denials: permissionDenials,
          },
        };
  }
}

async function rawRequest(options: {
  paths: DaemonPaths;
  path: string;
  method?: "GET" | "POST";
  token?: string;
  bridgeToken?: string;
  origin?: string;
  body?: Buffer;
}): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { ok?: boolean; error?: { code?: string } };
}> {
  const endpoint = await readEndpoint(options.paths.endpoint);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json, text/event-stream",
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
          ...(options.bridgeToken === undefined
            ? {}
            : { "X-Bridge-Token": options.bridgeToken }),
          ...(options.origin === undefined ? {} : { Origin: options.origin }),
          ...(options.body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(options.body.length),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              ok?: boolean;
              error?: { code?: string };
            },
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

async function waitForState(
  paths: DaemonPaths,
  jobId: string,
  states: string[],
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getJobStatus(jobId, paths);
    if (states.includes(status.state)) {
      return status.state;
    }
    if (["succeeded", "failed", "cancelled", "expired", "needs_attention"].includes(status.state)) {
      const protectedRecord = JSON.parse(
        await readFile(join(paths.jobs, `${jobId}.json`), "utf8"),
      ) as { error?: unknown; history?: unknown; adapter_details?: unknown };
      throw new Error(`job ${jobId} reached ${status.state}: ${JSON.stringify(protectedRecord)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} did not reach ${states.join(",")}`);
}

async function waitForSession(
  paths: DaemonPaths,
  bridgeThreadId: string,
  previousSessionId?: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await listSessions(paths)).sessions.find(
      (candidate) => candidate.bridge_thread_id === bridgeThreadId,
    );
    if (
      session !== undefined &&
      (session.peer_session_id ?? session.claude_session_id) !== previousSessionId
    ) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session ${bridgeThreadId} was not persisted`);
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("test server did not obtain a TCP port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      assert.fail(`Process ${String(pid)} did not exit within ${String(timeoutMs)} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("daemon serves authenticated stateless MCP requests and cleans each request", async () => {
  const paths = await temporaryPaths("bridge-http-mcp-");
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  await daemon.start();
  try {
    const endpoint = await readEndpoint(paths.endpoint);
    const token = await readToken(paths.token);
    assert.equal(endpoint.version, BRIDGE_VERSION);
    assert.equal(endpoint.build_id, BRIDGE_BUILD_ID);
    assert.equal(endpoint.protocol_version, BRIDGE_PROTOCOL_VERSION);
    assert.equal(endpoint.mcp_url, `http://127.0.0.1:${String(endpoint.port)}/mcp`);

    const initialize = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "1.0.0" },
      },
    }));
    const unauthorized = await rawRequest({
      paths,
      path: "/mcp",
      method: "POST",
      body: initialize,
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error?.code, "unauthorized");
    const originRejected = await rawRequest({
      paths,
      path: "/mcp",
      method: "POST",
      bridgeToken: token,
      origin: "https://example.test",
      body: initialize,
    });
    assert.equal(originRejected.status, 403);
    assert.equal(originRejected.body.error?.code, "browser_origin_rejected");
    const oversized = await rawRequest({
      paths,
      path: "/mcp",
      method: "POST",
      bridgeToken: token,
      body: Buffer.alloc(LIMITS.requestBytes + 1, 0x20),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error?.code, "request_too_large");
    const initialized = await rawRequest({
      paths,
      path: "/mcp",
      method: "POST",
      bridgeToken: token,
      body: initialize,
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers["mcp-session-id"], undefined);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = new Client({ name: `http-client-${attempt}`, version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.mcp_url as string), {
        requestInit: { headers: { "X-Bridge-Token": token } },
      });
      await client.connect(transport as unknown as Transport);
      try {
        const tools = await client.listTools();
        assert.equal(tools.tools.some((tool) => tool.name === "review_repair_peer"), true);
        const status = await client.callTool({ name: "peer_status", arguments: {} });
        const structured = status.structuredContent as Record<string, unknown> | undefined;
        assert.equal(structured?.["version"], BRIDGE_VERSION);
        assert.equal(structured?.["build_id"], BRIDGE_BUILD_ID);
        assert.equal(structured?.["protocol_version"], BRIDGE_PROTOCOL_VERSION);
      } finally {
        await client.close();
      }
    }

    const deadline = Date.now() + 2_000;
    for (;;) {
      const status = await getBridgeStatus(paths);
      if (status.active_mcp_requests === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        assert.fail(`MCP requests did not clean up: ${JSON.stringify(status)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(await readdir(paths.jobs), []);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("token rotation is persistent, explicit, and blocked by active jobs", async () => {
  const paths = await temporaryPaths("bridge-token-rotation-");
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  await daemon.start();
  try {
    const original = await readToken(paths.token);
    const active = await submitJob(
      createBridgeRequest(
        { question: "slow-token-rotation", bridge_thread_id: "token-rotation-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    await waitForState(paths, active.job_id, ["running"]);
    await assert.rejects(
      rotateBridgeToken(paths),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "token_rotation_blocked",
    );
    assert.equal(await readToken(paths.token), original);
    await cancelJob(active.job_id, paths);
    const rotated = await rotateBridgeToken(paths);
    assert.equal(rotated.rotated, true);
    assert.equal(rotated.restart_required, true);
    const replacement = await readToken(paths.token);
    assert.notEqual(replacement, original);
    assert.equal((await rawRequest({ paths, path: "/health", token: original })).status, 401);
    assert.equal((await rawRequest({ paths, path: "/health", token: replacement })).status, 200);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon accepts either bridge credential format and rejects conflicting credentials", async () => {
  const paths = await temporaryPaths("bridge-http-auth-");
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  await daemon.start();
  try {
    const token = await readToken(paths.token);
    assert.equal((await rawRequest({ paths, path: "/health", token })).status, 200);
    assert.equal((await rawRequest({ paths, path: "/health", bridgeToken: token })).status, 200);
    assert.equal((await rawRequest({
      paths,
      path: "/health",
      token,
      bridgeToken: token,
    })).status, 200);
    const mismatched = await rawRequest({
      paths,
      path: "/health",
      token,
      bridgeToken: `${token}mismatch`,
    });
    assert.equal(mismatched.status, 401);
    assert.equal(mismatched.body.error?.code, "unauthorized");
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon freezes routing configuration while a job is active", async () => {
  const paths = await temporaryPaths("bridge-config-freeze-");
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  await daemon.start();
  try {
    const active = await submitJob(
      createBridgeRequest(
        { question: "slow-config-freeze", bridge_thread_id: "config-freeze-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    await waitForState(paths, active.job_id, ["running"]);
    await assert.rejects(
      () => requestDaemon("/v1/config", {
        method: "POST",
        paths,
        body: {
          action: "allow-model",
          model: "claude-future-1",
          target: "claude",
          efforts: ["max"],
        },
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "config_change_blocked",
    );
    await cancelJob(active.job_id, paths);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon validates retry routes before it creates a replacement job", async () => {
  const paths = await temporaryPaths("bridge-retry-route-");
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  await daemon.start();
  try {
    const initial = await submitJob(
      createBridgeRequest(
        { question: "retry-route", bridge_thread_id: "retry-route-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    const initialResult = await waitJob(initial.job_id, 5_000, paths);
    assert.equal(initialResult.job?.state, "succeeded");
    const beforeInvalidRetry = await readdir(paths.jobs);
    await assert.rejects(
      () => requestDaemon(`/v1/jobs/${initial.job_id}/retry`, {
        method: "POST",
        paths,
        body: { model: "claude-opus-4-6", task_profile: "quality" },
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_retry_route",
    );
    assert.deepEqual(await readdir(paths.jobs), beforeInvalidRetry);
    const replacement = await requestDaemon<{ job_id: string; retried_from: string }>(
      `/v1/jobs/${initial.job_id}/retry`,
      {
        method: "POST",
        paths,
        body: { model: "claude-opus-4-6" },
      },
    );
    assert.equal(replacement.retried_from, initial.job_id);
    assert.notEqual(replacement.job_id, initial.job_id);
    assert.equal((await waitJob(replacement.job_id, 5_000, paths)).job?.state, "succeeded");
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("ensureDaemon replaces an idle mismatched build on the configured port", async () => {
  const paths = await temporaryPaths("bridge-build-replace-");
  const previousPort = process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
  const port = await freeLoopbackPort();
  process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = String(port);
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port });
  await daemon.start();
  try {
    const original = await readEndpoint(paths.endpoint);
    await writeEndpoint(paths.endpoint, { ...original, build_id: "0".repeat(64) });
    const replacement = await ensureDaemon(paths);
    assert.notEqual(replacement.pid, original.pid);
    assert.equal(replacement.port, port);
    assert.equal(replacement.version, BRIDGE_VERSION);
    assert.equal(replacement.build_id, BRIDGE_BUILD_ID);
    assert.equal(replacement.protocol_version, BRIDGE_PROTOCOL_VERSION);
    await requestDaemon("/shutdown", { method: "POST", body: {}, paths });
    await waitForProcessExit(replacement.pid);
  } finally {
    await daemon.stop().catch(() => undefined);
    if (previousPort === undefined) {
      delete process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
    } else {
      process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = previousPort;
    }
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("ensureDaemon preserves a mismatched build while a job is active", async () => {
  const paths = await temporaryPaths("bridge-build-active-");
  const port = await freeLoopbackPort();
  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port });
  await daemon.start();
  try {
    const original = await readEndpoint(paths.endpoint);
    const active = await submitJob(
      createBridgeRequest(
        { question: "slow-build-block", bridge_thread_id: "build-block-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    await waitForState(paths, active.job_id, ["running"]);
    await writeEndpoint(paths.endpoint, { ...original, build_id: "0".repeat(64) });
    await assert.rejects(
      ensureDaemon(paths),
      (error: unknown) =>
        error instanceof BridgeError
        && error.code === "daemon_build_mismatch_active"
        && error.details?.["running_pid"] === original.pid,
    );
    await writeEndpoint(paths.endpoint, original);
    assert.equal((await requestDaemon<{ pid: number }>("/health", { paths })).pid, original.pid);
    await cancelJob(active.job_id, paths);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("concurrent ensureDaemon callers join one current-build daemon", async () => {
  const paths = await temporaryPaths("bridge-build-concurrent-");
  const previousPort = process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
  const port = await freeLoopbackPort();
  process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = String(port);
  let pid: number | undefined;
  try {
    const endpoints = await Promise.all([
      ensureDaemon(paths),
      ensureDaemon(paths),
      ensureDaemon(paths),
    ]);
    pid = endpoints[0]?.pid;
    assert.ok(pid !== undefined);
    assert.equal(new Set(endpoints.map((endpoint) => endpoint.pid)).size, 1);
    assert.equal(endpoints.every((endpoint) => endpoint.build_id === BRIDGE_BUILD_ID), true);
    await requestDaemon("/shutdown", { method: "POST", body: {}, paths });
    await waitForProcessExit(pid);
  } finally {
    if (previousPort === undefined) {
      delete process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
    } else {
      process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = previousPort;
    }
    if (pid !== undefined) {
      await waitForProcessExit(pid).catch(() => undefined);
    }
    await rm(paths.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ensureDaemon rejects a non-bridge port owner without selecting another port", async () => {
  const paths = await temporaryPaths("bridge-port-owner-");
  const previousPort = process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
  const port = await freeLoopbackPort();
  const blocker = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    blocker.once("error", rejectListen);
    blocker.listen(port, "127.0.0.1", resolveListen);
  });
  process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = String(port);
  try {
    await assert.rejects(
      ensureDaemon(paths),
      (error: unknown) => error instanceof BridgeError && error.code === "daemon_port_in_use",
    );
    await assert.rejects(readEndpoint(paths.endpoint));
  } finally {
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    if (previousPort === undefined) {
      delete process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT;
    } else {
      process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT = previousPort;
    }
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon publishes readiness only after crash recovery", async () => {
  const paths = await temporaryPaths("claude-codex-bridge-recovery-");
  await prepareRuntime(paths);
  const store = new JobStore(paths.jobs, new AuditLog(paths.audit));
  const jobIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const created = await store.create(
      createBridgeRequest(
        { question: `recover-${index}`, bridge_thread_id: `recover-thread-${index}` },
        { origin: "recovery-test" },
      ),
    );
    jobIds.push(created.record.job_id);
    await store.transition(created.record.job_id, "dispatching");
    await store.transition(created.record.job_id, "transport_delivered");
    await store.transition(created.record.job_id, "running");
  }

  const daemon = new BridgeDaemon({ paths, adapter: new FakeRunner(), port: 0 });
  const starting = daemon.start();
  try {
    const endpointDeadline = Date.now() + 5_000;
    while (true) {
      try {
        await readEndpoint(paths.endpoint);
        break;
      } catch (error) {
        if (Date.now() >= endpointDeadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const status = await getBridgeStatus(paths);
    assert.equal((status.jobs as Record<string, number>).running, 0);
    assert.equal((status.jobs as Record<string, number>).needs_attention, jobIds.length);
    for (const jobId of jobIds) {
      const recovered = await getJobStatus(jobId, paths);
      assert.equal(recovered.state, "needs_attention");
      assert.equal(recovered.error_code, "daemon_restarted");
    }
    await starting;
  } finally {
    await starting.catch(() => undefined);
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon M1 control plane, limits, serialization, cancellation, and audit", async () => {
  const paths = await temporaryPaths("claude-codex-bridge-daemon-");
  const runner = new FakeRunner();
  const daemon = new BridgeDaemon({ paths, adapter: runner, port: 0 });
  await daemon.start();
  try {
    const token = await readToken(paths.token);

    const unauthorized = await rawRequest({ paths, path: "/health" });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error?.code, "unauthorized");

    const browserOrigin = await rawRequest({
      paths,
      path: "/health",
      token,
      origin: "https://example.test",
    });
    assert.equal(browserOrigin.status, 403);
    assert.equal(browserOrigin.body.error?.code, "browser_origin_rejected");

    const oversized = Buffer.from(
      JSON.stringify({ question: "x".repeat(LIMITS.requestBytes) }),
    );
    const tooLarge = await rawRequest({
      paths,
      path: "/v1/jobs",
      method: "POST",
      token,
      body: oversized,
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error?.code, "request_too_large");

    const secondDaemon = new BridgeDaemon({ paths, adapter: runner, port: 0 });
    await assert.rejects(
      () => secondDaemon.start(),
      (error: unknown) => error instanceof BridgeError && error.code === "daemon_already_running",
    );
    assert.equal((await requestDaemon<{ name: string }>("/health", { paths })).name, "claude-codex-bridge");

    const beforeLive = (await readdir(paths.jobs)).length;
    const liveRequest = createBridgeRequest(
      { question: "live", route: "live" },
      { origin: "integration", target: "claude" },
    );
    await assert.rejects(
      () => requestDaemon("/v1/jobs", { method: "POST", body: liveRequest, paths }),
      (error: unknown) => error instanceof BridgeError && error.code === "live_unavailable",
    );
    assert.equal((await readdir(paths.jobs)).length, beforeLive);

    const auto = await submitJob(
      createBridgeRequest(
        { question: "auto-ok", route: "auto", bridge_thread_id: "auto-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    const autoResult = await waitJob(auto.job_id, 5_000, paths);
    assert.equal(autoResult.status, "complete");
    assert.equal(autoResult.job?.state, "succeeded");
    assert.equal(autoResult.job?.result, "fake:auto-ok");
    assert.equal(autoResult.job?.review_model, REQUIRED_CLAUDE_MODEL);
    assert.equal(autoResult.job?.version, BRIDGE_VERSION);
    assert.equal(autoResult.job?.build_id, BRIDGE_BUILD_ID);
    assert.equal(autoResult.job?.protocol_version, BRIDGE_LEGACY_PROTOCOL_VERSION);

    const noFallbackThread = "resume-no-fallback-thread";
    const noFallbackSeed = await submitJob(
      createBridgeRequest(
        { question: "resume-no-fallback-seed", bridge_thread_id: noFallbackThread },
        { origin: "integration" },
      ),
      paths,
    );
    const noFallbackSeedResult = await waitJob(noFallbackSeed.job_id, 5_000, paths);
    const noFallbackSeedProtected = JSON.parse(
      await readFile(join(paths.jobs, `${noFallbackSeed.job_id}.json`), "utf8"),
    ) as { error?: unknown; history?: unknown; adapter_details?: unknown };
    assert.equal(noFallbackSeedResult.status, "complete");
    assert.equal(
      noFallbackSeedResult.job?.state,
      "succeeded",
      JSON.stringify(noFallbackSeedProtected),
    );
    const noFallbackSession = await waitForSession(paths, noFallbackThread);
    runner.failResumeQuestions.add("resume-no-fallback");
    const noFallbackCallStart = runner.calls.length;
    const noFallback = await submitJob(
      createBridgeRequest(
        { question: "resume-no-fallback", bridge_thread_id: noFallbackThread },
        { origin: "integration" },
      ),
      paths,
    );
    const noFallbackResult = await waitJob(noFallback.job_id, 5_000, paths);
    assert.equal(noFallbackResult.job?.state, "failed");
    assert.equal(
      noFallbackResult.job?.error?.code,
      "resume_failed",
      JSON.stringify(noFallbackResult.job?.error),
    );
    assert.equal(noFallbackResult.job?.context_reset, undefined);
    assert.deepEqual(runner.calls.slice(noFallbackCallStart), [
      {
        question: "resume-no-fallback",
        sessionId: noFallbackSession.claude_session_id,
      },
    ]);

    const fallbackThread = "resume-fallback-thread";
    const fallbackSeed = await submitJob(
      createBridgeRequest(
        { question: "resume-fallback-seed", bridge_thread_id: fallbackThread },
        { origin: "integration" },
      ),
      paths,
    );
    const fallbackSeedResult = await waitJob(fallbackSeed.job_id, 5_000, paths);
    const fallbackSeedProtected = JSON.parse(
      await readFile(join(paths.jobs, `${fallbackSeed.job_id}.json`), "utf8"),
    ) as { error?: unknown; history?: unknown; adapter_details?: unknown };
    assert.equal(fallbackSeedResult.status, "complete");
    assert.equal(
      fallbackSeedResult.job?.state,
      "succeeded",
      JSON.stringify(fallbackSeedProtected),
    );
    const oldFallbackSession = await waitForSession(paths, fallbackThread);
    runner.failResumeQuestions.add("resume-with-fallback");
    const fallbackCallStart = runner.calls.length;
    const fallback = await submitJob(
      createBridgeRequest(
        {
          question: "resume-with-fallback",
          bridge_thread_id: fallbackThread,
          allow_fresh_fallback: true,
        },
        { origin: "integration" },
      ),
      paths,
    );
    const fallbackResult = await waitJob(fallback.job_id, 5_000, paths);
    assert.equal(fallbackResult.job?.state, "succeeded");
    assert.equal(fallbackResult.job?.context_reset, true);
    assert.equal(fallbackResult.job?.result, "fake:resume-with-fallback");
    assert.deepEqual(runner.calls.slice(fallbackCallStart), [
      {
        question: "resume-with-fallback",
        sessionId: oldFallbackSession.claude_session_id,
      },
      { question: "resume-with-fallback" },
    ]);
    const newFallbackSession = await waitForSession(
      paths,
      fallbackThread,
      oldFallbackSession.claude_session_id,
    );
    assert.notEqual(
      newFallbackSession.claude_session_id,
      oldFallbackSession.claude_session_id,
    );

    runner.isolationResumeQuestions.add("resume-isolation-breach");
    const isolationCallStart = runner.calls.length;
    const isolation = await submitJob(
      createBridgeRequest(
        {
          question: "resume-isolation-breach",
          bridge_thread_id: fallbackThread,
          allow_fresh_fallback: true,
        },
        { origin: "integration" },
      ),
      paths,
    );
    const isolationResult = await waitJob(isolation.job_id, 5_000, paths);
    assert.equal(isolationResult.job?.state, "failed");
    assert.equal(isolationResult.job?.error?.code, "isolation_breach");
    assert.deepEqual(isolationResult.job?.error?.details?.["isolation_violation"], {
      event_index: 2,
      tool_name: "Bash",
      reason_code: "bash_command_not_allowed",
      preview: "type <arguments>",
    });
    assert.doesNotMatch(JSON.stringify(isolationResult.job), /RAW_ISOLATION_SECRET/u);
    assert.match(
      await readFile(join(paths.jobs, `${isolation.job_id}.json`), "utf8"),
      /RAW_ISOLATION_SECRET/u,
    );
    assert.equal(isolationResult.job?.context_reset, undefined);
    assert.deepEqual(runner.calls.slice(isolationCallStart), [
      {
        question: "resume-isolation-breach",
        sessionId: newFallbackSession.claude_session_id,
      },
    ]);

    runner.modelMismatchResumeQuestions.add("resume-model-mismatch");
    const modelMismatchCallStart = runner.calls.length;
    const modelMismatch = await submitJob(
      createBridgeRequest(
        {
          question: "resume-model-mismatch",
          bridge_thread_id: fallbackThread,
          allow_fresh_fallback: true,
        },
        { origin: "integration" },
      ),
      paths,
    );
    const modelMismatchResult = await waitJob(modelMismatch.job_id, 5_000, paths);
    assert.equal(modelMismatchResult.job?.state, "failed");
    assert.equal(
      modelMismatchResult.job?.error?.code,
      "model_mismatch",
      JSON.stringify(modelMismatchResult.job?.error),
    );
    assert.equal(modelMismatchResult.job?.context_reset, undefined);
    assert.equal(modelMismatchResult.job?.review_model, "claude-sonnet-5");
    assert.deepEqual(runner.calls.slice(modelMismatchCallStart), [
      {
        question: "resume-model-mismatch",
        sessionId: newFallbackSession.claude_session_id,
      },
    ]);

    const idempotentRequest = createBridgeRequest(
      {
        question: "same",
        idempotency_key: "integration-idempotency",
        bridge_thread_id: "idempotency-thread",
      },
      { origin: "integration" },
    );
    const firstIdempotent = await submitJob(idempotentRequest, paths);
    const secondIdempotent = await submitJob(idempotentRequest, paths);
    assert.equal(firstIdempotent.job_id, secondIdempotent.job_id);
    assert.equal(secondIdempotent.created, false);
    await assert.rejects(
      () => submitJob({ ...idempotentRequest, question: "changed" }, paths),
      (error: unknown) => error instanceof BridgeError && error.code === "idempotency_conflict",
    );

    const serialOne = await submitJob(
      createBridgeRequest(
        { question: "serial-one", bridge_thread_id: "serial-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    const serialTwo = await submitJob(
      createBridgeRequest(
        { question: "serial-two", bridge_thread_id: "serial-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    await Promise.all([
      waitJob(serialOne.job_id, 5_000, paths),
      waitJob(serialTwo.job_id, 5_000, paths),
    ]);
    assert.equal(runner.maxSerialActive, 1);

    runner.maxActive = 0;
    const parallel = await Promise.all(
      Array.from({ length: 6 }, async (_, index) =>
        submitJob(
          createBridgeRequest(
            { question: `parallel-${index}`, bridge_thread_id: `parallel-thread-${index}` },
            { origin: "integration" },
          ),
          paths,
        ),
      ),
    );
    await Promise.all(parallel.map(async (job) => waitJob(job.job_id, 5_000, paths)));
    assert.ok(runner.maxActive >= 2);
    assert.ok(runner.maxActive <= LIMITS.activeJobs);

    const cancellable = await submitJob(
      createBridgeRequest(
        { question: "slow-cancel", bridge_thread_id: "cancel-thread" },
        { origin: "integration" },
      ),
      paths,
    );
    await waitForState(paths, cancellable.job_id, ["running"]);
    const cancelled = await cancelJob(cancellable.job_id, paths);
    assert.equal(cancelled.cancellation_requested, true);
    assert.equal(cancelled.target_confirmed, true);
    assert.equal(cancelled.state, "cancelled");

    const deadline = new Date(Date.now() + 250).toISOString();
    const expiring = await submitJob(
      createBridgeRequest(
        { question: "slow-timeout", bridge_thread_id: "timeout-thread", deadline },
        { origin: "integration" },
      ),
      paths,
    );
    const expired = await waitJob(expiring.job_id, 5_000, paths);
    assert.equal(expired.job?.state, "expired");
    assert.equal(expired.job?.error?.code, "job_timeout");

    const auditJob = await submitJob(
      createBridgeRequest(
        {
          question: "AUDIT_PROMPT_SECRET",
          context: "AUDIT_CONTEXT_SECRET",
          bridge_thread_id: "audit-thread",
        },
        { origin: "integration" },
      ),
      paths,
    );
    await waitJob(auditJob.job_id, 5_000, paths);
    const explicitResult = await getJobResult(auditJob.job_id, paths);
    assert.equal("result" in explicitResult ? explicitResult.result : undefined, "AUDIT_RESULT_SECRET");
    const auditText = await readFile(paths.audit, "utf8");
    assert.doesNotMatch(
      auditText,
      /AUDIT_PROMPT_SECRET|AUDIT_CONTEXT_SECRET|AUDIT_RESULT_SECRET|RAW_TOOL_INPUT_SECRET/u,
    );
    assert.match(auditText, /tool_input_sha256/u);
    const detailText = await readFile(`${paths.jobs}\\${auditJob.job_id}.json`, "utf8");
    assert.match(detailText, /AUDIT_PROMPT_SECRET/u);
    assert.match(detailText, /RAW_TOOL_INPUT_SECRET/u);

    const activeBlockers = await Promise.all(
      Array.from({ length: 3 }, async (_, index) =>
        submitJob(
          createBridgeRequest(
            {
              question: `queue-block-${index}`,
              bridge_thread_id: `queue-block-thread-${index}`,
            },
            { origin: "queue-limit" },
          ),
          paths,
        ),
      ),
    );
    await Promise.all(
      activeBlockers.map(async (job) => waitForState(paths, job.job_id, ["running"])),
    );
    const queued = [];
    for (let index = 0; index < LIMITS.queuedJobs; index += 1) {
      queued.push(
        await submitJob(
          createBridgeRequest(
            {
              question: `queued-${index}`,
              bridge_thread_id: `queued-thread-${index}`,
            },
            { origin: "queue-limit" },
          ),
          paths,
        ),
      );
    }
    await assert.rejects(
      () =>
        submitJob(
          createBridgeRequest(
            { question: "queue-overflow", bridge_thread_id: "queue-overflow-thread" },
            { origin: "queue-limit" },
          ),
          paths,
        ),
      (error: unknown) => error instanceof BridgeError && error.code === "queue_full",
    );
    for (const job of queued.toReversed()) {
      await cancelJob(job.job_id, paths);
    }
    for (const job of activeBlockers) {
      await cancelJob(job.job_id, paths);
    }
    const status = await getBridgeStatus(paths);
    assert.equal((status.jobs as Record<string, number>).queued, 0);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});
