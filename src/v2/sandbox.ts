import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { sha256 } from "../hash.js";
import { terminateProcessTree } from "../adapter/claude.js";
import type { V2TestResult } from "./gate.js";
import type { V2TestCommand } from "./types.js";

const require = createRequire(import.meta.url);
const MAX_OUTPUT_BYTES = 128 * 1024;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export interface V2SandboxProbe {
  at: string;
  v2WorkspaceTests: boolean;
  workspaceWrite: boolean;
  externalWriteDenied: boolean;
  loopbackDenied: boolean;
  internetDenied: boolean;
  childInheritanceDenied: boolean;
  childTreeTerminated: boolean;
  error?: string;
}

export interface V2SandboxRunnerOptions {
  onSpawn?(pid: number): Promise<void> | void;
}

function bundledCodexEntry(): string {
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch (error) {
    throw new BridgeError("bundled_codex_missing", "The SDK-bundled Codex CLI is unavailable.", {
      httpStatus: 500,
      cause: error,
    });
  }
}

async function assertProgram(command: V2TestCommand): Promise<string> {
  if (!isAbsolute(command.program) || extname(command.program).toLowerCase() !== ".exe") {
    throw new BridgeError("invalid_test_program", "Protocol v2 test program must be an absolute ordinary .exe file.", {
      httpStatus: 400,
    });
  }
  const path = resolve(command.program);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new BridgeError("invalid_test_program", "Protocol v2 test program must be a non-linked ordinary file.", {
      httpStatus: 409,
    });
  }
  const bytes = await readFile(path);
  const hash = sha256(bytes);
  if (bytes.byteLength !== command.programBytes || hash !== command.programSha256) {
    throw new BridgeError("test_program_integrity_mismatch", "Protocol v2 test program bytes or SHA-256 changed.", {
      httpStatus: 409,
      details: { program: basename(path) },
    });
  }
  return path;
}

function sandboxProfileName(): string {
  return `bridge_workspace_${randomUUID().replaceAll("-", "")}`;
}

function sandboxFilesystemConfig(profile: string, program: string): string {
  return [
    `permissions.${profile}.filesystem={`,
    '":minimal"="read",',
    `${tomlString(program)}="read",`,
    '":workspace_roots"={"."="write"}',
    "}",
  ].join("");
}

export function buildSandboxArguments(
  workspace: string,
  command: { program: string; args: readonly string[] },
  profile: string,
): string[] {
  return [
    bundledCodexEntry(),
    "sandbox",
    "--config",
    sandboxFilesystemConfig(profile, command.program),
    "--config",
    `permissions.${profile}.network.enabled=false`,
    "--config",
    `permissions.${profile}.network.allow_upstream_proxy=false`,
    "--config",
    `permissions.${profile}.network.enable_socks5=false`,
    "--config",
    "features.network_proxy=true",
    "--config",
    'windows.sandbox="elevated"',
    "--permission-profile",
    profile,
    "-C",
    workspace,
    command.program,
    ...command.args,
  ];
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, BRIDGE_CHILD: "1" };
  for (const key of Object.keys(environment)) {
    if (
      key.toUpperCase() === "CLAUDE_CODEX_BRIDGE_TOKEN"
      || key.toUpperCase() === "CODEX_MODEL"
      || key.toUpperCase() === "CODEX_HOME"
      || key.toUpperCase() === "HTTP_PROXY"
      || key.toUpperCase() === "HTTPS_PROXY"
      || key.toUpperCase() === "ALL_PROXY"
      || key.toUpperCase() === "NO_PROXY"
    ) {
      delete environment[key];
    }
  }
  return environment;
}

async function runSandbox(
  workspace: string,
  command: { program: string; args: readonly string[]; timeoutMs: number },
  options: V2SandboxRunnerOptions,
): Promise<{ code: number | null; timedOut: boolean; output: string; pid?: number }> {
  const profile = sandboxProfileName();
  const child = spawn(
    process.execPath,
    buildSandboxArguments(workspace, command, profile),
    {
      cwd: workspace,
      env: sanitizedEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const sandboxPid = child.pid;
  if (sandboxPid !== undefined) {
    await options.onSpawn?.(sandboxPid);
  }
  let output = "";
  const append = (chunk: Buffer): void => {
    if (Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES) {
      return;
    }
    const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(output, "utf8");
    output += chunk.subarray(0, remaining).toString("utf8");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      termination ??= terminateProcessTree(child.pid);
    }
  }, command.timeoutMs);
  timeout.unref();
  const code = await new Promise<number | null>((resolveClose, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("close", resolveClose);
  }).finally(() => clearTimeout(timeout));
  await termination;
  return {
    code,
    timedOut,
    output: output.trim().slice(0, MAX_OUTPUT_BYTES),
    ...(sandboxPid === undefined ? {} : { pid: sandboxPid }),
  };
}

