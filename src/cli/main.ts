#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvePeerSync,
  cancelJob,
  cleanupBridgeRuntime,
  discardPeerSync,
  getBridgeConfig,
  getBridgeStatus,
  getJobResult,
  getJobStatus,
  listSessions,
  mutateBridgeConfig,
  retryJob,
  rotateBridgeToken,
  submitJob,
  waitJob,
} from "../api.js";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  LIMITS,
} from "../constants.js";
import { getBridgeHome, getDaemonPaths, readBridgeConfig } from "../config.js";
import { requestDaemon, daemonHealth } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/ensure.js";
import {
  DAEMON_TASK_NAME,
  installDaemonScheduledTask,
} from "../daemon/scheduled-task.js";
import { BridgeError, asBridgeError, toStructuredError } from "../errors.js";
import { assertOutsideBridgeChild, createBridgeRequest } from "../request.js";
import { resolveWaitTimeoutMs } from "./timeout.js";

function output(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BridgeError("missing_option_value", `${name} requires a value.`);
  }
  return value;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current?.startsWith("--")) {
      index += 1;
    } else if (current !== undefined) {
      values.push(current);
    }
  }
  return values;
}

async function claudeVersion(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "claude";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "claude.cmd --version"] : ["--version"];
  const child = spawn(command, args, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = (await once(child, "close")) as [number | null];
  return code === 0
    ? { ok: true, version: stdout.trim() }
    : { ok: false, error: stderr.trim() || `exit ${String(code)}` };
}

function parseCleanupAge(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)([dhm])?$/u.exec(value);
  if (match?.[1] === undefined) {
    throw new BridgeError("invalid_cleanup_age", "--older-than must use an integer with optional d, h, or m.");
  }
  const quantity = Number(match[1]);
  const unit = match[2] ?? "d";
  const multiplier = unit === "d" ? 24 * 60 * 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 60 * 1000;
  const milliseconds = quantity * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new BridgeError("invalid_cleanup_age", "--older-than is too large.");
  }
  return milliseconds;
}

