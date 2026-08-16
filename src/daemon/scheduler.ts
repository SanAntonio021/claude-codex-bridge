import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BridgeError, asBridgeError, toStructuredError } from "../errors.js";
import { LIMITS } from "../constants.js";
import { sha256Json } from "../hash.js";
import {
  buildBridgePrompt,
  terminateProcessTree,
  type HeadlessOutcome,
  type HeadlessRunOptions,
} from "../adapter/claude.js";
import {
  WorkspaceManager,
  type SyncResult,
  type WorkspaceHandle,
} from "../workspace.js";
import {
  isTerminalState,
  type BridgeRequest,
  type JobRecord,
  type JobState,
} from "../types.js";
import {
  peerReviewFailureReport,
  validatePeerOutcome,
} from "../review-contract.js";
import { JobStore } from "./store.js";
import { SessionStore } from "./sessions.js";

export interface HeadlessRunner {
  run(options: HeadlessRunOptions): Promise<HeadlessOutcome>;
  runCodex?(options: HeadlessRunOptions): Promise<HeadlessOutcome>;
}

interface ActiveExecution {
  controller: AbortController;
  threadKey: string;
  completion: Promise<void>;
}

export interface CancellationResult {
  job_id: string;
  cancellation_requested: boolean;
  target_confirmed: boolean;
  state: JobState;
}

function outcomeErrorCode(outcome: HeadlessOutcome): string {
  switch (outcome.classification) {
    case "result_error":
      return "headless_result_error";
    case "parameter_error":
      return "headless_parameter_error";
    case "stream_interrupted":
      return "headless_stream_interrupted";
    case "isolation_breach":
      return "isolation_breach";
    case "model_mismatch":
      return "model_mismatch";
    case "protocol_error":
      return "headless_protocol_error";
    case "spawn_error":
      return "headless_spawn_error";
    case "cancelled":
      return "headless_cancelled";
    case "output_limit_exceeded":
      return "headless_output_limit_exceeded";
    case "codex_error":
      return "codex_error";
    case "codex_protocol_error":
      return "codex_protocol_error";
    case "success":
      return "headless_success";
  }
}

function outcomeMessage(outcome: HeadlessOutcome): string {
  switch (outcome.classification) {
    case "result_error":
      return "Claude returned a result event with is_error=true.";
    case "parameter_error":
      return "Claude exited with a parameter error before emitting stdout.";
    case "stream_interrupted":
      return "Claude stream ended without a complete result event.";
    case "isolation_breach":
      return "Claude violated the fixed workspace or tool isolation contract.";
    case "model_mismatch":
      return "Peer runtime did not report the exact selected model.";
    case "protocol_error":
      return "Claude stream did not satisfy the expected JSONL protocol.";
    case "spawn_error":
      return "Peer headless process could not be started or receive input.";
    case "cancelled":
      return "Claude headless process was cancelled.";
    case "output_limit_exceeded":
      return "Claude headless stream exceeded the protected output limit.";
    case "codex_error":
      return "Codex peer task returned an error.";
    case "codex_protocol_error":
      return "Codex peer stream did not contain a complete turn.";
    case "success":
      return "Peer completed successfully.";
  }
}

function publicOutcomeDetails(outcome: HeadlessOutcome): Record<string, unknown> {
  return {
    classification: outcome.classification,
    ...(outcome.details.isolation_violation === undefined
      ? {}
      : { isolation_violation: outcome.details.isolation_violation }),
  };
}

export interface SyncApprovalResult {
  job_id: string;
  state: JobState;
  sync_status: "synced";
  sync_request_id: string;
  changed_files: string[];
}

export interface SyncDiscardResult {
  job_id: string;
  state: "failed";
  sync_status: "discarded";
  discarded_at: string;
}

function workspaceArtifactPath(
  request: BridgeRequest,
  workspacePath: string | undefined,
): string | undefined {
  if (
    request.artifact_path === undefined
    || request.target_root === undefined
    || workspacePath === undefined
  ) {
    return request.artifact_path;
  }
  const targetRoot = resolve(request.target_root);
  const artifactPath = isAbsolute(request.artifact_path)
    ? resolve(request.artifact_path)
    : resolve(targetRoot, request.artifact_path);
  if (!pathIsInside(targetRoot, artifactPath)) {
    return request.artifact_path;
  }
  return resolve(workspacePath, relative(targetRoot, artifactPath));
}

