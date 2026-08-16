import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuditLog } from "./audit.js";
import {
  DaemonLock,
  ensurePersistentToken,
  mirrorTokenToUserEnvironment,
  prepareRuntime,
  removeEndpoint,
  rotatePersistentToken,
  tokenMatches,
  writeEndpoint,
  type TokenEnvironmentWriter,
} from "./runtime.js";
import { JobStore } from "./store.js";
import { cleanupRuntime } from "./cleanup.js";
import { SessionStore } from "./sessions.js";
import { JobScheduler, type HeadlessRunner } from "./scheduler.js";
import { ClaudeHeadlessAdapter } from "../adapter/claude.js";
import { CodexHeadlessAdapter } from "../adapter/codex.js";
import { PeerAdapter } from "../adapter/peer.js";
import { WorkspaceManager } from "../workspace.js";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_CLAUDE_MCP_PATH,
  BRIDGE_CLAUDE_TOKEN_ENV,
  BRIDGE_CODEX_MCP_PATH,
  BRIDGE_CODEX_TOKEN_ENV,
  BRIDGE_HTTP_PORT,
  BRIDGE_LEGACY_PROTOCOL_VERSION,
  BRIDGE_MCP_PATH,
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SUPPORTED_PROTOCOL_VERSIONS,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_VERSION,
  LIMITS,
  LOOPBACK_HOST,
} from "../constants.js";
import {
  ConfigMutationSchema,
  ensureBridgeConfig,
  getDaemonPaths,
  mutateBridgeConfig,
  publicBridgeConfig,
  readBridgeConfig,
  type DaemonPaths,
} from "../config.js";
import { BridgeError, asBridgeError, toStructuredError } from "../errors.js";
import { createBridgeMcpServer } from "../mcp/main.js";
import { createV2BridgeMcpServer } from "../v2/mcp.js";
import { V2ReviewService } from "../v2/service.js";
import type { V2Owner } from "../v2/types.js";
import { createBridgeRequest } from "../request.js";
import { ModelIdSchema, TaskProfileSchema } from "../model-routing.js";
import { isTerminalState, parseBridgeRequest, publicJobResult, publicJobStatus, type JobState } from "../types.js";

