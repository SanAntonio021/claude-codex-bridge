import assert from "node:assert/strict";
import { test } from "node:test";
import type { Codex, CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import {
  CODEX_BRIDGE_CONFIG,
  CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  CodexHeadlessAdapter,
} from "../../src/adapter/codex.js";

function eventStream(threadId: string): AsyncGenerator<ThreadEvent> {
  return (async function* events() {
    yield { type: "thread.started", thread_id: threadId };
    yield { type: "turn.started" };
    yield {
      type: "item.completed",
      item: { id: "warn", type: "error", message: "non-fatal context warning" },
    };
    yield {
      type: "item.completed",
      item: {
        id: "change",
        type: "file_change",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: "update" }],
      },
    };
    yield {
      type: "item.completed",
      item: {
        id: "test",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "ok",
        exit_code: 0,
        status: "completed",
      },
    };
    yield {
      type: "item.completed",
      item: {
        id: "failed-probe",
        type: "command_execution",
        command: "node missing-check.mjs",
        aggregated_output: "blocked by policy",
        exit_code: -1,
        status: "failed",
      },
    };
    yield {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "DELIVERABLE_REVIEW\n结论：通过" },
    };
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    };
  })();
}

function retryEventStream(
  threadId: string,
  attempts: Array<{ exitCode: number; status: "completed" | "failed" }>,
): AsyncGenerator<ThreadEvent> {
  return (async function* events() {
    yield { type: "thread.started", thread_id: threadId };
    yield { type: "turn.started" };
    for (const [index, attempt] of attempts.entries()) {
      yield {
        type: "item.completed",
        item: {
          id: `verify-${String(index)}`,
          type: "command_execution",
          command: "node verify-result.mjs",
          aggregated_output: attempt.exitCode === 0 ? "VERIFY_RESULT_OK" : "verification failed",
          exit_code: attempt.exitCode,
          status: attempt.status,
        },
      };
    }
    yield {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "DELIVERABLE_REVIEW\n结论：通过" },
    };
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    };
  })();
}

function topLevelErrorEventStream(
  threadId: string,
  completed: boolean,
): AsyncGenerator<ThreadEvent> {
  return (async function* events() {
    yield { type: "thread.started", thread_id: threadId };
    yield { type: "turn.started" };
    yield {
      type: "error",
      message: "Reconnecting... 1/5 (stream disconnected before completion)",
    };
    if (completed) {
      yield {
        type: "item.completed",
        item: { id: "answer", type: "agent_message", text: "CODEX_RECOVERED_OK" },
      };
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      };
    }
  })();
}

async function runTopLevelErrorFixture(completed: boolean) {
  const threadId = "44444444-4444-4444-8444-444444444444";
  const fakeThread = {
    id: threadId,
    runStreamed: async () => ({ events: topLevelErrorEventStream(threadId, completed) }),
  };
  const fakeCodex = {
    startThread: () => fakeThread,
  } as unknown as Codex;
  const adapter = new CodexHeadlessAdapter({
    model: DEFAULT_CODEX_MODEL,
    cliVersion: "codex-cli 0.test",
    cwd: "C:\\fixture",
    codexFactory: () => fakeCodex,
  });
  return adapter.run({ prompt: "canary", operation: "ask" });
}

async function runCommandRetryFixture(
  attempts: Array<{ exitCode: number; status: "completed" | "failed" }>,
) {
  const threadId = "33333333-3333-4333-8333-333333333333";
  const fakeThread = {
    id: threadId,
    runStreamed: async () => ({ events: retryEventStream(threadId, attempts) }),
  };
  const fakeCodex = {
    startThread: () => fakeThread,
  } as unknown as Codex;
  const adapter = new CodexHeadlessAdapter({
    model: DEFAULT_CODEX_MODEL,
    cliVersion: "codex-cli 0.test",
    cwd: "C:\\fixture",
    codexFactory: () => fakeCodex,
  });
  return adapter.run({
    prompt: "review and repair",
    operation: "review_repair",
    workspacePath: "C:\\fixture\\workspace",
  });
}

