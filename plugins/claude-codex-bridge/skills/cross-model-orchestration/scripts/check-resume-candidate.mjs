#!/usr/bin/env node

// ARCHIVED BEHAVIOR REFERENCE ONLY.
// The unified claude-codex-bridge is the sole runtime route. This file is
// intentionally fail-closed unless an operator explicitly opts into reading
// the retired plugin registry for historical diagnosis.
if (process.env.CLAUDE_CODEX_LEGACY_ARCHIVE !== "1") {
  console.log(JSON.stringify({
    ok: false,
    message: "Archived codex@openai-codex resume inspection is disabled; use claude-codex-bridge resume_peer with an explicit job ID."
  }, null, 2));
  process.exit(2);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fail(message, detail = null, status = 1) {
  console.log(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(status);
}

const mode = process.argv[2] || null;
const expectedThreadId = mode === "--companion-path" ? null : mode;
const home = os.homedir();
const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");

// Windows 用户名可能在工具参数传输中被改写，字面绝对路径因此不可靠。
// 调用方改用 shell 本地展开的 $USERPROFILE，需要一个相对 home 的后缀。
function toHomeRelative(absolutePath) {
  const normalized = absolutePath.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.startsWith(`${normalizedHome}/`)
    ? normalized.slice(normalizedHome.length + 1)
    : null;
}

if (!fs.existsSync(registryPath)) {
  fail("Claude plugin registry not found.", registryPath);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
} catch (error) {
  fail("Claude plugin registry is not valid JSON.", error.message);
}

const installs = registry.plugins?.["codex@openai-codex"] ?? [];
const install = installs.find((item) => item.scope === "user") ?? installs.at(-1);
if (!install?.installPath) {
  fail("codex@openai-codex is not installed.");
}

const companion = path.join(install.installPath, "scripts", "codex-companion.mjs");
if (!fs.existsSync(companion)) {
  fail("Codex companion script not found.", companion);
}

if (mode === "--companion-path") {
  const companionHomeRelative = toHomeRelative(companion);
  if (!companionHomeRelative) {
    fail("Codex companion is not inside the user home directory.", companion);
  }
  console.log(JSON.stringify({
    ok: true,
    companionHomeRelative,
    companionPath: companion.replaceAll("\\", "/"),
    pluginVersion: install.version ?? null
  }, null, 2));
  process.exit(0);
}

const child = spawnSync(
  process.execPath,
  [companion, "task-resume-candidate", "--json", "--cwd", process.cwd()],
  { encoding: "utf8", env: process.env, windowsHide: true }
);

if (child.status !== 0) {
  fail("Unable to query the Codex resume candidate.", (child.stderr || child.stdout).trim());
}

let payload;
try {
  payload = JSON.parse(child.stdout);
} catch (error) {
  fail("Codex resume candidate returned invalid JSON.", error.message);
}

const candidateThreadId = payload.candidate?.threadId ?? null;
const sessionId = payload.sessionId ?? null;
if (!sessionId) {
  fail("Claude session ID is unavailable; refusing a workspace-wide resume candidate.");
}

const matches = Boolean(candidateThreadId) &&
  (expectedThreadId === null || candidateThreadId === expectedThreadId);

const result = {
  ok: matches,
  available: Boolean(payload.available),
  sessionId,
  expectedThreadId,
  candidateThreadId,
  candidateJobId: payload.candidate?.id ?? null,
  candidateStatus: payload.candidate?.status ?? null,
  pluginVersion: install.version ?? null
};

if (!matches) {
  result.message = candidateThreadId
    ? "Codex resume candidate does not match the recorded orchestration thread."
    : "No resumable Codex task thread is available for this Claude session.";
}

console.log(JSON.stringify(result, null, 2));
process.exit(matches ? 0 : 2);
