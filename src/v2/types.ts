import { isAbsolute } from "node:path";
import { z } from "zod";
import { BridgeError } from "../errors.js";
import { sha256 } from "../hash.js";
import {
  ModelIdSchema,
  ReasoningEffortSchema,
  TaskProfileSchema,
  resolveModelRoute,
  type ModelId,
  type ReasoningEffort,
  type ResolvedModelRoute,
  type RoutingConfiguration,
  type TaskProfile,
} from "../model-routing.js";

export const V2_OWNER_VALUES = ["codex", "claude"] as const;
export const V2OwnerSchema = z.enum(V2_OWNER_VALUES);
export type V2Owner = z.infer<typeof V2OwnerSchema>;

export const V2_OPERATION_VALUES = ["review_only", "review_repair"] as const;
export const V2OperationSchema = z.enum(V2_OPERATION_VALUES);
export type V2Operation = z.infer<typeof V2OperationSchema>;

export const V2_ARTIFACT_MODE_VALUES = ["inline", "workspace"] as const;
export const V2ArtifactModeSchema = z.enum(V2_ARTIFACT_MODE_VALUES);
export type V2ArtifactMode = z.infer<typeof V2ArtifactModeSchema>;

export const V2ArtifactTypeSchema = z.enum(["plan", "deliverable"]);
export type V2ArtifactType = z.infer<typeof V2ArtifactTypeSchema>;

export const V2_REPAIR_ACTION_VALUES = ["modify", "create"] as const;
export const V2RepairActionSchema = z.enum(V2_REPAIR_ACTION_VALUES);
export type V2RepairAction = z.infer<typeof V2RepairActionSchema>;

export const V2TestCommandSchema = z
  .object({
    program: z.string().min(1).max(32_767),
    programBytes: z.number().int().positive(),
    programSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    args: z.array(z.string().max(8_192)).max(128),
    timeoutMs: z.number().int().min(100).max(15 * 60 * 1_000),
  })
  .strict();
export type V2TestCommand = z.infer<typeof V2TestCommandSchema>;

export const V2RepairTargetSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    action: V2RepairActionSchema,
  })
  .strict();
export type V2RepairTarget = z.infer<typeof V2RepairTargetSchema>;

export const V2RequestInputSchema = z
  .object({
    operation: V2OperationSchema,
    artifactMode: V2ArtifactModeSchema,
    question: z.string().min(1).max(900_000),
    artifactId: z.string().min(1).max(256),
    artifactType: V2ArtifactTypeSchema,
    artifactName: z.string().min(1).max(512),
    artifactPath: z.string().min(1).max(4_096).optional(),
    artifactContent: z.string().min(1).max(900_000),
    artifactBytes: z.number().int().nonnegative(),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    acceptanceCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
    constraints: z.array(z.string().min(1).max(8_192)).max(128).default([]),
    targetRoot: z.string().min(1).max(4_096).optional(),
    repairTargets: z.array(V2RepairTargetSchema).min(1).max(128).optional(),
    testCommands: z.array(V2TestCommandSchema).max(16).optional(),
    taskProfile: TaskProfileSchema.optional(),
    model: ModelIdSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    seriesId: z.string().min(1).max(256).optional(),
    seriesVersion: z.number().int().nonnegative().optional(),
    latestJobId: z.uuid().optional(),
  })
  .strict();

export type V2RequestInput = z.input<typeof V2RequestInputSchema>;

export interface V2ReviewRequest {
  owner: V2Owner;
  target: "claude" | "codex";
  operation: V2Operation;
  artifactMode: V2ArtifactMode;
  question: string;
  artifactId: string;
  artifactType: V2ArtifactType;
  artifactName: string;
  artifactPath?: string;
  artifactContent: string;
  artifactBytes: number;
  artifactSha256: string;
  acceptanceCriteria: string[];
  constraints: string[];
  targetRoot?: string;
  repairTargets?: V2RepairTarget[];
  testCommands: V2TestCommand[];
  taskProfile: TaskProfile;
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  routingSource: ResolvedModelRoute["selectionSource"];
  routingRuleId: string;
  seriesId: string;
  seriesVersion?: number;
  latestJobId?: string;
}

export function oppositeTarget(owner: V2Owner): "claude" | "codex" {
  return owner === "codex" ? "claude" : "codex";
}

export function normalizeV2RelativePath(value: string, field = "path"): string {
  if (
    value.trim() === ""
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || value.includes(":")
  ) {
    throw new BridgeError("invalid_v2_path", `${field} must be a non-empty forward-slash relative path.`, {
      httpStatus: 400,
    });
  }
  const segments = value.split("/");
  const devices = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
  ]);
  for (const segment of segments) {
    const deviceBase = segment.split(".")[0]?.toLowerCase() ?? "";
    if (
      segment === ""
      || segment === "."
      || segment === ".."
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || segment.toLowerCase() === ".git"
      || devices.has(deviceBase)
    ) {
      throw new BridgeError("invalid_v2_path", `${field} contains a protected or ambiguous path segment.`, {
        httpStatus: 400,
      });
    }
  }
  return segments.join("/");
}

