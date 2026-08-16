import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BRIDGE_BUILD_ID, BRIDGE_NAME, BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION, LIMITS } from "../constants.js";
import { getDaemonPaths, readBridgeConfig, type DaemonPaths } from "../config.js";
import { toStructuredError } from "../errors.js";
import { ModelIdSchema, ReasoningEffortSchema, TaskProfileSchema } from "../model-routing.js";
import { assertOutsideBridgeChild } from "../request.js";
import { V2AdjudicationInputSchema, V2ArtifactModeSchema, V2TestCommandSchema, type V2Owner } from "./types.js";
import { V2ReviewService } from "./service.js";
import type { V2JobRecord } from "./series.js";

type ToolPayload = Record<string, unknown>;

const ReviewFields = {
  question: z.string().min(1).max(900_000),
  artifactId: z.string().min(1).max(256),
  artifactType: z.enum(["plan", "deliverable"]),
  artifactName: z.string().min(1).max(512),
  artifactPath: z.string().min(1).max(4_096).optional(),
  artifactContent: z.string().min(1).max(900_000),
  artifactBytes: z.number().int().nonnegative(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  acceptanceCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
  constraints: z.array(z.string().min(1).max(8_192)).max(128).default([]),
  taskProfile: TaskProfileSchema.optional(),
  model: ModelIdSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  seriesId: z.string().min(1).max(256).optional(),
  seriesVersion: z.number().int().nonnegative().optional(),
  latestJobId: z.uuid().optional(),
} as const;

const ReviewPeerSchema = z.object(ReviewFields).strict();
const ReviewRepairPeerSchema = z.object({
  ...ReviewFields,
  artifactMode: V2ArtifactModeSchema,
  targetRoot: z.string().min(1).max(4_096).optional(),
  repairTargets: z.array(z.object({
    path: z.string().min(1).max(4_096),
    action: z.enum(["modify", "create"]),
  }).strict()).min(1).max(128).optional(),
  testCommands: z.array(V2TestCommandSchema).max(16).optional(),
}).strict();

const AwaitSchema = z.object({
  job_id: z.uuid(),
  timeout_ms: z.number().int().min(0).max(LIMITS.awaitMs),
}).strict();

const JobIdSchema = z.object({ job_id: z.uuid() }).strict();

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

function isTerminal(state: V2JobRecord["state"]): boolean {
  return ["succeeded", "failed", "awaiting_evidence", "awaiting_user_decision"].includes(state);
}

function publicJob(record: V2JobRecord): ToolPayload {
  return {
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    job_id: record.jobId,
    series_id: record.request.seriesId,
    series_version: record.seriesVersion,
    round: record.round,
    attempt: record.attempt,
    state: record.state,
    owner: record.request.owner,
    target: record.request.target,
    operation: record.request.operation,
    artifact_mode: record.request.artifactMode,
    artifact_id: record.request.artifactId,
    artifact_type: record.request.artifactType,
    requested_model: record.request.model,
    requested_reasoning_effort: record.request.reasoningEffort,
    task_profile: record.request.taskProfile,
    routing_source: record.request.routingSource,
    routing_rule_id: record.request.routingRuleId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...(record.adapterEvidence === undefined ? {} : { adapter_evidence: record.adapterEvidence }),
    ...(record.gate === undefined ? {} : { gate: record.gate }),
    ...(record.modelResponse === undefined ? {} : { model_response: record.modelResponse }),
    ...(record.renderedReview === undefined ? {} : { result: record.renderedReview }),
    ...(record.findings === undefined ? {} : { findings: record.findings }),
    ...(record.testResults === undefined ? {} : { test_results: record.testResults }),
    ...(record.repairedArtifact === undefined ? {} : { repaired_artifact: record.repairedArtifact }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.workspace === undefined ? {} : { workspace_retained_until: record.workspace.retainedUntil }),
    ...(record.adjudication === undefined ? {} : { adjudication: record.adjudication }),
  };
}

export interface V2McpServerOptions {
  owner: V2Owner;
  service: V2ReviewService;
  paths?: DaemonPaths;
}

export function createV2BridgeMcpServer(options: V2McpServerOptions): McpServer {
  const paths = options.paths ?? getDaemonPaths();
  const { owner, service } = options;
  const server = new McpServer({ name: `${BRIDGE_NAME}-${owner}`, version: BRIDGE_VERSION });

  server.registerTool(
    "review_peer",
    {
      description: "Submit an inline, zero-tool protocol-v2 review. The endpoint authenticates the author role and derives the opposite reviewer.",
      inputSchema: ReviewPeerSchema,
    },
    async (input) => execute(async () => {
      const { config } = await readBridgeConfig(paths);
      const submitted = await service.submit(owner, {
        ...input,
        operation: "review_only",
        artifactMode: "inline",
      }, config);
      return { status: "submitted", job_id: submitted.jobId, state: submitted.state, series_version: submitted.seriesVersion };
    }),
  );

  server.registerTool(
    "review_repair_peer",
    {
      description: "Submit a protocol-v2 repair review. Inline repairs return a complete artifact; workspace repairs are constrained to fixed repair targets.",
      inputSchema: ReviewRepairPeerSchema,
    },
    async (input) => execute(async () => {
      const { config } = await readBridgeConfig(paths);
      const submitted = await service.submit(owner, {
        ...input,
        operation: "review_repair",
      }, config);
      return { status: "submitted", job_id: submitted.jobId, state: submitted.state, series_version: submitted.seriesVersion };
    }),
  );

  server.registerTool(
    "await_peer",
    { description: "Wait up to 45 seconds for a protocol-v2 peer job.", inputSchema: AwaitSchema },
    async ({ job_id, timeout_ms }) => execute(async () => {
      const record = await service.wait(job_id, timeout_ms);
      return isTerminal(record.state)
        ? { status: "complete", job: publicJob(record) }
        : { status: "pending", job_id: record.jobId, state: record.state };
    }),
  );

  server.registerTool(
    "peer_result",
    { description: "Return the protocol-v2 result or its pending state.", inputSchema: JobIdSchema },
    async ({ job_id }) => execute(async () => {
      const record = service.get(job_id);
      return isTerminal(record.state)
        ? publicJob(record)
        : { status: "pending", job_id: record.jobId, state: record.state };
    }),
  );

  server.registerTool(
    "peer_status",
    { description: "Return protocol-v2 capabilities or metadata for one v2 job.", inputSchema: z.object({ job_id: z.uuid().optional() }).strict() },
    async ({ job_id }) => execute(async () => job_id === undefined
      ? {
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          version: BRIDGE_VERSION,
          build_id: BRIDGE_BUILD_ID,
          owner,
          capabilities: service.capabilities() ?? { v2WorkspaceTests: false },
          active: service.isActive(),
        }
      : publicJob(service.get(job_id))),
  );

  server.registerTool(
    "adjudicate_peer_series",
    {
      description: "Record the user's complete decision for a v2 series that has exhausted its accepted rounds or attempts.",
      inputSchema: V2AdjudicationInputSchema.extend({ job_id: z.uuid() }).strict(),
    },
    async ({ job_id, ...decision }) => execute(async () => publicJob(await service.adjudicate(job_id, decision))),
  );

  return server;
}
