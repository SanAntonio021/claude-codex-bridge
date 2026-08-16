import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const tomlString = (value) => JSON.stringify(value);
const root = await mkdtemp(join(tmpdir(), "bridge-v2-sandbox-debug-"));

try {
  const workspace = join(root, "workspace");
  const output = join(workspace, "inside.txt");
  const outside = join(root, "outside.txt");
  const childPidPath = join(workspace, "child.pid");
  const childProbePath = join(workspace, "child-probe.json");
  const spawnErrorPath = join(workspace, "spawn-error.txt");
  await mkdir(workspace, { recursive: true });
  const profile = `bridge_workspace_${randomUUID().replaceAll("-", "")}`;
  const child = spawn(
    process.execPath,
    [
      require.resolve("@openai/codex/bin/codex.js"),
      "sandbox",
      "--config",
      `permissions.${profile}.filesystem={":minimal"="read",${tomlString(process.execPath)}="read",":workspace_roots"={"."="write"}}`,
      "--config",
      'windows.sandbox="elevated"',
      "--permission-profile",
      profile,
      "-C",
      workspace,
      process.execPath,
      "-e",
      "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.argv[5],process.argv[1],process.argv[3]],{stdio:'ignore'});child.once('error',(error)=>fs.writeFileSync(process.argv[4],error.message));fs.writeFileSync(process.argv[2],String(child.pid??''));setTimeout(()=>process.exit(0),1500)",
      outside,
      childPidPath,
      childProbePath,
      spawnErrorPath,
      "const fs=require('node:fs');const net=require('node:net');let externalWriteDenied=false;try{fs.writeFileSync(process.argv[1],'outside')}catch{externalWriteDenied=true}const denied=(host)=>new Promise((resolve)=>{const socket=net.connect(9,host);let done=false;const finish=(value)=>{if(done)return;done=true;socket.destroy();resolve(value)};socket.once('connect',()=>finish(false));socket.once('error',()=>finish(true));setTimeout(()=>finish(false),300)});Promise.all([denied('127.0.0.1'),denied('1.1.1.1')]).then(([loopbackDenied,internetDenied])=>{fs.writeFileSync(process.argv[2],JSON.stringify({externalWriteDenied,loopbackDenied,internetDenied}));process.exit(0)})",
    ],
    {
      cwd: workspace,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "CODEX_HOME")),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolveExit, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("close", resolveExit);
  });
  const content = async (path) => readFile(path, "utf8").catch(() => "missing");
  process.stdout.write(`${JSON.stringify({
    code,
    inside: await content(output),
    childPid: await content(childPidPath),
    childProbe: await content(childProbePath),
    spawnError: await content(spawnErrorPath),
    outside: await content(outside),
    stdout,
    stderr,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