export function requestPrompt(request: BridgeRequest, workspacePath?: string): string {
  const mappedArtifactPath = workspaceArtifactPath(request, workspacePath);
  const artifactEnvelope = request.artifact_id === undefined
    ? undefined
    : JSON.stringify({
        artifactId: request.artifact_id,
        artifactType: request.artifact_type,
        author: request.author,
        reviewer: request.reviewer,
        taskProfile: request.task_profile,
        model: request.model,
        reasoningEffort: request.reasoning_effort,
        routingSource: request.routing_source,
        routingRuleId: request.routing_rule_id,
        artifactName: request.artifact_name,
        artifactPath: mappedArtifactPath,
        artifactBytes: request.artifact_bytes,
        artifactSha256: request.artifact_sha256,
        artifactContent: request.artifact_content,
        round: request.round,
        maxRounds: request.max_rounds ?? 3,
        targetRoot: request.target_root === undefined
          ? undefined
          : workspacePath ?? request.target_root,
        allowedPaths: request.allowed_paths ?? [],
        priorRounds: request.prior_rounds ?? [],
        priorFindings: request.prior_findings ?? [],
        openItems: request.open_items ?? [],
        acceptanceCriteria: request.acceptance_criteria ?? [],
        testCommands: request.test_commands ?? [],
        constraints: request.constraints ?? [],
        ...(request.reviewer_access === undefined
          ? {}
          : { reviewerAccess: request.reviewer_access }),
      });
  const context = [
    request.context,
    artifactEnvelope === undefined ? undefined : `Peer artifact envelope:\n${artifactEnvelope}`,
  ]
    .filter((item): item is string => item !== undefined && item !== "")
    .join("\n\n");
  return buildBridgePrompt(
    request.question,
    context === "" ? undefined : context,
    request.operation,
    request.test_commands ?? [],
  );
}

function pathIsInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function rootsOverlap(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return pathIsInside(normalizedLeft, normalizedRight) || pathIsInside(normalizedRight, normalizedLeft);
}

export class JobScheduler {
  readonly #store: JobStore;
  readonly #sessions: SessionStore;
  readonly #adapter: HeadlessRunner;
  readonly #workspace: WorkspaceManager | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #activeThreads = new Set<string>();
  #scheduling = false;
  #stopping = false;
  #submitLock: Promise<void> = Promise.resolve();

  constructor(
    store: JobStore,
    sessions: SessionStore,
    adapter: HeadlessRunner,
    workspace?: WorkspaceManager,
  ) {
    this.#store = store;
    this.#sessions = sessions;
    this.#adapter = adapter;
    this.#workspace = workspace;
  }

  async recoverAndStart(): Promise<JobRecord[]> {
    await this.expireLegacySyncLeases();
    for (const record of this.#store.list()) {
      if (
        ["dispatching", "transport_delivered", "running"].includes(record.state) &&
        record.child_pid !== undefined
      ) {
        await terminateProcessTree(record.child_pid);
      }
    }
    const recovered = await this.#store.recoverUncertain();
    for (const record of recovered) {
      if (record.request.bridge_thread_id !== undefined && record.state === "needs_attention") {
        await this.#sessions.setStatus(record.request.bridge_thread_id, "needs_attention");
      }
    }
    this.schedule();
    return recovered;
  }