test("Codex adapter fixes sandbox, approval, network, and recorded thread metadata", async () => {
  let captured: ThreadOptions | undefined;
  let capturedClientConfig: CodexOptions["config"] | undefined;
  let capturedClientEnvironment: Record<string, string> | undefined;
  let capturedPrompt: string | undefined;
  let resumedId: string | undefined;
  const threadId = "11111111-1111-4111-8111-111111111111";
  const fakeThread = {
    id: threadId,
    runStreamed: async (prompt: string) => {
      capturedPrompt = prompt;
      return { events: eventStream(threadId) };
    },
  };
  const fakeCodex = {
    startThread: (options?: ThreadOptions) => {
      captured = options;
      return fakeThread;
    },
    resumeThread: (id: string, options?: ThreadOptions) => {
      resumedId = id;
      captured = options;
      return fakeThread;
    },
  } as unknown as Codex;
  const adapter = new CodexHeadlessAdapter({
    cliVersion: "codex-cli 0.test",
    cwd: "C:\\fixture",
    environment: {
      PATH: "C:\\fixture\\bin",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
      CODEX_PERMISSION_PROFILE: ":read-only",
      CODEX_SESSION_ID: "outer-session",
      CODEX_THREAD_ID: "outer-thread",
      CLAUDE_CODEX_BRIDGE_TOKEN: "must-not-reach-child",
      claude_codex_bridge_token: "must-not-reach-child-either",
    },
    codexFactory: (options) => {
      capturedClientEnvironment = options.env;
      capturedClientConfig = options.config;
      return fakeCodex;
    },
  });

  const phases: string[] = [];
  const outcome = await adapter.run({
    prompt: "review and repair",
    operation: "review_repair",
    workspacePath: "C:\\fixture\\workspace",
    targetSessionId: threadId,
    allowedPaths: ["src"],
    acceptanceCriteria: ["tests pass"],
    hooks: {
      onTransportDelivered: () => {
        phases.push("transport");
      },
      onRunning: () => {
        phases.push("running");
      },
    },
  });

  assert.equal(outcome.classification, "success");
  assert.equal(resumedId, threadId);
  assert.equal(captured?.sandboxMode, "workspace-write");
  assert.equal(captured?.approvalPolicy, "never");
  assert.equal(captured?.model, DEFAULT_CODEX_MODEL);
  assert.equal(captured?.modelReasoningEffort, undefined);
  assert.equal(captured?.networkAccessEnabled, false);
  assert.equal(captured?.webSearchMode, "disabled");
  assert.deepEqual(captured?.additionalDirectories, []);
  assert.equal(captured?.workingDirectory, "C:\\fixture\\workspace");
  assert.equal(outcome.details.requested_model, DEFAULT_CODEX_MODEL);
  assert.equal(outcome.details.requested_reasoning_effort, CODEX_REASONING_EFFORT);
  assert.equal(outcome.details.reported_model, undefined);
  assert.equal(outcome.details.cli_version, "codex-cli 0.test");
  assert.equal(capturedClientEnvironment?.BRIDGE_CHILD, "1");
  assert.equal(capturedClientEnvironment?.PATH, "C:\\fixture\\bin");
  assert.equal(capturedClientEnvironment?.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(capturedClientEnvironment?.CODEX_SESSION_ID, undefined);
  assert.equal(capturedClientEnvironment?.CODEX_THREAD_ID, undefined);
  assert.equal(capturedClientEnvironment?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  assert.equal(capturedClientEnvironment?.CLAUDE_CODEX_BRIDGE_TOKEN, undefined);
  assert.equal(capturedClientEnvironment?.claude_codex_bridge_token, undefined);
  assert.deepEqual(capturedClientConfig, CODEX_BRIDGE_CONFIG);
  assert.equal(capturedClientConfig?.model_reasoning_effort, CODEX_REASONING_EFFORT);
  assert.equal(capturedClientConfig?.project_doc_max_bytes, 0);
  assert.deepEqual(capturedClientConfig?.skills, { include_instructions: false });
  assert.equal(capturedClientConfig?.include_environment_context, true);
  assert.deepEqual(capturedClientConfig?.windows, { sandbox: "unelevated" });
  assert.match(String(capturedClientConfig?.developer_instructions), /complete task contract/u);
  assert.match(capturedPrompt ?? "", /only for the writable paths listed below/u);
  assert.match(capturedPrompt ?? "", /bridge independently rejects every out-of-allowlist change/u);
  assert.equal(outcome.details.requested_sandbox_mode, "workspace-write");
  assert.equal(outcome.details.approval_policy, "never");
  assert.equal(outcome.details.network_access_enabled, false);
  assert.equal(outcome.details.web_search_mode, "disabled");
  assert.equal(outcome.details.project_doc_max_bytes, 0);
  assert.equal(outcome.details.skill_instructions_enabled, false);
  assert.equal(outcome.details.environment_context_enabled, true);
  assert.equal(outcome.details.windows_sandbox_mode, "unelevated");
  assert.deepEqual(outcome.details.changed_files, ["src/a.ts"]);
  assert.deepEqual(outcome.details.tests, ["npm test (exit 0)"]);
  assert.deepEqual(outcome.details.command_failures, [
    "node missing-check.mjs (exit -1); status failed",
  ]);
  assert.deepEqual(phases, ["transport", "running"]);
});

test("Codex adapter applies a per-task model and bridge-local reasoning effort", async () => {
  let capturedThread: ThreadOptions | undefined;
  let capturedConfig: CodexOptions["config"] | undefined;
  const threadId = "55555555-5555-4555-8555-555555555555";
  const fakeThread = {
    id: threadId,
    runStreamed: async () => ({ events: eventStream(threadId) }),
  };
  const fakeCodex = {
    startThread: (options?: ThreadOptions) => {
      capturedThread = options;
      return fakeThread;
    },
  } as unknown as Codex;
  const adapter = new CodexHeadlessAdapter({
    cliVersion: "codex-cli 0.test",
    cwd: "C:\\fixture",
    codexFactory: (options) => {
      capturedConfig = options.config;
      return fakeCodex;
    },
  });

  const outcome = await adapter.run({
    prompt: "balanced route",
    operation: "ask",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    taskProfile: "balanced",
    routingSource: "profile",
    routingRuleId: "codex-balanced-2026-08-15",
  });

  assert.equal(outcome.classification, "success");
  assert.equal(capturedThread?.model, "gpt-5.6-terra");
  assert.equal(capturedConfig?.model_reasoning_effort, "max");
  assert.equal(outcome.details.requested_model, "gpt-5.6-terra");
  assert.equal(outcome.details.requested_reasoning_effort, "max");
  assert.equal(outcome.details.task_profile, "balanced");
  assert.equal(outcome.details.routing_source, "profile");
  assert.equal(outcome.details.routing_rule_id, "codex-balanced-2026-08-15");
});

test("Codex adapter strips a host permission profile and relies on the SDK sandbox option", async () => {
  let capturedClientEnvironment: Record<string, string> | undefined;
  const threadId = "22222222-2222-4222-8222-222222222222";
  const fakeThread = {
    id: threadId,
    runStreamed: async () => ({ events: eventStream(threadId) }),
  };
  const fakeCodex = {
    startThread: () => fakeThread,
  } as unknown as Codex;
  const adapter = new CodexHeadlessAdapter({
    model: DEFAULT_CODEX_MODEL,
    cliVersion: "codex-cli 0.test",
    cwd: "C:\\fixture",
    environment: { CODEX_PERMISSION_PROFILE: ":danger-full-access" },
    codexFactory: (options) => {
      capturedClientEnvironment = options.env;
      return fakeCodex;
    },
  });

  const outcome = await adapter.run({
    prompt: "review only",
    operation: "ask",
    workspacePath: "C:\\fixture\\workspace",
  });

  assert.equal(outcome.classification, "success");
  assert.equal(capturedClientEnvironment?.CODEX_PERMISSION_PROFILE, undefined);
});

test("Codex adapter accepts a completed turn after a transient top-level reconnect error", async () => {
  const outcome = await runTopLevelErrorFixture(true);

  assert.equal(outcome.classification, "success");
  assert.equal(outcome.result, "CODEX_RECOVERED_OK");
  assert.equal(outcome.details.stderr, "");
  assert.match(outcome.details.complete_stdout_lines?.[2] ?? "", /Reconnecting/u);
});

test("Codex adapter fails a top-level error when no turn completes", async () => {
  const outcome = await runTopLevelErrorFixture(false);

  assert.equal(outcome.classification, "codex_error");
  assert.equal(outcome.is_error, true);
  assert.match(outcome.details.stderr, /Reconnecting/u);
});

test("Codex adapter clears a command failure after the exact command passes on retry", async () => {
  const outcome = await runCommandRetryFixture([
    { exitCode: 1, status: "failed" },
    { exitCode: 0, status: "completed" },
  ]);

  assert.equal(outcome.classification, "success");
  assert.deepEqual(outcome.details.tests, ["node verify-result.mjs (exit 0)"]);
  assert.equal(outcome.details.command_failures, undefined);
  assert.equal(outcome.details.complete_stdout_lines?.length, 6);
});

test("Codex adapter keeps only the final failure when the exact command later fails", async () => {
  const outcome = await runCommandRetryFixture([
    { exitCode: 0, status: "completed" },
    { exitCode: 1, status: "failed" },
  ]);

  assert.equal(outcome.classification, "success");
  assert.equal(outcome.details.tests, undefined);
  assert.deepEqual(outcome.details.command_failures, [
    "node verify-result.mjs (exit 1); status failed",
  ]);
  assert.equal(outcome.details.complete_stdout_lines?.length, 6);
});
