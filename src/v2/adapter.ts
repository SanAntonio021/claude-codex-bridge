import type { HeadlessOutcome, HeadlessRunOptions } from "../adapter/claude.js";
import type { PeerRunner } from "../adapter/peer.js";
import { V2ModelResponseJsonSchema, type V2ReviewRequest } from "./types.js";
import type { V2WorkspaceHandle } from "./workspace.js";

export interface V2AdapterRunner {
  run(request: V2ReviewRequest, workspace?: V2WorkspaceHandle): Promise<HeadlessOutcome>;
}

function promptFor(request: V2ReviewRequest, workspace?: V2WorkspaceHandle): string {
  const workspaceMode = workspace !== undefined;
  const repairInstruction = request.operation === "review_only"
    ? "Evaluate the supplied artifact only. Do not propose or create a repaired file."
    : request.artifactMode === "inline"
      ? "Evaluate the supplied artifact. When returning a repair, put the complete replacement UTF-8 artifact in repairedArtifact; do not use tools."
      : [
          "Inspect the fixed workspace with the only available native file-change capability.",
          "You may change only the explicit repair targets. Do not run commands, tests, MCP, web, browser, or app tools.",
          "The bridge, not you, runs structured test commands after this response.",
        ].join(" ");
  const targetText = workspaceMode
    ? request.repairTargets?.map((target) => `${target.action}:${target.path}`).join(", ") ?? ""
    : "none";
  return [
    "You are a protocol-v2 peer reviewer for claude-codex-bridge.",
    `Operation: ${request.operation}; artifact mode: ${request.artifactMode}.`,
    `Reviewer target is fixed by endpoint authentication: ${request.target}.`,
    repairInstruction,
    `Artifact ID: ${request.artifactId}; type: ${request.artifactType}; name: ${request.artifactName}.`,
    `Explicit workspace repair targets: ${targetText}.`,
    "Return exactly one JSON object matching the supplied JSON Schema. Do not add Markdown, prose, or code fences.",
    "Use evidence_request only when the supplied material cannot answer a necessary question. Otherwise return final_review.",
    "For every finding, include bridge-verifiable evidence with a source path and line range or exact quote.",
    "A pass can only mean the supplied acceptance criteria are met from the evidence you have. Never claim tests ran.",
    `Acceptance criteria: ${JSON.stringify(request.acceptanceCriteria)}.`,
    `Constraints: ${JSON.stringify(request.constraints)}.`,
    `Question: ${request.question}`,
    `Artifact content:\n${request.artifactContent}`,
  ].join("\n\n");
}

export class BridgeV2AdapterRunner implements V2AdapterRunner {
  readonly #peer: PeerRunner;

  constructor(peer: PeerRunner) {
    this.#peer = peer;
  }

  async run(request: V2ReviewRequest, workspace?: V2WorkspaceHandle): Promise<HeadlessOutcome> {
    const workspaceMode = workspace !== undefined;
    const options: HeadlessRunOptions = {
      prompt: promptFor(request, workspace),
      outputSchema: V2ModelResponseJsonSchema,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      taskProfile: request.taskProfile,
      routingSource: request.routingSource,
      routingRuleId: request.routingRuleId,
      operation: workspaceMode ? "review_repair" : "ask",
      ...(workspaceMode
        ? {
            workspacePath: workspace.workspaceRoot,
            allowedPaths: workspace.repairTargets.map((target) => target.path),
            acceptanceCriteria: request.acceptanceCriteria,
            testCommands: [],
            nativeFileChangeOnly: true,
            fileChangePolicy: workspace.repairTargets,
          }
        : { zeroTools: true }),
    };
    return request.target === "claude"
      ? this.#peer.run(options)
      : this.#peer.runCodex(options);
  }
}
