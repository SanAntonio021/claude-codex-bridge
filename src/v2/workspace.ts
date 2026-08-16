import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { sha256Json } from "../hash.js";
import { atomicWriteJson, ensureProtectedDirectory } from "../daemon/atomic.js";
import {
  readV2Utf8File,
  resolveV2Path,
  sameV2Snapshot,
  snapshotV2Tree,
  type V2FileIdentity,
  type V2TreeSnapshot,
} from "./path.js";
import { normalizeV2RelativePath, type V2RepairTarget, type V2ReviewRequest } from "./types.js";

export const V2_WORKSPACE_MAX_BYTES = 1024 * 1024 * 1024;
export const V2_WORKSPACE_MAX_FILES = 100_000;
export const V2_WORKSPACE_GLOBAL_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const V2_WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface V2WorkspaceManifest {
  version: 2;
  jobId: string;
  targetRoot: string;
  workspaceRoot: string;
  artifactPath: string;
  repairTargets: V2RepairTarget[];
  baseline: V2TreeSnapshot;
  retainedUntil: string;
  sha256: string;
}

export interface V2WorkspaceHandle {
  jobId: string;
  targetRoot: string;
  workspaceRoot: string;
  artifactPath: string;
  repairTargets: V2RepairTarget[];
  baseline: V2TreeSnapshot;
  retainedUntil: string;
}

export interface V2WorkspaceSyncResult {
  changedFiles: string[];
  artifactDelta: boolean;
  result: V2TreeSnapshot;
}

export type V2SyncPhase = "sealed" | "sync_prepared" | "replace" | "verify" | "rollback";

function manifestHash(value: Omit<V2WorkspaceManifest, "sha256">): string {
  return sha256Json(value);
}

function comparable(entry: V2FileIdentity): Omit<V2FileIdentity, "fileId"> {
  const { fileId: _fileId, ...value } = entry;
  return value;
}

function entryChanged(before: V2FileIdentity | undefined, after: V2FileIdentity | undefined): boolean {
  if (before === undefined || after === undefined) {
    return before !== after;
  }
  return before.relativePath !== after.relativePath
    || before.kind !== after.kind
    || before.bytes !== after.bytes
    || before.sha256 !== after.sha256
    || before.mode !== after.mode;
}

function mapSnapshot(snapshot: V2TreeSnapshot): Map<string, V2FileIdentity> {
  return new Map(snapshot.files.map((entry) => [entry.relativePath, entry]));
}

function targetMap(targets: readonly V2RepairTarget[]): Map<string, V2RepairTarget> {
  return new Map(targets.map((target) => [target.path, target]));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new BridgeError("reparse_point_rejected", "Protocol v2 retention storage contains a reparse point.", {
        httpStatus: 409,
      });
    }
    if (info.isDirectory()) {
      total += await directoryBytes(path);
    } else if (info.isFile()) {
      total += info.size;
    }
  }
  return total;
}

async function reservationBytes(root: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) {
      throw new BridgeError("workspace_reservation_invalid", "Protocol v2 reservation storage contains an unexpected entry.", {
        httpStatus: 409,
      });
    }
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new BridgeError("workspace_reservation_invalid", "Protocol v2 reservation storage contains a linked or non-file entry.", {
        httpStatus: 409,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      throw new BridgeError("workspace_reservation_invalid", "Protocol v2 reservation metadata is invalid.", {
        httpStatus: 409,
        cause: error,
      });
    }
    const bytes = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["bytes"]
      : undefined;
    if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) {
      throw new BridgeError("workspace_reservation_invalid", "Protocol v2 reservation bytes must be a positive safe integer.", {
        httpStatus: 409,
      });
    }
    total += bytes as number;
    if (!Number.isSafeInteger(total)) {
      throw new BridgeError("workspace_reservation_invalid", "Protocol v2 reservation total overflowed.", {
        httpStatus: 409,
      });
    }
  }
  return total;
}

export class V2WorkspaceManager {
  readonly #runtimeRoot: string;
  readonly #workspaceRoot: string;
  readonly #reservationRoot: string;
  readonly #manifestRoot: string;
  readonly #capacityLockPath: string;