export interface BridgeDaemonOptions {
  paths?: DaemonPaths;
  adapter?: HeadlessRunner;
  port?: number;
  tokenEnvironmentWriter?: TokenEnvironmentWriter;
  v2Service?: V2ReviewService;
  probeV2Workspace?: boolean;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendData(response: ServerResponse, data: unknown, status = 200): void {
  sendJson(response, status, { ok: true, data });
}

function sendError(response: ServerResponse, error: unknown): void {
  const bridgeError = asBridgeError(error);
  sendJson(response, bridgeError.httpStatus, {
    ok: false,
    error: toStructuredError(bridgeError),
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new BridgeError("unsupported_media_type", "POST requests require application/json.", {
      httpStatus: 415,
    });
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > LIMITS.requestBytes) {
    throw new BridgeError("request_too_large", "Request exceeds the 1 MiB limit.", {
      httpStatus: 413,
    });
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    length += chunk.length;
    if (length > LIMITS.requestBytes) {
      request.resume();
      throw new BridgeError("request_too_large", "Request exceeds the 1 MiB limit.", {
        httpStatus: 413,
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new BridgeError("invalid_json", "Request body is not valid JSON.", {
      httpStatus: 400,
      cause: error,
    });
  }
}

function parseTimeout(value: string | null): number {
  if (value === null) {
    return LIMITS.awaitMs;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > LIMITS.awaitMs) {
    throw new BridgeError("invalid_timeout", "timeout_ms must be an integer from 0 to 45000.");
  }
  return timeout;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  const authorization = singleHeader(value);
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token === "" ? undefined : token;
}

function authenticateRequest(request: IncomingMessage, expectedToken: string): void {
  const headerToken = singleHeader(request.headers[BRIDGE_TOKEN_HEADER]);
  const bearer = bearerToken(request.headers.authorization);
  if (headerToken === undefined && bearer === undefined) {
    throw new BridgeError("unauthorized", "Bridge token authentication failed.", { httpStatus: 401 });
  }
  if (
    headerToken !== undefined
    && bearer !== undefined
    && !tokenMatches(headerToken, bearer)
  ) {
    throw new BridgeError("unauthorized", "Bridge authentication headers disagree.", { httpStatus: 401 });
  }
  const supplied = headerToken ?? bearer;
  if (supplied === undefined || !tokenMatches(expectedToken, supplied)) {
    throw new BridgeError("unauthorized", "Bridge token authentication failed.", { httpStatus: 401 });
  }
}

export class BridgeDaemon {
  readonly #paths: DaemonPaths;
  readonly #port: number;
  readonly #lock: DaemonLock;
  readonly #audit: AuditLog;
  readonly #sessions: SessionStore;
  readonly #store: JobStore;
  readonly #scheduler: JobScheduler;
  readonly #v2: V2ReviewService;
  readonly #probeV2Workspace: boolean;
  readonly #tokenEnvironmentWriter: TokenEnvironmentWriter;
  #token = "";
  #ownerTokens: Record<V2Owner, string> = { codex: "", claude: "" };
  #server: Server | undefined;
  #boundPort = 0;
  #activeMcpRequests = 0;
  #startedAt = "";
  #stopping: Promise<void> | undefined;

  constructor(options: BridgeDaemonOptions = {}) {
    this.#paths = options.paths ?? getDaemonPaths();
    this.#port = options.port ?? BRIDGE_HTTP_PORT;
    this.#tokenEnvironmentWriter = options.tokenEnvironmentWriter
      ?? (process.env.BRIDGE_SKIP_ACL === "1"
        ? async () => undefined
        : mirrorTokenToUserEnvironment);
    this.#probeV2Workspace = options.probeV2Workspace ?? process.env.BRIDGE_SKIP_ACL !== "1";
    this.#lock = new DaemonLock(this.#paths.lock);
    this.#audit = new AuditLog(this.#paths.audit);
    this.#sessions = new SessionStore(this.#paths.sessions);
    this.#store = new JobStore(this.#paths.jobs, this.#audit);
    this.#scheduler = new JobScheduler(
      this.#store,
      this.#sessions,
      options.adapter ??
        new PeerAdapter({
          claude: new ClaudeHeadlessAdapter({ cwd: process.cwd(), inputDirectory: this.#paths.jobs }),
          codex: new CodexHeadlessAdapter({ cwd: this.#paths.readonlyWorkspace }),
        }),
      new WorkspaceManager(this.#paths.root),
    );
    this.#v2 = options.v2Service ?? V2ReviewService.withBridgeRunner(
      this.#paths.root,
      new PeerAdapter({
        claude: new ClaudeHeadlessAdapter({ cwd: process.cwd(), inputDirectory: this.#paths.jobs }),
        codex: new CodexHeadlessAdapter({ cwd: this.#paths.readonlyWorkspace }),
      }),
    );
  }

  get paths(): DaemonPaths {
    return this.#paths;
  }

  async start(): Promise<void> {
    await prepareRuntime(this.#paths);
    await this.#lock.acquire();
    try {
      this.#token = (await ensurePersistentToken(
        this.#paths.token,
        this.#tokenEnvironmentWriter,
      )).token;
      this.#ownerTokens = {
        codex: (await ensurePersistentToken(
          this.#paths.codexToken,
          this.#tokenEnvironmentWriter,
          BRIDGE_CODEX_TOKEN_ENV,
        )).token,
        claude: (await ensurePersistentToken(
          this.#paths.claudeToken,
          this.#tokenEnvironmentWriter,
          BRIDGE_CLAUDE_TOKEN_ENV,
        )).token,
      };
      const config = await ensureBridgeConfig(this.#paths);
      await Promise.all([this.#sessions.load(), this.#store.load()]);
      await this.#v2.initialize();
      this.#server = createServer((request, response) => {
        void this.#handle(request, response);
      });
      this.#server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      });
      await new Promise<void>((resolve, reject) => {
        const rejectBind = (error: Error): void => {
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            code === "EADDRINUSE"
              ? new BridgeError(
                  "daemon_port_in_use",
                  `Port ${String(this.#port)} is occupied; the bridge will not select another port.`,
                  { httpStatus: 409, details: { host: LOOPBACK_HOST, port: this.#port } },
                )
              : error,
          );
        };
        this.#server?.once("error", rejectBind);
        this.#server?.listen(this.#port, LOOPBACK_HOST, () => {
          this.#server?.off("error", rejectBind);
          resolve();
        });
      });
      const address = this.#server.address();
      if (address === null || typeof address === "string") {
        throw new BridgeError("daemon_bind_failed", "Daemon did not obtain a TCP address.", {
          httpStatus: 500,
        });
      }
      this.#boundPort = address.port;
      this.#startedAt = new Date().toISOString();
      await this.#scheduler.recoverAndStart();
      await this.#audit.append({
        at: new Date().toISOString(),
        event: "daemon_started",
        metadata: {
          pid: process.pid,
          port: address.port,
          version: BRIDGE_VERSION,
          build_id: BRIDGE_BUILD_ID,
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          config_schema: config.config.schemaVersion,
          config_hash: config.hash,
          v2_inline_reviews: this.#v2.isActive(),
          v2_workspace_repairs: this.#v2.workspaceRepairsAvailable(),
        },
      });
      await writeEndpoint(this.#paths.endpoint, {
        pid: process.pid,
        port: address.port,
        host: LOOPBACK_HOST,
        started_at: this.#startedAt,
        version: BRIDGE_VERSION,
        build_id: BRIDGE_BUILD_ID,
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        config_schema: config.config.schemaVersion,
        config_hash: config.hash,
        mcp_url: `http://${LOOPBACK_HOST}:${String(address.port)}${BRIDGE_MCP_PATH}`,
        supported_protocols: this.#v2.isActive()
          ? [...BRIDGE_SUPPORTED_PROTOCOL_VERSIONS]
          : [BRIDGE_LEGACY_PROTOCOL_VERSION],
        role_mcp_urls: {
          codex: `http://${LOOPBACK_HOST}:${String(address.port)}${BRIDGE_CODEX_MCP_PATH}`,
          claude: `http://${LOOPBACK_HOST}:${String(address.port)}${BRIDGE_CLAUDE_MCP_PATH}`,
        },
      });
      if (this.#probeV2Workspace) {
        void this.#v2.refreshWorkspaceCapabilities().then((capabilities) =>
          this.#audit.append({
            at: new Date().toISOString(),
            event: "v2_workspace_probe_completed",
            metadata: {
              workspace_repairs: capabilities.workspaceRepairs,
              workspace_probe_state: capabilities.workspaceProbeState,
              ...(capabilities.workspaceProbeReason === undefined
                ? {}
                : { workspace_probe_reason: capabilities.workspaceProbeReason }),
            },
          }).catch(() => undefined),
        );
      }
    } catch (error) {
      await this.#scheduler.stop().catch(() => undefined);
      await this.#closeServer();
      await this.#cleanupRuntimeFiles();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping ??= this.#stopOnce();
    return this.#stopping;
  }

  async #stopOnce(): Promise<void> {
    await this.#scheduler.stop();
    await this.#closeServer();
    await this.#audit
      .append({
        at: new Date().toISOString(),
        event: "daemon_stopped",
        metadata: { pid: process.pid },
      })
      .catch(() => undefined);
    await this.#cleanupRuntimeFiles();
  }

  async #closeServer(): Promise<void> {
    if (this.#server === undefined) {
      return;
    }
    const server = this.#server;
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }

  async #cleanupRuntimeFiles(): Promise<void> {
    await removeEndpoint(this.#paths.endpoint).catch(() => undefined);
    await this.#lock.release().catch(() => undefined);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(request.socket.remoteAddress)) {
        throw new BridgeError("non_loopback_rejected", "Only loopback requests are allowed.", {
          httpStatus: 403,
        });
      }
      if (request.headers.origin !== undefined) {
        throw new BridgeError(
          "browser_origin_rejected",
          "Requests carrying a browser Origin header are not allowed.",
          { httpStatus: 403 },
        );
      }
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      const method = request.method ?? "GET";
      const owner: V2Owner | undefined = url.pathname === BRIDGE_CODEX_MCP_PATH
        ? "codex"
        : url.pathname === BRIDGE_CLAUDE_MCP_PATH
          ? "claude"
          : undefined;
      authenticateRequest(request, owner === undefined ? this.#token : this.#ownerTokens[owner]);
      if (url.pathname === BRIDGE_MCP_PATH) {
        await this.#handleMcp(request, response, method);
        return;
      }
      if (owner !== undefined) {
        await this.#handleMcp(request, response, method, owner);
        return;
      }
      const config = await readBridgeConfig(this.#paths);

      if (method === "GET" && url.pathname === "/health") {
        sendData(response, {
          name: BRIDGE_NAME,
          version: BRIDGE_VERSION,
          build_id: BRIDGE_BUILD_ID,
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          supported_protocols: this.#v2.isActive()
            ? [...BRIDGE_SUPPORTED_PROTOCOL_VERSIONS]
            : [BRIDGE_LEGACY_PROTOCOL_VERSION],
          config_schema: config.config.schemaVersion,
          config_hash: config.hash,
          mcp_url: `http://${LOOPBACK_HOST}:${String(this.#boundPort)}${BRIDGE_MCP_PATH}`,
          role_mcp_urls: {
            codex: `http://${LOOPBACK_HOST}:${String(this.#boundPort)}${BRIDGE_CODEX_MCP_PATH}`,
            claude: `http://${LOOPBACK_HOST}:${String(this.#boundPort)}${BRIDGE_CLAUDE_MCP_PATH}`,
          },
          v2_capabilities: this.#v2.capabilities() ?? {
            v2WorkspaceTests: false,
            inlineReviews: false,
            workspaceRepairs: false,
            workspaceProbeState: "pending",
            workspaceProbeReason: "not_started",
          },
          pid: process.pid,
          host: LOOPBACK_HOST,
          started_at: this.#startedAt,
          uptime_ms: Math.max(0, Date.now() - Date.parse(this.#startedAt)),
          active_jobs: this.#scheduler.activeCount(),
          queued_jobs: this.#store.count("queued"),
          active_mcp_requests: this.#activeMcpRequests,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/status") {
        const states = Object.fromEntries(
          [
            "queued",
            "dispatching",
            "transport_delivered",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "expired",
            "needs_attention",
          ].map((state) => [state, this.#store.count(state as JobState)]),
        );
        sendData(response, {
          health: "ok",
          version: BRIDGE_VERSION,
          build_id: BRIDGE_BUILD_ID,
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          supported_protocols: this.#v2.isActive()
            ? [...BRIDGE_SUPPORTED_PROTOCOL_VERSIONS]
            : [BRIDGE_LEGACY_PROTOCOL_VERSION],
          config_schema: config.config.schemaVersion,
          config_hash: config.hash,
          active_jobs: this.#scheduler.activeCount(),
          active_mcp_requests: this.#activeMcpRequests,
          jobs: states,
          sessions: this.#sessions.list(),
          v2_capabilities: this.#v2.capabilities() ?? {
            v2WorkspaceTests: false,
            inlineReviews: false,
            workspaceRepairs: false,
            workspaceProbeState: "pending",
            workspaceProbeReason: "not_started",
          },
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/sessions") {
        sendData(response, { sessions: this.#sessions.list() });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/jobs") {
        const bridgeRequest = parseBridgeRequest(
          await readJsonBody(request),
          Date.now(),
          config.config,
        );
        if (bridgeRequest.route === "live") {
          throw new BridgeError("live_unavailable", "Live peer routing is unavailable.", {
            httpStatus: 503,
          });
        }
        const submitted = await this.#scheduler.submit(bridgeRequest);
        sendData(
          response,
          {
            job_id: submitted.record.job_id,
            state: submitted.record.state,
            created: submitted.created,
          },
          submitted.created ? 202 : 200,
        );
        return;
      }

      const retryMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/retry$/iu.exec(url.pathname);
      if (method === "POST" && retryMatch?.[1] !== undefined) {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new BridgeError("invalid_retry_route", "Retry route must be an object.", {
            httpStatus: 400,
          });
        }
        const route = body as Record<string, unknown>;
        const model = ModelIdSchema.safeParse(route.model);
        const profile = TaskProfileSchema.safeParse(route.task_profile);
        if ((model.success ? 1 : 0) + (profile.success ? 1 : 0) !== 1) {
          throw new BridgeError(
            "invalid_retry_route",
            "Retry requires exactly one allowlisted model or supported task_profile.",
            { httpStatus: 400 },
          );
        }
        if (Object.keys(route).some((key) => key !== "model" && key !== "task_profile")) {
          throw new BridgeError("invalid_retry_route", "Retry route contains unsupported fields.", {
            httpStatus: 400,
          });
        }
        const previous = this.#store.require(retryMatch[1]);
        if (!isTerminalState(previous.state)) {
          throw new BridgeError("job_not_terminal", "Only terminal jobs can be retried.", {
            httpStatus: 409,
          });
        }
        const {
          origin: _origin,
          target: _target,
          request_id: _requestId,
          idempotency_key: _idempotencyKey,
          created_at: _createdAt,
          deadline: _deadline,
          model: _model,
          reasoning_effort: _reasoningEffort,
          task_profile: _taskProfile,
          routing_source: _routingSource,
          routing_rule_id: _routingRuleId,
          config_schema: _configSchema,
          config_hash: _configHash,
          ...input
        } = previous.request;
        const retryRequest = createBridgeRequest(
          {
            ...input,
            ...(model.success ? { model: model.data } : { task_profile: profile.data }),
          },
          { origin: "retry", target: previous.request.target, configuration: config.config },
        );
        const submitted = await this.#scheduler.submit(retryRequest);
        sendData(response, {
          job_id: submitted.record.job_id,
          state: submitted.record.state,
          created: submitted.created,
          retried_from: previous.job_id,
        }, submitted.created ? 202 : 200);
        return;
      }

      const jobMatch = /^\/v1\/jobs\/([0-9a-f-]+)$/iu.exec(url.pathname);
      if (method === "GET" && jobMatch?.[1] !== undefined) {
        sendData(response, publicJobStatus(this.#store.require(jobMatch[1])));
        return;
      }
      const waitMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/wait$/iu.exec(url.pathname);
      if (method === "GET" && waitMatch?.[1] !== undefined) {
        const record = await this.#store.wait(
          waitMatch[1],
          parseTimeout(url.searchParams.get("timeout_ms")),
        );
        sendData(
          response,
          isTerminalState(record.state)
            ? { status: "complete", job: publicJobResult(record) }
            : { status: "pending", job_id: record.job_id, state: record.state },
        );
        return;
      }
      const resultMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/result$/iu.exec(url.pathname);
      if (method === "GET" && resultMatch?.[1] !== undefined) {
        const record = this.#store.require(resultMatch[1]);
        sendData(
          response,
          isTerminalState(record.state)
            ? publicJobResult(record)
            : { status: "pending", job_id: record.job_id, state: record.state },
        );
        return;
      }
      const cancelMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/cancel$/iu.exec(url.pathname);
      if (method === "POST" && cancelMatch?.[1] !== undefined) {
        await readJsonBody(request);
        sendData(response, await this.#scheduler.cancel(cancelMatch[1]));
        return;
      }
      const approveSyncMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/approve-sync$/iu.exec(url.pathname);
      if (method === "POST" && approveSyncMatch?.[1] !== undefined) {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new BridgeError("invalid_sync_approval", "Sync approval body must be an object.", {
            httpStatus: 400,
          });
        }
        const approvedChangeIds = (body as Record<string, unknown>)["approved_change_ids"];
        if (
          !Array.isArray(approvedChangeIds) ||
          approvedChangeIds.length === 0 ||
          approvedChangeIds.length > 512 ||
          !approvedChangeIds.every(
            (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
          )
        ) {
          throw new BridgeError(
            "invalid_sync_approval",
            "approved_change_ids must contain one to 512 SHA-256 change IDs.",
            { httpStatus: 400 },
          );
        }
        sendData(response, await this.#scheduler.approveSync(approveSyncMatch[1], approvedChangeIds));
        return;
      }
      const discardSyncMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/discard-sync$/iu.exec(url.pathname);
      if (method === "POST" && discardSyncMatch?.[1] !== undefined) {
        await readJsonBody(request);
        sendData(response, await this.#scheduler.discardSync(discardSyncMatch[1]));
        return;
      }
      if (method === "POST" && url.pathname === "/shutdown") {
        await readJsonBody(request);
        sendData(response, { stopping: true });
        setImmediate(() => {
          void this.stop();
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/token/rotate") {
        await readJsonBody(request);
        await this.#scheduler.expireLegacySyncLeases();
        const blockingJobs = this.#store.list().filter((record) =>
          ["queued", "dispatching", "transport_delivered", "running"].includes(record.state)
          || (record.state === "needs_attention" && record.sync_status === "awaiting_user"),
        );
        if (blockingJobs.length > 0) {
          throw new BridgeError(
            "token_rotation_blocked",
            "Bridge token rotation is blocked while jobs are active, queued, or awaiting synchronization.",
            {
              httpStatus: 409,
              details: { blocking_jobs: blockingJobs.length },
            },
          );
        }
        this.#token = await rotatePersistentToken(
          this.#paths.token,
          this.#tokenEnvironmentWriter,
        );
        await this.#audit.append({
          at: new Date().toISOString(),
          event: "token_rotated",
          metadata: { pid: process.pid },
        });
        sendData(response, {
          rotated: true,
          restart_required: true,
          restart_targets: ["Claude", "Codex"],
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/config") {
        sendData(response, publicBridgeConfig(config));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/config") {
        const blockingJobs = this.#store.list().filter((record) =>
          ["queued", "dispatching", "transport_delivered", "running"].includes(record.state),
        );
        if (blockingJobs.length > 0) {
          throw new BridgeError(
            "config_change_blocked",
            "Bridge routing cannot change while jobs are active or queued.",
            { httpStatus: 409, details: { blocking_jobs: blockingJobs.length } },
          );
        }
        const parsed = ConfigMutationSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          throw new BridgeError("invalid_config_mutation", "Bridge config mutation is invalid.", {
            httpStatus: 400,
            details: { issues: parsed.error.issues.map((issue) => issue.message) },
          });
        }
        sendData(response, publicBridgeConfig(await mutateBridgeConfig(this.#paths, parsed.data)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/cleanup") {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new BridgeError("invalid_cleanup_request", "Cleanup request must be an object.", {
            httpStatus: 400,
          });
        }
        const options = body as Record<string, unknown>;
        if (
          Object.keys(options).some((key) =>
            !["job_id", "older_than_ms", "include_jobs", "execute"].includes(key),
          )
          || (options.job_id !== undefined && (typeof options.job_id !== "string" || !/^[0-9a-f-]+$/iu.test(options.job_id)))
          || (options.older_than_ms !== undefined && (!Number.isInteger(options.older_than_ms) || Number(options.older_than_ms) < 0))
          || (options.include_jobs !== undefined && typeof options.include_jobs !== "boolean")
          || (options.execute !== undefined && typeof options.execute !== "boolean")
        ) {
          throw new BridgeError("invalid_cleanup_request", "Cleanup request fields are invalid.", {
            httpStatus: 400,
          });
        }
        sendData(response, await cleanupRuntime(this.#paths, this.#store, this.#audit, {
          ...(typeof options.job_id === "string" ? { jobId: options.job_id } : {}),
          ...(typeof options.older_than_ms === "number" ? { olderThanMs: options.older_than_ms } : {}),
          ...(typeof options.include_jobs === "boolean" ? { includeJobs: options.include_jobs } : {}),
          ...(typeof options.execute === "boolean" ? { execute: options.execute } : {}),
        }));
        return;
      }
      throw new BridgeError("not_found", "Bridge endpoint was not found.", { httpStatus: 404 });
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.end();
      }
    }
  }

  async #handleMcp(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    owner?: V2Owner,
  ): Promise<void> {
    if (method !== "POST") {
      sendJson(response, 405, {
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Method not allowed." },
        id: null,
      });
      return;
    }
    const body = await readJsonBody(request);
    this.#activeMcpRequests += 1;
    const server = owner === undefined
      ? createBridgeMcpServer(this.#paths)
      : createV2BridgeMcpServer({ paths: this.#paths, owner, service: this.#v2 });
    const transport = new StreamableHTTPServerTransport({
      // In SDK 1.30.0, omitting sessionIdGenerator selects stateless mode.
      enableJsonResponse: true,
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= Promise.allSettled([transport.close(), server.close()]).then(() => {
        this.#activeMcpRequests = Math.max(0, this.#activeMcpRequests - 1);
      });
      return cleanupPromise;
    };
    response.once("close", () => {
      void cleanup();
    });
    response.once("finish", () => {
      void cleanup();
    });
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      await cleanup();
      throw error;
    }
    if (response.writableFinished) {
      await cleanup();
    }
  }
}