  async submit(request: BridgeRequest): Promise<{ record: JobRecord; created: boolean }> {
    await this.expireLegacySyncLeases();
    let release!: () => void;
    const previous = this.#submitLock;
    this.#submitLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const matching = this.#store
        .list()
        .find(
          (record) =>
            record.request.origin === request.origin &&
            record.request.idempotency_key === request.idempotency_key,
        );
      if (matching !== undefined) {
        if (matching.request_hash !== sha256Json(request)) {
          throw new BridgeError(
            "idempotency_conflict",
            "Idempotency key was already used for a different request.",
            { httpStatus: 409 },
          );
        }
        return { record: matching, created: false };
      }
      if (this.#store.count("queued") >= LIMITS.queuedJobs) {
        throw new BridgeError("queue_full", "Bridge queue has reached its 20-job limit.", {
          httpStatus: 429,
          retryable: true,
        });
      }
      const created = await this.#store.create(request);
      this.schedule();
      return created;
    } finally {
      release();
    }
  }

  schedule(): void {
    if (this.#scheduling || this.#stopping) {
      return;
    }
    this.#scheduling = true;
    queueMicrotask(() => {
      this.#scheduling = false;
      this.#fillSlots();
    });
  }

  async cancel(jobId: string): Promise<CancellationResult> {
    const record = this.#store.require(jobId);
    if (isTerminalState(record.state)) {
      return {
        job_id: jobId,
        cancellation_requested: false,
        target_confirmed: record.state === "cancelled",
        state: record.state,
      };
    }
    if (record.state === "queued") {
      const cancelled = await this.#store.transition(jobId, "cancelled", {
        cancellation_requested_at: new Date().toISOString(),
        error: {
          code: "cancelled_before_dispatch",
          message: "Job was cancelled before dispatch.",
          retryable: false,
        },
      });
      return {
        job_id: jobId,
        cancellation_requested: true,
        target_confirmed: true,
        state: cancelled.state,
      };
    }

    const active = this.#active.get(jobId);
    if (active === undefined) {
      return {
        job_id: jobId,
        cancellation_requested: false,
        target_confirmed: false,
        state: record.state,
      };
    }
    await this.#store.patch(jobId, { cancellation_requested_at: new Date().toISOString() });
    active.controller.abort("cancelled");
    const after = await this.#store.wait(jobId, 10_000);
    return {
      job_id: jobId,
      cancellation_requested: true,
      target_confirmed: after.state === "cancelled",
      state: after.state,
    };
  }

  async approveSync(jobId: string, approvedChangeIds: readonly string[]): Promise<SyncApprovalResult> {
    await this.expireLegacySyncLeases();
    const record = this.#store.require(jobId);
    if (
      record.state !== "needs_attention" ||
      record.sync_status !== "awaiting_user" ||
      record.error?.code !== "high_risk_workspace_change"
    ) {
      throw new BridgeError(
        "sync_approval_unavailable",
        "Only a job awaiting explicit high-risk synchronization approval can be approved.",
        { httpStatus: 409 },
      );
    }
    if (
      record.sync_approval_expires_at === undefined
      || Date.parse(record.sync_approval_expires_at) <= Date.now()
    ) {
      throw new BridgeError(
        "sync_approval_lease_expired",
        "The legacy peer synchronization approval lease has expired; the retained workspace was not synchronized.",
        { httpStatus: 409 },
      );
    }
    if (
      this.#workspace === undefined ||
      record.workspace_manifest === undefined ||
      record.adapter_details?.result_manifest_hash === undefined ||
      record.pending_high_risk === undefined
    ) {
      throw new BridgeError(
        "sync_approval_unavailable",
        "The retained synchronization evidence is incomplete.",
        { httpStatus: 409 },
      );
    }
    const expectedIds = [...new Set(record.pending_high_risk.map((change) => change.id))].sort();
    const approvedIds = [...new Set(approvedChangeIds)].sort();
    if (
      expectedIds.length !== approvedIds.length ||
      expectedIds.some((id, index) => id !== approvedIds[index])
    ) {
      throw new BridgeError(
        "sync_approval_mismatch",
        "Approved change IDs must exactly match the job's pending high-risk changes.",
        { httpStatus: 409, details: { expected_change_ids: expectedIds } },
      );
    }

    const syncRequestId = randomUUID();
    try {
      const synced = await this.#workspace.approveSync(
        record.request,
        record.workspace_manifest,
        record.adapter_details.result_manifest_hash,
        approvedIds,
        syncRequestId,
      );
      const updated = await this.#store.transition(jobId, "succeeded", {
        error: null,
        sync_status: "synced",
        changed_files: synced.changedFiles,
        pending_high_risk: [],
        sync_authorization: {
          sync_request_id: syncRequestId,
          approved_change_ids: approvedIds,
          authorized_at: new Date().toISOString(),
        },
      });
      if (record.request.bridge_thread_id !== undefined) {
        await this.#sessions.setStatus(record.request.bridge_thread_id, "idle");
      }
      return {
        job_id: jobId,
        state: updated.state,
        sync_status: "synced",
        sync_request_id: syncRequestId,
        changed_files: synced.changedFiles,
      };
    } catch (error) {
      const bridgeError = asBridgeError(error);
      if (["sync_approval_mismatch", "sync_approval_not_required"].includes(bridgeError.code)) {
        throw bridgeError;
      }
      await this.#store.transition(jobId, "failed", {
        sync_status: bridgeError.code.includes("drift") ? "conflict" : "failed",
        error: toStructuredError(bridgeError),
        sync_authorization: {
          sync_request_id: syncRequestId,
          approved_change_ids: approvedIds,
          authorized_at: new Date().toISOString(),
        },
      });
      if (record.request.bridge_thread_id !== undefined) {
        await this.#sessions.setStatus(record.request.bridge_thread_id, "needs_attention");
      }
      throw bridgeError;
    }
  }

  async discardSync(jobId: string): Promise<SyncDiscardResult> {
    await this.expireLegacySyncLeases();
    const record = this.#store.require(jobId);
    if (
      record.state !== "needs_attention"
      || record.sync_status !== "awaiting_user"
      || record.error?.code !== "high_risk_workspace_change"
    ) {
      throw new BridgeError(
        "sync_discard_unavailable",
        "Only a legacy job awaiting high-risk synchronization approval can be discarded.",
        { httpStatus: 409 },
      );
    }
    const discardedAt = new Date().toISOString();
    const updated = await this.#store.transition(jobId, "failed", {
      sync_status: "discarded",
      error: {
        code: "peer_sync_discarded",
        message: "User discarded the retained peer synchronization; no reviewer changes were applied.",
        retryable: false,
      },
    });
    if (record.request.bridge_thread_id !== undefined) {
      await this.#sessions.setStatus(record.request.bridge_thread_id, "idle");
    }
    return {
      job_id: jobId,
      state: updated.state as "failed",
      sync_status: "discarded",
      discarded_at: discardedAt,
    };
  }

  async expireLegacySyncLeases(now = Date.now()): Promise<string[]> {
    const expired: string[] = [];
    for (const candidate of this.#store.list()) {
      if (
        candidate.state !== "needs_attention"
        || candidate.sync_status !== "awaiting_user"
        || candidate.error?.code !== "high_risk_workspace_change"
      ) {
        continue;
      }
      const parsedExisting = candidate.sync_approval_expires_at === undefined
        ? Number.NaN
        : Date.parse(candidate.sync_approval_expires_at);
      const base = Date.parse(candidate.updated_at);
      const expiresAt = Number.isFinite(parsedExisting)
        ? parsedExisting
        : Number.isFinite(base)
          ? base + LIMITS.legacySyncApprovalLeaseMs
          : Number.NaN;
      if (!Number.isFinite(expiresAt)) {
        continue;
      }
      const expiry = new Date(expiresAt).toISOString();
      if (candidate.sync_approval_expires_at === undefined) {
        await this.#store.patch(candidate.job_id, { sync_approval_expires_at: expiry });
      }
      if (expiresAt > now) {
        continue;
      }
      const latest = this.#store.require(candidate.job_id);
      if (latest.state !== "needs_attention" || latest.sync_status !== "awaiting_user") {
        continue;
      }
      await this.#store.transition(candidate.job_id, "failed", {
        sync_status: "discarded",
        error: {
          code: "sync_approval_lease_expired",
          message: "The 24-hour legacy synchronization approval lease expired; retained peer changes were not applied.",
          retryable: false,
        },
        sync_approval_expires_at: expiry,
      });
      if (latest.request.bridge_thread_id !== undefined) {
        await this.#sessions.setStatus(latest.request.bridge_thread_id, "idle");
      }
      expired.push(candidate.job_id);
    }
    return expired;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const active of this.#active.values()) {
      active.controller.abort("daemon_stopped");
    }
    await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
  }

  activeCount(): number {
    return this.#active.size;
  }

  #fillSlots(): void {
    while (!this.#stopping && this.#active.size < LIMITS.activeJobs) {
      const next = this.#store
        .list()
        .find(
          (record) =>
            record.state === "queued" &&
            !this.#activeThreads.has(this.#threadKey(record)),
        );
      if (next === undefined) {
        return;
      }
      const threadKey = this.#threadKey(next);
      const controller = new AbortController();
      this.#activeThreads.add(threadKey);
      const active: ActiveExecution = {
        controller,
        threadKey,
        completion: Promise.resolve(),
      };
      this.#active.set(next.job_id, active);
      active.completion = this.#execute(next, controller)
        .catch(async (error: unknown) => {
          const current = this.#store.require(next.job_id);
          if (!isTerminalState(current.state)) {
            const bridgeError = asBridgeError(error);
            const internalDiagnostic = bridgeError.code === "internal_error" && error instanceof Error
              ? {
                  adapter_details: {
                    ...(current.adapter_details ?? {
                      exit_code: null,
                      stderr: "",
                      complete_stdout_lines: [],
                    }),
                    internal_error_name: error.name,
                    internal_error_message: error.message,
                  },
                }
              : {};
            await this.#store.transition(next.job_id, "failed", {
              error: toStructuredError(bridgeError),
              ...internalDiagnostic,
            });
            if (current.request.bridge_thread_id !== undefined) {
              await this.#sessions.setStatus(current.request.bridge_thread_id, "needs_attention");
            }
          }
        })
        .finally(() => {
          this.#active.delete(next.job_id);
          this.#activeThreads.delete(threadKey);
          this.schedule();
        });
    }
  }

  async #execute(initial: JobRecord, controller: AbortController): Promise<void> {
    const request = initial.request;
    if (Date.parse(request.deadline) <= Date.now()) {
      await this.#store.transition(initial.job_id, "expired", {
        error: {
          code: "deadline_expired",
          message: "Job deadline passed before dispatch.",
          retryable: false,
        },
      });
      return;
    }

    await this.#store.transition(initial.job_id, "dispatching");
    let workspace: WorkspaceHandle | undefined;
    let mappedSession: ReturnType<SessionStore["get"]>;
    let resumeSessionId: string | undefined;
    try {
      if (request.target_root !== undefined) {
        if (this.#workspace === undefined) {
          throw new BridgeError("workspace_unavailable", "Peer workspace support is unavailable.", {
            httpStatus: 503,
            retryable: true,
          });
        }
        const retainedConflict = this.#store.list().find(
          (record) =>
            record.job_id !== initial.job_id &&
            record.state === "needs_attention" &&
            record.sync_status === "awaiting_user" &&
            record.request.target_root !== undefined &&
            rootsOverlap(record.request.target_root, request.target_root as string),
        );
        if (retainedConflict !== undefined) {
          throw new BridgeError(
            "retained_workspace_conflict",
            "A prior peer job is still awaiting user synchronization approval for this targetRoot.",
            {
              httpStatus: 409,
              retryable: false,
              details: { blocking_job_id: retainedConflict.job_id },
            },
          );
        }
        workspace = await this.#workspace.prepare(request);
        if (workspace === undefined) {
          throw new BridgeError("workspace_unavailable", "Peer workspace preparation returned no workspace.", {
            httpStatus: 500,
          });
        }
        await this.#store.patch(initial.job_id, {
          sync_status: "prepared",
          workspace_manifest: workspace.baselineTarget,
          workspace_retained_until: workspace.retainedUntil,
        });
      }
      mappedSession =
        request.bridge_thread_id === undefined
          ? undefined
          : this.#sessions.get(request.bridge_thread_id);
      if (mappedSession !== undefined && mappedSession.target !== request.target) {
        throw new BridgeError(
          "session_target_mismatch",
          "bridgeThreadId is owned by the other peer target.",
          { httpStatus: 409 },
        );
      }
      if (
        mappedSession?.model !== undefined
        && request.model !== undefined
        && mappedSession.model !== request.model
      ) {
        throw new BridgeError(
          "session_model_mismatch",
          "A recorded peer session cannot switch models; use a new bridgeThreadId.",
          { httpStatus: 409 },
        );
      }
      if (
        mappedSession?.reasoning_effort !== undefined
        && request.reasoning_effort !== undefined
        && mappedSession.reasoning_effort !== request.reasoning_effort
      ) {
        throw new BridgeError(
          "session_effort_mismatch",
          "A recorded peer session cannot switch reasoning effort; use a new bridgeThreadId.",
          { httpStatus: 409 },
        );
      }
      if (
        mappedSession?.task_profile !== undefined
        && request.task_profile !== undefined
        && mappedSession.task_profile !== request.task_profile
      ) {
        throw new BridgeError(
          "session_profile_mismatch",
          "A recorded peer session cannot switch task profile; use a new bridgeThreadId.",
          { httpStatus: 409 },
        );
      }
      if (request.target_session_id !== undefined) {
        if (
          request.bridge_thread_id === undefined ||
          (mappedSession?.peer_session_id ?? mappedSession?.claude_session_id) !==
            request.target_session_id
        ) {
          throw new BridgeError(
            "session_not_owned",
            "target_session_id is not owned by the supplied bridge_thread_id.",
            { httpStatus: 409 },
          );
        }
      }
      resumeSessionId =
        request.target_session_id ?? mappedSession?.peer_session_id ?? mappedSession?.claude_session_id;
      if (request.bridge_thread_id !== undefined && mappedSession !== undefined) {
        await this.#sessions.setStatus(request.bridge_thread_id, "running");
      }
    } catch (error) {
      if (workspace !== undefined && this.#workspace !== undefined) {
        await this.#workspace.release(workspace);
      }
      throw error;
    }

    const deadlineMs = Date.parse(request.deadline) - Date.now();
    const timeout = setTimeout(() => controller.abort("expired"), Math.max(1, deadlineMs));
    timeout.unref();

    try {
      const first = await this.#runAdapter(
        initial.job_id,
        request,
        resumeSessionId,
        controller,
        true,
        workspace,
      );
      if (controller.signal.aborted) {
        await this.#finishAborted(initial.job_id, controller.signal.reason, request, first);
        return;
      }
      if (first.classification === "isolation_breach" || first.classification === "model_mismatch") {
        await this.#store.transition(initial.job_id, "failed", {
          error: {
            code: outcomeErrorCode(first),
            message: outcomeMessage(first),
            retryable: false,
            details: publicOutcomeDetails(first),
          },
          ...(first.result === undefined ? {} : { result: first.result }),
          adapter_details: first.details,
        });
        return;
      }

      let outcome = first;
      let contextReset = false;
      if (outcome.classification !== "success" && resumeSessionId !== undefined) {
        if (
          request.allow_fresh_fallback === true &&
          ![
            "isolation_breach",
            "model_mismatch",
            "parameter_error",
            "spawn_error",
            "output_limit_exceeded",
            "cancelled",
          ].includes(outcome.classification)
        ) {
          contextReset = true;
          outcome = await this.#runAdapter(
            initial.job_id,
            request,
            undefined,
            controller,
            false,
            workspace,
          );
          if (controller.signal.aborted) {
            await this.#finishAborted(initial.job_id, controller.signal.reason, request, outcome);
            return;
          }
        } else {
          await this.#store.transition(initial.job_id, "failed", {
            error: {
              code: "resume_failed",
              message: "Peer session resume failed; no fresh context fallback was used.",
              retryable: false,
              details: { cause_code: outcomeErrorCode(outcome) },
            },
            ...(outcome.result === undefined ? {} : { result: outcome.result }),
            adapter_details: outcome.details,
          });
          return;
        }
      }

      if (outcome.classification !== "success") {
        await this.#store.transition(initial.job_id, "failed", {
          error: {
            code: contextReset ? "fresh_fallback_failed" : outcomeErrorCode(outcome),
            message: contextReset
              ? "Fresh context fallback failed after peer resume failure."
              : outcomeMessage(outcome),
            retryable: false,
            details: publicOutcomeDetails(outcome),
          },
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
          ...(contextReset ? { context_reset: true } : {}),
          adapter_details: outcome.details,
        });
        return;
      }
      const reviewContractIssue = validatePeerOutcome(request, outcome);
      if (reviewContractIssue !== undefined) {
        if (request.bridge_thread_id !== undefined && outcome.session_id !== undefined) {
          await this.#sessions.assignPeer(
            request.bridge_thread_id,
            outcome.session_id,
            request.target,
            {
              status: "needs_attention",
              ...(contextReset ? { contextReset: true } : {}),
              ...(outcome.details.requested_model === undefined
                ? {}
                : { model: outcome.details.requested_model }),
              ...(request.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: request.reasoning_effort }),
              ...(request.task_profile === undefined
                ? {}
                : { taskProfile: request.task_profile }),
            },
          );
        }
        const failureReport = peerReviewFailureReport(
          initial.job_id,
          request,
          outcome,
          reviewContractIssue,
        );
        await this.#store.transition(initial.job_id, "failed", {
          result: failureReport,
          ...(outcome.session_id === undefined
            ? {}
            : request.target === "claude"
              ? { claude_session_id: outcome.session_id }
              : { peer_session_id: outcome.session_id }),
          adapter_details: outcome.details,
          ...(workspace === undefined ? {} : { sync_status: "failed" }),
          error: {
            code: "peer_contract_error",
            message: reviewContractIssue.message,
            retryable: false,
            details: {
              phase: request.operation === "task"
                ? "peer_task"
                : request.artifact_type === "plan"
                  ? "plan_review"
                  : "deliverable_review",
              issue_code: reviewContractIssue.code,
              ...reviewContractIssue.details,
            },
          },
        });
        return;
      }
      if (outcome.result === undefined || outcome.session_id === undefined) {
        await this.#store.transition(initial.job_id, "failed", {
          error: {
            code: "headless_protocol_error",
            message: "Successful Claude result lacked result text or session_id.",
            retryable: false,
          },
          ...(contextReset ? { context_reset: true } : {}),
          adapter_details: outcome.details,
        });
        return;
      }

      if (request.bridge_thread_id !== undefined) {
        await this.#sessions.assignPeer(request.bridge_thread_id, outcome.session_id, request.target, {
          status: "idle",
          ...(contextReset ? { contextReset: true } : {}),
          ...(outcome.details.requested_model === undefined
            ? {}
            : { model: outcome.details.requested_model }),
          ...(request.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: request.reasoning_effort }),
          ...(request.task_profile === undefined
            ? {}
            : { taskProfile: request.task_profile }),
        });
      }
      let syncStatus = initial.sync_status;
      let changedFiles = outcome.details.changed_files;
      if (workspace !== undefined && this.#workspace !== undefined) {
        let synced: SyncResult;
        try {
          synced = await this.#workspace.sync(workspace);
        } catch (error) {
          const bridgeError = asBridgeError(error);
          await this.#store.transition(initial.job_id, "failed", {
            result: outcome.result,
            adapter_details: outcome.details,
            sync_status:
              bridgeError.code === "workspace_baseline_drift" ? "conflict" : "failed",
            error: toStructuredError(bridgeError),
          });
          return;
        }
        syncStatus = synced.status;
        changedFiles = synced.changedFiles;
        const syncDetails = {
          ...outcome.details,
          baseline_manifest_hash: synced.baselineManifestHash,
          result_manifest_hash: synced.resultManifestHash,
        };
        if (synced.status === "awaiting_user") {
          const syncApprovalExpiresAt = new Date(
            Date.now() + LIMITS.legacySyncApprovalLeaseMs,
          ).toISOString();
          await this.#store.transition(initial.job_id, "needs_attention", {
            result: outcome.result,
            ...(request.target === "claude" ? { claude_session_id: outcome.session_id } : { peer_session_id: outcome.session_id }),
            adapter_details: syncDetails,
            changed_files: synced.changedFiles,
            ...(outcome.details.tests === undefined ? {} : { test_results: outcome.details.tests }),
            pending_high_risk: synced.highRisk,
            result_workspace_manifest: synced.resultManifest,
            sync_status: "awaiting_user",
            sync_approval_expires_at: syncApprovalExpiresAt,
            error: {
              code: "high_risk_workspace_change",
              message: "Peer produced a delete, rename, permission, or directory replacement requiring user authorization.",
              retryable: false,
              details: {
                high_risk: synced.highRisk,
                ordinary_changes: synced.changedFiles,
              },
            },
          });
          if (request.bridge_thread_id !== undefined) {
            await this.#sessions.setStatus(request.bridge_thread_id, "needs_attention");
          }
          return;
        }
        await this.#store.patch(initial.job_id, {
          sync_status: syncStatus,
          changed_files: changedFiles,
          ...(outcome.details.tests === undefined ? {} : { test_results: outcome.details.tests }),
          adapter_details: syncDetails,
          result_workspace_manifest: synced.resultManifest,
        });
        outcome = { ...outcome, details: syncDetails };
      }
      await this.#store.transition(initial.job_id, "succeeded", {
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        ...(request.target === "claude"
          ? outcome.session_id === undefined
            ? {}
            : { claude_session_id: outcome.session_id }
          : outcome.session_id === undefined
            ? {}
            : { peer_session_id: outcome.session_id }),
        ...(contextReset ? { context_reset: true } : {}),
        adapter_details: outcome.details,
        ...(outcome.details.tests === undefined ? {} : { test_results: outcome.details.tests }),
        ...(changedFiles === undefined ? {} : { changed_files: changedFiles }),
        ...(syncStatus === undefined ? {} : { sync_status: syncStatus }),
      });
    } finally {
      clearTimeout(timeout);
      if (request.bridge_thread_id !== undefined) {
        const current = this.#store.require(initial.job_id);
        await this.#sessions.setStatus(
          request.bridge_thread_id,
          current.state === "needs_attention" || current.state === "failed"
            ? "needs_attention"
            : "idle",
        );
      }
      if (workspace !== undefined && this.#workspace !== undefined) {
        await this.#workspace.release(workspace);
      }
    }
  }

  async #runAdapter(
    jobId: string,
    request: BridgeRequest,
    sessionId: string | undefined,
    controller: AbortController,
    updatePhases: boolean,
    workspace?: WorkspaceHandle,
  ): Promise<HeadlessOutcome> {
    const options: HeadlessRunOptions = {
      prompt: requestPrompt(request, workspace?.root),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.reasoning_effort === undefined
        ? {}
        : { reasoningEffort: request.reasoning_effort }),
      ...(request.task_profile === undefined ? {} : { taskProfile: request.task_profile }),
      ...(request.routing_source === undefined
        ? {}
        : { routingSource: request.routing_source }),
      ...(request.routing_rule_id === undefined
        ? {}
        : { routingRuleId: request.routing_rule_id }),
      operation: request.operation,
      ...(request.target === "claude"
        ? sessionId === undefined
          ? {}
          : { sessionId }
        : sessionId === undefined
          ? {}
          : { targetSessionId: sessionId }),
      ...(workspace === undefined ? {} : { workspacePath: workspace.root, allowedPaths: workspace.allowedPaths }),
      ...(request.acceptance_criteria === undefined
        ? {}
        : { acceptanceCriteria: request.acceptance_criteria }),
      ...(request.test_commands === undefined ? {} : { testCommands: request.test_commands }),
      signal: controller.signal,
      hooks: {
        onSpawn: async (pid) => {
          await this.#store.patch(jobId, { child_pid: pid });
        },
        onTransportDelivered: async () => {
          if (updatePhases) {
            await this.#store.transition(jobId, "transport_delivered");
          }
        },
        onRunning: async () => {
          if (updatePhases) {
            await this.#store.transition(jobId, "running");
          }
        },
      },
    };
    if (request.target === "codex") {
      if (this.#adapter.runCodex === undefined) {
        throw new BridgeError("not_implemented", "Codex peer routing is unavailable in this bridge build.", {
          httpStatus: 501,
        });
      }
      return this.#adapter.runCodex(options);
    }
    return this.#adapter.run(options);
  }

  async #finishAborted(
    jobId: string,
    reason: unknown,
    request: BridgeRequest,
    outcome?: HeadlessOutcome,
  ): Promise<void> {
    const current = this.#store.require(jobId);
    if (isTerminalState(current.state)) {
      return;
    }
    const expired = reason === "expired";
    const daemonStopped = reason === "daemon_stopped";
    if (
      request.bridge_thread_id !== undefined &&
      outcome?.session_id !== undefined
    ) {
      await this.#sessions.assignPeer(
        request.bridge_thread_id,
        outcome.session_id,
        request.target,
        {
          status: "idle",
          ...(outcome.details.requested_model === undefined
            ? {}
            : { model: outcome.details.requested_model }),
          ...(request.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: request.reasoning_effort }),
          ...(request.task_profile === undefined
            ? {}
            : { taskProfile: request.task_profile }),
        },
      );
    }
    await this.#store.transition(jobId, expired ? "expired" : "cancelled", {
      error: {
        code: expired ? "job_timeout" : daemonStopped ? "daemon_stopped" : "job_cancelled",
        message: expired
          ? "Job exceeded its deadline."
          : daemonStopped
            ? "Job was cancelled during clean daemon shutdown."
            : "Job cancellation was confirmed.",
        retryable: false,
      },
      ...(outcome?.session_id === undefined
        ? {}
        : request.target === "claude"
          ? { claude_session_id: outcome.session_id }
          : { peer_session_id: outcome.session_id }),
      ...(outcome?.details === undefined ? {} : { adapter_details: outcome.details }),
    });
  }

  #threadKey(record: JobRecord): string {
    return record.request.bridge_thread_id ?? `job:${record.job_id}`;
  }
}