function assertArtifactIntegrity(input: z.output<typeof V2RequestInputSchema>): void {
  const bytes = Buffer.byteLength(input.artifactContent, "utf8");
  const hash = sha256(Buffer.from(input.artifactContent, "utf8"));
  if (input.artifactBytes !== bytes || input.artifactSha256 !== hash) {
    throw new BridgeError(
      "artifact_integrity_mismatch",
      "artifactBytes and artifactSha256 must match the exact UTF-8 artifactContent bytes.",
      { httpStatus: 400, details: { expected_bytes: bytes, expected_sha256: hash } },
    );
  }
}

function normalizeRepairTargets(targets: readonly V2RepairTarget[]): V2RepairTarget[] {
  const seen = new Set<string>();
  return targets.map((target) => {
    const path = normalizeV2RelativePath(target.path, "repairTargets.path");
    const folded = path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) {
      throw new BridgeError("duplicate_repair_target", "repairTargets must not contain case-colliding paths.", {
        httpStatus: 400,
      });
    }
    seen.add(folded);
    return { path, action: target.action };
  });
}

function resolvedRoute(
  input: z.output<typeof V2RequestInputSchema>,
  owner: V2Owner,
  configuration?: RoutingConfiguration,
): ResolvedModelRoute {
  return resolveModelRoute({
    target: oppositeTarget(owner),
    ...(input.taskProfile === undefined ? {} : { taskProfile: input.taskProfile }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  }, configuration);
}

export function parseV2ReviewRequest(
  value: unknown,
  owner: V2Owner,
  configuration?: RoutingConfiguration,
): V2ReviewRequest {
  const parsed = V2RequestInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("invalid_v2_request", "Protocol v2 request validation failed.", {
      httpStatus: 400,
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const input = parsed.data;
  assertArtifactIntegrity(input);
  const artifactPath = input.artifactPath === undefined
    ? undefined
    : normalizeV2RelativePath(input.artifactPath, "artifactPath");
  const testCommands = input.testCommands ?? [];
  let targets: V2RepairTarget[] | undefined;

  if (input.operation === "review_only") {
    if (
      input.artifactMode !== "inline"
      || input.targetRoot !== undefined
      || input.repairTargets !== undefined
      || input.testCommands !== undefined
    ) {
      throw new BridgeError(
        "review_only_contract_violation",
        "review_only is inline, zero-tool, and cannot declare a workspace, repair target, or test command.",
        { httpStatus: 400 },
      );
    }
  } else if (input.artifactMode === "inline") {
    if (input.targetRoot !== undefined || input.repairTargets !== undefined || input.testCommands !== undefined) {
      throw new BridgeError(
        "inline_repair_contract_violation",
        "Inline repair returns a complete repairedArtifact and cannot declare a workspace, repair target, or test command.",
        { httpStatus: 400 },
      );
    }
  } else {
    if (input.targetRoot === undefined || input.repairTargets === undefined || artifactPath === undefined) {
      throw new BridgeError(
        "workspace_repair_contract_incomplete",
        "Workspace repair requires targetRoot, artifactPath, and one or more explicit repairTargets.",
        { httpStatus: 400 },
      );
    }
    if (!isAbsolute(input.targetRoot)) {
      throw new BridgeError("invalid_target_root", "targetRoot must be an absolute path.", { httpStatus: 400 });
    }
    targets = normalizeRepairTargets(input.repairTargets);
    if (input.artifactType === "plan") {
      if (
        artifactPath === undefined
        || targets.length !== 1
        || targets[0]?.action !== "modify"
        || targets[0].path !== artifactPath
      ) {
        throw new BridgeError(
          "plan_repair_target_invalid",
          "A plan workspace review has exactly one modify target and it must equal artifactPath.",
          { httpStatus: 400 },
        );
      }
    }
  }

  const route = resolvedRoute(input, owner, configuration);
  return {
    owner,
    target: route.target,
    operation: input.operation,
    artifactMode: input.artifactMode,
    question: input.question,
    artifactId: input.artifactId,
    artifactType: input.artifactType,
    artifactName: input.artifactName,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    artifactContent: input.artifactContent,
    artifactBytes: input.artifactBytes,
    artifactSha256: input.artifactSha256,
    acceptanceCriteria: [...input.acceptanceCriteria],
    constraints: [...input.constraints],
    ...(input.targetRoot === undefined ? {} : { targetRoot: input.targetRoot }),
    ...(targets === undefined ? {} : { repairTargets: targets }),
    testCommands,
    taskProfile: route.taskProfile,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    routingSource: route.selectionSource,
    routingRuleId: route.ruleId,
    seriesId: input.seriesId ?? input.artifactId,
    ...(input.seriesVersion === undefined ? {} : { seriesVersion: input.seriesVersion }),
    ...(input.latestJobId === undefined ? {} : { latestJobId: input.latestJobId }),
  };
}

const V2EvidenceReferenceSchema = z
  .object({
    path: z.string().min(1).max(4_096).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    quote: z.string().min(1).max(8_192).optional(),
  })
  .strict();
export type V2EvidenceReference = z.infer<typeof V2EvidenceReferenceSchema>;

const V2FindingSchema = z
  .object({
    summary: z.string().min(1).max(8_192),
    rationale: z.string().min(1).max(16_384),
    evidence: z.array(V2EvidenceReferenceSchema).min(1).max(16),
  })
  .strict();
export type V2Finding = z.infer<typeof V2FindingSchema>;

const V2EvidenceRequestSchema = z
  .object({
    kind: z.literal("evidence_request"),
    requests: z.array(
      z.object({
        question: z.string().min(1).max(8_192),
        references: z.array(V2EvidenceReferenceSchema).max(16),
      }).strict(),
    ).min(1).max(32),
  })
  .strict();
export type V2EvidenceRequest = z.infer<typeof V2EvidenceRequestSchema>;

const V2FinalReviewSchema = z
  .object({
    kind: z.literal("final_review"),
    verdict: z.enum(["pass", "needs_changes", "disagreement"]),
    confirmed: z.array(z.string().min(1).max(8_192)).max(128),
    findings: z.array(V2FindingSchema).max(128),
    requiredChanges: z.array(z.string().min(1).max(8_192)).max(128),
    risks: z.array(z.string().min(1).max(8_192)).max(128),
    repairedArtifact: z.string().min(1).max(900_000).optional(),
  })
  .strict();

export const V2ModelResponseSchema = z.discriminatedUnion("kind", [
  V2EvidenceRequestSchema,
  V2FinalReviewSchema,
]);
export type V2ModelResponse = z.infer<typeof V2ModelResponseSchema>;
export type V2FinalReview = z.infer<typeof V2FinalReviewSchema>;

export const V2AdjudicationInputSchema = z
  .object({
    decision: z.enum(["accept_author", "accept_reviewer", "mixed"]),
    summary: z.string().min(1).max(16_384),
    acceptedFindingIds: z.array(z.string().regex(/^F-[0-9A-F]{12}$/u)).max(128),
    rejectedFindingIds: z.array(z.string().regex(/^F-[0-9A-F]{12}$/u)).max(128),
    additionalRequirements: z.array(z.string().min(1).max(8_192)).max(128),
  })
  .strict();
export type V2AdjudicationInput = z.infer<typeof V2AdjudicationInputSchema>;

const V2EvidenceReferenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    quote: { type: "string", minLength: 1, maxLength: 8192 },
  },
} as const;

const V2FindingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rationale", "evidence"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 8192 },
    rationale: { type: "string", minLength: 1, maxLength: 16384 },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: V2EvidenceReferenceJsonSchema,
    },
  },
} as const;

