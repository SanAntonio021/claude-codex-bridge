import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelJob,
  getJobStatus,
  submitJob,
  waitJob,
} from "../../src/api.js";
import { getDaemonPaths, type DaemonPaths } from "../../src/config.js";
import { BridgeDaemon } from "../../src/daemon/server.js";
import { createBridgeRequest } from "../../src/request.js";
import { sha256 } from "../../src/hash.js";
import type { PublicJobResult } from "../../src/types.js";
import {
  CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
} from "../../src/adapter/codex.js";

/**
 * M3 acceptance evidence for the Claude-to-Codex direction. This suite uses
 * the real bridge daemon and @openai/codex-sdk adapter, so it consumes quota
 * and is excluded from npm test. It proves a real write task, cancellation,
 * and recovery of the exact recorded Codex thread.
 */

interface ProtectedJobDetails {
  state?: string;
  error?: unknown;
  result?: string;
  sync_status?: string;
  changed_files?: string[];
  test_results?: string[];
  adapter_details?: {
    requested_model?: string;
    requested_reasoning_effort?: string;
    task_profile?: string;
    routing_source?: string;
    cli_version?: string;
    requested_sandbox_mode?: string;
    approval_policy?: string;
    project_doc_max_bytes?: number;
    skill_instructions_enabled?: boolean;
    environment_context_enabled?: boolean;
    windows_sandbox_mode?: string;
    thread_id?: string;
    workspace_path?: string;
    baseline_manifest_hash?: string;
    result_manifest_hash?: string;
  };
}

async function readProtectedJob(paths: DaemonPaths, jobId: string): Promise<ProtectedJobDetails> {
  return JSON.parse(
    await readFile(join(paths.jobs, `${jobId}.json`), "utf8"),
  ) as ProtectedJobDetails;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function assertTaskAccepted(
  paths: DaemonPaths,
  jobId: string,
  taskResult: PublicJobResult,
  resultPath: string,
): Promise<ProtectedJobDetails> {
  const protectedDetails = await readProtectedJob(paths, jobId);
  const resultContents = await readOptionalText(resultPath);
  const accepted =
    taskResult.state === "succeeded" &&
    taskResult.sync_status === "synced" &&
    taskResult.changed_files?.includes("result.txt") === true &&
    resultContents === "BRIDGE_CODEX_OK\n";
  if (!accepted) {
    throw new Error(
      `M3 Codex task acceptance failed; protected evidence retained at ${paths.root}:\n${JSON.stringify(
        {
          job_id: jobId,
          state: taskResult.state,
          error: taskResult.error,
          result: taskResult.result,
          requested_model:
            protectedDetails.adapter_details?.requested_model ?? taskResult.requested_model,
          cli_version: protectedDetails.adapter_details?.cli_version,
          thread_id:
            protectedDetails.adapter_details?.thread_id ?? taskResult.session_id,
          sync_status: taskResult.sync_status ?? protectedDetails.sync_status,
          changed_files: taskResult.changed_files ?? protectedDetails.changed_files,
          tests: protectedDetails.test_results,
          result_file: resultContents,
        },
        null,
        2,
      )}`,
    );
  }
  return protectedDetails;
}

async function waitComplete(paths: DaemonPaths, jobId: string): Promise<PublicJobResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waited = await waitJob(jobId, 45_000, paths);
    if (waited.status === "complete" && waited.job !== undefined) {
      return waited.job;
    }
  }
  throw new Error(`Codex bridge job ${jobId} remained pending after 180 seconds.`);
}

