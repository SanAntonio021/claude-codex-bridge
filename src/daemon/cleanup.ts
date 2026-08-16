import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LIMITS } from "../constants.js";
import type { DaemonPaths } from "../config.js";
import { sha256 } from "../hash.js";
import { isTerminalState, type JobRecord } from "../types.js";
import { atomicWriteJson } from "./atomic.js";
import { AuditLog } from "./audit.js";
import { JobStore } from "./store.js";
import { BridgeError } from "../errors.js";

export interface CleanupOptions {
  jobId?: string;
  olderThanMs?: number;
  includeJobs?: boolean;
  execute?: boolean;
}

export interface CleanupCandidate {
  job_id: string;
  state: string;
  updated_at: string;
  workspace_retained: boolean;
}

export interface CleanupResult {
  dry_run: boolean;
  job_candidates: CleanupCandidate[];
  skipped: Array<{ job_id: string; reason: string }>;
  tombstones_expired: number;
  audit_prune_due: boolean;
  deleted_jobs?: number;
  deleted_tombstones?: number;
}

interface Tombstone {
  schema_version: 1;
  job_id: string;
  state: string;
  completed_at: string;
  expires_at: string;
}

function workspaceKey(record: JobRecord): string | undefined {
  if (record.request.artifact_id === undefined || record.request.target_root === undefined) {
    return undefined;
  }
  return sha256(`${record.request.artifact_id}\0${resolve(record.request.target_root)}`).slice(0, 32);
}

function workspacePaths(paths: DaemonPaths, record: JobRecord): string[] {
  const key = workspaceKey(record);
  return key === undefined
    ? []
    : [join(paths.workspaces, key), join(paths.workspaces, `${key}.manifest.json`)];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function workspaceIsLocked(paths: DaemonPaths, record: JobRecord): Promise<boolean> {
  const key = workspaceKey(record);
  return key !== undefined && exists(join(paths.artifactLocks, `${key}.lock`));
}

function cutoffFor(options: CleanupOptions): number {
  const requested = options.olderThanMs ?? LIMITS.jobRetentionMs;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new BridgeError("invalid_cleanup_age", "older-than must be a non-negative integer duration.", {
      httpStatus: 400,
    });
  }
  // Explicit cleanup never shortens the public 30-day terminal-job retention.
  return Date.now() - Math.max(LIMITS.jobRetentionMs, requested);
}

function terminalAndSettled(record: JobRecord): boolean {
  return isTerminalState(record.state)
    && !(record.state === "needs_attention" && record.sync_status === "awaiting_user");
}

async function expiredTombstoneCount(paths: DaemonPaths): Promise<number> {
  let names: string[];
  try {
    names = await readdir(paths.tombstones);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  const cutoff = Date.now();
  let count = 0;
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const info = await stat(join(paths.tombstones, name));
      if (info.mtimeMs < cutoff - LIMITS.tombstoneRetentionMs) {
        count += 1;
      }
    } catch {
      // A concurrent cleanup has already removed the candidate.
    }
  }
  return count;
}

async function assertCleanupSpace(paths: DaemonPaths, jobs: number): Promise<void> {
  const fileSystem = await statfs(paths.root);
  const available = Number(fileSystem.bavail) * Number(fileSystem.bsize);
  const required = 1024 * 1024 + jobs * 1024;
  if (!Number.isFinite(available) || available < required) {
    throw new BridgeError(
      "cleanup_insufficient_space",
      "Cleanup will not remove retained material when there is insufficient space for protected tombstones.",
      { httpStatus: 507, details: { required_bytes: required } },
    );
  }
}

async function removeExpiredTombstones(paths: DaemonPaths): Promise<number> {
  let names: string[];
  try {
    names = await readdir(paths.tombstones);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let removed = 0;
  const cutoff = Date.now() - LIMITS.tombstoneRetentionMs;
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const path = join(paths.tombstones, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return removed;
}

export async function cleanupRuntime(
  paths: DaemonPaths,
  store: JobStore,
  audit: AuditLog,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const cutoff = cutoffFor(options);
  const records = store.list();
  const candidates: JobRecord[] = [];
  const skipped: Array<{ job_id: string; reason: string }> = [];
  if (options.includeJobs === true) {
    for (const record of records) {
      if (options.jobId !== undefined && record.job_id !== options.jobId) {
        continue;
      }
      if (!terminalAndSettled(record)) {
        skipped.push({ job_id: record.job_id, reason: "non_terminal_or_awaiting_user" });
        continue;
      }
      const updatedAt = Date.parse(record.updated_at);
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) {
        skipped.push({ job_id: record.job_id, reason: "retention_not_expired" });
        continue;
      }
      if (await workspaceIsLocked(paths, record)) {
        skipped.push({ job_id: record.job_id, reason: "workspace_locked" });
        continue;
      }
      candidates.push(record);
    }
    if (options.jobId !== undefined && !records.some((record) => record.job_id === options.jobId)) {
      throw new BridgeError("job_not_found", "Cleanup job_id was not found.", { httpStatus: 404 });
    }
  }
  const result: CleanupResult = {
    dry_run: options.execute !== true,
    job_candidates: candidates.map((record) => ({
      job_id: record.job_id,
      state: record.state,
      updated_at: record.updated_at,
      workspace_retained: workspaceKey(record) !== undefined,
    })),
    skipped,
    tombstones_expired: await expiredTombstoneCount(paths),
    audit_prune_due: true,
  };
  if (options.execute !== true) {
    return result;
  }

  await assertCleanupSpace(paths, candidates.length);
  const candidateIds = new Set(candidates.map((record) => record.job_id));
  const retainedWorkspaceKeys = new Set(
    records
      .filter((record) => !candidateIds.has(record.job_id))
      .map(workspaceKey)
      .filter((key): key is string => key !== undefined),
  );
  let deletedJobs = 0;
  const removedWorkspaceKeys = new Set<string>();
  for (const record of candidates) {
    const tombstone: Tombstone = {
      schema_version: 1,
      job_id: record.job_id,
      state: record.state,
      completed_at: record.updated_at,
      expires_at: new Date(Date.now() + LIMITS.tombstoneRetentionMs).toISOString(),
    };
    await atomicWriteJson(join(paths.tombstones, `${record.job_id}.json`), tombstone, { protect: true });
    await store.deleteTerminal(record.job_id);
    deletedJobs += 1;
    const key = workspaceKey(record);
    if (key !== undefined && !retainedWorkspaceKeys.has(key) && !removedWorkspaceKeys.has(key)) {
      for (const path of workspacePaths(paths, record)) {
        await rm(path, { recursive: true, force: true });
      }
      removedWorkspaceKeys.add(key);
    }
  }
  await audit.prune(LIMITS.auditRetentionMs);
  result.deleted_jobs = deletedJobs;
  result.deleted_tombstones = await removeExpiredTombstones(paths);
  return result;
}
