import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildClaudeArgs,
  buildWindowsClaudeCommand,
  REQUIRED_CLAUDE_MODEL,
  resolveClaudeCmdTarget,
  validateClaudeCommandPrefixArgs,
  validateClaudeArgs,
} from "../../src/adapter/claude.js";
import { BridgeError } from "../../src/errors.js";
import { createBridgeRequest } from "../../src/request.js";
import { assertTransition } from "../../src/daemon/state-machine.js";
import { requestPrompt } from "../../src/daemon/scheduler.js";
import { resolveWaitTimeoutMs } from "../../src/cli/timeout.js";
import { LIMITS } from "../../src/constants.js";
import { sha256 } from "../../src/hash.js";

test("peer prompt rewrites author workspace paths to the fixed review copy", () => {
  const authorRoot = join(tmpdir(), "bridge-author-root");
  const workspaceRoot = join(tmpdir(), "bridge-fixed-workspace");
  const artifactContent = "isolated artifact\n";
  const request = createBridgeRequest(
    {
      question: "review the supplied artifact",
      operation: "review_repair",
      artifact_id: "workspace-path-rewrite",
      artifact_type: "deliverable",
      artifact_name: "src/artifact.md",
      artifact_path: join(authorRoot, "src", "artifact.md"),
      artifact_bytes: Buffer.byteLength(artifactContent, "utf8"),
      artifact_sha256: sha256(artifactContent),
      artifact_content: artifactContent,
      target_root: authorRoot,
      allowed_paths: ["src/artifact.md"],
      round: 1,
      acceptance_criteria: ["artifact remains isolated"],
      test_commands: [],
    },
    { origin: "test", target: "claude" },
  );

  const prompt = requestPrompt(request, workspaceRoot);
  const escapedAuthorRoot = JSON.stringify(authorRoot).slice(1, -1);
  assert.equal(prompt.includes(escapedAuthorRoot), false);
  assert.equal(prompt.includes(JSON.stringify(workspaceRoot)), true);
  assert.equal(prompt.includes(JSON.stringify(join(workspaceRoot, "src", "artifact.md"))), true);
});

test("wait timeout treats --timeout as seconds and --timeout-ms as milliseconds", () => {
  const reader = (options: Record<string, string>) => (name: string) => options[name];

  assert.equal(resolveWaitTimeoutMs(reader({ "--timeout": "45" })), 45_000);
  assert.equal(resolveWaitTimeoutMs(reader({ "--timeout": "0" })), 0);
  assert.equal(resolveWaitTimeoutMs(reader({ "--timeout": "1.5" })), 1_500);
  assert.equal(resolveWaitTimeoutMs(reader({ "--timeout-ms": "45000" })), 45_000);
  assert.equal(resolveWaitTimeoutMs(reader({})), LIMITS.awaitMs);

  assert.throws(
    () => resolveWaitTimeoutMs(reader({ "--timeout": "45", "--timeout-ms": "45000" })),
    (error: unknown) => error instanceof BridgeError && error.code === "conflicting_timeout_options",
  );
  assert.throws(
    () => resolveWaitTimeoutMs(reader({ "--timeout": "-1" })),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_timeout",
  );
  assert.throws(
    () => resolveWaitTimeoutMs(reader({ "--timeout-ms": "1.5" })),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_timeout",
  );
});

