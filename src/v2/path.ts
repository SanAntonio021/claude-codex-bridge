import { realpath as realpathCallback, type BigIntStats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BridgeError } from "../errors.js";
import { sha256 } from "../hash.js";
import { normalizeV2RelativePath } from "./types.js";

const realpathNative = promisify(realpathCallback.native);

export interface V2FileIdentity {
  relativePath: string;
  kind: "file" | "directory";
  bytes: number;
  sha256: string;
  mode: number;
  fileId: string;
}

export interface V2TreeSnapshot {
  root: string;
  files: V2FileIdentity[];
  bytes: number;
  fileCount: number;
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isReparseOrLink(info: BigIntStats): boolean {
  // Node exposes NTFS junctions and symlinks through lstat().isSymbolicLink().
  // realpath.native below independently verifies that no component escaped.
  return info.isSymbolicLink();
}

export async function nativeRealpath(path: string): Promise<string> {
  return realpathNative(path);
}

function fileId(info: BigIntStats, relativePath: string): string {
  // `Stats.ino` is a JavaScript number by default. NTFS file IDs can exceed
  // Number.MAX_SAFE_INTEGER, which can alias two distinct files after rounding.
  if (info.dev <= 0n || info.ino <= 0n) {
    throw new BridgeError("file_identity_unavailable", "Protocol v2 could not verify an exact file identity.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  return `${info.dev.toString()}:${info.ino.toString()}`;
}

function assertSafeName(relativePath: string): string {
  return normalizeV2RelativePath(relativePath, "workspace path");
}

async function assertRegularNode(
  absolutePath: string,
  root: string,
  relativePath: string,
): Promise<BigIntStats> {
  const info = await lstat(absolutePath, { bigint: true });
  if (isReparseOrLink(info)) {
    throw new BridgeError("reparse_point_rejected", "Protocol v2 rejects symlinks, junctions, and reparse points.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  if (!info.isDirectory() && !info.isFile()) {
    throw new BridgeError("unsupported_workspace_entry", "Protocol v2 accepts only ordinary files and directories.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  if (info.isFile() && info.nlink > 1n) {
    throw new BridgeError("hardlink_rejected", "Protocol v2 rejects hardlinked files.", {
      httpStatus: 409,
      details: { path: relativePath, nlink: info.nlink },
    });
  }
  const resolved = await nativeRealpath(absolutePath);
  if (!pathIsInside(root, resolved)) {
    throw new BridgeError("path_escape_rejected", "Protocol v2 path resolved outside its declared root.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  return info;
}

export async function assertV2Root(root: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw new BridgeError("invalid_target_root", "Protocol v2 targetRoot must be an absolute path.", {
      httpStatus: 400,
    });
  }
  const resolved = resolve(root);
  let info: BigIntStats;
  try {
    info = await lstat(resolved, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("invalid_target_root", "Protocol v2 targetRoot must exist.", { httpStatus: 400 });
    }
    throw error;
  }
  if (!info.isDirectory() || isReparseOrLink(info)) {
    throw new BridgeError("invalid_target_root", "Protocol v2 targetRoot must be a normal directory.", {
      httpStatus: 409,
    });
  }
  return nativeRealpath(resolved);
}

export async function resolveV2Path(
  root: string,
  relativePath: string,
  options: { mustExist?: boolean; allowMissingLeaf?: boolean } = {},
): Promise<string> {
  const normalized = normalizeV2RelativePath(relativePath, "path");
  const realRoot = await assertV2Root(root);
  const candidate = resolve(realRoot, ...normalized.split("/"));
  if (!pathIsInside(realRoot, candidate)) {
    throw new BridgeError("path_escape_rejected", "Protocol v2 path escaped its declared root.", {
      httpStatus: 409,
      details: { path: normalized },
    });
  }
  let existing = candidate;
  for (;;) {
    try {
      const realExisting = await nativeRealpath(existing);
      if (!pathIsInside(realRoot, realExisting)) {
        throw new BridgeError("path_escape_rejected", "Protocol v2 resolved a path outside its root.", {
          httpStatus: 409,
          details: { path: normalized },
        });
      }
      break;
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = resolve(existing, "..");
      if (parent === existing) {
        throw new BridgeError("path_escape_rejected", "Protocol v2 could not verify a path parent.", {
          httpStatus: 409,
          details: { path: normalized },
        });
      }
      existing = parent;
    }
  }
  try {
    await assertRegularNode(candidate, realRoot, normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissingLeaf === true) {
      return candidate;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.mustExist !== true) {
      return candidate;
    }
    throw error;
  }
  return candidate;
}

export function decodeStrictUtf8(bytes: Buffer, relativePath = "artifact"): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new BridgeError("utf8_bom_rejected", "Protocol v2 files must be strict UTF-8 without a BOM.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BridgeError("invalid_utf8", "Protocol v2 files must be strict UTF-8.", {
      httpStatus: 409,
      details: { path: relativePath },
      cause: error,
    });
  }
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new BridgeError("invalid_utf8", "Protocol v2 rejects non-canonical UTF-8 bytes.", {
      httpStatus: 409,
      details: { path: relativePath },
    });
  }
  return content;
}

export async function readV2Utf8File(root: string, relativePath: string): Promise<{
  path: string;
  content: string;
  bytes: Buffer;
  sha256: string;
}> {
  const normalized = normalizeV2RelativePath(relativePath, "path");
  const path = await resolveV2Path(root, normalized, { mustExist: true });
  const info = await lstat(path);
  if (!info.isFile()) {
    throw new BridgeError("artifact_not_file", "Protocol v2 artifactPath must name an ordinary file.", {
      httpStatus: 409,
      details: { path: normalized },
    });
  }
  const bytes = await readFile(path);
  return { path, content: decodeStrictUtf8(bytes, normalized), bytes, sha256: sha256(bytes) };
}

export async function snapshotV2Tree(
  root: string,
  options: { excludeGitDirectory?: boolean } = {},
): Promise<V2TreeSnapshot> {
  const realRoot = await assertV2Root(root);
  const files: V2FileIdentity[] = [];
  const casePaths = new Map<string, string>();
  const fileIds = new Map<string, string>();

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLocaleLowerCase("en-US") === ".git") {
        if (options.excludeGitDirectory === true) {
          continue;
        }
        throw new BridgeError("reviewer_scope_violation", "Protocol v2 rejects Git metadata in a fixed workspace.", {
          httpStatus: 409,
          details: { path: relativeDirectory === "" ? ".git" : `${relativeDirectory}/.git` },
        });
      }
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const normalized = assertSafeName(relativePath);
      const folded = normalized.toLocaleLowerCase("en-US");
      const existing = casePaths.get(folded);
      if (existing !== undefined && existing !== normalized) {
        throw new BridgeError("case_collision_rejected", "Protocol v2 rejects case-colliding workspace paths.", {
          httpStatus: 409,
          details: { first_path: existing, second_path: normalized },
        });
      }
      casePaths.set(folded, normalized);
      const absolute = join(directory, entry.name);
      const info = await assertRegularNode(absolute, realRoot, normalized);
      if (info.isDirectory()) {
        files.push({
          relativePath: normalized,
          kind: "directory",
          bytes: 0,
          sha256: "",
          mode: Number(info.mode),
          fileId: fileId(info, normalized),
        });
        await walk(absolute, normalized);
        continue;
      }
      const data = await readFile(absolute);
      decodeStrictUtf8(data, normalized);
      const id = fileId(info, normalized);
      const existingFile = fileIds.get(id);
      if (existingFile !== undefined && existingFile !== normalized) {
        throw new BridgeError("hardlink_rejected", "Protocol v2 rejects duplicate file identities.", {
          httpStatus: 409,
          details: { first_path: existingFile, second_path: normalized },
        });
      }
      fileIds.set(id, normalized);
      files.push({
        relativePath: normalized,
        kind: "file",
        bytes: data.byteLength,
        sha256: sha256(data),
        mode: Number(info.mode),
        fileId: id,
      });
    }
  };

  await walk(realRoot, "");
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return {
    root: realRoot,
    files,
    bytes: files.reduce((total, entry) => total + (entry.kind === "file" ? entry.bytes : 0), 0),
    fileCount: files.filter((entry) => entry.kind === "file").length,
  };
}

export function sameV2Snapshot(
  left: V2TreeSnapshot,
  right: V2TreeSnapshot,
  options: { includeFileId?: boolean } = {},
): boolean {
  if (left.files.length !== right.files.length) {
    return false;
  }
  return left.files.every((entry, index) => {
    const other = right.files[index];
    return other !== undefined
      && entry.relativePath === other.relativePath
      && entry.kind === other.kind
      && entry.bytes === other.bytes
      && entry.sha256 === other.sha256
      && entry.mode === other.mode
      && (options.includeFileId !== true || entry.fileId === other.fileId);
  });
}
