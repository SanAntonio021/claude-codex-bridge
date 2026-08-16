import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBridgePrompt,
  ClaudeHeadlessAdapter,
  REQUIRED_CLAUDE_MODEL,
  sanitizeBashCommandPreview,
  sanitizeIsolationPreview,
} from "../../src/adapter/claude.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-claude.js", import.meta.url));

test("isolation previews redact workspace paths, escape controls, and cap length", () => {
  const workspace = "C:\\bridge\\workspace";
  const preview = sanitizeIsolationPreview(
    `${workspace}\\plan.md\n${"x".repeat(300)}`,
    workspace,
  );
  assert.match(preview, /^<workspace>\\plan\.md\\u000a/u);
  assert.equal(preview.includes(workspace), false);
  assert.equal(preview.length, 256);
});

test("Bash isolation previews omit arguments and redact credential-like commands", () => {
  assert.equal(sanitizeBashCommandPreview("ls -la"), "ls <arguments>");
  assert.equal(
    sanitizeBashCommandPreview('"C:\\Program Files\\nodejs\\node.exe" script.js --secret value'),
    "node.exe <arguments>",
  );
  assert.equal(
    sanitizeBashCommandPreview("ghp_fixture1 --version"),
    "<redacted-command>",
  );
});

function adapter(
  scenario: string,
  inputDirectory?: string,
  environment?: NodeJS.ProcessEnv,
): ClaudeHeadlessAdapter {
  return new ClaudeHeadlessAdapter({
    command: process.execPath,
    commandPrefixArgs: [fixture, scenario],
    launchMode: "direct",
    ...(inputDirectory === undefined ? {} : { inputDirectory }),
    ...(environment === undefined ? {} : { environment }),
  });
}

test("review_repair prompt directs workspace inspection through Read", () => {
  const prompt = buildBridgePrompt(
    "review the supplied artifact",
    "Peer artifact envelope: {\"allowedPaths\":[\"src/adapter/codex.ts\"]}",
    "review_repair",
    ["npm.cmd test"],
  );

  assert.match(prompt, /Use Read, not Bash, to inspect files and workspace context before editing/u);
  assert.match(prompt, /do not use it to list files, inspect Git state, print the current directory/u);
  assert.match(prompt, /Any other Bash command ends this peer job as an isolation breach/u);
  assert.match(prompt, /- npm\.cmd test/u);
});

test("review_repair prompt states that Bash is unavailable for empty testCommands", () => {
  const prompt = buildBridgePrompt(
    "review the supplied artifact",
    undefined,
    "review_repair",
    [],
  );
  assert.match(prompt, /Bash is not available because the author supplied an empty testCommands array/u);
  assert.doesNotMatch(prompt, /No Bash command is pre-approved/u);
});

test("adapter sends prompt on stdin, preserves argv, and sets BRIDGE_CHILD", async () => {
  const phases: string[] = [];
  const outcome = await adapter("args").run({
    prompt: '中文\n"quoted" {json} <tag>',
    sessionId: "11111111-1111-4111-8111-111111111111",
    hooks: {
      onSpawn: () => {
        phases.push("spawned");
      },
      onTransportDelivered: () => {
        phases.push("transport_delivered");
      },
      onRunning: () => {
        phases.push("running");
      },
    },
  });
  assert.equal(outcome.classification, "success");
  const result = JSON.parse(outcome.result ?? "{}") as {
    args: string[];
    prompt: string;
    bridge_child: string;
    bridge_token?: string;
  };
  assert.equal(
    result.prompt,
    `中文${process.platform === "win32" ? "\r\n" : "\n"}"quoted" {json} <tag>${process.platform === "win32" ? "\r\n\r\n" : "\n\n"}`,
  );
  assert.equal(result.args.includes('中文\n"quoted" {json} <tag>'), false);
  assert.equal(result.args[result.args.indexOf("--model") + 1], REQUIRED_CLAUDE_MODEL);
  assert.equal(result.args[result.args.indexOf("--tools") + 1], "");
  assert.equal(result.bridge_child, "1");
  assert.equal(result.bridge_token, undefined);
  assert.equal(outcome.details.reported_model, REQUIRED_CLAUDE_MODEL);
  assert.deepEqual(phases, ["spawned", "transport_delivered", "running"]);
});