test("Claude argv locks Opus 5, empty tools, and default permission mode", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const args = buildClaudeArgs(sessionId);
  const modelIndex = args.indexOf("--model");
  const effortIndex = args.indexOf("--effort");
  const toolsIndex = args.indexOf("--tools");
  assert.equal(args[modelIndex + 1], REQUIRED_CLAUDE_MODEL);
  assert.equal(args[effortIndex + 1], "max");
  assert.equal(args[toolsIndex + 1], "");
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "default",
  ]);
  assert.deepEqual(args.slice(-2), ["--resume", sessionId]);
  assert.match(
    buildWindowsClaudeCommand("claude.cmd", args),
    /--model claude-opus-5 --effort max --tools "" --permission-mode default/u,
  );
  assert.throws(
    () => validateClaudeArgs(["-p", "--tools", "--permission-mode", "default"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );

  const withoutModel = args.filter((argument, index) => index !== modelIndex && index !== modelIndex + 1);
  assert.throws(
    () => validateClaudeArgs(withoutModel),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );

  const wrongModel = [...args];
  wrongModel[modelIndex + 1] = "claude-sonnet-5";
  assert.throws(
    () => validateClaudeArgs(wrongModel),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs([...args, "--model", REQUIRED_CLAUDE_MODEL]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs([...args, "--effort", "high"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs([...args, "--tools", "Read"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs([...args, "--permission-mode", "bypassPermissions"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs([...args, "--fallback-model", "claude-sonnet-5"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
});

test("Claude argv accepts an allowlisted explicit model and validates its exact receipt contract", () => {
  const selection = { model: "claude-opus-4-6" as const, reasoningEffort: "max" as const };
  const args = buildClaudeArgs(undefined, selection);
  assert.equal(args[args.indexOf("--model") + 1], selection.model);
  assert.equal(args[args.indexOf("--effort") + 1], selection.reasoningEffort);
  assert.doesNotThrow(() => validateClaudeArgs(args, selection));

  const changed = [...args];
  changed[changed.indexOf("--model") + 1] = "claude-opus-5";
  assert.throws(
    () => validateClaudeArgs(changed, selection),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
});

test("Claude isolated repair argv is fixed to its workspace and controlled tools", () => {
  const workspace = join(tmpdir(), "bridge-controlled-workspace");
  const isolation = { workspacePath: workspace, testCommands: ["npm.cmd test"] };
  const args = buildClaudeArgs(undefined, isolation);
  assert.equal(args[args.indexOf("--model") + 1], REQUIRED_CLAUDE_MODEL);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write,Bash");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--allowed-tools") + 1], "Bash(npm.cmd test)");
  assert.equal(args[args.indexOf("--add-dir") + 1], workspace);
  assert.throws(
    () => validateClaudeArgs([...args, "--add-dir", workspace], isolation),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeArgs(
      args.filter((argument, index) =>
        index !== args.indexOf("--allowed-tools")
        && index !== args.indexOf("--allowed-tools") + 1
      ),
      isolation,
    ),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => buildClaudeArgs(undefined, {
      workspacePath: workspace,
      testCommands: ["npm.cmd test && whoami"],
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_test_commands",
  );
});

test("Claude isolated repair argv excludes Bash when no tests are authorized", () => {
  const workspace = join(tmpdir(), "bridge-controlled-workspace-no-bash");
  const isolation = { workspacePath: workspace, testCommands: [] };
  const args = buildClaudeArgs(undefined, isolation);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write");
  assert.equal(args.includes("--allowed-tools"), false);
  assert.doesNotThrow(() => validateClaudeArgs(args, isolation));
  const broadened = [...args];
  broadened[broadened.indexOf("--tools") + 1] = "Read,Edit,Write,Bash";
  assert.throws(
    () => validateClaudeArgs(broadened, isolation),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
});

test("Claude wrapper prefixes cannot override fixed model, tools, or permissions", () => {
  assert.throws(
    () => validateClaudeCommandPrefixArgs(["--model", "claude-sonnet-5"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.throws(
    () => validateClaudeCommandPrefixArgs(["--tools=Read"]),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_isolation_arguments",
  );
  assert.doesNotThrow(() => validateClaudeCommandPrefixArgs(["fixture-wrapper", "scenario"]));
});

test("Claude wrapper resolver accepts only a descendant official executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-wrapper-test-"));
  const packageDirectory = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin");
  const executable = join(packageDirectory, "claude.exe");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(executable, "fixture", "utf8");

  const wrapper = join(root, "claude.cmd");
  await writeFile(
    wrapper,
    [
      "@ECHO off",
      "SET dp0=%~dp0",
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    ].join("\r\n"),
    "utf8",
  );
  assert.equal(await resolveClaudeCmdTarget(wrapper, {}), await realpath(executable));

  const outsideExecutable = join(root, "..", "claude.exe");
  await writeFile(outsideExecutable, "fixture", "utf8");
  await writeFile(wrapper, '"..\\claude.exe" %*\r\n', "utf8");
  await assert.rejects(
    resolveClaudeCmdTarget(wrapper, {}),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_claude_wrapper",
  );

  await writeFile(wrapper, '"%OTHER%\\claude.exe" %*\r\n', "utf8");
  await assert.rejects(
    resolveClaudeCmdTarget(wrapper, {}),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_claude_wrapper",
  );
});

test("request validation rejects recursive ancestry and excessive hops", () => {
  assert.throws(
    () => createBridgeRequest({ question: "x", hop_count: 2 }, { origin: "test" }),
    (error: unknown) => error instanceof BridgeError && error.code === "hop_limit_exceeded",
  );
  const requestId = "22222222-2222-4222-8222-222222222222";
  assert.throws(
    () =>
      createBridgeRequest(
        {
          question: "x",
          request_id: requestId,
          ancestor_request_ids: [requestId],
        },
        { origin: "test" },
      ),
    (error: unknown) => error instanceof BridgeError && error.code === "recursive_request",
  );
});

test("peer request accepts camelCase contract and enforces artifact integrity", () => {
  const artifactContent = "review me";
  const targetRoot = join(tmpdir(), "bridge-peer-target");
  const request = createBridgeRequest(
    {
      question: "review and repair",
      operation: "review_repair",
      reviewerAccess: "isolated_write",
      artifactId: "artifact-1",
      artifactType: "deliverable",
      artifactName: "artifact.md",
      artifactBytes: Buffer.byteLength(artifactContent),
      artifactSha256: sha256(artifactContent),
      artifactContent,
      targetRoot,
      allowedPaths: ["src"],
      round: 1,
      priorRounds: [],
      acceptanceCriteria: ["tests pass"],
      testCommands: ["npm.cmd test"],
    },
    { origin: "test", target: "codex" },
  );
  assert.equal(request.target, "codex");
  assert.equal(request.artifact_id, "artifact-1");
  assert.equal(request.operation, "review_repair");
  assert.equal(request.reviewer_access, "isolated_write");
  assert.equal(request.author, "Claude");
  assert.equal(request.reviewer, "Codex");
  assert.equal(request.max_rounds, 3);
  assert.deepEqual(request.allowed_paths, ["src"]);
  assert.deepEqual(request.test_commands, ["npm.cmd test"]);

  assert.throws(
    () => createBridgeRequest(
      { question: "read only", operation: "ask", testCommands: ["npm.cmd test"] },
      { origin: "test", target: "claude" },
    ),
    (error: unknown) => error instanceof BridgeError && error.code === "test_commands_not_allowed",
  );
  assert.throws(
    () => createBridgeRequest(
      {
        question: "unsafe command",
        operation: "task",
        artifactId: "unsafe-test-command",
        targetRoot,
        allowedPaths: ["src"],
        testCommands: ["npm.cmd test 2>&1"],
      },
      { origin: "test", target: "claude" },
    ),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_request_file",
  );

  assert.throws(
    () =>
      createBridgeRequest(
        { question: "unsafe task", operation: "task", artifactId: "task-without-workspace" },
        { origin: "test", target: "codex" },
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "task_workspace_contract_incomplete",
  );

  assert.throws(
    () =>
      createBridgeRequest(
        {
          question: "review and repair",
          operation: "review_repair",
          artifactId: "artifact-1",
          artifactType: "deliverable",
          artifactName: "artifact.md",
          artifactBytes: 99,
          artifactSha256: sha256(artifactContent),
          artifactContent,
          targetRoot,
          allowedPaths: ["src"],
          round: 1,
          acceptanceCriteria: ["tests pass"],
          testCommands: [],
        },
        { origin: "test", target: "codex" },
      ),
    (error: unknown) => error instanceof BridgeError && error.code === "artifact_integrity_mismatch",
  );

  assert.throws(
    () =>
      createBridgeRequest(
        {
          question: "review and repair",
          operation: "review_repair",
          reviewerAccess: "read_only",
          artifactId: "artifact-1",
          artifactType: "deliverable",
          targetRoot,
          allowedPaths: ["src"],
          round: 1,
        },
        { origin: "test", target: "codex" },
      ),
    (error: unknown) => error instanceof BridgeError && error.code === "reviewer_access_mismatch",
  );
});

test("state machine accepts the M1 path and rejects replay from terminal state", () => {
  assert.doesNotThrow(() => assertTransition("queued", "dispatching"));
  assert.doesNotThrow(() => assertTransition("dispatching", "transport_delivered"));
  assert.doesNotThrow(() => assertTransition("transport_delivered", "running"));
  assert.doesNotThrow(() => assertTransition("running", "succeeded"));
  assert.throws(
    () => assertTransition("succeeded", "dispatching"),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_state_transition",
  );
});
