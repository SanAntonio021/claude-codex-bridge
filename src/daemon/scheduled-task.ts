import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { BridgeError } from "../errors.js";

export const DAEMON_TASK_NAME = "ClaudeCodexBridgeDaemon";

export function scheduledTaskPowerShellArgs(
  scriptPath: string,
  nodePath: string,
  daemonPath: string,
  workingDirectory: string,
): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-NodePath",
    nodePath,
    "-DaemonPath",
    daemonPath,
    "-WorkingDirectory",
    workingDirectory,
  ];
}

export async function installDaemonScheduledTask(
  scriptPath: string,
  nodePath: string,
  daemonPath: string,
  workingDirectory: string,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new BridgeError(
      "scheduled_task_unsupported",
      "The bridge login task is only supported on Windows.",
    );
  }
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    powershell,
    scheduledTaskPowerShellArgs(scriptPath, nodePath, daemonPath, workingDirectory),
    { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_192) {
      stderr += chunk.slice(0, 8_192 - stderr.length);
    }
  });
  let code: number | null;
  try {
    [code] = await once(child, "close") as [number | null];
  } catch (error) {
    throw new BridgeError(
      "scheduled_task_install_failed",
      "Unable to launch the bridge login-task installer.",
      {
        httpStatus: 500,
        details: {
          launch_error: error instanceof Error ? error.message.slice(0, 1_024) : "unknown",
        },
        cause: error,
      },
    );
  }
  if (code !== 0) {
    throw new BridgeError(
      "scheduled_task_install_failed",
      "Unable to register the bridge login task.",
      { httpStatus: 500, details: { exit_code: code, stderr: stderr.trim().slice(0, 1_024) } },
    );
  }
}
