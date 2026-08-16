import { z } from "zod";
import { BridgeError } from "./errors.js";

export const CLAUDE_MODELS = [
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-sonnet-5",
] as const;

export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export const MODEL_IDS = [...CLAUDE_MODELS, ...CODEX_MODELS] as const;
// Installed config owns the effective allowlist. Built-ins seed a new config;
// this syntax check permits explicitly added future model IDs.
export const ModelIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^(?:claude|gpt)-[A-Za-z0-9._-]+$/u, "model must be a Claude or GPT model ID.");
export type ModelId = z.infer<typeof ModelIdSchema>;

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const TASK_PROFILES = [
  "quality",
  "writing",
  "creative_writing",
  "coding",
  "research",
  "knowledge_work",
  "balanced",
  "high_volume",
] as const;
export const TaskProfileSchema = z.enum(TASK_PROFILES);
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export const RoutingSourceSchema = z.enum(["default", "profile", "explicit"]);
export type RoutingSource = z.infer<typeof RoutingSourceSchema>;

export const DEFAULT_TASK_PROFILE: TaskProfile = "quality";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5" as const;
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol" as const;
export const DEFAULT_REASONING_EFFORT = "max" as const;

export const REVIEWER_LABELS = [
  "Claude Opus 5",
  "Claude Opus 4.6",
  "Claude Sonnet 5",
  "Codex",
] as const;
export type ReviewerLabel = string;

export const PeerTargetSchema = z.enum(["claude", "codex"]);
export type PeerTarget = z.infer<typeof PeerTargetSchema>;

export interface ProfileRoute {
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  ruleId: string;
}

export interface ModelAllowance {
  target: PeerTarget;
  efforts: readonly ReasoningEffort[];
}

export type ProfileRoutes = Record<TaskProfile, Record<PeerTarget, ProfileRoute>>;

export interface RoutingConfiguration {
  schemaVersion: 1;
  models: Record<string, ModelAllowance>;
  profiles: ProfileRoutes;
}

const QUALITY_ROUTES = {
  claude: {
    model: DEFAULT_CLAUDE_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    ruleId: "claude-frontier-quality-2026-08-15",
  },
  codex: {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    ruleId: "codex-frontier-quality-2026-08-15",
  },
} as const satisfies Record<PeerTarget, ProfileRoute>;

const PROFILE_ROUTES: ProfileRoutes = {
  quality: QUALITY_ROUTES,
  writing: {
    claude: { ...QUALITY_ROUTES.claude, ruleId: "claude-writing-leader-2026-08-15" },
    codex: { ...QUALITY_ROUTES.codex, ruleId: "codex-writing-quality-2026-08-15" },
  },
  creative_writing: {
    claude: { ...QUALITY_ROUTES.claude, ruleId: "claude-creative-writing-leader-2026-08-15" },
    codex: { ...QUALITY_ROUTES.codex, ruleId: "codex-creative-writing-quality-2026-08-15" },
  },
  coding: {
    claude: { ...QUALITY_ROUTES.claude, ruleId: "claude-coding-quality-2026-08-15" },
    codex: { ...QUALITY_ROUTES.codex, ruleId: "codex-coding-frontier-2026-08-15" },
  },
  research: {
    claude: { ...QUALITY_ROUTES.claude, ruleId: "claude-research-quality-2026-08-15" },
    codex: { ...QUALITY_ROUTES.codex, ruleId: "codex-research-quality-2026-08-15" },
  },
  knowledge_work: {
    claude: { ...QUALITY_ROUTES.claude, ruleId: "claude-knowledge-work-quality-2026-08-15" },
    codex: { ...QUALITY_ROUTES.codex, ruleId: "codex-knowledge-work-quality-2026-08-15" },
  },
  balanced: {
    claude: {
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      ruleId: "claude-balanced-2026-08-15",
    },
    codex: {
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      ruleId: "codex-balanced-2026-08-15",
    },
  },
  high_volume: {
    claude: {
      model: "claude-sonnet-5",
      reasoningEffort: "medium",
      ruleId: "claude-high-volume-2026-08-15",
    },
    codex: {
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      ruleId: "codex-high-volume-2026-08-15",
    },
  },
};

