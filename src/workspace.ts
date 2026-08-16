import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "./errors.js";
import { LIMITS } from "./constants.js";
import { sha256, sha256Json } from "./hash.js";
import type {
  BridgeRequest,
  HighRiskChange,
  ManifestEntry,
  WorkspaceManifest,
} from "./types.js";
import { atomicWriteJson, ensureProtectedDirectory } from "./daemon/atomic.js";

export interface WorkspaceHandle {
  root: string;
  targetRoot: string;
  artifactId: string;
  allowedPaths: string[];
  baselineTarget: WorkspaceManifest;
  baselineWorkspace: WorkspaceManifest;
  lockPath: string;
  retainedUntil: string;
}

export interface SyncResult {
  status: "synced" | "awaiting_user";
  changedFiles: string[];
  highRisk: HighRiskChange[];
  baselineManifestHash: string;
  resultManifestHash: string;
  resultManifest: WorkspaceManifest;
}

export interface SyncApprovalResult extends SyncResult {
  syncRequestId: string;
}

interface LockRecord {
  pid: number;
  created_at: string;
  artifact_id: string;
  target_root: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectUnsafeRelativePath(value: string): string {
  if (value.trim() === "" || isAbsolute(value) || value.includes("\0") || value.includes(":")) {
    throw new BridgeError("invalid_allowed_path", "allowedPaths must be non-empty relative paths.", {
      httpStatus: 400,
    });
  }
  const normalized = value.replaceAll("/", sep);
  if (normalized === ".") {
    return normalized;
  }
  const parts = normalized.split(sep);
  if (parts.some((part) => part === "." || part === ".." || part === ".git" || part === "")) {
    throw new BridgeError("invalid_allowed_path", "allowedPaths may not contain traversal or .git.", {
      httpStatus: 400,
    });
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new BridgeError("invalid_allowed_path", "Git metadata is never an allowed path.", {
      httpStatus: 400,
    });
  }
  return parts.join(sep);
}

async function assertTargetRoot(targetRoot: string): Promise<void> {
  let info;
  try {
    info = await lstat(targetRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("invalid_target_root", "targetRoot must be an existing directory.", {
        httpStatus: 400,
      });
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new BridgeError("invalid_target_root", "targetRoot must be a regular directory, not a symlink.", {
      httpStatus: 409,
    });
  }
}

function lockIsStale(record: LockRecord): boolean {
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

async function readPersistentLocks(directory: string): Promise<LockRecord[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: LockRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".lock"))) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as Partial<LockRecord>;
      if (
        Number.isInteger(parsed.pid) &&
        typeof parsed.created_at === "string" &&
        typeof parsed.artifact_id === "string" &&
        typeof parsed.target_root === "string"
      ) {
        records.push(parsed as LockRecord);
      }
    } catch {
      // A malformed lock is handled by acquireLock's normal fail-closed path.
    }
  }
  return records;
}

