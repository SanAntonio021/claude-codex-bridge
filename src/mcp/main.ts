#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import {
  approvePeerSync,
  cancelJob,
  discardPeerSync,
  getBridgeStatus,
  getJobResult,
  getJobStatus,
  listSessions,
  submitJob,
  waitJob,
} from "../api.js";
import { BRIDGE_NAME, BRIDGE_VERSION, LIMITS } from "../constants.js";
import { getDaemonPaths, readBridgeConfig, type DaemonPaths } from "../config.js";
import { ensureDaemon } from "../daemon/ensure.js";
import { BridgeError, toStructuredError } from "../errors.js";
import {
  ModelIdSchema,
  ReasoningEffortSchema,
  RoutingSourceSchema,
  TaskProfileSchema,
  validateResolvedModelRoute,
  type ResolvedModelRoute,
  type RoutingConfiguration,
} from "../model-routing.js";
import { assertOutsideBridgeChild, createBridgeRequest } from "../request.js";
import { TestCommandsSchema } from "../types.js";

const CommonSubmitShape = {
  question: z.string().min(1),
  context: z.string().optional(),
  route: z.enum(["auto", "headless", "live"]).optional(),
  taskProfile: TaskProfileSchema.optional(),
  model: ModelIdSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  operation: z.enum(["ask", "task", "review_repair"]).optional(),
  reviewerAccess: z.enum(["read_only", "isolated_write"]).optional(),
  target_session_id: z.string().min(1).max(256).optional(),
  bridge_thread_id: z.string().min(1).max(256).optional(),
  artifactId: z.string().min(1).max(256).optional(),
  artifactType: z.enum(["plan", "deliverable"]).optional(),
  author: z.enum(["Codex", "Claude"]).optional(),
  reviewer: z.string().min(1).max(128).optional(),
  artifactName: z.string().min(1).max(512).optional(),
  artifactPath: z.string().min(1).max(4_096).optional(),
  artifactBytes: z.number().int().nonnegative().optional(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  artifactContent: z.string().min(1).max(900_000).optional(),
  targetRoot: z.string().min(1).max(4_096).optional(),
  allowedPaths: z.array(z.string().min(1).max(4_096)).max(512).optional(),
  round: z.number().int().min(1).max(3).optional(),
  maxRounds: z.literal(3).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(4_096)).max(128).optional(),
  testCommands: TestCommandsSchema.optional(),
  constraints: z.array(z.string().min(1).max(8_192)).max(128).optional(),
  priorRounds: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
  priorFindings: z.array(z.string().max(8_192)).max(256).optional(),
  openItems: z.array(z.string().max(8_192)).max(256).optional(),
} as const;