const DEFAULT_MODEL_ALLOWANCES: Record<string, ModelAllowance> = {
  "claude-opus-5": { target: "claude", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-opus-4-6": { target: "claude", efforts: ["low", "medium", "high", "max"] },
  "claude-sonnet-5": { target: "claude", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-sol": { target: "codex", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  "gpt-5.6-terra": { target: "codex", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  "gpt-5.6-luna": { target: "codex", efforts: ["low", "medium", "high", "xhigh", "max"] },
};

export const DEFAULT_ROUTING_CONFIGURATION: RoutingConfiguration = {
  schemaVersion: 1,
  models: DEFAULT_MODEL_ALLOWANCES,
  profiles: PROFILE_ROUTES,
};

export function defaultRoutingConfiguration(): RoutingConfiguration {
  return JSON.parse(JSON.stringify(DEFAULT_ROUTING_CONFIGURATION)) as RoutingConfiguration;
}

function configurationOrDefault(configuration: RoutingConfiguration | undefined): RoutingConfiguration {
  return configuration ?? DEFAULT_ROUTING_CONFIGURATION;
}

export interface ResolvedModelRoute {
  target: PeerTarget;
  taskProfile: TaskProfile;
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  selectionSource: RoutingSource;
  ruleId: string;
}

export interface ModelRouteInput {
  target: PeerTarget;
  taskProfile?: TaskProfile;
  model?: ModelId;
  reasoningEffort?: ReasoningEffort;
}

export function assertRoutingConfiguration(configuration: RoutingConfiguration): void {
  if (configuration.schemaVersion !== 1) {
    throw new BridgeError("invalid_config", "Unsupported bridge routing configuration schema.", {
      httpStatus: 500,
    });
  }
  for (const [model, allowance] of Object.entries(configuration.models)) {
    if (!ModelIdSchema.safeParse(model).success || allowance.efforts.length === 0) {
      throw new BridgeError("invalid_config", "Bridge model configuration is invalid.", {
        httpStatus: 500,
      });
    }
    if (!PeerTargetSchema.safeParse(allowance.target).success) {
      throw new BridgeError("invalid_config", "Bridge model target configuration is invalid.", {
        httpStatus: 500,
      });
    }
    if (new Set(allowance.efforts).size !== allowance.efforts.length) {
      throw new BridgeError("invalid_config", "Bridge model efforts must be unique.", {
        httpStatus: 500,
      });
    }
    for (const effort of allowance.efforts) {
      if (!ReasoningEffortSchema.safeParse(effort).success) {
        throw new BridgeError("invalid_config", "Bridge model effort configuration is invalid.", {
          httpStatus: 500,
        });
      }
    }
  }
  for (const profile of TASK_PROFILES) {
    const routes = configuration.profiles[profile];
    if (routes === undefined) {
      throw new BridgeError("invalid_config", `Missing ${profile} profile route.`, { httpStatus: 500 });
    }
    for (const target of ["claude", "codex"] as const) {
      const route = routes[target];
      if (route === undefined || route.ruleId.trim() === "") {
        throw new BridgeError("invalid_config", `Missing ${profile}/${target} profile route.`, {
          httpStatus: 500,
        });
      }
      const allowance = configuration.models[route.model];
      if (
        allowance === undefined
        || allowance.target !== target
        || !allowance.efforts.includes(route.reasoningEffort)
      ) {
        throw new BridgeError("invalid_config", `Invalid ${profile}/${target} profile route.`, {
          httpStatus: 500,
        });
      }
    }
  }
}

export function assertModelSelection(
  target: PeerTarget,
  model: ModelId,
  reasoningEffort: ReasoningEffort,
  configuration?: RoutingConfiguration,
): void {
  const allowance = configurationOrDefault(configuration).models[model];
  if (allowance === undefined) {
    throw new BridgeError("model_not_allowed", `${model} is not in the configured bridge allowlist.`, {
      httpStatus: 400,
    });
  }
  if (allowance.target !== target) {
    throw new BridgeError(
      "model_target_mismatch",
      `${model} is not an allowed ${target} target model.`,
      { httpStatus: 400 },
    );
  }
  if (!allowance.efforts.includes(reasoningEffort)) {
    throw new BridgeError(
      "model_effort_mismatch",
      `${reasoningEffort} is not supported by ${model}.`,
      { httpStatus: 400 },
    );
  }
}

export function resolveModelRoute(
  input: ModelRouteInput,
  configuration?: RoutingConfiguration,
): ResolvedModelRoute {
  const config = configurationOrDefault(configuration);
  assertRoutingConfiguration(config);
  const taskProfile = input.taskProfile ?? DEFAULT_TASK_PROFILE;
  const profileRoute = config.profiles[taskProfile][input.target];
  const model = input.model ?? profileRoute.model;
  const reasoningEffort = input.reasoningEffort
    ?? (input.model === undefined ? profileRoute.reasoningEffort : DEFAULT_REASONING_EFFORT);
  assertModelSelection(input.target, model, reasoningEffort, config);

  const selectionSource: RoutingSource = input.model !== undefined || input.reasoningEffort !== undefined
    ? "explicit"
    : input.taskProfile === undefined
      ? "default"
      : "profile";
  return {
    target: input.target,
    taskProfile,
    model,
    reasoningEffort,
    selectionSource,
    ruleId: selectionSource === "explicit"
      ? `explicit-${input.target}-model-selection-v1`
      : profileRoute.ruleId,
  };
}

export function validateResolvedModelRoute(
  route: ResolvedModelRoute,
  configuration?: RoutingConfiguration,
): void {
  const config = configurationOrDefault(configuration);
  assertRoutingConfiguration(config);
  if (config.models[route.model] === undefined) {
    throw new BridgeError(
      "model_route_revoked",
      `The recorded model ${route.model} is no longer enabled by the current bridge configuration.`,
      { httpStatus: 409, retryable: false },
    );
  }
  assertModelSelection(route.target, route.model, route.reasoningEffort, config);
  if (route.selectionSource === "explicit") {
    if (route.ruleId !== `explicit-${route.target}-model-selection-v1`) {
      throw new BridgeError("model_route_mismatch", "Explicit model selection has an invalid rule ID.", {
        httpStatus: 400,
      });
    }
    return;
  }
  const expected = resolveModelRoute(
    {
      target: route.target,
      ...(route.selectionSource === "profile" ? { taskProfile: route.taskProfile } : {}),
    },
    config,
  );
  if (
    expected.taskProfile !== route.taskProfile
    || expected.model !== route.model
    || expected.reasoningEffort !== route.reasoningEffort
    || expected.ruleId !== route.ruleId
  ) {
    throw new BridgeError("model_route_mismatch", "Persisted model route does not match its rule.", {
      httpStatus: 400,
    });
  }
}

export function reviewerLabel(target: PeerTarget, model: ModelId): ReviewerLabel {
  if (target === "codex") {
    return "Codex";
  }
  switch (model) {
    case "claude-opus-5":
      return "Claude Opus 5";
    case "claude-opus-4-6":
      return "Claude Opus 4.6";
    case "claude-sonnet-5":
      return "Claude Sonnet 5";
    default:
      return "Claude";
  }
}

export function supportedModelRoutes(
  configuration?: RoutingConfiguration,
): Readonly<ProfileRoutes> {
  return configurationOrDefault(configuration).profiles;
}
