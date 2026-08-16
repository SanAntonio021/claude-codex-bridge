import { LIMITS } from "./constants.js";
import { getDaemonPaths, type DaemonPaths } from "./config.js";
import { BridgeError } from "./errors.js";
import { requestDaemon } from "./daemon/client.js";
import { ensureDaemon } from "./daemon/ensure.js";
import type { BridgeRequest, PublicJobResult, PublicJobStatus, SessionRecord } from "./types.js";
import type { CancellationResult, SyncApprovalResult, SyncDiscardResult } from "./daemon/scheduler.js";

export interface SubmitResult {
  job_id: string;
  state: string;
  created: boolean;
}
export interface WaitResult {
  status: "complete" | "pending";
  job?: PublicJobResult;
  job_id?: string;
  state?: string;
}

export async function submitJob(
  request: BridgeRequest,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<SubmitResult> {
  if (request.route === "live") {
    throw new BridgeError("live_unavailable", "Live peer routing is unavailable.", {
      httpStatus: 503,
    });
  }
  await ensureDaemon(paths);
  return requestDaemon<SubmitResult>("/v1/jobs", { method: "POST", body: request, paths });
}

export async function waitJob(
  jobId: string,
  timeoutMs: number,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<WaitResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > LIMITS.awaitMs) {
    throw new BridgeError("invalid_timeout", "timeout_ms must be an integer from 0 to 45000.");
  }
  await ensureDaemon(paths);
  return requestDaemon<WaitResult>(
    `/v1/jobs/${encodeURIComponent(jobId)}/wait?timeout_ms=${timeoutMs}`,
    { paths, timeoutMs: timeoutMs + 2_000 },
  );
}

export async function getJobStatus(
  jobId: string,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<PublicJobStatus> {
  await ensureDaemon(paths);
  return requestDaemon<PublicJobStatus>(`/v1/jobs/${encodeURIComponent(jobId)}`, { paths });
}

export async function getJobResult(
  jobId: string,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<PublicJobResult | { status: "pending"; job_id: string; state: string }> {
  await ensureDaemon(paths);
  return requestDaemon(`/v1/jobs/${encodeURIComponent(jobId)}/result`, { paths });
}

export async function getBridgeStatus(
  paths: DaemonPaths = getDaemonPaths(),
): Promise<Record<string, unknown>> {
  await ensureDaemon(paths);
  return requestDaemon<Record<string, unknown>>("/v1/status", { paths });
}

export async function cancelJob(
  jobId: string,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<CancellationResult> {
  await ensureDaemon(paths);
  return requestDaemon<CancellationResult>(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: {},
    paths,
    timeoutMs: 12_000,
  });
}

export async function rotateBridgeToken(
  paths: DaemonPaths = getDaemonPaths(),
): Promise<{ rotated: boolean; restart_required: boolean; restart_targets: string[] }> {
  await ensureDaemon(paths);
  return requestDaemon("/v1/token/rotate", {
    method: "POST",
    body: {},
    paths,
    timeoutMs: 10_000,
  });
}

export async function approvePeerSync(
  jobId: string,
  approvedChangeIds: readonly string[],
  paths: DaemonPaths = getDaemonPaths(),
): Promise<SyncApprovalResult> {
  await ensureDaemon(paths);
  return requestDaemon<SyncApprovalResult>(
    `/v1/jobs/${encodeURIComponent(jobId)}/approve-sync`,
    {
      method: "POST",
      body: { approved_change_ids: approvedChangeIds },
      paths,
      timeoutMs: 30_000,
    },
  );
}

export async function discardPeerSync(
  jobId: string,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<SyncDiscardResult> {
  await ensureDaemon(paths);
  return requestDaemon<SyncDiscardResult>(
    `/v1/jobs/${encodeURIComponent(jobId)}/discard-sync`,
    {
      method: "POST",
      body: {},
      paths,
      timeoutMs: 10_000,
    },
  );
}

export async function listSessions(
  paths: DaemonPaths = getDaemonPaths(),
): Promise<{ sessions: SessionRecord[] }> {
  await ensureDaemon(paths);
  return requestDaemon<{ sessions: SessionRecord[] }>("/v1/sessions", { paths });
}

export async function getBridgeConfig(
  paths: DaemonPaths = getDaemonPaths(),
): Promise<Record<string, unknown>> {
  await ensureDaemon(paths);
  return requestDaemon<Record<string, unknown>>("/v1/config", { paths });
}

export async function mutateBridgeConfig(
  mutation: Record<string, unknown>,
  paths: DaemonPaths = getDaemonPaths(),
): Promise<Record<string, unknown>> {
  await ensureDaemon(paths);
  return requestDaemon<Record<string, unknown>>("/v1/config", {
    method: "POST",
    body: mutation,
    paths,
  });
}

export async function retryJob(
  jobId: string,
  route: { model?: string; task_profile?: string },
  paths: DaemonPaths = getDaemonPaths(),
): Promise<SubmitResult> {
  await ensureDaemon(paths);
  return requestDaemon<SubmitResult>(`/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: route,
    paths,
  });
}

export async function cleanupBridgeRuntime(
  options: {
    job_id?: string;
    older_than_ms?: number;
    include_jobs?: boolean;
    execute?: boolean;
  },
  paths: DaemonPaths = getDaemonPaths(),
): Promise<Record<string, unknown>> {
  await ensureDaemon(paths);
  return requestDaemon<Record<string, unknown>>("/v1/cleanup", {
    method: "POST",
    body: options,
    paths,
    timeoutMs: 30_000,
  });
}