const SubmitSchema = z.object(CommonSubmitShape);
const PeerSubmitSchema = z.object({
  target: z.enum(["claude", "codex"]),
  ...CommonSubmitShape,
});
const ReviewRepairPeerSchema = z.object({
  target: z.enum(["claude", "codex"]),
  question: CommonSubmitShape.question,
  context: CommonSubmitShape.context,
  route: z.enum(["auto", "headless"]).optional(),
  taskProfile: CommonSubmitShape.taskProfile,
  model: CommonSubmitShape.model,
  reasoningEffort: CommonSubmitShape.reasoningEffort,
  target_session_id: CommonSubmitShape.target_session_id,
  bridge_thread_id: CommonSubmitShape.bridge_thread_id,
  artifactId: z.string().min(1).max(256),
  artifactType: z.enum(["plan", "deliverable"]),
  author: CommonSubmitShape.author,
  reviewer: CommonSubmitShape.reviewer,
  artifactName: z.string().min(1).max(512),
  artifactPath: CommonSubmitShape.artifactPath,
  artifactBytes: z.number().int().nonnegative(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  artifactContent: z.string().min(1).max(900_000),
  targetRoot: z.string().min(1).max(4_096),
  allowedPaths: z.array(z.string().min(1).max(4_096)).min(1).max(512),
  round: z.number().int().min(1).max(3),
  acceptanceCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
  testCommands: TestCommandsSchema,
  constraints: CommonSubmitShape.constraints,
  priorRounds: CommonSubmitShape.priorRounds,
  priorFindings: CommonSubmitShape.priorFindings,
  openItems: CommonSubmitShape.openItems,
}).strict();
const ResumeSchema = z.object({
  job_id: z.uuid(),
  target: z.enum(["claude", "codex"]).optional(),
  ...CommonSubmitShape,
});

type ToolPayload = Record<string, unknown>;

function toolResult(payload: ToolPayload, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

async function execute(action: () => Promise<ToolPayload>) {
  try {
    assertOutsideBridgeChild();
    return toolResult(await action());
  } catch (error) {
    return toolResult({ structured_error: toStructuredError(error) }, true);
  }
}

function submitInput(input: z.infer<typeof SubmitSchema>): Record<string, unknown> {
  return {
    question: input.question,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.taskProfile === undefined ? {} : { task_profile: input.taskProfile }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: input.reasoningEffort }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.reviewerAccess === undefined
      ? {}
      : { reviewer_access: input.reviewerAccess }),
    ...(input.target_session_id === undefined
      ? {}
      : { target_session_id: input.target_session_id }),
    ...(input.bridge_thread_id === undefined
      ? {}
      : { bridge_thread_id: input.bridge_thread_id }),
    ...(input.artifactId === undefined ? {} : { artifact_id: input.artifactId }),
    ...(input.artifactType === undefined ? {} : { artifact_type: input.artifactType }),
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    ...(input.artifactName === undefined ? {} : { artifact_name: input.artifactName }),
    ...(input.artifactPath === undefined ? {} : { artifact_path: input.artifactPath }),
    ...(input.artifactBytes === undefined ? {} : { artifact_bytes: input.artifactBytes }),
    ...(input.artifactSha256 === undefined ? {} : { artifact_sha256: input.artifactSha256 }),
    ...(input.artifactContent === undefined ? {} : { artifact_content: input.artifactContent }),
    ...(input.targetRoot === undefined ? {} : { target_root: input.targetRoot }),
    ...(input.allowedPaths === undefined ? {} : { allowed_paths: input.allowedPaths }),
    ...(input.round === undefined ? {} : { round: input.round }),
    ...(input.maxRounds === undefined ? {} : { max_rounds: input.maxRounds }),
    ...(input.acceptanceCriteria === undefined
      ? {}
      : { acceptance_criteria: input.acceptanceCriteria }),
    ...(input.testCommands === undefined ? {} : { test_commands: input.testCommands }),
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    ...(input.priorRounds === undefined ? {} : { prior_rounds: input.priorRounds }),
    ...(input.priorFindings === undefined ? {} : { prior_findings: input.priorFindings }),
    ...(input.openItems === undefined ? {} : { open_items: input.openItems }),
  };
}

async function createMcpRequest(
  paths: DaemonPaths,
  input: unknown,
  options: {
    origin: string;
    target: "claude" | "codex";
    resolvedRoute?: ResolvedModelRoute;
  },
) {
  const { config } = await readBridgeConfig(paths);
  return createBridgeRequest(input, { ...options, configuration: config });
}

const REVIEW_REPAIR_REQUIRED_FIELDS = [
  "artifactId",
  "artifactType",
  "artifactName",
  "artifactContent",
  "artifactBytes",
  "artifactSha256",
  "targetRoot",
  "allowedPaths",
  "round",
  "acceptanceCriteria",
  "testCommands",
] as const;

export function missingLegacyReviewRepairFields(
  input: z.infer<typeof PeerSubmitSchema>,
): string[] {
  return REVIEW_REPAIR_REQUIRED_FIELDS.filter((field) => {
    const value = input[field];
    return value === undefined || (Array.isArray(value) && value.length === 0 && field !== "testCommands");
  });
}

export function preservedResumeRoute(
  previous: {
    target: "claude" | "codex";
    requested_model?: string;
    requested_reasoning_effort?: string;
    task_profile?: string;
    routing_source?: string;
    routing_rule_id?: string;
  },
  input: z.infer<typeof ResumeSchema>,
  configuration?: RoutingConfiguration,
): ResolvedModelRoute {
  const model = ModelIdSchema.safeParse(previous.requested_model);
  const effort = ReasoningEffortSchema.safeParse(previous.requested_reasoning_effort);
  const profile = TaskProfileSchema.safeParse(previous.task_profile);
  const source = RoutingSourceSchema.safeParse(previous.routing_source);
  if (
    !model.success
    || !effort.success
    || !profile.success
    || !source.success
    || previous.routing_rule_id === undefined
  ) {
    throw new BridgeError(
      "session_model_not_recorded",
      "The prior job does not contain a complete model route and cannot be resumed without guessing.",
      { httpStatus: 409 },
    );
  }
  if (input.model !== undefined && input.model !== model.data) {
    throw new BridgeError("resume_model_mismatch", "resume_peer cannot change the recorded model.", {
      httpStatus: 409,
    });
  }
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== effort.data) {
    throw new BridgeError(
      "resume_effort_mismatch",
      "resume_peer cannot change the recorded reasoning effort.",
      { httpStatus: 409 },
    );
  }
  if (input.taskProfile !== undefined && input.taskProfile !== profile.data) {
    throw new BridgeError(
      "resume_profile_mismatch",
      "resume_peer cannot change the recorded task profile.",
      { httpStatus: 409 },
    );
  }
  const route: ResolvedModelRoute = {
    target: previous.target,
    model: model.data,
    reasoningEffort: effort.data,
    taskProfile: profile.data,
    selectionSource: source.data,
    ruleId: previous.routing_rule_id,
  };
  if (configuration !== undefined) {
    validateResolvedModelRoute(route, configuration);
  }
  return route;
}