async function requireCleanupConfirmation(args: string[]): Promise<void> {
  if (option(args, "--confirm") === "DELETE") {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new BridgeError(
      "cleanup_confirmation_required",
      "--execute in a non-interactive shell requires --confirm DELETE.",
      { httpStatus: 409 },
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Type DELETE to remove expired bridge records: ");
    if (answer !== "DELETE") {
      throw new BridgeError("cleanup_confirmation_required", "Cleanup was not confirmed.", {
        httpStatus: 409,
      });
    }
  } finally {
    prompt.close();
  }
}

async function codexVersion(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "codex.cmd --version"] : ["--version"];
  const child = spawn(command, args, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = (await once(child, "close")) as [number | null];
  return code === 0
    ? { ok: true, version: stdout.trim() }
    : { ok: false, error: stderr.trim() || `exit ${String(code)}` };
}

async function doctor(): Promise<void> {
  const paths = getDaemonPaths();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const [claude, codex] = await Promise.all([claudeVersion(), codexVersion()]);
  let daemon: Record<string, unknown> | undefined;
  try {
    daemon = await daemonHealth(paths);
  } catch {
    daemon = undefined;
  }
  const healthy = nodeMajor === 24 && claude.ok && codex.ok;
  output({
    ok: healthy,
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    build_id: BRIDGE_BUILD_ID,
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    checks: {
      node: { ok: nodeMajor === 24, version: process.versions.node, required: "24.x" },
      claude,
      codex,
      daemon: daemon === undefined ? { ok: false, state: "stopped" } : { ok: true, ...daemon },
      runtime: { path: getBridgeHome() },
    },
  });
  if (!healthy) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(
      "Usage: bridge doctor|start|stop|auth|config|job|cleanup|update|install-daemon-task|submit|wait|status|result|cancel|approve-sync|discard-sync|sessions\n" +
        "  bridge auth rotate-token\n" +
        "  bridge config show|allow-model|remove-model|set-profile|reset\n" +
        "  bridge job retry <job-id> (--model <id>|--profile <name>)\n" +
        "  wait <job-id> [--timeout <seconds, default 45>] [--timeout-ms <milliseconds>]\n",
    );
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  assertOutsideBridgeChild();
  if (command === "start") {
    const endpoint = await ensureDaemon();
    output({ ok: true, data: endpoint });
    return;
  }
  if (command === "stop") {
    try {
      const data = await requestDaemon("/shutdown", { method: "POST", body: {} });
      output({ ok: true, data });
    } catch (error) {
      if (asBridgeError(error).code === "daemon_unavailable") {
        output({ ok: true, data: { stopping: false, state: "already_stopped" } });
        return;
      }
      throw error;
    }
    return;
  }
  if (command === "submit") {
    const target = option(args, "--target");
    const requestFile = option(args, "--request-file");
    if ((target !== "claude" && target !== "codex") || requestFile === undefined) {
      throw new BridgeError(
        "invalid_submit_arguments",
        "submit requires --target claude|codex and --request-file <path>.",
      );
    }
    let requestValue: unknown;
    try {
      requestValue = JSON.parse(await readFile(requestFile, "utf8")) as unknown;
    } catch (error) {
      throw new BridgeError("invalid_request_file", "Request file must contain valid JSON.", {
        cause: error,
      });
    }
    const paths = getDaemonPaths();
    const { config } = await readBridgeConfig(paths);
    const request = createBridgeRequest(requestValue, { origin: "cli", target, configuration: config });
    output({ ok: true, data: await submitJob(request, paths) });
    return;
  }
  if (command === "wait") {
    const jobId = positional(args)[0];
    if (jobId === undefined) {
      throw new BridgeError("missing_job_id", "wait requires a job ID.");
    }
    const timeoutMs = resolveWaitTimeoutMs((name) => option(args, name));
    output({ ok: true, data: await waitJob(jobId, timeoutMs) });
    return;
  }
  if (command === "status") {
    const jobId = positional(args)[0];
    output({ ok: true, data: jobId === undefined ? await getBridgeStatus() : await getJobStatus(jobId) });
    return;
  }
  if (command === "result") {
    const jobId = positional(args)[0];
    if (jobId === undefined) {
      throw new BridgeError("missing_job_id", "result requires a job ID.");
    }
    output({ ok: true, data: await getJobResult(jobId) });
    return;
  }
  if (command === "cancel") {
    const jobId = positional(args)[0];
    if (jobId === undefined) {
      throw new BridgeError("missing_job_id", "cancel requires a job ID.");
    }
    output({ ok: true, data: await cancelJob(jobId) });
    return;
  }
  if (command === "rotate-token") {
    output({ ok: true, data: await rotateBridgeToken() });
    return;
  }
  if (command === "auth") {
    if (args[0] !== "rotate-token" || args.length !== 1) {
      throw new BridgeError("invalid_auth_command", "Use bridge auth rotate-token.");
    }
    output({ ok: true, data: await rotateBridgeToken() });
    return;
  }
  if (command === "config") {
    const [action, ...configArgs] = args;
    if (action === "show") {
      output({ ok: true, data: await getBridgeConfig() });
      return;
    }
    if (action === "allow-model") {
      const model = option(configArgs, "--model");
      const target = option(configArgs, "--target");
      const efforts = option(configArgs, "--efforts");
      if (model === undefined || target === undefined || efforts === undefined) {
        throw new BridgeError(
          "invalid_config_command",
          "allow-model requires --model, --target, and --efforts.",
        );
      }
      output({
        ok: true,
        data: await mutateBridgeConfig({
          action: "allow-model",
          model,
          target,
          efforts: efforts.split(",").map((item) => item.trim()).filter(Boolean),
        }),
      });
      return;
    }
    if (action === "remove-model") {
      const model = option(configArgs, "--model");
      if (model === undefined) {
        throw new BridgeError("invalid_config_command", "remove-model requires --model.");
      }
      output({ ok: true, data: await mutateBridgeConfig({ action: "remove-model", model }) });
      return;
    }
    if (action === "set-profile") {
      const profile = option(configArgs, "--profile");
      const target = option(configArgs, "--target");
      const model = option(configArgs, "--model");
      const reasoningEffort = option(configArgs, "--effort");
      const ruleId = option(configArgs, "--rule-id");
      if (
        profile === undefined
        || target === undefined
        || model === undefined
        || reasoningEffort === undefined
      ) {
        throw new BridgeError(
          "invalid_config_command",
          "set-profile requires --profile, --target, --model, and --effort.",
        );
      }
      output({
        ok: true,
        data: await mutateBridgeConfig({
          action: "set-profile",
          profile,
          target,
          model,
          reasoningEffort,
          ...(ruleId === undefined ? {} : { ruleId }),
        }),
      });
      return;
    }
    if (action === "reset" && configArgs.length === 0) {
      output({ ok: true, data: await mutateBridgeConfig({ action: "reset" }) });
      return;
    }
    throw new BridgeError(
      "invalid_config_command",
      "Use bridge config show|allow-model|remove-model|set-profile|reset.",
    );
  }
  if (command === "cleanup") {
    const execute = args.includes("--execute");
    if (execute) {
      await requireCleanupConfirmation(args);
    }
    const jobId = option(args, "--job-id");
    const olderThanMs = parseCleanupAge(option(args, "--older-than"));
    output({
      ok: true,
      data: await cleanupBridgeRuntime({
        ...(jobId === undefined ? {} : { job_id: jobId }),
        ...(olderThanMs === undefined ? {} : { older_than_ms: olderThanMs }),
        ...(args.includes("--include-jobs") ? { include_jobs: true } : {}),
        ...(execute ? { execute: true } : {}),
      }),
    });
    return;
  }
  if (command === "job") {
    const [action, jobId, ...jobArgs] = args;
    if (action !== "retry" || jobId === undefined) {
      throw new BridgeError("invalid_job_command", "Use bridge job retry <job-id> (--model|--profile).");
    }
    const model = option(jobArgs, "--model");
    const profile = option(jobArgs, "--profile");
    if ((model === undefined ? 0 : 1) + (profile === undefined ? 0 : 1) !== 1) {
      throw new BridgeError(
        "invalid_job_command",
        "retry requires exactly one of --model or --profile.",
      );
    }
    const retryRoute = model === undefined
      ? profile === undefined
        ? undefined
        : { task_profile: profile }
      : { model };
    if (retryRoute === undefined) {
      throw new BridgeError("invalid_job_command", "retry requires a model or profile.");
    }
    output({
      ok: true,
      data: await retryJob(jobId, retryRoute),
    });
    return;
  }
  if (command === "install-daemon-task") {
    const endpoint = await ensureDaemon();
    const daemonMain = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
    const projectRoot = resolve(dirname(daemonMain), "../../..");
    const scriptPath = join(projectRoot, "scripts", "Register-BridgeDaemonTask.ps1");
    await installDaemonScheduledTask(
      scriptPath,
      process.execPath,
      daemonMain,
      projectRoot,
    );
    output({
      ok: true,
      data: {
        installed: true,
        task_name: DAEMON_TASK_NAME,
        daemon: endpoint,
      },
    });
    return;
  }
  if (command === "approve-sync") {
    const jobId = positional(args)[0];
    const rawChangeIds = option(args, "--change-ids");
    if (jobId === undefined || rawChangeIds === undefined) {
      throw new BridgeError(
        "missing_sync_approval",
        "approve-sync requires a job ID and --change-ids with the exact comma-separated IDs.",
      );
    }
    const changeIds = rawChangeIds.split(",").map((value) => value.trim()).filter(Boolean);
    output({ ok: true, data: await approvePeerSync(jobId, changeIds) });
    return;
  }
  if (command === "discard-sync") {
    const jobId = positional(args)[0];
    if (jobId === undefined) {
      throw new BridgeError("missing_job_id", "discard-sync requires a job ID.");
    }
    output({ ok: true, data: await discardPeerSync(jobId) });
    return;
  }
  if (command === "sessions") {
    output({ ok: true, data: await listSessions() });
    return;
  }
  throw new BridgeError("unknown_command", `Unknown bridge command: ${command}.`);
}

main().catch((error: unknown) => {
  const bridgeError = asBridgeError(error);
  output({ ok: false, error: toStructuredError(bridgeError) });
  process.exitCode = 1;
});
