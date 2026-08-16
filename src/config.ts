import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteJson, ensureProtectedDirectory } from "./daemon/atomic.js";
import { BridgeError } from "./errors.js";
import {
  ModelIdSchema,
  PeerTargetSchema,
  ReasoningEffortSchema,
  TASK_PROFILES,
  TaskProfileSchema,
  assertModelSelection,
  assertRoutingConfiguration,
  defaultRoutingConfiguration,
  type ModelId,
  type PeerTarget,
  type ReasoningEffort,
  type RoutingConfiguration,
  type TaskProfile,
} from "./model-routing.js";
import { BRIDGE_NAME } from "./constants.js";

export interface DaemonPaths {
  root: string;
  jobs: string;
  tombstones: string;
  token: string;
  codexToken: string;
  claudeToken: string;
  config: string;
  configLock: string;
  endpoint: string;
  lock: string;
  audit: string;
  sessions: string;
  workspaces: string;
  artifactLocks: string;
  readonlyWorkspace: string;
  backups: string;
}

export function getBridgeHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.CLAUDE_CODEX_BRIDGE_HOME;
  if (override !== undefined && override.trim() !== "") {
    return resolve(override);
  }
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim() !== "") {
    return join(localAppData, BRIDGE_NAME);
  }
  return join(homedir(), "AppData", "Local", BRIDGE_NAME);
}

export function getDaemonPaths(root = getBridgeHome()): DaemonPaths {
  return {
    root,
    jobs: join(root, "jobs"),
    tombstones: join(root, "tombstones"),
    token: join(root, "token"),
    codexToken: join(root, "token.codex"),
    claudeToken: join(root, "token.claude"),
    config: join(root, "config.json"),
    configLock: join(root, "config.lock"),
    endpoint: join(root, "daemon.json"),
    lock: join(root, "daemon.lock"),
    audit: join(root, "audit.ndjson"),
    sessions: join(root, "sessions.json"),
    workspaces: join(root, "workspaces"),
    artifactLocks: join(root, "locks"),
    readonlyWorkspace: join(root, "readonly-workspace"),
    backups: join(root, "backups"),
  };
}

export interface BridgeConfig extends RoutingConfiguration {
  schemaVersion: 1;
}

export interface LoadedBridgeConfig {
  config: BridgeConfig;
  hash: string;
}

export const ConfigMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("allow-model"),
    model: ModelIdSchema,
    target: PeerTargetSchema,
    efforts: z.array(ReasoningEffortSchema).min(1).max(6),
  }).strict(),
  z.object({
    action: z.literal("remove-model"),
    model: ModelIdSchema,
  }).strict(),
  z.object({
    action: z.literal("set-profile"),
    profile: TaskProfileSchema,
    target: PeerTargetSchema,
    model: ModelIdSchema,
    reasoningEffort: ReasoningEffortSchema,
    ruleId: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("reset"),
  }).strict(),
]);
export type ConfigMutation = z.infer<typeof ConfigMutationSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalConfigJson(config: BridgeConfig): string {
  return JSON.stringify(canonicalize(config));
}

export function bridgeConfigHash(config: BridgeConfig): string {
  return createHash("sha256").update(canonicalConfigJson(config), "utf8").digest("hex");
}

export function defaultBridgeConfig(): BridgeConfig {
  return defaultRoutingConfiguration();
}

function parseConfig(value: unknown): BridgeConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_config", "Bridge config.json must be an object.", {
      httpStatus: 500,
    });
  }
  const candidate = value as Partial<BridgeConfig>;
  if (candidate.schemaVersion !== 1 || candidate.models === undefined || candidate.profiles === undefined) {
    throw new BridgeError("invalid_config", "Bridge config.json has an unsupported schema.", {
      httpStatus: 500,
    });
  }
  const config: BridgeConfig = {
    schemaVersion: 1,
    models: candidate.models,
    profiles: candidate.profiles,
  } as BridgeConfig;
  assertRoutingConfiguration(config);
  return config;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function acquireConfigLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await delay(25);
    }
  }
  throw new BridgeError("config_lock_timeout", "Bridge configuration is currently being updated.", {
    httpStatus: 409,
    retryable: true,
  });
}

