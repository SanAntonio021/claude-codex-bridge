import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { BridgeError } from "../errors.js";
import { BRIDGE_TOKEN_ENV, LIMITS } from "../constants.js";
import type { AdapterDetails } from "../types.js";
import {
  DEFAULT_CODEX_MODEL as ROUTED_DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  assertModelSelection,
  type ModelId,
  type ReasoningEffort,
} from "../model-routing.js";
import type { HeadlessHooks, HeadlessOutcome, HeadlessRunOptions } from "./claude.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = ROUTED_DEFAULT_CODEX_MODEL;
const CODEX_REASONING_EFFORT = DEFAULT_REASONING_EFFORT;
const CODEX_PROJECT_DOC_MAX_BYTES = 0;
const CODEX_ENVIRONMENT_CONTEXT_ENABLED = true;
const CODEX_WINDOWS_SANDBOX = "unelevated" as const;
const CODEX_DEVELOPER_INSTRUCTIONS = [
  "You are the Codex peer launched by claude-codex-bridge.",
  "Treat the supplied bridge prompt as the complete task contract.",
  "Stay inside the selected workspace and never inspect parent projects, user configuration, or unrelated instructions.",
  "Use only the workspace-write permissions and tools supplied for this turn; do not request broader access.",
].join(" ");
function codexBridgeConfig(reasoningEffort: ReasoningEffort): NonNullable<CodexOptions["config"]> {
  return {
    developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
    model_reasoning_effort: reasoningEffort,
    // Windows command tools lose ThreadOptions.workingDirectory when this is
    // disabled. Project docs and skill instructions remain disabled separately.
    include_environment_context: CODEX_ENVIRONMENT_CONTEXT_ENABLED,
    project_doc_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES,
    skills: { include_instructions: false },
    windows: { sandbox: CODEX_WINDOWS_SANDBOX },
  };
}

const CODEX_BRIDGE_CONFIG = Object.freeze(codexBridgeConfig(CODEX_REASONING_EFFORT));
const HOST_CODEX_CONTEXT_VARIABLES = [
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  BRIDGE_TOKEN_ENV,
] as const;

export interface CodexRunOptions extends HeadlessRunOptions {
  operation?: "ask" | "task" | "review_repair";
  targetSessionId?: string;
  workspacePath?: string;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
}

function normalizeEventPath(value: string): string | undefined {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || isAbsolute(value)) {
    return undefined;
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    return undefined;
  }
  return parts.join("/");
}