async function waitUntilRunning(paths: DaemonPaths, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await getJobStatus(jobId, paths);
    if (status.state === "running" || status.state === "transport_delivered") {
      return;
    }
    if (["failed", "cancelled", "expired", "needs_attention", "succeeded"].includes(status.state)) {
      throw new Error(`Codex cancellation job reached ${status.state} before it was running.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Codex cancellation job did not reach running within 30 seconds.");
}

async function run(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The Codex live acceptance test requires Windows SDK process semantics.");
  }

  // The local Codex policy excludes %TEMP% from workspace-write. Keep the
  // disposable fixture under the bridge's non-Temp live-test root instead.
  const liveBase = join(process.env.LOCALAPPDATA ?? tmpdir(), "claude-codex-bridge", "live-tests");
  await mkdir(liveBase, { recursive: true });
  const root = await mkdtemp(join(liveBase, "codex-peer-"));
  const paths = getDaemonPaths(root);
  const targetRoot = join(root, "project");
  const resultPath = join(targetRoot, "result.txt");
  const verifyPath = join(targetRoot, "verify-result.mjs");
  const bridgeThreadId = `m3-live-${randomUUID()}`;
  const originalCwd = process.cwd();
  process.chdir(root);
  const daemon = new BridgeDaemon({ paths });
  let completed = false;

  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, "README.md"), "Disposable Codex bridge fixture.\n", "utf8");
    await writeFile(
      verifyPath,
      [
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'assert.equal(await readFile(new URL("./result.txt", import.meta.url), "utf8"), "BRIDGE_CODEX_OK\\n");',
        'process.stdout.write("VERIFY_RESULT_OK\\n");',
        "",
      ].join("\n"),
      "utf8",
    );
    await daemon.start();

    const task = await submitJob(
      createBridgeRequest(
        {
          question:
            "In the isolated bridge workspace, create result.txt containing exactly BRIDGE_CODEX_OK followed by a newline. Verify it by running node verify-result.mjs directly, then return a concise DELIVERABLE_REVIEW.",
          operation: "task",
          bridge_thread_id: bridgeThreadId,
          artifact_id: "m3-codex-live-task",
          artifact_type: "deliverable",
          artifact_name: "result.txt",
          target_root: targetRoot,
          allowed_paths: ["result.txt"],
          round: 1,
          acceptance_criteria: [
            "Only result.txt is added.",
            "The file content is exactly BRIDGE_CODEX_OK followed by a newline.",
            "node verify-result.mjs exits successfully and prints VERIFY_RESULT_OK.",
          ],
          prior_rounds: [],
          prior_findings: [],
          open_items: [],
          test_commands: ["node verify-result.mjs"],
          route: "headless",
        },
        { origin: "m3-codex-live", target: "codex" },
      ),
      paths,
    );
    const taskResult = await waitComplete(paths, task.job_id);
    const protectedDetails = await assertTaskAccepted(paths, task.job_id, taskResult, resultPath);
    assert.equal(taskResult.state, "succeeded", JSON.stringify(taskResult.error));
    assert.equal(taskResult.sync_status, "synced");
    assert.ok(taskResult.changed_files?.includes("result.txt"));
    assert.equal(await readFile(resultPath, "utf8"), "BRIDGE_CODEX_OK\n");
    assert.equal(taskResult.requested_model, DEFAULT_CODEX_MODEL);
    assert.equal(taskResult.requested_reasoning_effort, CODEX_REASONING_EFFORT);
    assert.equal(taskResult.task_profile, "quality");
    assert.equal(taskResult.routing_source, "default");
    assert.match(taskResult.session_id ?? "", /^.+$/u);
    const establishedSessionId = taskResult.session_id as string;
    assert.equal(protectedDetails.adapter_details?.requested_model, taskResult.requested_model);
    assert.equal(
      protectedDetails.adapter_details?.requested_reasoning_effort,
      CODEX_REASONING_EFFORT,
    );
    assert.equal(protectedDetails.adapter_details?.task_profile, "quality");
    assert.equal(protectedDetails.adapter_details?.routing_source, "default");
    assert.equal(protectedDetails.adapter_details?.thread_id, establishedSessionId);
    assert.match(protectedDetails.adapter_details?.cli_version ?? "", /^.+$/u);
    assert.equal(protectedDetails.adapter_details?.requested_sandbox_mode, "workspace-write");
    assert.equal(protectedDetails.adapter_details?.approval_policy, "never");
    assert.equal(protectedDetails.adapter_details?.project_doc_max_bytes, 0);
    assert.equal(protectedDetails.adapter_details?.skill_instructions_enabled, false);
    assert.equal(protectedDetails.adapter_details?.environment_context_enabled, true);
    assert.equal(protectedDetails.adapter_details?.windows_sandbox_mode, "unelevated");

    const cancellable = await submitJob(
      createBridgeRequest(
        {
          question:
            "Continue in this same thread and count from 1 to 100000, one number per line, with no commentary. This deliberately long turn will be cancelled by the bridge.",
          operation: "ask",
          bridge_thread_id: bridgeThreadId,
          target_session_id: establishedSessionId,
          route: "headless",
        },
        { origin: "m3-codex-live", target: "codex" },
      ),
      paths,
    );
    await waitUntilRunning(paths, cancellable.job_id);
    const cancelled = await cancelJob(cancellable.job_id, paths);
    assert.equal(cancelled.target_confirmed, true);
    const cancelledResult = await waitJob(cancellable.job_id, 0, paths);
    assert.equal(cancelledResult.status, "complete");
    assert.equal(cancelledResult.job?.state, "cancelled");
    assert.equal(cancelledResult.job?.session_id, establishedSessionId);

    const resumed = await submitJob(
      createBridgeRequest(
        {
          question: "Reply with exactly M3_RESUMED_OK and nothing else.",
          operation: "ask",
          bridge_thread_id: bridgeThreadId,
          target_session_id: establishedSessionId,
          route: "headless",
        },
        { origin: "m3-codex-live", target: "codex" },
      ),
      paths,
    );
    const resumedResult = await waitComplete(paths, resumed.job_id);
    assert.equal(resumedResult.state, "succeeded", JSON.stringify(resumedResult.error));
    assert.equal(resumedResult.session_id, establishedSessionId);
    assert.match(resumedResult.result ?? "", /M3_RESUMED_OK/u);

    completed = true;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        suite: "Claude-to-Codex bridge task, cancellation, and exact-thread recovery",
        request_model: taskResult.requested_model,
        requested_reasoning_effort: taskResult.requested_reasoning_effort,
        cli_version: protectedDetails.adapter_details?.cli_version,
        requested_sandbox_mode: protectedDetails.adapter_details?.requested_sandbox_mode,
        approval_policy: protectedDetails.adapter_details?.approval_policy,
        skill_instructions_enabled: protectedDetails.adapter_details?.skill_instructions_enabled,
        environment_context_enabled: protectedDetails.adapter_details?.environment_context_enabled,
        windows_sandbox_mode: protectedDetails.adapter_details?.windows_sandbox_mode,
        task_job_id: task.job_id,
        cancellation_job_id: cancellable.job_id,
        resume_job_id: resumed.job_id,
        thread_id: establishedSessionId,
        task_sha256: sha256(await readFile(resultPath)),
        cancellation_state: cancelledResult.job?.state,
        resumed_state: resumedResult.state,
      })}\n`,
    );
  } finally {
    await daemon.stop().catch(() => undefined);
    process.chdir(originalCwd);
    if (completed) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`${JSON.stringify({ retained_live_test_root: root })}\n`);
    }
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