test(
  "adapter preloads and removes protected Windows stdin",
  { skip: process.platform !== "win32" },
  async () => {
    const inputDirectory = await mkdtemp(join(tmpdir(), "bridge-adapter-stdin-"));
    try {
      const phases: string[] = [];
      const outcome = await adapter("args", inputDirectory).run({
        prompt: "line one\nline two",
        hooks: {
          onSpawn: () => {
            phases.push("spawned");
          },
          onTransportDelivered: () => {
            phases.push("transport_delivered");
          },
          onRunning: () => {
            phases.push("running");
          },
        },
      });
      assert.equal(outcome.classification, "success");
      const result = JSON.parse(outcome.result ?? "{}") as {
        args: string[];
        prompt: string;
        bridge_child?: string;
        bridge_hop_count?: string;
      };
      assert.equal(result.prompt, "line one\r\nline two\r\n\r\n");
      assert.equal(result.args.includes("line one\nline two"), false);
      assert.equal(result.bridge_child, "1");
      assert.equal(result.bridge_hop_count, undefined);
      assert.deepEqual(phases, ["spawned", "transport_delivered", "running"]);
      assert.deepEqual(await readdir(inputDirectory), []);
    } finally {
      await rm(inputDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows stdin helper streams init for immediate isolation enforcement",
  { skip: process.platform !== "win32", timeout: 5_000 },
  async () => {
    const inputDirectory = await mkdtemp(join(tmpdir(), "bridge-adapter-isolation-"));
    try {
      const outcome = await adapter("isolation", inputDirectory).run({ prompt: "x" });
      assert.equal(outcome.classification, "isolation_breach");
      assert.equal(outcome.is_error, true);
      assert.deepEqual(await readdir(inputDirectory), []);
    } finally {
      await rm(inputDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows stdin helper reports inner launch failures as spawn errors",
  { skip: process.platform !== "win32" },
  async () => {
    const inputDirectory = await mkdtemp(join(tmpdir(), "bridge-adapter-spawn-"));
    try {
      const outcome = await new ClaudeHeadlessAdapter({
        command: join(inputDirectory, "missing-command.exe"),
        launchMode: "direct",
        inputDirectory,
      }).run({ prompt: "x" });
      assert.equal(outcome.classification, "spawn_error");
      assert.equal(outcome.details.exit_code, 126);
      assert.deepEqual(await readdir(inputDirectory), []);
    } finally {
      await rm(inputDirectory, { recursive: true, force: true });
    }
  },
);

test("adapter treats tool-like result text as opaque", async () => {
  const outcome = await adapter("opaque").run({ prompt: "x" });
  assert.equal(outcome.classification, "success");
  assert.equal(outcome.result, "<tool_call><tool_name>read_file</tool_name></tool_call>");
});

test("adapter fails closed when init tools are non-empty", async () => {
  const outcome = await adapter("isolation").run({ prompt: "x" });
  assert.equal(outcome.classification, "isolation_breach");
  assert.equal(outcome.is_error, true);
});

test("adapter sends and verifies an explicit Claude model and effort", async () => {
  const outcome = await adapter("args", undefined, {
    ...process.env,
    CLAUDE_CODEX_BRIDGE_TOKEN: "must-not-reach-child",
    claude_codex_bridge_token: "must-not-reach-child-either",
  }).run({
    prompt: "explicit route",
    model: "claude-opus-4-6",
    reasoningEffort: "max",
    taskProfile: "writing",
    routingSource: "explicit",
    routingRuleId: "explicit-claude-model-selection-v1",
  });
  assert.equal(outcome.classification, "success");
  const result = JSON.parse(outcome.result ?? "{}") as {
    args: string[];
    bridge_token?: string;
    bridge_token_lower?: string;
  };
  assert.equal(result.args[result.args.indexOf("--model") + 1], "claude-opus-4-6");
  assert.equal(result.args[result.args.indexOf("--effort") + 1], "max");
  assert.equal(result.bridge_token, undefined);
  assert.equal(result.bridge_token_lower, undefined);
  assert.equal(outcome.details.reported_model, "claude-opus-4-6");
  assert.equal(outcome.details.requested_model, "claude-opus-4-6");
  assert.equal(outcome.details.requested_reasoning_effort, "max");
  assert.equal(outcome.details.task_profile, "writing");
  assert.equal(outcome.details.routing_source, "explicit");
});

test("adapter confines review_repair to controlled tools and one workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-claude-workspace-"));
  const inputDirectory = await mkdtemp(join(tmpdir(), "bridge-claude-input-"));
  try {
    const outcome = await adapter("args", inputDirectory).run({
      prompt: "repair the isolated fixture",
      operation: "review_repair",
      workspacePath: root,
      allowedPaths: ["README.md"],
      testCommands: ["npm.cmd test"],
    });
    assert.equal(outcome.classification, "success");
    const result = JSON.parse(outcome.result ?? "{}") as { args: string[] };
    assert.equal(result.args[result.args.indexOf("--tools") + 1], "Read,Edit,Write,Bash");
    assert.equal(result.args[result.args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(result.args[result.args.indexOf("--allowed-tools") + 1], "Bash(npm.cmd test)");
    assert.equal(result.args[result.args.indexOf("--add-dir") + 1], root);
    assert.deepEqual(outcome.details.allowed_tool_patterns, ["Bash(npm.cmd test)"]);
    assert.equal(outcome.details.workspace_path, root);
    assert.equal(outcome.details.reported_model, REQUIRED_CLAUDE_MODEL);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(inputDirectory, { recursive: true, force: true });
  }
});

test("adapter omits Bash entirely when review_repair testCommands is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-claude-no-bash-"));
  try {
    const outcome = await adapter("args").run({
      prompt: "repair without shell tests",
      operation: "review_repair",
      workspacePath: root,
      testCommands: [],
    });
    assert.equal(outcome.classification, "success");
    const result = JSON.parse(outcome.result ?? "{}") as { args: string[] };
    assert.equal(result.args[result.args.indexOf("--tools") + 1], "Read,Edit,Write");
    assert.equal(result.args.includes("--allowed-tools"), false);
    assert.equal(outcome.details.allowed_tool_patterns, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter records exact Claude tests and fails closed on other Bash commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-claude-command-evidence-"));
  try {
    const success = await adapter("bash_success").run({
      prompt: "run the exact test",
      operation: "review_repair",
      workspacePath: root,
      testCommands: ["npm.cmd test"],
    });
    assert.equal(success.classification, "success");
    assert.deepEqual(success.details.tests, ["npm.cmd test (exit 0)"]);
    assert.equal(success.details.command_failures, undefined);
    assert.equal(success.details.missing_test_commands, undefined);

    const failed = await adapter("bash_failure").run({
      prompt: "run the exact test",
      operation: "review_repair",
      workspacePath: root,
      testCommands: ["npm.cmd test"],
    });
    assert.equal(failed.classification, "success");
    assert.deepEqual(failed.details.command_failures, ["npm.cmd test (tool error)"]);

    const missing = await adapter("args").run({
      prompt: "run the exact test",
      operation: "review_repair",
      workspacePath: root,
      testCommands: ["npm.cmd test"],
    });
    assert.equal(missing.classification, "success");
    assert.deepEqual(missing.details.missing_test_commands, ["npm.cmd test"]);

    const unauthorized = await adapter("bash_unauthorized").run({
      prompt: "run the exact test",
      operation: "review_repair",
      workspacePath: root,
      testCommands: ["npm.cmd test"],
    });
    assert.equal(unauthorized.classification, "isolation_breach");
    assert.equal(unauthorized.is_error, true);
    assert.deepEqual(unauthorized.details.isolation_violation, {
      event_index: 2,
      tool_name: "Bash",
      reason_code: "bash_command_not_allowed",
      preview: "ls <arguments>",
    });
    assert.equal(unauthorized.details.isolation_violation_raw?.event_index, 2);
    assert.match(JSON.stringify(unauthorized.details.isolation_violation_raw), /ls -la/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter confines Read, Edit, and Write tool paths to the fixed workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-claude-file-tools-"));
  try {
    for (const tool of ["Read", "Edit", "Write"] as const) {
      for (const location of ["inside_relative", "inside_absolute"] as const) {
        const outcome = await adapter(`file_${location}_${tool}`).run({
          prompt: "use the controlled file tool",
          operation: "review_repair",
          workspacePath: root,
        });
        assert.equal(outcome.classification, "success", `${tool} ${location}`);
      }

      const outside = await adapter(`file_outside_${tool}`).run({
        prompt: "attempt an external file tool path",
        operation: "review_repair",
        workspacePath: root,
      });
      assert.equal(outside.classification, "isolation_breach", `${tool} outside`);
    }

    for (const location of ["traversal", "git"] as const) {
      const outcome = await adapter(`file_${location}_Read`).run({
        prompt: "attempt a protected file tool path",
        operation: "review_repair",
        workspacePath: root,
      });
      assert.equal(outcome.classification, "isolation_breach", `Read ${location}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter fails closed when init omits or changes the required model", async () => {
  const missing = await adapter("missing_model").run({ prompt: "x" });
  assert.equal(missing.classification, "model_mismatch");
  assert.equal(missing.is_error, true);
  assert.equal(missing.details.reported_model, undefined);

  const wrong = await adapter("wrong_model").run({ prompt: "x" });
  assert.equal(wrong.classification, "model_mismatch");
  assert.equal(wrong.is_error, true);
  assert.equal(wrong.details.reported_model, "claude-sonnet-5");
});

test("adapter distinguishes documented headless failure classes", async () => {
  const resultError = await adapter("result_error").run({ prompt: "x" });
  assert.equal(resultError.classification, "result_error");
  assert.equal(resultError.result, "resume failed");

  const parameterError = await adapter("parameter_error").run({ prompt: "x" });
  assert.equal(parameterError.classification, "parameter_error");
  assert.equal(parameterError.details.complete_stdout_lines.length, 0);
  assert.match(parameterError.details.stderr, /invalid command parameter/u);

  const interrupted = await adapter("stream_interrupted").run({ prompt: "x" });
  assert.equal(interrupted.classification, "stream_interrupted");
  assert.ok(interrupted.details.complete_stdout_lines.length >= 2);

  const partial = await adapter("partial_line").run({ prompt: "x" });
  assert.equal(partial.classification, "stream_interrupted");
});

test("adapter cancellation terminates a process tree", async () => {
  const controller = new AbortController();
  const running = adapter("slow").run({
    prompt: "x",
    signal: controller.signal,
    hooks: { onRunning: () => controller.abort("cancelled") },
  });
  const outcome = await running;
  assert.equal(outcome.classification, "cancelled");
});
