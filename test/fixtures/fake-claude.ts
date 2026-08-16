import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const scenario = process.argv[2] ?? "success";
const bridgeArgs = process.argv.slice(3);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  prompt += chunk;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const resumeIndex = bridgeArgs.indexOf("--resume");
const resumedSession = resumeIndex >= 0 ? bridgeArgs[resumeIndex + 1] : undefined;
const sessionId = resumedSession ?? randomUUID();
const toolsIndex = bridgeArgs.indexOf("--tools");
const configuredTools = toolsIndex < 0 || bridgeArgs[toolsIndex + 1] === ""
  ? []
  : (bridgeArgs[toolsIndex + 1] ?? "").split(",");
const modelIndex = bridgeArgs.indexOf("--model");
const configuredModel = bridgeArgs[modelIndex + 1] ?? "claude-opus-5";

function emitBash(command: string, isError = false): void {
  const toolUseId = randomUUID();
  emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
  });
  emit({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }],
    },
    tool_use_result: {
      stdout: isError ? "" : "ok",
      stderr: isError ? "command failed" : "",
      interrupted: false,
    },
  });
}

function emitFileTool(name: string, filePath: string): void {
  emit({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: randomUUID(),
        name,
        input: { file_path: filePath },
      }],
    },
  });
}

if (scenario === "parameter_error") {
  process.stderr.write("invalid command parameter\n");
  process.exitCode = 1;
} else if (scenario === "isolation") {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: configuredModel,
    tools: ["Read"],
  });
  setInterval(() => undefined, 1_000);
} else {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    ...(scenario === "missing_model"
      ? {}
      : { model: scenario === "wrong_model" ? "claude-sonnet-5" : configuredModel }),
    tools: configuredTools,
  });
  if (scenario === "result_error") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      session_id: sessionId,
      is_error: true,
      result: "resume failed",
      permission_denials: [],
    });
    process.exitCode = 1;
  } else if (scenario === "stream_interrupted") {
    emit({ type: "assistant", message: "partial but complete event" });
    process.exitCode = 7;
  } else if (scenario === "partial_line") {
    process.stdout.write('{"type":"assistant"');
    process.exitCode = 7;
  } else if (scenario === "slow") {
    setInterval(() => undefined, 1_000);
  } else if (scenario === "bash_unauthorized") {
    emitBash("ls -la");
    setInterval(() => undefined, 1_000);
  } else {
    const fileToolScenario = /^file_(inside_relative|inside_absolute|outside|traversal|git)_(Read|Edit|Write)$/u.exec(scenario);
    if (fileToolScenario !== null) {
      const location = fileToolScenario[1];
      const tool = fileToolScenario[2] as string;
      const filePath = location === "inside_relative"
        ? "README.md"
        : location === "inside_absolute"
          ? join(process.cwd(), "README.md")
          : location === "outside"
            ? join(dirname(process.cwd()), "outside.txt")
            : location === "traversal"
              ? "..\\outside.txt"
              : ".git\\config";
      emitFileTool(tool, filePath);
    }
    if (scenario === "bash_success") {
      emitBash("npm.cmd test");
    } else if (scenario === "bash_failure") {
      emitBash("npm.cmd test", true);
    }
    const result =
      scenario === "args"
        ? JSON.stringify({
            args: bridgeArgs,
            prompt,
            bridge_child: process.env.BRIDGE_CHILD,
            bridge_hop_count: process.env.BRIDGE_HOP_COUNT,
            bridge_token: process.env.CLAUDE_CODEX_BRIDGE_TOKEN,
            bridge_token_lower: process.env.claude_codex_bridge_token,
          })
        : scenario === "opaque"
          ? "<tool_call><tool_name>read_file</tool_name></tool_call>"
          : "fixture success";
    emit({
      type: "result",
      session_id: sessionId,
      is_error: false,
      result,
      permission_denials:
        scenario === "denial"
          ? [
              {
                tool_name: "Write",
                tool_use_id: "tool-1",
                tool_input: { path: "RAW_TOOL_INPUT_SECRET" },
              },
            ]
          : [],
    });
  }
}
