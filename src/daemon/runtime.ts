import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  atomicWriteFile,
  atomicWriteJson,
  cleanupStaleTemporaryFiles,
  ensureProtectedDirectory,
} from "./atomic.js";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_TOKEN_ENV,
  BRIDGE_VERSION,
} from "../constants.js";
import { BridgeError } from "../errors.js";
import type { DaemonPaths } from "../config.js";

export const DaemonEndpointSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  host: z.literal("127.0.0.1"),
  started_at: z.string(),
  version: z.string(),
  build_id: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  protocol_version: z.number().int().positive().optional(),
  config_schema: z.literal(1).optional(),
  config_hash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  mcp_url: z.string().url().optional(),
  supported_protocols: z.array(z.number().int().positive()).min(1).optional(),
  role_mcp_urls: z.object({
    codex: z.string().url(),
    claude: z.string().url(),
  }).strict().optional(),
});

export type DaemonEndpoint = z.infer<typeof DaemonEndpointSchema>;

interface LockRecord {
  pid: number;
  created_at: string;
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    if (Number.isInteger(value.pid) && typeof value.created_at === "string") {
      return value as LockRecord;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

export class DaemonLock {
  readonly #path: string;
  #held = false;

  constructor(path: string) {
    this.#path = path;
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(this.#path, "wx", 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const existing = await readLock(this.#path);
      if (existing !== undefined && isProcessAlive(existing.pid)) {
        throw new BridgeError("daemon_already_running", "Bridge daemon lock is held.", {
          httpStatus: 409,
          details: { pid: existing.pid },
        });
      }
      await unlink(this.#path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
    }
    throw new BridgeError("daemon_lock_failed", "Unable to acquire daemon lock.", {
      httpStatus: 500,
    });
  }

  async release(): Promise<void> {
    if (!this.#held) {
      return;
    }
    const existing = await readLock(this.#path);
    if (existing?.pid === process.pid) {
      await unlink(this.#path).catch(() => undefined);
    }
    this.#held = false;
  }
}

export async function prepareRuntime(paths: DaemonPaths): Promise<void> {
  await ensureProtectedDirectory(paths.root);
  await cleanupStaleTemporaryFiles(paths.root);
  await ensureProtectedDirectory(paths.jobs);
  await ensureProtectedDirectory(paths.tombstones);
  await ensureProtectedDirectory(paths.backups);
  await ensureProtectedDirectory(paths.workspaces);
  await ensureProtectedDirectory(paths.artifactLocks);
  await ensureProtectedDirectory(paths.readonlyWorkspace);
  if ((await readdir(paths.readonlyWorkspace)).length !== 0) {
    throw new BridgeError(
      "readonly_workspace_not_empty",
      "The Codex read-only workspace must remain empty.",
      { httpStatus: 500 },
    );
  }
}

export type TokenEnvironmentWriter = (token: string, environmentVariable?: string) => Promise<void>;

function newToken(): string {
  return randomBytes(48).toString("base64url");
}

export async function mirrorTokenToUserEnvironment(
  token: string,
  environmentVariable = BRIDGE_TOKEN_ENV,
): Promise<void> {
  if (process.platform !== "win32") {
    process.env[environmentVariable] = token;
    return;
  }
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$value = [Console]::In.ReadToEnd().Trim()",
    `[Environment]::SetEnvironmentVariable('${environmentVariable}', $value, [EnvironmentVariableTarget]::User)`,
  ].join("; ");
  const child = spawn(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_192) {
      stderr += chunk.slice(0, 8_192 - stderr.length);
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${token}\n`, "utf8");
  const code = await new Promise<number | null>((resolveClose, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("close", resolveClose);
  });
  if (code !== 0) {
    throw new BridgeError(
      "token_environment_update_failed",
      "Unable to update the persistent bridge token environment variable.",
      {
        httpStatus: 500,
        details: { exit_code: code, stderr: stderr.trim().slice(0, 512) },
      },
    );
  }
}

async function writeToken(path: string, token: string): Promise<void> {
  if (token.length < 43) {
    throw new BridgeError("invalid_token", "Bridge token is too short.", { httpStatus: 500 });
  }
  await atomicWriteFile(path, `${token}\n`, { protect: true });
}

export async function ensurePersistentToken(
  path: string,
  writeEnvironment: TokenEnvironmentWriter = mirrorTokenToUserEnvironment,
  environmentVariable = BRIDGE_TOKEN_ENV,
): Promise<{ token: string; created: boolean }> {
  try {
    const token = await readToken(path);
    await writeEnvironment(token, environmentVariable);
    return { token, created: false };
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "daemon_unavailable") {
      throw error;
    }
  }
  const token = newToken();
  await writeToken(path, token);
  try {
    await writeEnvironment(token, environmentVariable);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { token, created: true };
}

export async function rotatePersistentToken(
  path: string,
  writeEnvironment: TokenEnvironmentWriter = mirrorTokenToUserEnvironment,
  environmentVariable = BRIDGE_TOKEN_ENV,
): Promise<string> {
  const previous = await readToken(path);
  const token = newToken();
  await writeToken(path, token);
  try {
    await writeEnvironment(token, environmentVariable);
  } catch (error) {
    await writeToken(path, previous).catch(() => undefined);
    await writeEnvironment(previous, environmentVariable).catch(() => undefined);
    throw error;
  }
  return token;
}

export async function readToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < 43) {
      throw new BridgeError("invalid_token_file", "Bridge token file is invalid.", {
        httpStatus: 500,
      });
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("daemon_unavailable", "Bridge daemon token is unavailable.", {
        httpStatus: 503,
        retryable: true,
      });
    }
    throw error;
  }
}

export function tokenMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function writeEndpoint(path: string, endpoint: DaemonEndpoint): Promise<void> {
  await atomicWriteJson(path, endpoint, { protect: true });
}

export async function readEndpoint(path: string): Promise<DaemonEndpoint> {
  try {
    const parsed = DaemonEndpointSchema.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (!parsed.success) {
      throw new BridgeError("invalid_endpoint_file", "Bridge daemon endpoint file is invalid.", {
        httpStatus: 500,
      });
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("daemon_unavailable", "Bridge daemon endpoint is unavailable.", {
        httpStatus: 503,
        retryable: true,
      });
    }
    throw error;
  }
}

export function endpointMatchesCurrentBuild(endpoint: DaemonEndpoint): boolean {
  return endpoint.version === BRIDGE_VERSION
    && endpoint.build_id === BRIDGE_BUILD_ID
    && endpoint.protocol_version === BRIDGE_PROTOCOL_VERSION;
}

export async function removeEndpoint(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
