import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelJob,
  getJobStatus,
  listSessions,
  submitJob,
  waitJob,
} from "../../src/api.js";
import { getDaemonPaths, type DaemonPaths } from "../../src/config.js";
import { daemonHealth, requestDaemon } from "../../src/daemon/client.js";
import { readToken } from "../../src/daemon/runtime.js";
import { createBridgeRequest } from "../../src/request.js";
import type { PublicJobResult } from "../../src/types.js";

interface StartedDaemon {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
}

const sourceFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(sourceFile), "../../..");
const daemonMain = resolve(dirname(sourceFile), "../../src/daemon/main.js");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function taskkill(pid: number, tree: boolean): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGKILL");
    return;
  }
  const args = [...(tree ? ["/T"] : []), "/F", "/PID", String(pid)];
  const child = spawn("taskkill.exe", args, {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  await once(child, "close");
}

async function startDaemon(paths: DaemonPaths): Promise<StartedDaemon> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_BRIDGE_HOME: paths.root,
  };
  delete environment.BRIDGE_SKIP_ACL;
  const child = spawn(process.execPath, [daemonMain, "serve"], {
    cwd: projectRoot,
    env: environment,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrText.length < 16_384) {
      stderrText += chunk.toString("utf8");
    }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited during startup: ${stderrText.trim()}`);
    }
    try {
      await daemonHealth(paths);
      return { child, stderr: () => stderrText };
    } catch {
      await delay(100);
    }
  }
  await taskkill(child.pid ?? -1, true).catch(() => undefined);
  throw new Error(`daemon health timeout: ${stderrText.trim()}`);
}

async function waitForState(
  paths: DaemonPaths,
  jobId: string,
  expected: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getJobStatus(jobId, paths);
    if (expected.includes(status.state)) {
      return status.state;
    }
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach ${expected.join(",")}`);
}

async function waitComplete(paths: DaemonPaths, jobId: string): Promise<PublicJobResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waited = await waitJob(jobId, 45_000, paths);
    if (waited.status === "complete" && waited.job !== undefined) {
      return waited.job;
    }
  }
  throw new Error(`job ${jobId} remained pending after 180 seconds`);
}

async function stopDaemon(paths: DaemonPaths, daemon: StartedDaemon): Promise<void> {
  if (daemon.child.exitCode === null) {
    await requestDaemon("/shutdown", { method: "POST", body: {}, paths }).catch(() => undefined);
    await Promise.race([once(daemon.child, "close"), delay(20_000)]);
  }
  if (daemon.child.exitCode === null && daemon.child.pid !== undefined) {
    await taskkill(daemon.child.pid, true);
  }
}