export async function ensureBridgeConfig(paths: DaemonPaths): Promise<LoadedBridgeConfig> {
  await ensureProtectedDirectory(paths.root);
  try {
    const config = parseConfig(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
    return { config, hash: bridgeConfigHash(config) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // First run initializes the versioned default below.
    } else if (error instanceof BridgeError) {
      throw error;
    } else {
      throw new BridgeError("invalid_config", "Bridge config.json could not be parsed.", {
        httpStatus: 500,
        cause: error,
      });
    }
  }
  const release = await acquireConfigLock(paths.configLock);
  try {
    try {
      const config = parseConfig(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
      return { config, hash: bridgeConfigHash(config) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Another initializer did not create config.json; create it below.
      } else if (error instanceof BridgeError) {
        throw error;
      } else {
        throw new BridgeError("invalid_config", "Bridge config.json could not be parsed.", {
          httpStatus: 500,
          cause: error,
        });
      }
    }
    const config = defaultBridgeConfig();
    await atomicWriteJson(paths.config, config, { protect: true });
    return { config, hash: bridgeConfigHash(config) };
  } finally {
    await release();
  }
}

export async function readBridgeConfig(paths: DaemonPaths): Promise<LoadedBridgeConfig> {
  try {
    const config = parseConfig(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
    return { config, hash: bridgeConfigHash(config) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ensureBridgeConfig(paths);
    }
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError("invalid_config", "Bridge config.json could not be parsed.", {
      httpStatus: 500,
      cause: error,
    });
  }
}

function cloneConfig(config: BridgeConfig): BridgeConfig {
  return JSON.parse(JSON.stringify(config)) as BridgeConfig;
}

function assertModelNotUsedByProfile(config: BridgeConfig, model: ModelId): void {
  for (const profile of TASK_PROFILES) {
    for (const target of ["claude", "codex"] as const) {
      if (config.profiles[profile][target].model === model) {
        throw new BridgeError(
          "model_in_use_by_profile",
          `${model} is still referenced by ${profile}/${target}; set another profile route first.`,
          { httpStatus: 409 },
        );
      }
    }
  }
}

export function applyConfigMutation(config: BridgeConfig, mutation: ConfigMutation): BridgeConfig {
  if (mutation.action === "reset") {
    return defaultBridgeConfig();
  }
  const next = cloneConfig(config);
  if (mutation.action === "allow-model") {
    if (new Set(mutation.efforts).size !== mutation.efforts.length) {
      throw new BridgeError("invalid_config", "Model effort allowlist must not contain duplicates.", {
        httpStatus: 400,
      });
    }
    next.models[mutation.model] = {
      target: mutation.target,
      efforts: [...mutation.efforts],
    };
  } else if (mutation.action === "remove-model") {
    if (next.models[mutation.model] === undefined) {
      throw new BridgeError("model_not_allowed", `${mutation.model} is not currently enabled.`, {
        httpStatus: 404,
      });
    }
    assertModelNotUsedByProfile(next, mutation.model);
    delete next.models[mutation.model];
  } else {
    assertModelSelection(
      mutation.target,
      mutation.model,
      mutation.reasoningEffort,
      next,
    );
    next.profiles[mutation.profile][mutation.target] = {
      model: mutation.model,
      reasoningEffort: mutation.reasoningEffort,
      ruleId: mutation.ruleId ?? `user-${mutation.profile}-${mutation.target}-v1`,
    };
  }
  assertRoutingConfiguration(next);
  return next;
}

export async function mutateBridgeConfig(
  paths: DaemonPaths,
  mutation: ConfigMutation,
): Promise<LoadedBridgeConfig> {
  await ensureBridgeConfig(paths);
  const release = await acquireConfigLock(paths.configLock);
  try {
    const current = parseConfig(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
    const config = applyConfigMutation(current, mutation);
    await atomicWriteJson(paths.config, config, { protect: true });
    return { config, hash: bridgeConfigHash(config) };
  } finally {
    await release();
  }
}

export function publicBridgeConfig(loaded: LoadedBridgeConfig): {
  schema_version: 1;
  config_hash: string;
  models: Record<string, { target: PeerTarget; efforts: readonly ReasoningEffort[] }>;
  profiles: BridgeConfig["profiles"];
} {
  return {
    schema_version: 1,
    config_hash: loaded.hash,
    models: loaded.config.models,
    profiles: loaded.config.profiles,
  };
}

export function parseModelId(value: string | undefined, optionName: string): ModelId {
  const parsed = ModelIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("invalid_option_value", `${optionName} requires a bridge model ID.`);
  }
  return parsed.data;
}

export function parsePeerTarget(value: string | undefined, optionName: string): PeerTarget {
  const parsed = PeerTargetSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("invalid_option_value", `${optionName} requires claude or codex.`);
  }
  return parsed.data;
}

export function parseReasoningEfforts(value: string | undefined, optionName: string): ReasoningEffort[] {
  if (value === undefined || value.trim() === "") {
    throw new BridgeError("invalid_option_value", `${optionName} requires a comma-separated effort list.`);
  }
  const efforts = value.split(",").map((item) => item.trim());
  const parsed = z.array(ReasoningEffortSchema).min(1).safeParse(efforts);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new BridgeError("invalid_option_value", `${optionName} has an invalid effort list.`);
  }
  return parsed.data;
}

export function parseTaskProfile(value: string | undefined, optionName: string): TaskProfile {
  const parsed = TaskProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("invalid_option_value", `${optionName} requires a supported profile.`);
  }
  return parsed.data;
}