  constructor(runtimeRoot: string) {
    this.#runtimeRoot = resolve(runtimeRoot);
    this.#workspaceRoot = join(this.#runtimeRoot, "v2-workspaces");
    this.#reservationRoot = join(this.#runtimeRoot, "v2-reservations");
    this.#manifestRoot = join(this.#runtimeRoot, "v2-manifests");
    this.#capacityLockPath = join(this.#runtimeRoot, "v2-capacity.lock");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensureProtectedDirectory(this.#workspaceRoot),
      ensureProtectedDirectory(this.#reservationRoot),
      ensureProtectedDirectory(this.#manifestRoot),
    ]);
  }

  async #withCapacityLock<T>(action: () => Promise<T>): Promise<T> {
    await ensureProtectedDirectory(this.#runtimeRoot);
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(this.#capacityLockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
        await handle.sync();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        await delay(25);
      }
    }
    if (handle === undefined) {
      throw new BridgeError("workspace_capacity_lock_timeout", "Protocol v2 capacity reservation is busy.", {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(this.#capacityLockPath).catch(() => undefined);
    }
  }

  async #reserve(jobId: string, bytes: number): Promise<string> {
    return this.#withCapacityLock(async () => {
      const existing = await directoryBytes(this.#workspaceRoot);
      const reservations = await reservationBytes(this.#reservationRoot);
      if (existing + reservations + bytes > V2_WORKSPACE_GLOBAL_MAX_BYTES) {
        throw new BridgeError(
          "workspace_capacity_reached",
          "Protocol v2 retained-workspace capacity is exhausted; no user material was removed.",
          { httpStatus: 507 },
        );
      }
      const path = join(this.#reservationRoot, `${jobId}.json`);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ job_id: jobId, bytes, at: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return path;
    });
  }

  async #copySnapshot(snapshot: V2TreeSnapshot, destination: string): Promise<void> {
    await ensureProtectedDirectory(destination);
    for (const entry of snapshot.files.filter((item) => item.kind === "directory")) {
      await mkdir(join(destination, ...entry.relativePath.split("/")), { recursive: true, mode: entry.mode });
      await chmod(join(destination, ...entry.relativePath.split("/")), entry.mode);
    }
    for (const entry of snapshot.files.filter((item) => item.kind === "file")) {
      const source = await readV2Utf8File(snapshot.root, entry.relativePath);
      if (source.sha256 !== entry.sha256 || source.bytes.byteLength !== entry.bytes) {
        throw new BridgeError("workspace_source_drift", "Source changed while the v2 workspace was being copied.", {
          httpStatus: 409,
          details: { path: entry.relativePath },
        });
      }
      const destinationPath = join(destination, ...entry.relativePath.split("/"));
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, source.bytes, { flag: "wx", mode: entry.mode });
      await chmod(destinationPath, entry.mode);
    }
  }

