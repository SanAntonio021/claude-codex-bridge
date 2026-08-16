import { z } from "zod";
import { isAbsolute } from "node:path";
import { LIMITS } from "./constants.js";
import { BridgeError, type StructuredError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  ModelIdSchema,
  ReasoningEffortSchema,
  RoutingSourceSchema,
  TaskProfileSchema,
  defaultRoutingConfiguration,
  resolveModelRoute,
  reviewerLabel,
  validateResolvedModelRoute,
  type ModelId,
  type ReasoningEffort,
  type RoutingConfiguration,
  type RoutingSource,
  type TaskProfile,
} from "./model-routing.js";
import { bridgeConfigHash } from "./config.js";

export const JOB_STATES = [
  "queued",
  "dispatching",
  "transport_delivered",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "needs_attention",
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type TerminalJobState = Extract<
  JobState,
  "succeeded" | "failed" | "cancelled" | "expired" | "needs_attention"
>;

export const TERMINAL_STATES = new Set<JobState>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "needs_attention",
]);

export const RouteSchema = z.enum(["auto", "headless", "live"]);
export type Route = z.infer<typeof RouteSchema>;

export const PeerTargetSchema = z.enum(["claude", "codex"]);
export type PeerTarget = z.infer<typeof PeerTargetSchema>;

export const OperationSchema = z.enum(["ask", "task", "review_repair"]);
export type Operation = z.infer<typeof OperationSchema>;

export const ReviewerAccessSchema = z.enum(["read_only", "isolated_write"]);
export type ReviewerAccess = z.infer<typeof ReviewerAccessSchema>;

export const TestCommandSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.:\\/@=+\-]+(?: [A-Za-z0-9_.:\\/@=+\-]+)*$/u,
    "testCommands must be exact commands without quoting, variables, wildcards, redirection, pipes, or chaining.",
  );
export const TestCommandsSchema = z
  .array(TestCommandSchema)
  .max(16)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "testCommands must not contain duplicates.",
  });

export const ArtifactTypeSchema = z.enum(["plan", "deliverable"]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactAuthorSchema = z.enum(["Codex", "Claude"]);
export type ArtifactAuthor = z.infer<typeof ArtifactAuthorSchema>;

export const ArtifactReviewerSchema = z.string().min(1).max(128);
export type ArtifactReviewer = z.infer<typeof ArtifactReviewerSchema>;

export const SyncStatusSchema = z.enum([
  "not_requested",
  "prepared",
  "synced",
  "awaiting_user",
  "conflict",
  "failed",
  "discarded",
]);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const HighRiskActionSchema = z.enum([
  "delete",
  "rename",
  "permission_change",
  "type_change",
]);
export type HighRiskAction = z.infer<typeof HighRiskActionSchema>;

export const HighRiskChangeSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    action: HighRiskActionSchema,
    path: z.string().min(1),
    from_path: z.string().min(1).optional(),
    before_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    after_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    before_mode: z.number().int().nonnegative().optional(),
    after_mode: z.number().int().nonnegative().optional(),
  })
  .strict();
export type HighRiskChange = z.infer<typeof HighRiskChangeSchema>;