export const V2ModelResponseJsonSchema = {
  type: "object",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requests"],
      properties: {
        kind: { const: "evidence_request" },
        requests: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["question", "references"],
            properties: {
              question: { type: "string", minLength: 1, maxLength: 8192 },
              references: {
                type: "array",
                maxItems: 16,
                items: V2EvidenceReferenceJsonSchema,
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "verdict", "confirmed", "findings", "requiredChanges", "risks"],
      properties: {
        kind: { const: "final_review" },
        verdict: { enum: ["pass", "needs_changes", "disagreement"] },
        confirmed: { type: "array", maxItems: 128, items: { type: "string" } },
        findings: { type: "array", maxItems: 128, items: V2FindingJsonSchema },
        requiredChanges: { type: "array", maxItems: 128, items: { type: "string" } },
        risks: { type: "array", maxItems: 128, items: { type: "string" } },
        repairedArtifact: { type: "string", minLength: 1, maxLength: 900000 },
      },
    },
  ],
} as const;

export function parseV2ModelResponse(value: string): V2ModelResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch (error) {
    throw new BridgeError("v2_result_not_json", "Peer output is not a JSON Schema constrained result.", {
      httpStatus: 409,
      cause: error,
    });
  }
  const parsed = V2ModelResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BridgeError("v2_result_schema_invalid", "Peer JSON result does not satisfy the v2 schema.", {
      httpStatus: 409,
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data;
}