  async prepare(jobId: string, request: V2ReviewRequest): Promise<V2WorkspaceHandle> {
    if (
      request.artifactMode !== "workspace"
      || request.targetRoot === undefined
      || request.repairTargets === undefined
      || request.artifactPath === undefined
    ) {
      throw new BridgeError("workspace_repair_contract_incomplete", "A v2 workspace handle requires workspace repair fields.", {
        httpStatus: 400,
      });
    }
    await this.initialize();
    const baseline = await snapshotV2Tree(request.targetRoot, { excludeGitDirectory: true });
    if (baseline.bytes > V2_WORKSPACE_MAX_BYTES || baseline.fileCount > V2_WORKSPACE_MAX_FILES) {
      throw new BridgeError("workspace_job_limit_exceeded", "Protocol v2 workspace exceeds its per-job size or file limit.", {
        httpStatus: 413,
        details: { bytes: baseline.bytes, file_count: baseline.fileCount },
      });
    }
    const artifact = await readV2Utf8File(baseline.root, request.artifactPath);
    if (artifact.content !== request.artifactContent || artifact.bytes.byteLength !== request.artifactBytes || artifact.sha256 !== request.artifactSha256) {
      throw new BridgeError("artifact_workspace_mismatch", "The v2 artifact fields do not match the original workspace bytes.", {
        httpStatus: 409,
        details: { path: request.artifactPath },
      });
    }
    const reservationPath = await this.#reserve(jobId, baseline.bytes);
    const workspaceRoot = join(this.#workspaceRoot, jobId);
    try {
      try {
        await lstat(workspaceRoot);
        throw new BridgeError("workspace_job_collision", "A v2 workspace already exists for this job ID.", {
          httpStatus: 409,
        });
      } catch (error) {
        if (error instanceof BridgeError) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await this.#copySnapshot(baseline, workspaceRoot);
      const copied = await snapshotV2Tree(workspaceRoot);
      if (!sameV2Snapshot(baseline, copied)) {
        throw new BridgeError("workspace_copy_mismatch", "Copied v2 workspace differs from its sealed source snapshot.", {
          httpStatus: 409,
        });
      }
      const retainedUntil = new Date(Date.now() + V2_WORKSPACE_RETENTION_MS).toISOString();
      const manifestBase = {
        version: 2 as const,
        jobId,
        targetRoot: baseline.root,
        workspaceRoot,
        artifactPath: request.artifactPath,
        repairTargets: request.repairTargets,
        baseline,
        retainedUntil,
      };
      const manifest: V2WorkspaceManifest = { ...manifestBase, sha256: manifestHash(manifestBase) };
      await atomicWriteJson(join(this.#manifestRoot, `${jobId}.json`), manifest, { protect: true });
      return {
        jobId,
        targetRoot: baseline.root,
        workspaceRoot,
        artifactPath: request.artifactPath,
        repairTargets: request.repairTargets,
        baseline,
        retainedUntil,
      };
    } finally {
      // A reservation is bridge-owned temporary metadata, not retained review material.
      await unlink(reservationPath).catch(() => undefined);
    }
  }

  async evidenceSources(
    handle: V2WorkspaceHandle,
    referencedPaths: readonly string[] = [],
  ): Promise<Array<{ path: string; content: string }>> {
    const available = new Set(
      handle.baseline.files
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.relativePath.toLocaleLowerCase("en-US")),
    );
    const paths = [...new Set([handle.artifactPath, ...referencedPaths].map((path) =>
      normalizeV2RelativePath(path, "evidence path"),
    ))];
    const sources: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      if (!available.has(path.toLocaleLowerCase("en-US"))) {
        throw new BridgeError("evidence_path_invalid", "Evidence cited a path outside the sealed workspace material.", {
          httpStatus: 409,
          details: { path },
        });
      }
      const source = await readV2Utf8File(handle.workspaceRoot, path);
      sources.push({ path, content: source.content });
    }
    return sources;
  }

  #validateChanges(
    handle: V2WorkspaceHandle,
    current: V2TreeSnapshot,
  ): string[] {
    const baseline = mapSnapshot(handle.baseline);
    const result = mapSnapshot(current);
    const targets = targetMap(handle.repairTargets);
    const paths = [...new Set([...baseline.keys(), ...result.keys()])].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    const changed: string[] = [];
    for (const path of paths) {
      const before = baseline.get(path);
      const after = result.get(path);
      if (!entryChanged(before, after)) {
        continue;
      }
      const target = targets.get(path);
      if (before?.kind === "directory" || after?.kind === "directory") {
        throw new BridgeError("reviewer_scope_violation", "Protocol v2 forbids directory changes.", {
          httpStatus: 409,
          details: { path },
        });
      }
      if (before === undefined && after?.kind === "file" && target?.action === "create") {
        changed.push(path);
        continue;
      }
      if (before === undefined || after === undefined || before.kind !== "file" || after.kind !== "file") {
        throw new BridgeError("reviewer_scope_violation", "Protocol v2 forbids delete, rename, and type changes.", {
          httpStatus: 409,
          details: { path },
        });
      }
      if (before.mode !== after.mode) {
        throw new BridgeError("reviewer_scope_violation", "Protocol v2 forbids metadata changes.", {
          httpStatus: 409,
          details: { path },
        });
      }
      if (target === undefined || target.action !== "modify") {
        throw new BridgeError("reviewer_scope_violation", "Peer changed a path outside its explicit v2 repair target.", {
          httpStatus: 409,
          details: { path },
        });
      }
      changed.push(path);
    }
    for (const target of handle.repairTargets.filter((item) => item.action === "create")) {
      if (baseline.has(target.path)) {
        throw new BridgeError("reviewer_scope_violation", "A v2 create target already existed in the baseline.", {
          httpStatus: 409,
          details: { path: target.path },
        });
      }
    }
    return [...new Set(changed)].sort((left, right) => left.localeCompare(right, "en"));
  }

  async validate(handle: V2WorkspaceHandle): Promise<{
    changedFiles: string[];
    artifactDelta: boolean;
    result: V2TreeSnapshot;
  }> {
    const result = await snapshotV2Tree(handle.workspaceRoot);
    const changedFiles = this.#validateChanges(handle, result);
    return { changedFiles, artifactDelta: changedFiles.length > 0, result };
  }

  async sync(
    handle: V2WorkspaceHandle,
    onPhase?: (phase: V2SyncPhase) => Promise<void> | void,
  ): Promise<V2WorkspaceSyncResult> {
    const targetNow = await snapshotV2Tree(handle.targetRoot, { excludeGitDirectory: true });
    if (!sameV2Snapshot(handle.baseline, targetNow, { includeFileId: true })) {
      throw new BridgeError("workspace_baseline_drift", "Author workspace drifted during protocol v2 review.", {
        httpStatus: 409,
      });
    }
    const inspected = await this.validate(handle);
    const { changedFiles, result: current } = inspected;
    const transactionRoot = join(
      handle.targetRoot,
      `.bridge-v2-txn-${handle.jobId}-${randomBytes(6).toString("hex")}`,
    );
    const stagingRoot = join(transactionRoot, "staging");
    const backupRoot = join(transactionRoot, "backup");
    const replaced: string[] = [];
    try {
      await onPhase?.("sealed");
      if (changedFiles.length === 0) {
        return { changedFiles, artifactDelta: false, result: current };
      }
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      for (const relativePath of changedFiles) {
        const source = await readV2Utf8File(handle.workspaceRoot, relativePath);
        const staged = join(stagingRoot, ...relativePath.split("/"));
        await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
        await writeFile(staged, source.bytes, { flag: "wx", mode: 0o600 });
      }
      await onPhase?.("sync_prepared");
      for (const relativePath of changedFiles) {
        const destination = await resolveV2Path(handle.targetRoot, relativePath, { allowMissingLeaf: true });
        const staged = join(stagingRoot, ...relativePath.split("/"));
        const backup = join(backupRoot, ...relativePath.split("/"));
        let hadOriginal = false;
        try {
          const source = await readV2Utf8File(handle.targetRoot, relativePath);
          await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
          await writeFile(backup, source.bytes, { flag: "wx", mode: 0o600 });
          hadOriginal = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (hadOriginal) {
          await unlink(destination);
        }
        await rename(staged, destination);
        replaced.push(relativePath);
        await onPhase?.("replace");
      }
      const verified = await snapshotV2Tree(handle.targetRoot, { excludeGitDirectory: true });
      const verifiedMap = mapSnapshot(verified);
      const currentMap = mapSnapshot(current);
      for (const relativePath of changedFiles) {
        const expected = currentMap.get(relativePath);
        const actual = verifiedMap.get(relativePath);
        if (expected === undefined || actual === undefined || JSON.stringify(comparable(expected)) !== JSON.stringify(comparable(actual))) {
          throw new BridgeError("workspace_sync_hash_mismatch", "Protocol v2 replacement verification failed.", {
            httpStatus: 409,
            details: { path: relativePath },
          });
        }
      }
      await onPhase?.("verify");
      await rm(transactionRoot, { recursive: true, force: true });
      return { changedFiles, artifactDelta: true, result: current };
    } catch (error) {
      // A phase observer is diagnostic only; even a synchronous observer failure
      // must not interrupt restoration of the author workspace.
      await Promise.resolve().then(() => onPhase?.("rollback")).catch(() => undefined);
      for (const relativePath of [...replaced].reverse()) {
        const destination = join(handle.targetRoot, ...relativePath.split("/"));
        const backup = join(backupRoot, ...relativePath.split("/"));
        await unlink(destination).catch(() => undefined);
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw restoreError;
          }
        }
      }
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError("workspace_sync_failed", "Protocol v2 synchronization failed and rollback was attempted.", {
        httpStatus: 409,
        cause: error,
      });
    }
  }
}
