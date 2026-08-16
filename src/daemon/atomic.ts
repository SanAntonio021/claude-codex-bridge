import { randomBytes } from "node:crypto";
import { open, mkdir, rename, unlink, chmod, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { BridgeError } from "../errors.js";

const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160, 320, 500] as const;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const STALE_TEMPORARY_FILE = /^\.[A-Za-z0-9_.-]+\.\d+\.[0-9a-f]{16}\.tmp$/u;

interface RenameRetryOptions {
  renameFile?: (source: string, target: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function renameWithTransientRetry(
  source: string,
  target: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const wait = options.wait ?? (async (milliseconds: number) => {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) {
        throw error;
      }
      await wait(delay);
    }
  }
}

function moveFileExReplace(source: string, target: string): void {
  if (process.platform !== "win32" || process.env.BRIDGE_SKIP_ACL === "1") {
    return;
  }
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop",
    "Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class BridgeMoveFile {\n  [DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)]\n  public static extern bool MoveFileEx(string source, string destination, int flags);\n}\n'@",
    "if (-not [BridgeMoveFile]::MoveFileEx([string]$payload.source, [string]$payload.target, 9)) { exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() }",
  ].join("\n");
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: `${JSON.stringify({ source, target })}\n`,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new BridgeError("atomic_replace_failed", "Unable to atomically replace protected bridge data.", {
      httpStatus: 500,
      details: { exit_code: result.status ?? null },
    });
  }
}

async function atomicReplace(source: string, target: string): Promise<void> {
  if (process.platform === "win32" && process.env.BRIDGE_SKIP_ACL !== "1") {
    moveFileExReplace(source, target);
    return;
  }
  await renameWithTransientRetry(source, target);
}

function currentWindowsUserSid(): string {
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = /S-\d-\d+(?:-\d+)+/iu.exec(result.stdout)?.[0];
  if (result.status !== 0 || sid === undefined) {
    throw new BridgeError("acl_identity_failed", "Unable to resolve the current Windows SID for ACL.", {
      httpStatus: 500,
    });
  }
  return sid;
}
export async function protectPath(path: string, directory = false): Promise<void> {
  await chmod(path, directory ? 0o700 : 0o600).catch(() => undefined);
  if (process.platform !== "win32" || process.env.BRIDGE_SKIP_ACL === "1") {
    return;
  }

  const sid = currentWindowsUserSid();
  const permission = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:(F)`;
  const result = spawnSync(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", permission],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new BridgeError("acl_protection_failed", "Unable to protect bridge runtime path.", {
      httpStatus: 500,
      details: { path: basename(path) },
    });
  }
}

export async function ensureProtectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await protectPath(path, true);
}

export async function atomicWriteFile(
  path: string,
  data: string | Buffer,
  options: { protect?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    if (options.protect === true) {
      await protectPath(temporary, false);
    }
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(temporary, path);
    if (options.protect === true) {
      await protectPath(path, false);
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: { protect?: boolean } = {},
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function appendFlushedLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function cleanupStaleTemporaryFiles(
  directory: string,
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.isFile() || !STALE_TEMPORARY_FILE.test(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      const handle = await open(path, "r");
      let modifiedAt = 0;
      try {
        modifiedAt = (await handle.stat()).mtimeMs;
      } finally {
        await handle.close();
      }
      if (modifiedAt < cutoff) {
        await rm(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