export const SyncAuthorizationSchema = z
  .object({
    sync_request_id: z.uuid(),
    approved_change_ids: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).min(1),
    authorized_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SyncAuthorization = z.infer<typeof SyncAuthorizationSchema>;

export const BridgeRequestSchema = z
  .object({
    request_id: z.uuid(),
    idempotency_key: z.string().min(1).max(128),
    origin: z.string().min(1).max(64),
    target: PeerTargetSchema,
    task_profile: TaskProfileSchema.optional(),
    model: ModelIdSchema.optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
    routing_source: RoutingSourceSchema.optional(),
    routing_rule_id: z.string().min(1).max(128).optional(),
    config_schema: z.literal(1).optional(),
    config_hash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    operation: OperationSchema.default("ask"),
    reviewer_access: ReviewerAccessSchema.optional(),
    hop_count: z.number().int().min(0).max(2),
    ancestor_request_ids: z.array(z.uuid()).max(16).optional(),
    created_at: z.iso.datetime({ offset: true }),
    deadline: z.iso.datetime({ offset: true }),
    question: z.string().min(1),
    context: z.string().optional(),
    route: RouteSchema,
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
  })
  .strict();

export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

export interface JobHistoryEntry {
  state: JobState;
  at: string;
  error_code?: string;
}
export interface PermissionDenial {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

export interface IsolationViolation {
  event_index: number;
  tool_name: string;
  reason_code: string;
  preview: string;
}

export interface AdapterDetails {
  exit_code: number | null;
  stderr: string;
  complete_stdout_lines: string[];
  reported_model?: string;
  requested_model?: string;
  requested_reasoning_effort?: string;
  task_profile?: TaskProfile;
  routing_source?: RoutingSource;
  routing_rule_id?: string;
  cli_version?: string;
  requested_sandbox_mode?: string;
  approval_policy?: string;
  network_access_enabled?: boolean;
  web_search_mode?: string;
  project_doc_max_bytes?: number;
  skill_instructions_enabled?: boolean;
  environment_context_enabled?: boolean;
  windows_sandbox_mode?: string;
  thread_id?: string;
  result_event?: Record<string, unknown>;
  permission_denials?: PermissionDenial[];
  changed_files?: string[];
  tests?: string[];
  command_failures?: string[];
  missing_test_commands?: string[];
  allowed_tool_patterns?: string[];
  workspace_path?: string;
  baseline_manifest_hash?: string;
  result_manifest_hash?: string;
  internal_error_name?: string;
  internal_error_message?: string;
  isolation_violation?: IsolationViolation;
  isolation_violation_raw?: {
    event_index: number;
    raw_event: unknown;
  };
}

export interface ManifestEntry {
  relative_path: string;
  bytes: number;
  sha256: string;
  kind: "file" | "directory" | "symlink";
  mode?: number;
}

export interface WorkspaceManifest {
  version: 1;
  root: string;
  target_root: string;
  artifact_id: string;
  allowed_paths: string[];
  files: ManifestEntry[];
  created_at: string;
  updated_at: string;
  retained_until?: string;
  sha256?: string;
}

export interface JobRecord {
  job_id: string;
  version?: string;
  build_id?: string;
  protocol_version?: number;
  state: JobState;
  request: BridgeRequest;
  request_hash: string;
  created_at: string;
  updated_at: string;
  history: JobHistoryEntry[];
  result?: string;
  result_hash?: string;
  error?: StructuredError;
  claude_session_id?: string;
  context_reset?: boolean;
  child_pid?: number;
  cancellation_requested_at?: string;
  adapter_details?: AdapterDetails;
  peer_session_id?: string;
  direction?: "codex_to_claude" | "claude_to_codex";
  workspace_manifest?: WorkspaceManifest;
  result_workspace_manifest?: WorkspaceManifest;
  changed_files?: string[];
  test_results?: string[];
  sync_status?: SyncStatus;
  pending_high_risk?: HighRiskChange[];
  sync_authorization?: SyncAuthorization;
  workspace_retained_until?: string;
  sync_approval_expires_at?: string;
}

export interface SessionRecord {
  bridge_thread_id: string;
  claude_session_id?: string;
  peer_session_id?: string;
  target: PeerTarget;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  task_profile?: TaskProfile;
  owner: "daemon";
  status: "idle" | "running" | "needs_attention";
  created_at: string;
  last_active_at: string;
}

export interface PublicJobStatus {
  job_id: string;
  version?: string;
  build_id?: string;
  protocol_version?: number;
  state: JobState;
  request_id: string;
  origin: string;
  target: PeerTarget;
  operation: Operation;
  route: Route;
  bridge_thread_id?: string;
  created_at: string;
  updated_at: string;
  deadline: string;
  error_code?: string;
  context_reset?: boolean;
  review_model?: string;
  requested_model?: string;
  requested_reasoning_effort?: string;
  task_profile?: TaskProfile;
  routing_source?: RoutingSource;
  routing_rule_id?: string;
  config_schema?: number;
  config_hash?: string;
  target_session_id?: string;
  session_id?: string;
  artifact_id?: string;
  artifact_type?: ArtifactType;
  round?: number;
  sync_status?: SyncStatus;
  changed_files?: string[];
  pending_high_risk?: HighRiskChange[];
  sync_request_id?: string;
  workspace_retained_until?: string;
  sync_approval_expires_at?: string;
}

export interface PublicJobResult extends PublicJobStatus {
  result?: string;
  error?: StructuredError;
}

export function isTerminalState(state: JobState): state is TerminalJobState {
  return TERMINAL_STATES.has(state);
}

export function publicJobStatus(record: JobRecord): PublicJobStatus {
  const requestedModel = record.adapter_details?.requested_model ?? record.request.model;
  const requestedReasoningEffort =
    record.adapter_details?.requested_reasoning_effort ?? record.request.reasoning_effort;
  return {
    job_id: record.job_id,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.build_id === undefined ? {} : { build_id: record.build_id }),
    ...(record.protocol_version === undefined
      ? {}
      : { protocol_version: record.protocol_version }),
    state: record.state,
    request_id: record.request.request_id,
    origin: record.request.origin,
    target: record.request.target,
    operation: record.request.operation,
    route: record.request.route,
    created_at: record.created_at,
    updated_at: record.updated_at,
    deadline: record.request.deadline,
    ...(record.request.bridge_thread_id === undefined
      ? {}
      : { bridge_thread_id: record.request.bridge_thread_id }),
    ...(record.request.target_session_id === undefined
      ? {}
      : { target_session_id: record.request.target_session_id }),
    ...(record.peer_session_id === undefined && record.claude_session_id === undefined
      ? {}
      : { session_id: record.peer_session_id ?? record.claude_session_id }),
    ...(record.request.artifact_id === undefined ? {} : { artifact_id: record.request.artifact_id }),
    ...(record.request.artifact_type === undefined
      ? {}
      : { artifact_type: record.request.artifact_type }),
    ...(record.request.round === undefined ? {} : { round: record.request.round }),
    ...(record.error === undefined ? {} : { error_code: record.error.code }),
    ...(record.context_reset === undefined ? {} : { context_reset: record.context_reset }),
    ...(record.adapter_details?.reported_model === undefined
      ? {}
      : { review_model: record.adapter_details.reported_model }),
    ...(requestedModel === undefined ? {} : { requested_model: requestedModel }),
    ...(requestedReasoningEffort === undefined
      ? {}
      : { requested_reasoning_effort: requestedReasoningEffort }),
    ...(record.request.task_profile === undefined
      ? {}
      : { task_profile: record.request.task_profile }),
    ...(record.request.routing_source === undefined
      ? {}
      : { routing_source: record.request.routing_source }),
    ...(record.request.routing_rule_id === undefined
      ? {}
      : { routing_rule_id: record.request.routing_rule_id }),
    ...(record.request.config_schema === undefined
      ? {}
      : { config_schema: record.request.config_schema }),
    ...(record.request.config_hash === undefined
      ? {}
      : { config_hash: record.request.config_hash }),
    ...(record.sync_status === undefined ? {} : { sync_status: record.sync_status }),
    ...(record.changed_files === undefined ? {} : { changed_files: record.changed_files }),
    ...(record.pending_high_risk === undefined
      ? {}
      : { pending_high_risk: record.pending_high_risk }),
    ...(record.sync_authorization === undefined
      ? {}
      : { sync_request_id: record.sync_authorization.sync_request_id }),
    ...(record.workspace_retained_until === undefined
      ? {}
      : { workspace_retained_until: record.workspace_retained_until }),
    ...(record.sync_approval_expires_at === undefined
      ? {}
      : { sync_approval_expires_at: record.sync_approval_expires_at }),
  };
}

export function publicJobResult(record: JobRecord): PublicJobResult {
  return {
    ...publicJobStatus(record),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

export function parseBridgeRequest(
  value: unknown,
  now = Date.now(),
  configuration: RoutingConfiguration = defaultRoutingConfiguration(),
): BridgeRequest {
  const parsed = BridgeRequestSchema.safeParse(normalizeRequestAliases(value));
  if (!parsed.success) {
    throw new BridgeError("invalid_request", "Request validation failed.", {
      httpStatus: 400,
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }

  const parsedRequest = parsed.data;
  const hasRoutingAudit = parsedRequest.routing_source !== undefined
    || parsedRequest.routing_rule_id !== undefined;
  if (
    hasRoutingAudit
    && (
      parsedRequest.task_profile === undefined
      || parsedRequest.model === undefined
      || parsedRequest.reasoning_effort === undefined
      || parsedRequest.routing_source === undefined
      || parsedRequest.routing_rule_id === undefined
    )
  ) {
    throw new BridgeError("model_route_mismatch", "Persisted model route audit fields are incomplete.", {
      httpStatus: 400,
    });
  }
  const resolvedRoute = hasRoutingAudit
    ? {
        target: parsedRequest.target,
        taskProfile: parsedRequest.task_profile as TaskProfile,
        model: parsedRequest.model as ModelId,
        reasoningEffort: parsedRequest.reasoning_effort as ReasoningEffort,
        selectionSource: parsedRequest.routing_source as RoutingSource,
        ruleId: parsedRequest.routing_rule_id as string,
      }
      : resolveModelRoute({
        target: parsedRequest.target,
        ...(parsedRequest.task_profile === undefined
          ? {}
          : { taskProfile: parsedRequest.task_profile }),
        ...(parsedRequest.model === undefined ? {} : { model: parsedRequest.model }),
        ...(parsedRequest.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: parsedRequest.reasoning_effort }),
        }, configuration);
  validateResolvedModelRoute(resolvedRoute, configuration);
  const request: BridgeRequest = {
    ...parsedRequest,
    task_profile: resolvedRoute.taskProfile,
    model: resolvedRoute.model,
    reasoning_effort: resolvedRoute.reasoningEffort,
    routing_source: resolvedRoute.selectionSource,
    routing_rule_id: resolvedRoute.ruleId,
    config_schema: configuration.schemaVersion,
    config_hash: bridgeConfigHash(configuration),
  };
  const createdAt = Date.parse(request.created_at);
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(createdAt) || !Number.isFinite(deadline)) {
    throw new BridgeError("invalid_deadline", "created_at and deadline must be valid timestamps.");
  }
  if (deadline <= now) {
    throw new BridgeError("deadline_expired", "Request deadline has already passed.", {
      httpStatus: 408,
    });
  }
  if (deadline - Math.max(createdAt, now) > LIMITS.jobRuntimeMs) {
    throw new BridgeError(
      "deadline_exceeds_limit",
      "Request deadline exceeds the 15-minute job limit.",
    );
  }
  if (request.hop_count > 1) {
    throw new BridgeError("hop_limit_exceeded", "Bridge hop_count must not exceed 1.", {
      httpStatus: 409,
    });
  }

  if (request.target_session_id !== undefined && request.bridge_thread_id === undefined) {
    throw new BridgeError(
      "bridge_thread_required",
      "targetSessionId requires the recorded bridgeThreadId that owns it.",
      { httpStatus: 409 },
    );
  }
  if (request.reviewer_access !== undefined) {
    const expectedAccess = request.operation === "review_repair"
      ? "isolated_write"
      : request.operation === "ask"
        ? "read_only"
        : undefined;
    if (expectedAccess === undefined || request.reviewer_access !== expectedAccess) {
      throw new BridgeError(
        "reviewer_access_mismatch",
        request.operation === "task"
          ? "reviewerAccess is not applicable to task operations."
          : `${request.operation} requires reviewerAccess=${expectedAccess}.`,
        { httpStatus: 400 },
      );
    }
  }
  if (request.operation === "task") {
    if (request.artifact_id === undefined || request.target_root === undefined) {
      throw new BridgeError(
        "task_workspace_contract_incomplete",
        "task requires artifactId, targetRoot, and allowedPaths.",
        { httpStatus: 400 },
      );
    }
  }
  if (request.operation === "ask" && (request.test_commands?.length ?? 0) > 0) {
    throw new BridgeError(
      "test_commands_not_allowed",
      "Read-only ask operations cannot authorize testCommands.",
      { httpStatus: 400 },
    );
  }
  if (request.allowed_paths !== undefined && request.target_root === undefined) {
    throw new BridgeError("target_root_required", "allowedPaths require targetRoot.", {
      httpStatus: 400,
    });
  }
  if (request.target_root !== undefined) {
    if (!isAbsolute(request.target_root)) {
      throw new BridgeError("invalid_target_root", "targetRoot must be an absolute path.", {
        httpStatus: 400,
      });
    }
    if (request.allowed_paths === undefined || request.allowed_paths.length === 0) {
      throw new BridgeError("allowed_paths_required", "targetRoot requires explicit allowedPaths.", {
        httpStatus: 400,
      });
    }
  }
  if (request.operation === "review_repair") {
    const expectedAuthor = request.target === "claude" ? "Codex" : "Claude";
    const expectedReviewer = reviewerLabel(request.target, request.model as ModelId);
    if (
      request.artifact_id === undefined ||
      request.artifact_type === undefined ||
      request.round === undefined ||
      request.target_root === undefined ||
      request.artifact_content === undefined ||
      request.artifact_bytes === undefined ||
      request.artifact_sha256 === undefined ||
      request.artifact_name === undefined ||
      request.max_rounds !== 3 ||
      request.reviewer_access !== "isolated_write" ||
      request.test_commands === undefined ||
      request.acceptance_criteria === undefined ||
      request.acceptance_criteria.length === 0
    ) {
      throw new BridgeError(
        "review_repair_contract_incomplete",
        "review_repair requires the complete fixed isolated-write contract, explicit testCommands, and artifact identity/content integrity.",
        { httpStatus: 400 },
      );
    }
    if (request.author !== undefined && request.author !== expectedAuthor) {
      throw new BridgeError(
        "artifact_author_mismatch",
        "author does not match the selected peer direction.",
        { httpStatus: 400 },
      );
    }
    if (request.reviewer !== undefined && request.reviewer !== expectedReviewer) {
      throw new BridgeError(
        "artifact_reviewer_mismatch",
        "reviewer does not match the selected peer direction.",
        { httpStatus: 400 },
      );
    }
  }
  if (request.round !== undefined && request.artifact_id === undefined) {
    throw new BridgeError("artifact_id_required", "round requires a stable artifactId.", {
      httpStatus: 400,
    });
  }
  if (
    request.prior_rounds !== undefined &&
    request.round !== undefined &&
    request.prior_rounds.length !== request.round - 1
  ) {
    throw new BridgeError(
      "invalid_prior_rounds",
      "priorRounds length must equal round - 1.",
      { httpStatus: 400 },
    );
  }
  if (request.artifact_content !== undefined) {
    const bytes = Buffer.byteLength(request.artifact_content, "utf8");
    if (request.artifact_bytes !== undefined && request.artifact_bytes !== bytes) {
      throw new BridgeError("artifact_integrity_mismatch", "artifactBytes does not match artifactContent.", {
        httpStatus: 409,
      });
    }
    if (
      request.artifact_sha256 !== undefined &&
      request.artifact_sha256 !== sha256(request.artifact_content)
    ) {
      throw new BridgeError("artifact_integrity_mismatch", "artifactSha256 does not match artifactContent.", {
        httpStatus: 409,
      });
    }
  }

  const ancestors = request.ancestor_request_ids ?? [];
  const uniqueAncestors = new Set(ancestors);
  if (uniqueAncestors.size !== ancestors.length || uniqueAncestors.has(request.request_id)) {
    throw new BridgeError(
      "recursive_request",
      "Request ancestry contains a duplicate request_id.",
      { httpStatus: 409 },
    );
  }
  return request;
}

/** Accept the camelCase public contract while keeping the persisted V1 shape stable. */
export function normalizeRequestAliases(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const aliases: Readonly<Record<string, string>> = {
    requestId: "request_id",
    idempotencyKey: "idempotency_key",
    hopCount: "hop_count",
    ancestorRequestIds: "ancestor_request_ids",
    createdAt: "created_at",
    targetSessionId: "target_session_id",
    bridgeThreadId: "bridge_thread_id",
    taskProfile: "task_profile",
    reasoningEffort: "reasoning_effort",
    routingSource: "routing_source",
    routingRuleId: "routing_rule_id",
    allowFreshFallback: "allow_fresh_fallback",
    reviewerAccess: "reviewer_access",
    artifactId: "artifact_id",
    artifactType: "artifact_type",
    artifactName: "artifact_name",
    artifactPath: "artifact_path",
    artifactBytes: "artifact_bytes",
    artifactSha256: "artifact_sha256",
    artifactContent: "artifact_content",
    targetRoot: "target_root",
    allowedPaths: "allowed_paths",
    maxRounds: "max_rounds",
    acceptanceCriteria: "acceptance_criteria",
    testCommands: "test_commands",
    constraints: "constraints",
    priorRounds: "prior_rounds",
    priorFindings: "prior_findings",
    openItems: "open_items",
  };
  const result: Record<string, unknown> = { ...source };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (result[canonical] === undefined && source[alias] !== undefined) {
      result[canonical] = source[alias];
    }
    if (alias !== canonical) {
      delete result[alias];
    }
  }
  return result;
}