export function createBridgeMcpServer(paths: DaemonPaths = getDaemonPaths()): McpServer {
  const server = new McpServer({ name: BRIDGE_NAME, version: BRIDGE_VERSION });

  server.registerTool(
    "submit_peer",
    {
      description: "Submit an ask, task, or isolated review-and-repair job to Claude or Codex.",
      inputSchema: PeerSubmitSchema,
    },
    async (input) =>
      execute(async () => {
        if (input.route === "live") {
          throw new BridgeError("live_unavailable", "Live peer routing is unavailable.");
        }
        const legacyInput = submitInput(input);
        if (input.operation === "review_repair") {
          const missingFields = missingLegacyReviewRepairFields(input);
          if (missingFields.length > 0) {
            throw new BridgeError(
              "missing_fields",
              "Legacy submit_peer review_repair input is incomplete.",
              { httpStatus: 400, details: { missing_fields: missingFields } },
            );
          }
          legacyInput["reviewer_access"] = input.reviewerAccess ?? "isolated_write";
          legacyInput["max_rounds"] = 3;
        }
        const request = await createMcpRequest(paths, legacyInput, {
          origin: "mcp",
          target: input.target,
        });
        return { status: "submitted", ...(await submitJob(request, paths)) };
      }),
  );

  server.registerTool(
    "review_repair_peer",
    {
      description:
        "Submit a complete isolated review-and-repair envelope with fixed operation, access, and three-round limit.",
      inputSchema: ReviewRepairPeerSchema,
    },
    async (input) =>
      execute(async () => {
        const request = await createMcpRequest(
          paths,
          {
            ...submitInput(input),
            operation: "review_repair",
            reviewer_access: "isolated_write",
            max_rounds: 3,
          },
          { origin: "mcp", target: input.target },
        );
        return { status: "submitted", ...(await submitJob(request, paths)) };
      }),
  );

  server.registerTool(
    "await_peer",
    {
      description: "Wait up to 45 seconds for a peer bridge job.",
      inputSchema: z.object({
        job_id: z.uuid(),
        timeout_ms: z.number().int().min(0).max(LIMITS.awaitMs),
      }),
    },
    async ({ job_id, timeout_ms }) =>
      execute(async () => (await waitJob(job_id, timeout_ms, paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "peer_result",
    {
      description: "Return a peer result or its current pending state.",
      inputSchema: z.object({ job_id: z.uuid() }),
    },
    async ({ job_id }) => execute(async () => (await getJobResult(job_id, paths)) as ToolPayload),
  );

  server.registerTool(
    "peer_status",
    {
      description: "Return bridge health or metadata-only status for one peer job.",
      inputSchema: z.object({ job_id: z.uuid().optional() }),
    },
    async ({ job_id }) =>
      execute(async () =>
        (job_id === undefined ? await getBridgeStatus(paths) : await getJobStatus(job_id, paths)) as ToolPayload,
      ),
  );

  server.registerTool(
    "cancel_peer",
    {
      description: "Cancel one recorded peer job.",
      inputSchema: z.object({ job_id: z.uuid() }),
    },
    async ({ job_id }) => execute(async () => (await cancelJob(job_id, paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "approve_peer_sync",
    {
      description:
        "After explicit user approval, synchronize the exact high-risk change IDs listed by a needs_attention job without invoking either model again.",
      inputSchema: z.object({
        job_id: z.uuid(),
        approved_change_ids: z
          .array(z.string().regex(/^[0-9a-f]{64}$/u))
          .min(1)
          .max(512),
      }),
    },
    async ({ job_id, approved_change_ids }) =>
      execute(async () =>
        (await approvePeerSync(job_id, approved_change_ids, paths)) as unknown as ToolPayload,
      ),
  );

  server.registerTool(
    "discard_peer_sync",
    {
      description:
        "Explicitly discard one retained legacy high-risk peer synchronization without applying its reviewer changes.",
      inputSchema: z.object({ job_id: z.uuid() }),
    },
    async ({ job_id }) =>
      execute(async () => (await discardPeerSync(job_id, paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "resume_peer",
    {
      description: "Continue the exact peer thread recorded by a prior job; never guesses the latest thread.",
      inputSchema: ResumeSchema,
    },
    async (input) =>
      execute(async () => {
        const previous = await getJobResult(input.job_id, paths);
        if ("status" in previous) {
          throw new BridgeError("job_not_terminal", "Only a terminal peer job can be resumed.", {
            httpStatus: 409,
          });
        }
        if (previous.session_id === undefined || previous.bridge_thread_id === undefined) {
          throw new BridgeError("session_not_recorded", "The selected job has no recorded resumable thread.", {
            httpStatus: 409,
          });
        }
        if (input.target !== undefined && input.target !== previous.target) {
          throw new BridgeError("target_mismatch", "resume_peer target does not match the recorded job.", {
            httpStatus: 409,
          });
        }
        const { config } = await readBridgeConfig(paths);
        const resolvedRoute = preservedResumeRoute(previous, input, config);
        const request = await createMcpRequest(
          paths,
          {
            ...submitInput(input),
            target_session_id: previous.session_id,
            bridge_thread_id: previous.bridge_thread_id,
          },
          { origin: "mcp", target: previous.target, resolvedRoute },
        );
        return { status: "submitted", resumed_from: input.job_id, ...(await submitJob(request, paths)) };
      }),
  );

  server.registerTool(
    "list_peer_sessions",
    {
      description: "List only persisted bridge-owned peer session mappings.",
      inputSchema: z.object({}),
    },
    async () => execute(async () => (await listSessions(paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "submit_claude",
    {
      description: "Submit an isolated headless Claude question and return a bridge job ID.",
      inputSchema: SubmitSchema,
    },
    async (input) =>
      execute(async () => {
        if (input.route === "live") {
          throw new BridgeError("live_unavailable", "Live Claude routing is unavailable in M1.");
        }
        const request = await createMcpRequest(paths, submitInput(input), {
          origin: "mcp",
          target: "claude",
        });
        return { status: "submitted", ...(await submitJob(request, paths)) };
      }),
  );

  server.registerTool(
    "await_claude",
    {
      description: "Wait up to 45 seconds for a Claude bridge job.",
      inputSchema: z.object({
        job_id: z.uuid(),
        timeout_ms: z.number().int().min(0).max(LIMITS.awaitMs),
      }),
    },
    async ({ job_id, timeout_ms }) =>
      execute(async () => (await waitJob(job_id, timeout_ms, paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "claude_result",
    {
      description: "Return the result or current pending state for a Claude bridge job.",
      inputSchema: z.object({ job_id: z.uuid() }),
    },
    async ({ job_id }) => execute(async () => (await getJobResult(job_id, paths)) as ToolPayload),
  );

  server.registerTool(
    "bridge_status",
    {
      description: "Return bridge health or metadata-only status for one job.",
      inputSchema: z.object({ job_id: z.uuid().optional() }),
    },
    async ({ job_id }) =>
      execute(async () =>
        (job_id === undefined ? await getBridgeStatus(paths) : await getJobStatus(job_id, paths)) as ToolPayload,
      ),
  );

  server.registerTool(
    "cancel_bridge_job",
    {
      description: "Request cancellation and report whether the target process confirmed it.",
      inputSchema: z.object({ job_id: z.uuid() }),
    },
    async ({ job_id }) => execute(async () => (await cancelJob(job_id, paths)) as unknown as ToolPayload),
  );

  server.registerTool(
    "ask_claude",
    {
      description: "Submit a Claude question and wait up to 45 seconds; returns pending with job ID on timeout.",
      inputSchema: SubmitSchema,
    },
    async (input) =>
      execute(async () => {
        if (input.route === "live") {
          throw new BridgeError("live_unavailable", "Live Claude routing is unavailable in M1.");
        }
        const request = await createMcpRequest(paths, submitInput(input), {
          origin: "mcp",
          target: "claude",
        });
        const submitted = await submitJob(request, paths);
        const waited = await waitJob(submitted.job_id, LIMITS.awaitMs, paths);
        return waited.status === "pending"
          ? { status: "pending", job_id: submitted.job_id }
          : ({ status: "complete", job_id: submitted.job_id, job: waited.job } as ToolPayload);
      }),
  );

  return server;
}

export async function runStdioMcp(paths: DaemonPaths = getDaemonPaths()): Promise<void> {
  await ensureDaemon(paths);
  const server = createBridgeMcpServer(paths);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: LIMITS.requestBytes,
  });
  await server.connect(transport);
  await new Promise<void>((resolveClosed) => {
    let closing = false;
    const close = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      void server.close().finally(resolveClosed);
    };
    process.stdin.once("end", close);
    process.stdin.once("close", close);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      close();
    }
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  runStdioMcp().catch((error: unknown) => {
    process.stderr.write(`mcp_start_failed: ${toStructuredError(error).message}\n`);
    process.exitCode = 1;
  });
}