function isAllowedNativeFileChange(
  path: string,
  kind: "add" | "delete" | "update",
  policy: readonly { path: string; action: "modify" | "create" }[],
): boolean {
  const normalized = normalizeEventPath(path);
  if (normalized === undefined) {
    return false;
  }
  const expected = policy.find((entry) => entry.path.toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US"));
  return expected !== undefined
    && (expected.action === "modify" ? kind === "update" : kind === "add");
}

export interface CodexAdapterOptions {
  model?: ModelId;
  reasoningEffort?: ReasoningEffort;
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  environment?: Record<string, string>;
  cwd?: string;
  codexFactory?: (options: CodexOptions) => Codex;
  cliVersion?: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function inheritedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function bridgeChildEnvironment(environment: Record<string, string>): Record<string, string> {
  const sanitized = { ...environment };
  const blocked = new Set(HOST_CODEX_CONTEXT_VARIABLES.map((name) => name.toUpperCase()));
  for (const name of Object.keys(sanitized)) {
    if (blocked.has(name.toUpperCase())) {
      delete sanitized[name];
    }
  }
  return sanitized;
}

function bundledCliVersion(): string {
  try {
    const packageJson = require("@openai/codex/package.json") as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version !== ""
      ? `codex-cli ${packageJson.version}`
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function detectCliVersion(
  codexPathOverride: string | undefined,
  environment: Record<string, string>,
): Promise<string> {
  if (codexPathOverride === undefined) {
    return bundledCliVersion();
  }
  try {
    const result = await execFileAsync(codexPathOverride, ["--version"], {
      timeout: 5_000,
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    return result.stdout.trim() || result.stderr.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function threadOptions(
  cwd: string,
  operation: CodexRunOptions["operation"],
  model: string,
): ThreadOptions {
  const writeCapable = operation === "task" || operation === "review_repair";
  return {
    model,
    sandboxMode: writeCapable ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    workingDirectory: cwd,
    additionalDirectories: [],
    skipGitRepoCheck: true,
  };
}

function buildPrompt(options: CodexRunOptions): string {
  const operation = options.operation ?? "ask";
  const editPolicy = operation === "ask"
    ? "Do not create, modify, rename, or delete files."
    : [
        "Prefer the native patch or file-change tool for edits.",
        "If that tool explicitly reports a write failure, you may use a local shell file writer only for the writable paths listed below and only inside the current workspace.",
        "Do not use a shell writer before a native patch failure, and never write any other path; the bridge independently rejects every out-of-allowlist change.",
      ].join(" ");
  const scope = options.allowedPaths?.length === 0 || options.allowedPaths === undefined
    ? "No file writes are permitted."
    : `The only writable paths are:\n${options.allowedPaths.map((path) => `- ${path}`).join("\n")}`;
  const criteria = options.acceptanceCriteria?.length === 0 || options.acceptanceCriteria === undefined
    ? "No additional acceptance criteria were supplied."
    : `Acceptance criteria:\n${options.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`;
  const tests = options.testCommands?.length === 0 || options.testCommands === undefined
    ? "No exact test commands were supplied."
    : `Run these exact test commands without modification:\n${options.testCommands.map((item) => `- ${item}`).join("\n")}`;
  const reportContract = operation === "review_repair"
    ? [
        "Return the matching PLAN_REVIEW or DELIVERABLE_REVIEW with exactly these sections:",
        "结论：通过 | 需修改 | 实质分歧",
        "已确认事项：",
        "问题与理由：",
        "必须修改：",
        "剩余风险：",
        "A blocked, incomplete, authentication, permission, sandbox, or execution-policy failure must be reported as blocked/incomplete, never as 通过 or 需修改.",
      ].join("\n")
    : operation === "task"
      ? "Return a concise task result with actual changed files, commands/tests, unmet criteria, and any blocking error."
      : "Answer only from the supplied prompt and the empty read-only workspace.";
  return [
    "You are the Codex peer in claude-codex-bridge.",
    `Operation: ${operation}.`,
    "The bridge prompt contains the complete task contract. Stay inside the supplied working directory and do not inspect parent projects or unrelated global instruction files.",
    "Do not use network access, web search, extra directories, or hidden sessions.",
    editPolicy,
    scope,
    criteria,
    tests,
    reportContract,
    options.prompt,
  ].join("\n\n");
}

function summarizeEvent(event: ThreadEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return event.type;
  }
}

export class CodexHeadlessAdapter {
  readonly #model: ModelId;
  readonly #reasoningEffort: ReasoningEffort;
  readonly #codexPathOverride: string | undefined;
  readonly #baseUrl: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #environment: Record<string, string>;
  readonly #cwd: string;
  readonly #codexFactory: NonNullable<CodexAdapterOptions["codexFactory"]>;
  readonly #cliVersion: string | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.#model = options.model ?? DEFAULT_CODEX_MODEL;
    this.#reasoningEffort = options.reasoningEffort ?? CODEX_REASONING_EFFORT;
    assertModelSelection("codex", this.#model, this.#reasoningEffort);
    this.#codexPathOverride = options.codexPathOverride;
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#environment = bridgeChildEnvironment(
      options.environment ?? inheritedEnvironment(process.env),
    );
    this.#cwd = options.cwd ?? process.cwd();
    this.#codexFactory = options.codexFactory ?? ((codexOptions) => new Codex(codexOptions));
    this.#cliVersion = options.cliVersion ?? (
      options.codexPathOverride === undefined ? bundledCliVersion() : undefined
    );
  }

  async run(options: CodexRunOptions): Promise<HeadlessOutcome> {
    const model = options.model ?? this.#model;
    const reasoningEffort = options.reasoningEffort ?? this.#reasoningEffort;
    try {
      assertModelSelection("codex", model, reasoningEffort);
    } catch (error) {
      return {
        classification: "parameter_error",
        is_error: true,
        details: {
          exit_code: null,
          stderr: error instanceof BridgeError ? error.code : "invalid_model_route",
          complete_stdout_lines: [],
          requested_model: model,
          requested_reasoning_effort: reasoningEffort,
        },
      };
    }
    if (options.signal?.aborted === true) {
      return this.emptyOutcome("cancelled", model, reasoningEffort);
    }
    const cwd = options.workspacePath ?? this.#cwd;
    const threadConfiguration = threadOptions(cwd, options.operation, model);
    const codex = this.#codexFactory({
      ...(this.#codexPathOverride === undefined ? {} : { codexPathOverride: this.#codexPathOverride }),
      ...(this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl }),
      ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
      config: codexBridgeConfig(reasoningEffort),
      env: {
        ...this.#environment,
        BRIDGE_CHILD: "1",
      },
    });
    const thread: Thread = options.targetSessionId === undefined
      ? codex.startThread(threadConfiguration)
      : codex.resumeThread(options.targetSessionId, threadConfiguration);
    const details: AdapterDetails = {
      exit_code: null,
      stderr: "",
      complete_stdout_lines: [],
      requested_model: model,
      requested_reasoning_effort: reasoningEffort,
      ...(options.taskProfile === undefined ? {} : { task_profile: options.taskProfile }),
      ...(options.routingSource === undefined ? {} : { routing_source: options.routingSource }),
      ...(options.routingRuleId === undefined ? {} : { routing_rule_id: options.routingRuleId }),
      ...(this.#cliVersion === undefined ? {} : { cli_version: this.#cliVersion }),
      ...(threadConfiguration.sandboxMode === undefined
        ? {}
        : { requested_sandbox_mode: threadConfiguration.sandboxMode }),
      ...(threadConfiguration.approvalPolicy === undefined
        ? {}
        : { approval_policy: threadConfiguration.approvalPolicy }),
      ...(threadConfiguration.networkAccessEnabled === undefined
        ? {}
        : { network_access_enabled: threadConfiguration.networkAccessEnabled }),
      ...(threadConfiguration.webSearchMode === undefined
        ? {}
        : { web_search_mode: threadConfiguration.webSearchMode }),
      project_doc_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES,
      skill_instructions_enabled: false,
      environment_context_enabled: CODEX_ENVIRONMENT_CONTEXT_ENABLED,
      windows_sandbox_mode: CODEX_WINDOWS_SANDBOX,
      ...(options.workspacePath === undefined ? {} : { workspace_path: options.workspacePath }),
    };
    const eventLines: string[] = [];
    let eventBytes = 0;
    let outputLimitExceeded = false;
    const changedFiles = new Set<string>();
    const commandOutcomes = new Map<string, { summary: string; failure?: string }>();
    let threadId = thread.id ?? undefined;
    let finalResponse = "";
    let completed = false;
    let terminalFailureMessage: string | undefined;
    let streamErrorMessage: string | undefined;
    let isolationFailureMessage: string | undefined;
    const localAbort = new AbortController();
    const forwardAbort = (): void => localAbort.abort(options.signal?.reason ?? "cancelled");
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      await options.hooks?.onTransportDelivered?.();
      const turnOptions = {
        signal: localAbort.signal,
        ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      };
      const streamed = await thread.runStreamed(
        buildPrompt(options),
        turnOptions,
      );
      for await (const event of streamed.events) {
        const eventLine = summarizeEvent(event);
        eventBytes += Buffer.byteLength(eventLine, "utf8");
        if (eventBytes <= LIMITS.streamBytes && eventLines.length < 128) {
          eventLines.push(eventLine);
          details.complete_stdout_lines = [...eventLines];
        } else if (eventBytes > LIMITS.streamBytes) {
          outputLimitExceeded = true;
        }
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          await options.hooks?.onRunning?.();
        } else if (event.type === "turn.failed") {
          terminalFailureMessage = event.error.message;
        } else if (event.type === "error") {
          streamErrorMessage = event.message;
        } else if (event.type === "item.completed") {
          if (event.item.type === "agent_message") {
            if (Buffer.byteLength(event.item.text, "utf8") <= LIMITS.streamBytes) {
              finalResponse = event.item.text;
            } else {
              outputLimitExceeded = true;
            }
          }
          if (event.item.type === "file_change") {
            if (
              options.zeroTools === true
              || (options.nativeFileChangeOnly === true && event.item.status !== "completed")
            ) {
              isolationFailureMessage = "Codex used a forbidden file-change tool path or failed native patch.";
              localAbort.abort("isolation_breach");
              break;
            }
            for (const change of event.item.changes) {
              if (
                options.nativeFileChangeOnly === true
                && !isAllowedNativeFileChange(change.path, change.kind, options.fileChangePolicy ?? [])
              ) {
                isolationFailureMessage = "Codex native file change exceeded the explicit v2 repair target.";
                localAbort.abort("isolation_breach");
                break;
              }
              changedFiles.add(change.path);
            }
          }
          if (event.item.type === "command_execution") {
            if (options.zeroTools === true || options.nativeFileChangeOnly === true) {
              isolationFailureMessage = "Codex command execution is forbidden by the v2 isolation contract.";
              localAbort.abort("isolation_breach");
              break;
            }
            const status = String(event.item.status);
            const exitCode = event.item.exit_code ?? (status === "completed" ? 0 : -1);
            const summary = `${event.item.command.slice(0, 8_192)} (exit ${String(exitCode)})`;
            if (status === "completed" && exitCode === 0) {
              commandOutcomes.set(event.item.command, { summary });
            } else {
              commandOutcomes.set(event.item.command, {
                summary,
                failure: `${summary}; status ${status}`,
              });
            }
          }
          if (
            (event.item.type === "mcp_tool_call" || event.item.type === "web_search")
            && (options.zeroTools === true || options.nativeFileChangeOnly === true)
          ) {
            isolationFailureMessage = "Codex MCP or web tool use is forbidden by the v2 isolation contract.";
            localAbort.abort("isolation_breach");
            break;
          }
        } else if (event.type === "turn.completed") {
          completed = true;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (isolationFailureMessage !== undefined) {
          // The terminal result below records the isolation failure rather than a normal cancellation.
        } else {
          return {
            classification: "cancelled",
            is_error: true,
            details: {
              ...details,
              ...(threadId === undefined ? {} : { thread_id: threadId }),
            },
            ...(threadId === undefined ? {} : { session_id: threadId }),
          };
        }
      }
      if (isolationFailureMessage === undefined) {
        terminalFailureMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }
    details.cli_version = this.#cliVersion
      ?? await detectCliVersion(this.#codexPathOverride, this.#environment);
    if (threadId !== undefined) {
      details.thread_id = threadId;
    }
    if (changedFiles.size > 0) {
      details.changed_files = [...changedFiles].sort();
    }
    const terminalTests = [...commandOutcomes.values()]
      .filter((outcome) => outcome.failure === undefined)
      .map((outcome) => outcome.summary);
    const terminalCommandFailures = [...commandOutcomes.values()]
      .flatMap((outcome) => outcome.failure === undefined ? [] : [outcome.failure]);
    if (terminalTests.length > 0) {
      details.tests = terminalTests;
    }
    if (terminalCommandFailures.length > 0) {
      details.command_failures = terminalCommandFailures;
    }
    if (isolationFailureMessage !== undefined) {
      details.stderr = isolationFailureMessage;
      return {
        classification: "isolation_breach",
        is_error: true,
        details,
        ...(threadId === undefined ? {} : { session_id: threadId }),
      };
    }
    const failedMessage = terminalFailureMessage ?? (completed ? undefined : streamErrorMessage);
    if (failedMessage !== undefined) {
      details.stderr = failedMessage.slice(0, LIMITS.stderrBytes);
      return {
        classification: "codex_error",
        is_error: true,
        details,
        ...(finalResponse === "" ? {} : { result: finalResponse }),
        ...(threadId === undefined ? {} : { session_id: threadId }),
      };
    }
    if (outputLimitExceeded) {
      return {
        classification: "output_limit_exceeded",
        is_error: true,
        details,
        ...(threadId === undefined ? {} : { session_id: threadId }),
      };
    }
    if (!completed) {
      return {
        classification: "codex_protocol_error",
        is_error: true,
        details,
        ...(finalResponse === "" ? {} : { result: finalResponse }),
        ...(threadId === undefined ? {} : { session_id: threadId }),
      };
    }
    if (threadId === undefined || finalResponse === "") {
      return {
        classification: "codex_protocol_error",
        is_error: true,
        details,
        ...(finalResponse === "" ? {} : { result: finalResponse }),
        ...(threadId === undefined ? {} : { session_id: threadId }),
      };
    }
    return {
      classification: "success",
      is_error: false,
      result: finalResponse,
      session_id: threadId,
      details,
    };
  }

  private emptyOutcome(
    classification: "cancelled" | "codex_error",
    model: ModelId,
    reasoningEffort: ReasoningEffort,
  ): HeadlessOutcome {
    return {
      classification,
      is_error: true,
      details: {
        exit_code: null,
        stderr: "",
        complete_stdout_lines: [],
        requested_model: model,
        requested_reasoning_effort: reasoningEffort,
        ...(this.#cliVersion === undefined ? {} : { cli_version: this.#cliVersion }),
      },
    };
  }
}

export { DEFAULT_CODEX_MODEL };
export { CODEX_REASONING_EFFORT };
export { CODEX_BRIDGE_CONFIG };
