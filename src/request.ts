import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LIMITS } from "./constants.js";
import { BridgeError } from "./errors.js";
import {
  ModelIdSchema,
  ReasoningEffortSchema,
  TaskProfileSchema,
  resolveModelRoute,
  reviewerLabel,
  validateResolvedModelRoute,
  type ResolvedModelRoute,
  type RoutingConfiguration,
} from "./model-routing.js";
import {
  ArtifactAuthorSchema,
  ArtifactReviewerSchema,
  ArtifactTypeSchema,
  OperationSchema,
  ReviewerAccessSchema,
  TestCommandsSchema,
  normalizeRequestAliases,
  parseBridgeRequest,
  RouteSchema,
  type BridgeRequest,
} from "./types.js";

export const RequestInputSchema = z
  .object({
    question: z.string().min(1),
    context: z.string().optional(),
    route: RouteSchema.optional(),
    task_profile: TaskProfileSchema.optional(),
    model: ModelIdSchema.optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
    operation: OperationSchema.optional(),
    reviewer_access: ReviewerAccessSchema.optional(),
    target_session_id: z.string().min(1).max(256).optional(),
    bridge_thread_id: z.string().min(1).max(256).optional(),
    allow_fresh_fallback: z.boolean().optional(),
    artifact_id: z.string().min(1).max(256).optional(),
    artifact_type: ArtifactTypeSchema.optional(),
    author: ArtifactAuthorSchema.optional(),
    reviewer: ArtifactReviewerSchema.optional(),
    artifact_name: z.string().min(1).max(512).optional(),
    artifact_path: z.string().min(1).max(4_096).optional(),
    artifact_bytes: z.number().int().nonnegative().optional(),
    artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    artifact_content: z.string().min(1).max(900_000).optional(),
    target_root: z.string().min(1).max(4_096).optional(),
    allowed_paths: z.array(z.string().min(1).max(4_096)).max(512).optional(),
    round: z.number().int().min(1).max(3).optional(),
    max_rounds: z.literal(3).optional(),
    acceptance_criteria: z.array(z.string().min(1).max(4_096)).max(128).optional(),
    test_commands: TestCommandsSchema.optional(),
    constraints: z.array(z.string().min(1).max(8_192)).max(128).optional(),
    prior_rounds: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
    prior_findings: z.array(z.string().max(8_192)).max(256).optional(),
    open_items: z.array(z.string().max(8_192)).max(256).optional(),
    request_id: z.uuid().optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
    hop_count: z.number().int().min(0).max(2).optional(),
    ancestor_request_ids: z.array(z.uuid()).max(16).optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type RequestInput = z.infer<typeof RequestInputSchema>;

export function createBridgeRequest(
  value: unknown,
  options: {
    origin: string;
    target?: "claude" | "codex";
    hopCount?: number;
    resolvedRoute?: ResolvedModelRoute;
    configuration?: RoutingConfiguration;
  },
): BridgeRequest {
  const parsed = RequestInputSchema.safeParse(normalizeRequestAliases(value));
  if (!parsed.success) {
    throw new BridgeError("invalid_request_file", "Request file or MCP input is invalid.", {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const input = parsed.data;
  const now = Date.now();
  const createdAt = input.created_at ?? new Date(now).toISOString();
  const operation = input.operation ?? "ask";
  const reviewerAccess = input.reviewer_access ?? (
    operation === "review_repair"
      ? "isolated_write"
      : operation === "ask"
        ? "read_only"
        : undefined
  );
  const target = options.target ?? "claude";
  const modelRoute = options.resolvedRoute ?? resolveModelRoute({
    target,
    ...(input.task_profile === undefined ? {} : { taskProfile: input.task_profile }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: input.reasoning_effort }),
  }, options.configuration);
  validateResolvedModelRoute(modelRoute, options.configuration);
  if (modelRoute.target !== target) {
    throw new BridgeError("model_target_mismatch", "Resolved model route targets the other peer.", {
      httpStatus: 400,
    });
  }
  const request: BridgeRequest = {
    request_id: input.request_id ?? randomUUID(),
    idempotency_key: input.idempotency_key ?? randomUUID(),
    origin: options.origin,
    target,
    task_profile: modelRoute.taskProfile,
    model: modelRoute.model,
    reasoning_effort: modelRoute.reasoningEffort,
    routing_source: modelRoute.selectionSource,
    routing_rule_id: modelRoute.ruleId,
    operation,
    ...(reviewerAccess === undefined ? {} : { reviewer_access: reviewerAccess }),
    hop_count: input.hop_count ?? options.hopCount ?? 0,
    created_at: createdAt,
    deadline: input.deadline ?? new Date(now + LIMITS.jobRuntimeMs).toISOString(),
    question: input.question,
    route: input.route ?? "auto",
    ...(input.ancestor_request_ids === undefined
      ? {}
      : { ancestor_request_ids: input.ancestor_request_ids }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.target_session_id === undefined
      ? {}
      : { target_session_id: input.target_session_id }),
    ...(input.bridge_thread_id === undefined
      ? {}
      : { bridge_thread_id: input.bridge_thread_id }),
    ...(input.allow_fresh_fallback === undefined
      ? {}
      : { allow_fresh_fallback: input.allow_fresh_fallback }),
    ...(input.artifact_id === undefined ? {} : { artifact_id: input.artifact_id }),
    ...(input.artifact_type === undefined ? {} : { artifact_type: input.artifact_type }),
    ...(operation !== "review_repair" && input.author === undefined
      ? {}
      : { author: input.author ?? (target === "claude" ? "Codex" : "Claude") }),
    ...(operation !== "review_repair" && input.reviewer === undefined
      ? {}
      : { reviewer: input.reviewer ?? reviewerLabel(target, modelRoute.model) }),
    ...(input.artifact_name === undefined ? {} : { artifact_name: input.artifact_name }),
    ...(input.artifact_path === undefined ? {} : { artifact_path: input.artifact_path }),
    ...(input.artifact_bytes === undefined ? {} : { artifact_bytes: input.artifact_bytes }),
    ...(input.artifact_sha256 === undefined ? {} : { artifact_sha256: input.artifact_sha256 }),
    ...(input.artifact_content === undefined ? {} : { artifact_content: input.artifact_content }),
    ...(input.target_root === undefined ? {} : { target_root: input.target_root }),
    ...(input.allowed_paths === undefined ? {} : { allowed_paths: input.allowed_paths }),
    ...(input.round === undefined ? {} : { round: input.round }),
    ...(input.max_rounds === undefined && operation !== "review_repair"
      ? {}
      : { max_rounds: input.max_rounds ?? 3 }),
    ...(input.acceptance_criteria === undefined
      ? {}
      : { acceptance_criteria: input.acceptance_criteria }),
    ...(input.test_commands === undefined ? {} : { test_commands: input.test_commands }),
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    ...(input.prior_rounds === undefined ? {} : { prior_rounds: input.prior_rounds }),
    ...(input.prior_findings === undefined ? {} : { prior_findings: input.prior_findings }),
    ...(input.open_items === undefined ? {} : { open_items: input.open_items }),
  };
  return parseBridgeRequest(request, now, options.configuration);
}
export function assertOutsideBridgeChild(environment: NodeJS.ProcessEnv = process.env): void {
  const hopCount = Number(environment.BRIDGE_HOP_COUNT ?? "0");
  if (environment.BRIDGE_CHILD === "1" || (Number.isFinite(hopCount) && hopCount > 1)) {
    throw new BridgeError(
      "recursive_bridge_call",
      "Bridge calls from a bridge child or hop_count greater than 1 are rejected.",
      { httpStatus: 409 },
    );
  }
}
