import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_HTTP_PORT,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  LOOPBACK_HOST,
} from "../constants.js";
import { getDaemonPaths, type DaemonPaths } from "../config.js";
import { BridgeError } from "../errors.js";
import { daemonHealth, requestDaemon } from "./client.js";
import {
  endpointMatchesCurrentBuild,
  prepareRuntime,
  readEndpoint,
  type DaemonEndpoint,
} from "./runtime.js";

const PRODUCTION_DAEMON_ACTIVATION_TIMEOUT_MS = 60_000;
const TEST_DAEMON_ACTIVATION_TIMEOUT_MS = 3_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function healthMatchesCurrentBuild(health: Record<string, unknown>): boolean {
  return health["version"] === BRIDGE_VERSION
    && health["build_id"] === BRIDGE_BUILD_ID
    && health["protocol_version"] === BRIDGE_PROTOCOL_VERSION;
}

export function daemonActivationTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return environment.BRIDGE_SKIP_ACL === "1"
    ? TEST_DAEMON_ACTIVATION_TIMEOUT_MS
    : PRODUCTION_DAEMON_ACTIVATION_TIMEOUT_MS;
}

async function waitForCurrentBuild(
  paths: DaemonPaths,
  timeoutMs: number,
): Promise<DaemonEndpoint | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [health, endpoint] = await Promise.all([
        daemonHealth(paths),
        readEndpoint(paths.endpoint),
      ]);
      if (endpointMatchesCurrentBuild(endpoint) && healthMatchesCurrentBuild(health)) {
        return endpoint;
      }
    } catch {
      // Another activation may have the lock or port before publishing readiness.
    }
    await delay(100);
  }
  return undefined;
}

async function assertPortAvailable(port = BRIDGE_HTTP_PORT): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectUnavailable) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      rejectUnavailable(
        error.code === "EADDRINUSE"
          ? new BridgeError(
              "daemon_port_in_use",
              `Port ${String(port)} is occupied by a non-current bridge endpoint.`,
              { httpStatus: 409, details: { host: LOOPBACK_HOST, port } },
            )
          : error,
      );
    });
    server.listen(port, LOOPBACK_HOST, () => {
      server.close(() => resolveAvailable());
    });
  });
}

function configuredDaemonPort(): number {
  if (process.env.BRIDGE_SKIP_ACL === "1") {
    const candidate = Number(process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT);
    if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535) {
      return candidate;
    }
  }
  return BRIDGE_HTTP_PORT;
}

async function stopMismatchedDaemon(
  paths: DaemonPaths,
  endpoint: DaemonEndpoint,
): Promise<void> {
  const status = await requestDaemon<Record<string, unknown>>("/v1/status", {
    paths,
    timeoutMs: 2_000,
  });
  const jobs = status["jobs"];
  const queuedJobs = jobs !== null && typeof jobs === "object"
    ? Number((jobs as Record<string, unknown>)["queued"] ?? 0)
    : 0;
  const activeJobs = Number(status["active_jobs"] ?? 0);
  if (activeJobs > 0 || queuedJobs > 0) {
    throw new BridgeError(
      "daemon_build_mismatch_active",
      "An older bridge build still owns active or queued jobs and was left running.",
      {
        httpStatus: 409,
        details: {
          running_pid: endpoint.pid,
          running_version: endpoint.version,
          running_build_id: endpoint.build_id ?? "unreported",
          expected_build_id: BRIDGE_BUILD_ID,
          active_jobs: activeJobs,
          queued_jobs: queuedJobs,
        },
      },
    );
  }
  await requestDaemon("/shutdown", { method: "POST", body: {}, paths, timeoutMs: 2_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await delay(100);
    try {
      await readEndpoint(paths.endpoint);
    } catch {
      return;
    }
  }
  throw new BridgeError(
    "daemon_replacement_timeout",
    "The idle older bridge build did not stop in time.",
    { httpStatus: 503, retryable: true, details: { running_pid: endpoint.pid } },
  );
}

export async function ensureDaemon(paths: DaemonPaths = getDaemonPaths()): Promise<DaemonEndpoint> {
  try {
    const [health, endpoint] = await Promise.all([
      daemonHealth(paths),
      readEndpoint(paths.endpoint),
    ]);
    if (endpointMatchesCurrentBuild(endpoint) && healthMatchesCurrentBuild(health)) {
      return endpoint;
    }
    await stopMismatchedDaemon(paths, endpoint);
  } catch (error) {
    if (
      error instanceof BridgeError
      && ["daemon_build_mismatch_active", "daemon_replacement_timeout"].includes(error.code)
    ) {
      throw error;
    }
    // A missing, stale, or unreachable endpoint is handled by starting the singleton below.
  }

  await prepareRuntime(paths);
  const port = configuredDaemonPort();
  try {
    await assertPortAvailable(port);
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "daemon_port_in_use") {
      throw error;
    }
    const joined = await waitForCurrentBuild(
      paths,
      daemonActivationTimeoutMs(),
    );
    if (joined !== undefined) {
      return joined;
    }
    // Eliminate a transient collision with another caller's availability probe.
    await assertPortAvailable(port);
  }
  const daemonMain = fileURLToPath(new URL("./main.js", import.meta.url));
  const child = spawn(process.execPath, [daemonMain, "serve"], {
    cwd: paths.root,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: { ...process.env, CLAUDE_CODEX_BRIDGE_HOME: paths.root },
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const deadline = Date.now() + daemonActivationTimeoutMs();
  let lastError: unknown;
  while (Date.now() < deadline) {
    await delay(100);
    if (spawnError !== undefined) {
      throw new BridgeError("daemon_start_failed", "Unable to launch the bridge daemon process.", {
        httpStatus: 503,
        retryable: true,
        cause: spawnError,
      });
    }
    try {
      const [health, endpoint] = await Promise.all([
        daemonHealth(paths),
        readEndpoint(paths.endpoint),
      ]);
      if (endpointMatchesCurrentBuild(endpoint) && healthMatchesCurrentBuild(health)) {
        return endpoint;
      }
      lastError = new BridgeError(
        "daemon_build_mismatch",
        "The responding daemon does not match the requested build.",
        {
          httpStatus: 409,
          details: {
            running_pid: endpoint.pid,
            running_version: endpoint.version,
            running_build_id: endpoint.build_id ?? "unreported",
            expected_build_id: BRIDGE_BUILD_ID,
          },
        },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new BridgeError("daemon_start_timeout", "Bridge daemon did not become healthy.", {
    httpStatus: 503,
    retryable: true,
    cause: lastError,
  });
}