async function acquireLock(path: string, request: BridgeRequest, targetRoot: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          artifact_id: request.artifact_id,
          target_root: targetRoot,
        })}\n`,
      );
      await handle.sync();
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      let stale = false;
      try {
        const raw = await stat(path);
        stale = Date.now() - raw.mtimeMs > 15 * 60 * 1000;
        if (stale) {
          const text = await readFile(path, "utf8");
          const record = JSON.parse(text) as LockRecord;
          stale = lockIsStale(record);
        }
      } catch {
        stale = false;
      }
      if (!stale) {
        throw new BridgeError("artifact_lock_conflict", "An artifact review is already active.", {
          httpStatus: 409,
          retryable: true,
        });
      }
      await rm(path, { force: true });
    }
  }
  throw new BridgeError("artifact_lock_conflict", "Unable to acquire artifact lock.", {
    httpStatus: 409,
  });
}

async function releaseLock(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

async function walk(
  root: string,
  current: string,
  entries: ManifestEntry[],
  options: { skipGit?: boolean } = {},
): Promise<void> {
  const directory = await readdir(current, { withFileTypes: true });
  for (const item of directory) {
    const absolute = join(current, item.name);
    const rel = relative(root, absolute);
    if (item.name.toLowerCase() === ".git") {
      if (options.skipGit === true) {
        continue;
      }
      throw new BridgeError("git_metadata_rejected", "Git metadata may not enter a peer workspace.", {
        httpStatus: 409,
      });
    }
    if (item.isSymbolicLink()) {
      throw new BridgeError("symlink_rejected", "Symlinks are not allowed in review scope.", {
        httpStatus: 409,
      });
    }
    if (item.isDirectory()) {
      const info = await lstat(absolute);
      entries.push({
        relative_path: rel,
        bytes: 0,
        sha256: "",
        kind: "directory",
        mode: info.mode,
      });
      await walk(root, absolute, entries, options);
      continue;
    }
    if (item.isFile()) {
      const info = await lstat(absolute);
      const data = await readFile(absolute);
      entries.push({
        relative_path: rel,
        bytes: data.byteLength,
        sha256: sha256(data),
        kind: "file",
        mode: info.mode,
      });
    }
  }
}

export async function buildManifest(
  root: string,
  allowedPaths: readonly string[],
  artifactId: string,
): Promise<WorkspaceManifest> {
  const absoluteRoot = resolve(root);
  const normalizedPaths = [...new Set(allowedPaths.map(rejectUnsafeRelativePath))].sort();
  const entries: ManifestEntry[] = [];
  for (const relativePath of normalizedPaths) {
    const absolute = resolve(absoluteRoot, relativePath);
    if (!isPathInside(absoluteRoot, absolute)) {
      throw new BridgeError("invalid_allowed_path", "An allowed path escapes targetRoot.", {
        httpStatus: 400,
      });
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new BridgeError("symlink_rejected", "Symlinks are not allowed in review scope.", {
        httpStatus: 409,
      });
    }
    if (info.isDirectory()) {
      entries.push({
        relative_path: relativePath,
        bytes: 0,
        sha256: "",
        kind: "directory",
        mode: info.mode,
      });
      await walk(absoluteRoot, absolute, entries, { skipGit: true });
    } else if (info.isFile()) {
      const data = await readFile(absolute);
      entries.push({
        relative_path: relativePath,
        bytes: data.byteLength,
        sha256: sha256(data),
        kind: "file",
        mode: info.mode,
      });
    }
  }
  entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const manifest: WorkspaceManifest = {
    version: 1,
    root: absoluteRoot,
    target_root: absoluteRoot,
    artifact_id: artifactId,
    allowed_paths: normalizedPaths,
    files: entries,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  manifest.sha256 = sha256Json(manifest);
  return manifest;
}

export async function buildFullManifest(
  root: string,
  allowedPaths: readonly string[],
  artifactId: string,
  options: { skipGit?: boolean } = {},
): Promise<WorkspaceManifest> {
  const absoluteRoot = resolve(root);
  const normalizedPaths = [...new Set(allowedPaths.map(rejectUnsafeRelativePath))].sort();
  const entries: ManifestEntry[] = [];
  await walk(absoluteRoot, absoluteRoot, entries, options);
  entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const manifest: WorkspaceManifest = {
    version: 1,
    root: absoluteRoot,
    target_root: absoluteRoot,
    artifact_id: artifactId,
    allowed_paths: normalizedPaths,
    files: entries,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  manifest.sha256 = manifestContentHash(manifest);
  return manifest;
}

async function copyWorkspace(sourceRoot: string, destinationRoot: string): Promise<void> {
  await ensureProtectedDirectory(destinationRoot);

  const copyDirectory = async (relativeDirectory: string): Promise<void> => {
    const sourceDirectory = resolve(sourceRoot, relativeDirectory);
    for (const item of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (item.name.toLowerCase() === ".git") {
        continue;
      }
      const relativePath = relativeDirectory === "" ? item.name : join(relativeDirectory, item.name);
      const source = resolve(sourceRoot, relativePath);
      const destination = resolve(destinationRoot, relativePath);
      if (!isPathInside(sourceRoot, source) || !isPathInside(destinationRoot, destination)) {
        throw new BridgeError("invalid_target_root", "A copied workspace path escaped its root.", {
          httpStatus: 409,
        });
      }
      const info = await lstat(source);
      if (info.isSymbolicLink()) {
        throw new BridgeError("symlink_rejected", "Symlinks are not copied into a peer workspace.", {
          httpStatus: 409,
        });
      }
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        await chmod(destination, info.mode);
        await copyDirectory(relativePath);
        continue;
      }
      if (!info.isFile()) {
        throw new BridgeError(
          "unsupported_workspace_entry",
          "Only regular files and directories may enter a peer workspace.",
          { httpStatus: 409 },
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, info.mode);
    }
  };

  await copyDirectory("");
}

async function refreshWorkspace(
  sourceRoot: string,
  workspaceRoot: string,
  baselineTarget: WorkspaceManifest,
  allowedPaths: readonly string[],
  artifactId: string,
): Promise<WorkspaceManifest> {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const stagingRoot = `${workspaceRoot}.refresh-${suffix}`;
  const backupRoot = `${workspaceRoot}.previous-${suffix}`;
  let backupCreated = false;
  let replacementInstalled = false;
  try {
    await copyWorkspace(sourceRoot, stagingRoot);
    const stagedManifest = await buildFullManifest(stagingRoot, allowedPaths, artifactId);
    if (manifestScopeHash(stagedManifest) !== manifestScopeHash(baselineTarget)) {
      throw new BridgeError(
        "workspace_source_drift",
        "The main project changed while its fixed peer workspace was being refreshed.",
        { httpStatus: 409 },
      );
    }
    try {
      await lstat(workspaceRoot);
      await rename(workspaceRoot, backupRoot);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await rename(stagingRoot, workspaceRoot);
    replacementInstalled = true;
    const installedManifest = await buildFullManifest(workspaceRoot, allowedPaths, artifactId);
    if (manifestScopeHash(installedManifest) !== manifestScopeHash(baselineTarget)) {
      throw new BridgeError(
        "workspace_refresh_hash_mismatch",
        "The installed fixed peer workspace did not match the author baseline.",
        { httpStatus: 409 },
      );
    }
    if (backupCreated) {
      await rm(backupRoot, { recursive: true, force: true });
    }
    return installedManifest;
  } catch (error) {
    if (replacementInstalled) {
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (backupCreated) {
      await rename(backupRoot, workspaceRoot).catch(() => undefined);
    }
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function manifestMap(manifest: WorkspaceManifest): Map<string, ManifestEntry> {
  return new Map(manifest.files.map((entry) => [entry.relative_path, entry]));
}

function isRelativePathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function entriesMatch(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.kind === right.kind && left.bytes === right.bytes && left.sha256 === right.sha256 &&
    left.mode === right.mode;
}

function assertWorkspaceChangesAllowed(
  baselineManifest: WorkspaceManifest,
  currentManifest: WorkspaceManifest,
): void {
  const baseline = manifestMap(baselineManifest);
  const current = manifestMap(currentManifest);
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  for (const path of [...paths].sort()) {
    if (entriesMatch(baseline.get(path), current.get(path))) {
      continue;
    }
    const allowed = currentManifest.allowed_paths.some((allowedPath) =>
      isRelativePathWithin(allowedPath, path)
    );
    if (!allowed) {
      throw new BridgeError("reviewer_scope_violation", "Peer changed a path outside allowedPaths.", {
        httpStatus: 409,
        details: { relative_path: path },
      });
    }
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  let items;
  try {
    items = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  for (const item of items) {
    if (item.isSymbolicLink()) {
      continue;
    }
    const path = join(root, item.name);
    if (item.isDirectory()) {
      total += await directoryBytes(path);
    } else if (item.isFile()) {
      total += (await stat(path)).size;
    }
  }
  return total;
}

export function manifestContentHash(manifest: WorkspaceManifest): string {
  return sha256Json({
    artifact_id: manifest.artifact_id,
    target_root: manifest.target_root,
    allowed_paths: manifest.allowed_paths,
    files: manifest.files,
  });
}

function manifestScopeHash(manifest: WorkspaceManifest): string {
  return sha256Json({
    artifact_id: manifest.artifact_id,
    allowed_paths: manifest.allowed_paths,
    files: manifest.files,
  });
}

function highRiskChange(
  change: Omit<HighRiskChange, "id">,
): HighRiskChange {
  return { id: sha256Json(change), ...change };
}

function fileFingerprint(entry: ManifestEntry): string {
  return `${entry.sha256}\0${entry.mode ?? -1}`;
}

function classifyWorkspaceChanges(
  baselineManifest: WorkspaceManifest,
  currentManifest: WorkspaceManifest,
): { changedFiles: string[]; highRisk: HighRiskChange[] } {
  const baseline = manifestMap(baselineManifest);
  const current = manifestMap(currentManifest);
  const changedFiles = new Set<string>();
  const highRisk: HighRiskChange[] = [];
  const addedFiles = new Map<string, ManifestEntry>();
  const removed = new Map<string, ManifestEntry>();
  const typeChangedRoots = new Set<string>();

  for (const [path, entry] of current) {
    const before = baseline.get(path);
    if (before === undefined) {
      if (entry.kind === "file") {
        changedFiles.add(path);
        addedFiles.set(path, entry);
      }
      continue;
    }
    if (before.kind !== entry.kind) {
      typeChangedRoots.add(path);
      highRisk.push(
        highRiskChange({
          action: "type_change",
          path,
          ...(before.sha256 === "" ? {} : { before_sha256: before.sha256 }),
          ...(entry.sha256 === "" ? {} : { after_sha256: entry.sha256 }),
          ...(before.mode === undefined ? {} : { before_mode: before.mode }),
          ...(entry.mode === undefined ? {} : { after_mode: entry.mode }),
        }),
      );
      continue;
    }
    if (before.mode !== entry.mode) {
      highRisk.push(
        highRiskChange({
          action: "permission_change",
          path,
          ...(before.sha256 === "" ? {} : { before_sha256: before.sha256 }),
          ...(entry.sha256 === "" ? {} : { after_sha256: entry.sha256 }),
          ...(before.mode === undefined ? {} : { before_mode: before.mode }),
          ...(entry.mode === undefined ? {} : { after_mode: entry.mode }),
        }),
      );
      continue;
    }
    if (entry.kind === "file" && before.sha256 !== entry.sha256) {
      changedFiles.add(path);
    }
  }

  for (const [path, entry] of baseline) {
    if (!current.has(path)) {
      const coveredByTypeChange = [...typeChangedRoots].some(
        (root) => root !== path && isRelativePathWithin(root, path),
      );
      if (!coveredByTypeChange) {
        removed.set(path, entry);
      }
    }
  }

  const addedByFingerprint = new Map<string, string[]>();
  const removedByFingerprint = new Map<string, string[]>();
  for (const [path, entry] of addedFiles) {
    const paths = addedByFingerprint.get(fileFingerprint(entry)) ?? [];
    paths.push(path);
    addedByFingerprint.set(fileFingerprint(entry), paths);
  }
  for (const [path, entry] of removed) {
    if (entry.kind !== "file") {
      continue;
    }
    const paths = removedByFingerprint.get(fileFingerprint(entry)) ?? [];
    paths.push(path);
    removedByFingerprint.set(fileFingerprint(entry), paths);
  }
  for (const [fingerprint, addedPaths] of addedByFingerprint) {
    const removedPaths = removedByFingerprint.get(fingerprint) ?? [];
    if (addedPaths.length !== 1 || removedPaths.length !== 1) {
      continue;
    }
    const path = addedPaths[0]!;
    const fromPath = removedPaths[0]!;
    const after = addedFiles.get(path)!;
    const before = removed.get(fromPath)!;
    changedFiles.delete(path);
    removed.delete(fromPath);
    highRisk.push(
      highRiskChange({
        action: "rename",
        path,
        from_path: fromPath,
        before_sha256: before.sha256,
        after_sha256: after.sha256,
        ...(before.mode === undefined ? {} : { before_mode: before.mode }),
        ...(after.mode === undefined ? {} : { after_mode: after.mode }),
      }),
    );
  }

  const removedRoots: string[] = [];
  for (const path of [...removed.keys()].sort((left, right) => left.length - right.length)) {
    if (removedRoots.some((root) => isRelativePathWithin(root, path))) {
      continue;
    }
    removedRoots.push(path);
    const before = removed.get(path)!;
    highRisk.push(
      highRiskChange({
        action: "delete",
        path,
        ...(before.sha256 === "" ? {} : { before_sha256: before.sha256 }),
        ...(before.mode === undefined ? {} : { before_mode: before.mode }),
      }),
    );
  }

  return {
    changedFiles: [...changedFiles].sort(),
    highRisk: highRisk.sort((left, right) =>
      `${left.action}\0${left.from_path ?? ""}\0${left.path}`.localeCompare(
        `${right.action}\0${right.from_path ?? ""}\0${right.path}`,
      ),
    ),
  };
}

function collapseAffectedRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  for (const path of [...new Set(paths)].sort((left, right) => left.length - right.length)) {
    if (!roots.some((root) => isRelativePathWithin(root, path))) {
      roots.push(path);
    }
  }
  return roots;
}

async function copyEntry(sourceRoot: string, destinationRoot: string, relativePath: string): Promise<boolean> {
  const source = resolve(sourceRoot, relativePath);
  const destination = resolve(destinationRoot, relativePath);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new BridgeError("symlink_rejected", "Symlinks are not synchronized from a peer workspace.", {
      httpStatus: 409,
    });
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source, { withFileTypes: true })) {
      if (child.name.toLowerCase() === ".git") {
        throw new BridgeError("git_metadata_rejected", "Git metadata may not be synchronized.", {
          httpStatus: 409,
        });
      }
      await copyEntry(sourceRoot, destinationRoot, join(relativePath, child.name));
    }
    await chmod(destination, info.mode);
    return true;
  }
  if (!info.isFile()) {
    throw new BridgeError("unsupported_workspace_entry", "Only regular files and directories may be synchronized.", {
      httpStatus: 409,
    });
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, info.mode);
  return true;
}

async function applyWorkspaceChanges(
  handle: WorkspaceHandle,
  currentWorkspace: WorkspaceManifest,
  changedFiles: readonly string[],
  highRisk: readonly HighRiskChange[],
  onPhase?: (phase: "after_backup" | "after_replace") => void | Promise<void>,
): Promise<void> {
  const affectedRoots = collapseAffectedRoots([
    ...changedFiles,
    ...highRisk.flatMap((change) =>
      change.from_path === undefined ? [change.path] : [change.from_path, change.path],
    ),
  ]);
  if (affectedRoots.length === 0) {
    return;
  }
  const transactionRoot = join(
    dirname(handle.targetRoot),
    `.bridge-sync-${basename(handle.targetRoot)}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const stagingRoot = join(transactionRoot, "staging");
  const backupRoot = join(transactionRoot, "backup");
  const backups: string[] = [];
  try {
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    for (const relativePath of affectedRoots) {
      await copyEntry(handle.root, stagingRoot, relativePath);
    }
    for (const relativePath of affectedRoots) {
      const target = resolve(handle.targetRoot, relativePath);
      const backup = resolve(backupRoot, relativePath);
      if (!isPathInside(handle.targetRoot, target) || !isPathInside(backupRoot, backup)) {
        throw new BridgeError("invalid_allowed_path", "A synchronized path escaped its root.", {
          httpStatus: 400,
        });
      }
      try {
        await lstat(target);
        await mkdir(dirname(backup), { recursive: true });
        await rename(target, backup);
        backups.push(relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    await onPhase?.("after_backup");
    for (const relativePath of affectedRoots) {
      const staged = resolve(stagingRoot, relativePath);
      const target = resolve(handle.targetRoot, relativePath);
      try {
        await lstat(staged);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(staged, target);
    }
    await onPhase?.("after_replace");
    const expected = await buildManifest(handle.root, handle.allowedPaths, handle.artifactId);
    const actual = await buildManifest(handle.targetRoot, handle.allowedPaths, handle.artifactId);
    if (manifestScopeHash(expected) !== manifestScopeHash(actual)) {
      throw new BridgeError("workspace_sync_hash_mismatch", "Post-sync file hashes did not match the peer workspace.", {
        httpStatus: 409,
      });
    }
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    for (const relativePath of [...affectedRoots].reverse()) {
      await rm(resolve(handle.targetRoot, relativePath), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    for (const relativePath of [...backups].reverse()) {
      const backup = resolve(backupRoot, relativePath);
      const target = resolve(handle.targetRoot, relativePath);
      await mkdir(dirname(target), { recursive: true }).catch(() => undefined);
      await rename(backup, target).catch(() => undefined);
    }
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new BridgeError("workspace_sync_failed", "Atomic peer synchronization failed and was rolled back.", {
      httpStatus: 409,
      cause: error,
    });
  }
}

export class WorkspaceManager {
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #syncFault:
    | ((phase: "after_backup" | "after_replace") => void | Promise<void>)
    | undefined;
  readonly #locks = new Set<string>();
  readonly #activeRoots = new Map<string, string>();
  #capacityLock: Promise<void> = Promise.resolve();

  constructor(
    root: string,
    options: {
      maxBytes?: number;
      syncFault?: (phase: "after_backup" | "after_replace") => void | Promise<void>;
    } = {},
  ) {
    this.#root = resolve(root);
    this.#maxBytes = options.maxBytes ?? LIMITS.workspaceBytes;
    this.#syncFault = options.syncFault;
  }

  async #assertNoPersistentOverlap(targetRoot: string, ownLockPath: string): Promise<void> {
    const lockDirectory = dirname(ownLockPath);
    for (const record of await readPersistentLocks(lockDirectory)) {
      const candidateRoot = resolve(record.target_root);
      const candidateLock = join(lockDirectory, `${sha256(`${record.artifact_id}\0${candidateRoot}`).slice(0, 32)}.lock`);
      if (candidateLock === ownLockPath || lockIsStale(record)) {
        continue;
      }
      if (isPathInside(candidateRoot, targetRoot) || isPathInside(targetRoot, candidateRoot)) {
        throw new BridgeError("target_root_conflict", "An active peer job has an overlapping targetRoot.", {
          httpStatus: 409,
          retryable: true,
          details: { target_root: targetRoot, active_target_root: candidateRoot },
        });
      }
    }
  }

  async #withCapacityLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#capacityLock;
    let release!: () => void;
    this.#capacityLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async prepare(request: BridgeRequest): Promise<WorkspaceHandle | undefined> {
    if (request.target_root === undefined) {
      return undefined;
    }
    if (request.artifact_id === undefined) {
      throw new BridgeError("artifact_id_required", "targetRoot requires a stable artifactId.", {
        httpStatus: 400,
      });
    }
    const targetRoot = resolve(request.target_root);
    await assertTargetRoot(targetRoot);
    const allowedPaths = request.allowed_paths ?? [];
    if (allowedPaths.length === 0) {
      throw new BridgeError("allowed_paths_required", "Write-capable peer jobs require allowedPaths.", {
        httpStatus: 400,
      });
    }
    const key = sha256(`${request.artifact_id}\0${targetRoot}`).slice(0, 32);
    const workspaceRoot = join(this.#root, "workspaces", key);
    const lockPath = join(this.#root, "locks", `${key}.lock`);
    await this.#assertNoPersistentOverlap(targetRoot, lockPath);
    for (const activeRoot of this.#activeRoots.values()) {
      if (isPathInside(activeRoot, targetRoot) || isPathInside(targetRoot, activeRoot)) {
        throw new BridgeError("target_root_conflict", "An active peer job has an overlapping targetRoot.", {
          httpStatus: 409,
          retryable: true,
        });
      }
    }
    if (this.#locks.has(lockPath)) {
      throw new BridgeError("artifact_lock_conflict", "An artifact review is already active.", {
        httpStatus: 409,
      });
    }
    await acquireLock(lockPath, request, targetRoot);
    this.#locks.add(lockPath);
    this.#activeRoots.set(lockPath, targetRoot);
    try {
      const baselineTarget = await buildFullManifest(targetRoot, allowedPaths, request.artifact_id, {
        skipGit: true,
      });
      const baselineBytes = baselineTarget.files.reduce(
        (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
        0,
      );
      const baselineWorkspace = await this.#withCapacityLock(async () => {
        const workspacesRoot = join(this.#root, "workspaces");
        const existingBytes = await directoryBytes(workspacesRoot);
        const replacedBytes = await directoryBytes(workspaceRoot);
        if (existingBytes - replacedBytes + baselineBytes > this.#maxBytes) {
          throw new BridgeError(
            "workspace_capacity_reached",
            "Peer workspace capacity is reached; no user material was deleted automatically.",
            { httpStatus: 507 },
          );
        }
        return refreshWorkspace(
          targetRoot,
          workspaceRoot,
          baselineTarget,
          allowedPaths,
          request.artifact_id as string,
        );
      });
      const retainedUntil = new Date(Date.now() + LIMITS.workspaceRetentionMs).toISOString();
      baselineTarget.retained_until = retainedUntil;
      baselineWorkspace.retained_until = retainedUntil;
      baselineTarget.sha256 = manifestContentHash(baselineTarget);
      baselineWorkspace.sha256 = manifestContentHash(baselineWorkspace);
      await atomicWriteJson(`${workspaceRoot}.manifest.json`, baselineWorkspace, { protect: true });
      return {
        root: workspaceRoot,
        targetRoot,
        artifactId: request.artifact_id,
        allowedPaths: [...baselineTarget.allowed_paths],
        baselineTarget,
        baselineWorkspace,
        lockPath,
        retainedUntil,
      };
    } catch (error) {
      this.#locks.delete(lockPath);
      this.#activeRoots.delete(lockPath);
      await releaseLock(lockPath);
      throw error;
    }
  }

  async sync(
    handle: WorkspaceHandle,
    options: {
      approvedChangeIds?: readonly string[];
      expectedResultManifestHash?: string;
    } = {},
  ): Promise<SyncResult> {
    const currentTarget = await buildFullManifest(
      handle.targetRoot,
      handle.allowedPaths,
      handle.artifactId,
      { skipGit: true },
    );
    if (manifestContentHash(currentTarget) !== manifestContentHash(handle.baselineTarget)) {
      throw new BridgeError("workspace_baseline_drift", "The main project changed during peer review.", {
        httpStatus: 409,
        details: { target_root: handle.targetRoot },
      });
    }
    const currentWorkspace = await buildFullManifest(handle.root, handle.allowedPaths, handle.artifactId);
    assertWorkspaceChangesAllowed(handle.baselineWorkspace, currentWorkspace);
    const resultManifestHash = manifestContentHash(currentWorkspace);
    if (
      options.expectedResultManifestHash !== undefined &&
      options.expectedResultManifestHash !== resultManifestHash
    ) {
      throw new BridgeError(
        "workspace_result_drift",
        "The retained peer workspace changed after the review result was recorded.",
        { httpStatus: 409 },
      );
    }
    const { changedFiles, highRisk } = classifyWorkspaceChanges(
      handle.baselineWorkspace,
      currentWorkspace,
    );
    const baselineManifestHash = manifestContentHash(handle.baselineTarget);
    if (highRisk.length > 0) {
      if (options.approvedChangeIds !== undefined) {
        const expectedIds = [...new Set(highRisk.map((change) => change.id))].sort();
        const approvedIds = [...new Set(options.approvedChangeIds)].sort();
        if (
          expectedIds.length !== approvedIds.length ||
          expectedIds.some((id, index) => id !== approvedIds[index])
        ) {
          throw new BridgeError(
            "sync_approval_mismatch",
            "Approved change IDs must exactly match the pending high-risk changes.",
            {
              httpStatus: 409,
              details: { expected_change_ids: expectedIds },
            },
          );
        }
      } else {
        return {
          status: "awaiting_user",
          changedFiles,
          highRisk,
          baselineManifestHash,
          resultManifestHash,
          resultManifest: currentWorkspace,
        };
      }
    } else if (options.approvedChangeIds !== undefined) {
      throw new BridgeError(
        "sync_approval_not_required",
        "The retained workspace has no high-risk changes requiring approval.",
        { httpStatus: 409 },
      );
    }
    await applyWorkspaceChanges(
      handle,
      currentWorkspace,
      changedFiles,
      highRisk,
      this.#syncFault,
    );
    return {
      status: "synced",
      changedFiles,
      highRisk,
      baselineManifestHash,
      resultManifestHash,
      resultManifest: currentWorkspace,
    };
  }

  async approveSync(
    request: BridgeRequest,
    baselineTarget: WorkspaceManifest,
    expectedResultManifestHash: string,
    approvedChangeIds: readonly string[],
    syncRequestId: string,
  ): Promise<SyncApprovalResult> {
    if (
      request.target_root === undefined ||
      request.artifact_id === undefined ||
      request.allowed_paths === undefined
    ) {
      throw new BridgeError(
        "sync_approval_unavailable",
        "The original job does not contain a complete retained-workspace contract.",
        { httpStatus: 409 },
      );
    }
    const targetRoot = resolve(request.target_root);
    await assertTargetRoot(targetRoot);
    const key = sha256(`${request.artifact_id}\0${targetRoot}`).slice(0, 32);
    const workspaceRoot = join(this.#root, "workspaces", key);
    const lockPath = join(this.#root, "locks", `${key}.lock`);
    await this.#assertNoPersistentOverlap(targetRoot, lockPath);
    for (const activeRoot of this.#activeRoots.values()) {
      if (isPathInside(activeRoot, targetRoot) || isPathInside(targetRoot, activeRoot)) {
        throw new BridgeError("target_root_conflict", "An active peer job has an overlapping targetRoot.", {
          httpStatus: 409,
          retryable: true,
        });
      }
    }
    if (this.#locks.has(lockPath)) {
      throw new BridgeError("artifact_lock_conflict", "An artifact review is already active.", {
        httpStatus: 409,
      });
    }
    await acquireLock(lockPath, request, targetRoot);
    this.#locks.add(lockPath);
    this.#activeRoots.set(lockPath, targetRoot);
    let baselineWorkspace: WorkspaceManifest;
    try {
      const parsed = JSON.parse(await readFile(`${workspaceRoot}.manifest.json`, "utf8")) as WorkspaceManifest;
      if (
        parsed.version !== 1 ||
        parsed.artifact_id !== request.artifact_id ||
        resolve(parsed.root) !== workspaceRoot ||
        parsed.sha256 !== manifestContentHash(parsed)
      ) {
        throw new BridgeError(
          "workspace_manifest_invalid",
          "The retained peer workspace manifest failed its identity or hash check.",
          { httpStatus: 409 },
        );
      }
      const expectedAllowed = [...new Set(request.allowed_paths.map(rejectUnsafeRelativePath))].sort();
      if (
        expectedAllowed.length !== parsed.allowed_paths.length ||
        expectedAllowed.some((path, index) => path !== parsed.allowed_paths[index])
      ) {
        throw new BridgeError(
          "workspace_manifest_invalid",
          "The retained peer workspace allowlist no longer matches the original job.",
          { httpStatus: 409 },
        );
      }
      baselineWorkspace = parsed;
      const result = await this.sync(
        {
          root: workspaceRoot,
          targetRoot,
          artifactId: request.artifact_id,
          allowedPaths: expectedAllowed,
          baselineTarget,
          baselineWorkspace,
          lockPath,
          retainedUntil:
            baselineWorkspace.retained_until ??
            new Date(Date.now() + LIMITS.workspaceRetentionMs).toISOString(),
        },
        { approvedChangeIds, expectedResultManifestHash },
      );
      if (result.status !== "synced") {
        throw new BridgeError("sync_approval_incomplete", "Approved synchronization did not complete.", {
          httpStatus: 409,
        });
      }
      return {
        ...result,
        syncRequestId,
      };
    } catch (error) {
      throw error;
    } finally {
      this.#locks.delete(lockPath);
      this.#activeRoots.delete(lockPath);
      await releaseLock(lockPath);
    }
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    this.#locks.delete(handle.lockPath);
    this.#activeRoots.delete(handle.lockPath);
    await releaseLock(handle.lockPath);
  }
}