async function run(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("M1 live verification requires Windows because process-tree semantics use taskkill.");
  }
  const localBase = process.env.LOCALAPPDATA ?? tmpdir();
  const liveBase = join(localBase, "claude-codex-bridge", "live-tests");
  await mkdir(liveBase, { recursive: true });
  const root = await mkdtemp(join(liveBase, "run-"));
  const paths = getDaemonPaths(root);
  const marker = `M1_${randomBytes(8).toString("hex")}`;
  const results: Record<string, unknown> = {};
  let daemon: StartedDaemon | undefined;

  try {
    daemon = await startDaemon(paths);

    const first = await submitJob(
      createBridgeRequest(
        {
          question: `Reply only with this exact token: ${marker}`,
          bridge_thread_id: "live-resume-thread",
        },
        { origin: "live-test" },
      ),
      paths,
    );
    const firstResult = await waitComplete(paths, first.job_id);
    assert.equal(firstResult.state, "succeeded", JSON.stringify(firstResult.error));
    assert.match(firstResult.result ?? "", new RegExp(marker, "u"));

    const second = await submitJob(
      createBridgeRequest(
        {
          question: "Repeat the exact token from your previous response. Reply only with that token.",
          bridge_thread_id: "live-resume-thread",
        },
        { origin: "live-test" },
      ),
      paths,
    );
    const secondResult = await waitComplete(paths, second.job_id);
    assert.equal(secondResult.state, "succeeded", JSON.stringify(secondResult.error));
    assert.match(secondResult.result ?? "", new RegExp(marker, "u"));
    const sessions = await listSessions(paths);
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0]?.owner, "daemon");
    results.resume = "PASS";

    const cancellable = await submitJob(
      createBridgeRequest(
        {
          question: "Write 10000 numbered lines, one number per line, without abbreviating.",
          bridge_thread_id: "live-cancel-thread",
        },
        { origin: "live-test" },
      ),
      paths,
    );
    await waitForState(paths, cancellable.job_id, ["running"]);
    const cancelled = await cancelJob(cancellable.job_id, paths);
    assert.equal(cancelled.target_confirmed, true);
    assert.equal((await getJobStatus(cancellable.job_id, paths)).state, "cancelled");
    results.cancel = "PASS";

    const expiring = await submitJob(
      createBridgeRequest(
        {
          question: "Write 10000 numbered lines, one number per line, without abbreviating.",
          bridge_thread_id: "live-timeout-thread",
          deadline: new Date(Date.now() + 2_000).toISOString(),
        },
        { origin: "live-test" },
      ),
      paths,
    );
    const expiredResult = await waitComplete(paths, expiring.job_id);
    assert.equal(expiredResult.state, "expired");
    assert.equal(expiredResult.error?.code, "job_timeout");
    results.timeout = "PASS";

    const crashJob = await submitJob(
      createBridgeRequest(
        {
          question: "Write 10000 numbered lines, one number per line, without abbreviating.",
          bridge_thread_id: "live-crash-thread",
        },
        { origin: "live-test" },
      ),
      paths,
    );
    await waitForState(paths, crashJob.job_id, ["running"]);
    const crashDetail = JSON.parse(
      await readFile(join(paths.jobs, `${crashJob.job_id}.json`), "utf8"),
    ) as { child_pid?: number };
    assert.equal(typeof crashDetail.child_pid, "number");
    const firstDaemonPid = daemon.child.pid;
    assert.equal(typeof firstDaemonPid, "number");
    await taskkill(firstDaemonPid as number, false);
    await once(daemon.child, "close");

    daemon = await startDaemon(paths);
    const recovered = await getJobStatus(crashJob.job_id, paths);
    assert.equal(recovered.state, "needs_attention");
    assert.equal(recovered.error_code, "daemon_restarted");
    assert.equal(await processAlive(crashDetail.child_pid as number), false);
    results.crash_recovery = "PASS";

    const token = await readToken(paths.token);
    const auditText = await readFile(paths.audit, "utf8");
    assert.doesNotMatch(auditText, new RegExp(marker, "u"));
    assert.doesNotMatch(auditText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    const acl = spawn("icacls.exe", [paths.token], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aclText = "";
    acl.stdout.on("data", (chunk: Buffer) => {
      aclText += chunk.toString("utf8");
    });
    const [aclCode] = (await once(acl, "close")) as [number | null];
    assert.equal(aclCode, 0);
    assert.doesNotMatch(aclText, /\(I\)/u);
    results.audit_and_acl = "PASS";

    await stopDaemon(paths, daemon);
    daemon = undefined;
    await assert.rejects(access(paths.endpoint));
    await assert.rejects(access(paths.lock));
    results.clean_stop = "PASS";

    process.stdout.write(
      `${JSON.stringify({ ok: true, suite: "M1 live", results, claude_sessions: sessions.sessions.length }, null, 2)}\n`,
    );
  } catch (error) {
    const stderr = daemon?.stderr().trim();
    if (stderr !== undefined && stderr !== "") {
      process.stderr.write(`daemon stderr: ${stderr}\n`);
    }
    throw error;
  } finally {
    if (daemon !== undefined) {
      await stopDaemon(paths, daemon).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
