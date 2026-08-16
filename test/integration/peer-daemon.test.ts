import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  approvePeerSync,
  cancelJob,
  getJobStatus,
  listSessions,
  submitJob,
  waitJob,
} from "../../src/api.js";
import type { HeadlessOutcome, HeadlessRunOptions } from "../../src/adapter/claude.js";
import type { HeadlessRunner } from "../../src/daemon/scheduler.js";
import { BridgeDaemon } from "../../src/daemon/server.js";
import { createBridgeRequest } from "../../src/request.js";
import { temporaryPaths } from "../helpers.js";
import { sha256 } from "../../src/hash.js";

process.env.BRIDGE_SKIP_ACL = "1";

class FakePeerRunner implements HeadlessRunner {
  readonly codexSessions: string[] = [];

  async run(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
    return this.complete(options, options.model ?? "claude-opus-5");
  }

  async runCodex(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
    const sessionId = options.targetSessionId ?? randomUUID();
    this.codexSessions.push(sessionId);
    await options.hooks?.onTransportDelivered?.();
    await options.hooks?.onRunning?.();
    if (options.prompt.includes("high-risk deletion") && options.workspacePath !== undefined) {
      await unlink(join(options.workspacePath, "src", "a.txt"));
      await writeFile(join(options.workspacePath, "src", "b.txt"), "peer addition\n", "utf8");
    }
    if (options.prompt.includes("blocked task") && options.workspacePath !== undefined) {
      await writeFile(join(options.workspacePath, "src", "a.txt"), "unsynchronized peer write\n", "utf8");
    }
    const cancelled = await new Promise<boolean>((resolve) => {
      const duration = options.prompt.includes("slow cancellation") ? 5_000 : 10;
      const timer = setTimeout(() => resolve(false), duration);
      const abort = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      if (options.signal?.aborted === true) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }
    });
    return {
      classification: cancelled ? "cancelled" : "success",
      is_error: cancelled,
      session_id: sessionId,
      ...(cancelled
        ? {}
        : {
            result:
              options.prompt.includes("blocked task")
                ? [
                    "DELIVERABLE_REVIEW",
                    "",
                    "- Changed files: none.",
                    "- Unmet criteria: result.txt was not created.",
                    "- Blocking error: the workspace is read-only here; writes were blocked by policy.",
                  ].join("\n")
                : options.operation === "review_repair"
                ? [
                    "DELIVERABLE_REVIEW",
                    "结论：需修改",
                    "已确认事项：",
                    "- isolated changes were inspected",
                    "问题与理由：",
                    "- fixture requires user review",
                    "必须修改：",
                    "- approve or reject the high-risk changes",
                    "剩余风险：",
                    "- deletion remains withheld",
                  ].join("\n")
                : "CODEX_PEER_OK",
          }),
      details: {
        exit_code: null,
        stderr: "",
        complete_stdout_lines: [],
        requested_model: options.model ?? "gpt-5.6-sol",
        requested_reasoning_effort: options.reasoningEffort ?? "max",
        ...(options.taskProfile === undefined ? {} : { task_profile: options.taskProfile }),
        ...(options.routingSource === undefined ? {} : { routing_source: options.routingSource }),
        ...(options.routingRuleId === undefined ? {} : { routing_rule_id: options.routingRuleId }),
        cli_version: "codex-cli test",
        thread_id: sessionId,
      },
    };
  }

  private async complete(options: HeadlessRunOptions, model: string): Promise<HeadlessOutcome> {
    await options.hooks?.onTransportDelivered?.();
    await options.hooks?.onRunning?.();
    const sessionId = options.sessionId ?? randomUUID();
    return {
      classification: "success",
      is_error: false,
      result: "CLAUDE_PEER_OK",
      session_id: sessionId,
      details: {
        exit_code: 0,
        stderr: "",
        complete_stdout_lines: [],
        reported_model: model,
        requested_model: model,
        requested_reasoning_effort: options.reasoningEffort ?? "max",
      },
    };
  }
}

async function waitUntilRunning(jobId: string, paths: Awaited<ReturnType<typeof temporaryPaths>>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await getJobStatus(jobId, paths);
    if (status.state === "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not reach running");
}