export class V2SandboxRunner {
  readonly #options: V2SandboxRunnerOptions;

  constructor(options: V2SandboxRunnerOptions = {}) {
    this.#options = options;
  }

  async run(workspace: string, commands: readonly V2TestCommand[]): Promise<V2TestResult[]> {
    const results: V2TestResult[] = [];
    for (const command of commands) {
      const program = await assertProgram(command);
      const executed = await runSandbox(workspace, {
        program,
        args: command.args,
        timeoutMs: command.timeoutMs,
      }, this.#options);
      const label = `${basename(program)} ${command.args.join(" ")}`.trim();
      results.push({
        command: label,
        passed: !executed.timedOut && executed.code === 0,
        detail: executed.timedOut
          ? "sandbox timeout"
          : `exit ${String(executed.code)}${executed.output === "" ? "" : `: ${executed.output}`}`,
      });
    }
    return results;
  }
}

function nodeCommand(args: string[], timeoutMs: number): V2TestCommand {
  const program = process.execPath;
  return {
    program,
    programBytes: 0,
    programSha256: "",
    args,
    timeoutMs,
  };
}

async function probeCommand(
  workspace: string,
  command: V2TestCommand,
  options: V2SandboxRunnerOptions,
): Promise<{ code: number | null; timedOut: boolean; pid?: number }> {
  const programBytes = await readFile(command.program);
  const executed = await runSandbox(workspace, {
    program: command.program,
    args: command.args,
    timeoutMs: command.timeoutMs,
  }, options);
  // Read the binary before each command. The caller never receives this transient value.
  void programBytes;
  return {
    code: executed.code,
    timedOut: executed.timedOut,
    ...(executed.pid === undefined ? {} : { pid: executed.pid }),
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
      return false;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function childPid(path: string): Promise<number | undefined> {
  try {
    const parsed = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function childProbe(path: string): Promise<{
  externalWriteDenied: boolean;
  loopbackDenied: boolean;
  internetDenied: boolean;
} | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const externalWriteDenied = value["externalWriteDenied"];
    const loopbackDenied = value["loopbackDenied"];
    const internetDenied = value["internetDenied"];
    return typeof externalWriteDenied === "boolean"
      && typeof loopbackDenied === "boolean"
      && typeof internetDenied === "boolean"
      ? { externalWriteDenied, loopbackDenied, internetDenied }
      : undefined;
  } catch {
    return undefined;
  }
}

async function startLoopbackProbeServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new BridgeError("sandbox_probe_loopback_listener_failed", "The v2 sandbox probe could not bind its loopback fixture.");
  }
  return { server, port: address.port };
}

async function canConnect(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>((resolveConnect) => {
    const socket = createConnection({ host, port });
    let completed = false;
    const finish = (value: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveConnect(value);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function probeV2WorkspaceSandbox(runtimeRoot: string): Promise<V2SandboxProbe> {
  const root = join(tmpdir(), `bridge-v2-sandbox-probe-${randomUUID()}`);
  const workspace = join(root, "workspace");
  const externalRoot = resolve(runtimeRoot);
  const outside = join(externalRoot, `v2-sandbox-probe-outside-${randomUUID()}.txt`);
  const childOutside = join(externalRoot, `v2-sandbox-probe-child-outside-${randomUUID()}.txt`);
  const inside = join(workspace, "inside.txt");
  const childPidPath = join(workspace, "child.pid");
  const childProbePath = join(workspace, "child-probe.json");
  const options: V2SandboxRunnerOptions = {};
  const base = nodeCommand([], 5_000);
  let loopbackServer: Server | undefined;
  try {
    if (extname(process.execPath).toLowerCase() !== ".exe") {
      throw new BridgeError("sandbox_probe_platform_unsupported", "The v2 sandbox probe requires Windows node.exe.");
    }
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(externalRoot, { recursive: true }),
    ]);
    const fixture = await startLoopbackProbeServer();
    loopbackServer = fixture.server;
    if (!await canConnect("1.1.1.1", 443)) {
      throw new BridgeError(
        "sandbox_probe_external_baseline_unavailable",
        "The v2 sandbox probe cannot prove external-network denial because the host cannot reach the fixed TCP fixture.",
      );
    }
    const writeInside = await probeCommand(workspace, {
      ...base,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'inside')", inside],
    }, options);
    const writeOutside = await probeCommand(workspace, {
      ...base,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'outside')", outside],
    }, options);
    const loopback = await probeCommand(workspace, {
      ...base,
      args: ["-e", "require('node:net').connect(Number(process.argv[1]), '127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))", String(fixture.port)],
    }, options);
    const internet = await probeCommand(workspace, {
      ...base,
      args: ["-e", "const socket=require('node:net').connect(443, '1.1.1.1');let done=false;const fail=()=>{if(!done){done=true;socket.destroy();process.exit(1)}};socket.on('connect',()=>process.exit(0));socket.on('error',fail);setTimeout(fail,500)"] ,
    }, options);
    const childTree = await probeCommand(workspace, {
      ...base,
      timeoutMs: 2_000,
      args: [
        "-e",
        "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.argv[4],process.argv[1],process.argv[3],process.argv[5]],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000)",
        childOutside,
        childPidPath,
        childProbePath,
        "const fs=require('node:fs');const net=require('node:net');let externalWriteDenied=false;try{fs.writeFileSync(process.argv[1],'child-outside')}catch{externalWriteDenied=true}const denied=(port,host)=>new Promise((resolve)=>{let done=false;const socket=net.connect(Number(port),host);const finish=(value)=>{if(done)return;done=true;socket.destroy();resolve(value)};socket.once('connect',()=>finish(false));socket.once('error',()=>finish(true));setTimeout(()=>finish(true),500)});Promise.all([denied(process.argv[3],'127.0.0.1'),denied(443,'1.1.1.1')]).then(([loopbackDenied,internetDenied])=>{fs.writeFileSync(process.argv[2],JSON.stringify({externalWriteDenied,loopbackDenied,internetDenied}));process.exit(0)})",
        String(fixture.port),
      ],
    }, options);
    let insideExists = false;
    let outsideExists = false;
    let childOutsideExists = false;
    try {
      await lstat(inside);
      insideExists = true;
    } catch {
      insideExists = false;
    }
    try {
      await lstat(outside);
      outsideExists = true;
    } catch {
      outsideExists = false;
    }
    try {
      await lstat(childOutside);
      childOutsideExists = true;
    } catch {
      childOutsideExists = false;
    }
    const spawnedChildPid = await childPid(childPidPath);
    const inheritedProbe = await childProbe(childProbePath);
    const [sandboxExited, spawnedChildExited] = await Promise.all([
      childTree.pid === undefined ? Promise.resolve(false) : waitForProcessExit(childTree.pid),
      spawnedChildPid === undefined ? Promise.resolve(false) : waitForProcessExit(spawnedChildPid),
    ]);
    const childTreeTerminated = childTree.timedOut && sandboxExited && spawnedChildExited;
    const probe: V2SandboxProbe = {
      at: new Date().toISOString(),
      workspaceWrite: writeInside.code === 0 && insideExists,
      externalWriteDenied: writeOutside.code !== 0 && !outsideExists,
      loopbackDenied: loopback.code !== 0 && !loopback.timedOut,
      internetDenied: internet.code !== 0 && !internet.timedOut,
      childInheritanceDenied: !childOutsideExists
        && inheritedProbe?.externalWriteDenied === true
        && inheritedProbe.loopbackDenied === true
        && inheritedProbe.internetDenied === true,
      childTreeTerminated,
      v2WorkspaceTests: false,
    };
    probe.v2WorkspaceTests = probe.workspaceWrite
      && probe.externalWriteDenied
      && probe.loopbackDenied
      && probe.internetDenied
      && probe.childInheritanceDenied
      && probe.childTreeTerminated;
    return probe;
  } catch (error) {
    return {
      at: new Date().toISOString(),
      v2WorkspaceTests: false,
      workspaceWrite: false,
      externalWriteDenied: false,
      loopbackDenied: false,
      internetDenied: false,
      childInheritanceDenied: false,
      childTreeTerminated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const server = loopbackServer;
    if (server !== undefined) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
    }
    await Promise.all([
      rm(outside, { force: true }).catch(() => undefined),
      rm(childOutside, { force: true }).catch(() => undefined),
    ]);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