test("daemon routes Claude to Codex, preserves exact threads, and resumes after cancellation", async () => {
  const paths = await temporaryPaths("bridge-peer-daemon-");
  const adapter = new FakePeerRunner();
  const daemon = new BridgeDaemon({ paths, adapter, port: 0 });
  await daemon.start();
  try {
    const bridgeThreadId = `codex-thread-${randomUUID()}`;
    const submitted = await submitJob(
      createBridgeRequest(
        { question: "first Codex turn", operation: "ask", bridge_thread_id: bridgeThreadId },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const first = await waitJob(submitted.job_id, 5_000, paths);
    assert.equal(first.status, "complete");
    assert.equal(first.job?.state, "succeeded");
    assert.equal(first.job?.review_model, undefined);
    assert.equal(first.job?.requested_model, "gpt-5.6-sol");
    assert.equal(first.job?.requested_reasoning_effort, "max");
    assert.equal(typeof first.job?.session_id, "string");

    const balancedThreadId = `balanced-thread-${randomUUID()}`;
    const balanced = await submitJob(
      createBridgeRequest(
        {
          question: "balanced Codex turn",
          operation: "ask",
          bridge_thread_id: balancedThreadId,
          taskProfile: "balanced",
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const balancedResult = await waitJob(balanced.job_id, 5_000, paths);
    assert.equal(balancedResult.job?.state, "succeeded");
    assert.equal(balancedResult.job?.requested_model, "gpt-5.6-terra");
    assert.equal(balancedResult.job?.requested_reasoning_effort, "max");
    assert.equal(balancedResult.job?.task_profile, "balanced");
    assert.equal(balancedResult.job?.routing_source, "profile");

    const changedRoute = await submitJob(
      createBridgeRequest(
        {
          question: "try to change the recorded route",
          operation: "ask",
          bridge_thread_id: balancedThreadId,
          taskProfile: "high_volume",
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const changedRouteResult = await waitJob(changedRoute.job_id, 5_000, paths);
    assert.equal(changedRouteResult.job?.state, "failed");
    assert.equal(changedRouteResult.job?.error?.code, "session_model_mismatch");

    const resumed = await submitJob(
      createBridgeRequest(
        {
          question: "resume exact Codex turn",
          operation: "ask",
          bridge_thread_id: bridgeThreadId,
          target_session_id: first.job?.session_id,
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const resumedResult = await waitJob(resumed.job_id, 5_000, paths);
    assert.equal(
      resumedResult.job?.state,
      "succeeded",
      JSON.stringify(resumedResult.job?.error ?? resumedResult),
    );
    assert.equal(resumedResult.job?.session_id, first.job?.session_id);

    const cancelThreadId = `cancel-thread-${randomUUID()}`;
    const cancellable = await submitJob(
      createBridgeRequest(
        { question: "slow cancellation", operation: "ask", bridge_thread_id: cancelThreadId },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    await waitUntilRunning(cancellable.job_id, paths);
    const cancelled = await cancelJob(cancellable.job_id, paths);
    assert.equal(cancelled.target_confirmed, true);
    const cancelledResult = await waitJob(cancellable.job_id, 0, paths);
    assert.equal(cancelledResult.job?.state, "cancelled");
    assert.equal(typeof cancelledResult.job?.session_id, "string");

    const afterCancel = await submitJob(
      createBridgeRequest(
        {
          question: "resume after cancellation",
          operation: "ask",
          bridge_thread_id: cancelThreadId,
          target_session_id: cancelledResult.job?.session_id,
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const afterCancelResult = await waitJob(afterCancel.job_id, 5_000, paths);
    assert.equal(afterCancelResult.job?.state, "succeeded");
    assert.equal(afterCancelResult.job?.session_id, cancelledResult.job?.session_id);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon requires exact explicit approval before synchronizing high-risk changes", async () => {
  const paths = await temporaryPaths("bridge-peer-approval-");
  const target = join(paths.root, "project");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "a.txt"), "author baseline\n", "utf8");
  const artifactContent = "Review the high-risk deletion fixture.";
  const daemon = new BridgeDaemon({ paths, adapter: new FakePeerRunner(), port: 0 });
  await daemon.start();
  try {
    const submitted = await submitJob(
      createBridgeRequest(
        {
          question: "high-risk deletion",
          operation: "review_repair",
          artifactId: "approval-fixture",
          artifactType: "deliverable",
          artifactName: "src",
          artifactContent,
          artifactBytes: Buffer.byteLength(artifactContent),
          artifactSha256: sha256(artifactContent),
          targetRoot: target,
          allowedPaths: ["src"],
          round: 1,
          priorRounds: [],
          acceptanceCriteria: ["report and withhold all high-risk changes"],
          testCommands: [],
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const reviewed = await waitJob(submitted.job_id, 5_000, paths);
    assert.equal(reviewed.status, "complete");
    assert.equal(reviewed.job?.state, "needs_attention");
    assert.equal(reviewed.job?.sync_status, "awaiting_user");
    assert.equal(reviewed.job?.pending_high_risk?.[0]?.action, "delete");
    assert.equal(await readFile(join(target, "src", "a.txt"), "utf8"), "author baseline\n");
    const protectedReview = JSON.parse(
      await readFile(join(paths.jobs, `${submitted.job_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(typeof protectedReview["workspace_manifest"], "object");
    assert.equal(typeof protectedReview["result_workspace_manifest"], "object");

    const blockedByApproval = await submitJob(
      createBridgeRequest(
        {
          question: "do not overwrite the retained approval workspace",
          operation: "task",
          artifactId: "overlapping-task",
          targetRoot: target,
          allowedPaths: ["src"],
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const blockedByApprovalResult = await waitJob(blockedByApproval.job_id, 5_000, paths);
    assert.equal(blockedByApprovalResult.job?.state, "failed");
    assert.equal(blockedByApprovalResult.job?.error_code, "retained_workspace_conflict");

    await assert.rejects(
      approvePeerSync(submitted.job_id, ["0".repeat(64)], paths),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "sync_approval_mismatch",
    );
    const approved = await approvePeerSync(
      submitted.job_id,
      reviewed.job?.pending_high_risk?.map((change) => change.id) ?? [],
      paths,
    );
    assert.equal(approved.state, "succeeded");
    assert.equal(approved.sync_status, "synced");
    assert.match(approved.sync_request_id, /^[0-9a-f-]{36}$/u);
    await assert.rejects(readFile(join(target, "src", "a.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(join(target, "src", "b.txt"), "utf8"), "peer addition\n");
    const final = await getJobStatus(submitted.job_id, paths);
    assert.equal(final.state, "succeeded");
    assert.equal(final.error_code, undefined);
    assert.equal(final.sync_request_id, approved.sync_request_id);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("daemon fails an explicitly blocked task before synchronizing its workspace", async () => {
  const paths = await temporaryPaths("bridge-peer-task-blocked-");
  const target = join(paths.root, "project");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "a.txt"), "author baseline\n", "utf8");
  const daemon = new BridgeDaemon({ paths, adapter: new FakePeerRunner(), port: 0 });
  await daemon.start();
  try {
    const blockedThreadId = "blocked-task-thread";
    const submitted = await submitJob(
      createBridgeRequest(
        {
          question: "blocked task",
          operation: "task",
          artifactId: "blocked-task-fixture",
          artifactType: "deliverable",
          targetRoot: target,
          allowedPaths: ["src/a.txt"],
          bridge_thread_id: blockedThreadId,
          round: 1,
          priorRounds: [],
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const finished = await waitJob(submitted.job_id, 5_000, paths);
    assert.equal(finished.status, "complete");
    assert.equal(finished.job?.state, "failed");
    assert.equal(finished.job?.error_code, "peer_contract_error");
    assert.equal(finished.job?.sync_status, "failed");
    assert.match(finished.job?.result ?? "", /^PEER_REVIEW_FAILURE_REPORT/mu);
    assert.equal(await readFile(join(target, "src", "a.txt"), "utf8"), "author baseline\n");
    const failedSessionId = finished.job?.session_id;
    assert.equal(typeof failedSessionId, "string");
    assert.equal(
      (await listSessions(paths)).sessions.find(
        (session) => session.bridge_thread_id === blockedThreadId,
      )?.status,
      "needs_attention",
    );

    const resumed = await submitJob(
      createBridgeRequest(
        {
          question: "resume after contract failure",
          operation: "ask",
          bridge_thread_id: blockedThreadId,
          target_session_id: failedSessionId,
        },
        { origin: "test", target: "codex" },
      ),
      paths,
    );
    const resumedResult = await waitJob(resumed.job_id, 5_000, paths);
    assert.equal(resumedResult.job?.state, "succeeded");
    assert.equal(resumedResult.job?.session_id, failedSessionId);
  } finally {
    await daemon.stop();
    await rm(paths.root, { recursive: true, force: true });
  }
});
