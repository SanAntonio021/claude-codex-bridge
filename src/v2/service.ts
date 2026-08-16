import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteJson, ensureProtectedDirectory } from "../daemon/atomic.js";
import { BridgeError, asBridgeError, toStructuredError, type StructuredError } from "../errors.js";
import type { RoutingConfiguration } from "../model-routing.js";
import { decodeStrictUtf8 } from "./path.js";
import { BridgeV2AdapterRunner, type V2AdapterRunner } from "./adapter.js";
import { deriveV2Gate, type V2TestResult } from "./gate.js";
import {
  renderV2EvidenceRequest,
  renderV2Review,
  validateV2Evidence,
  type V2EvidenceSource,
} from "./renderer.js";
import { V2SeriesStore, type V2AdapterEvidence, type V2JobRecord } from "./series.js";
import { probeV2WorkspaceSandbox, V2SandboxRunner, type V2SandboxProbe } from "./sandbox.js";
import {
  parseV2ModelResponse,
  type V2AdjudicationInput,
  parseV2ReviewRequest,
  type V2FinalReview,
  type V2ModelResponse,
  type V2Owner,
  type V2ReviewRequest,
} from "./types.js";
import { V2WorkspaceManager, type V2WorkspaceHandle } from "./workspace.js";

export interface V2Capabilities extends V2SandboxProbe {
  buildId?: string;
}

export interface V2ReviewServiceOptions {
  runtimeRoot: string;
  runner: V2AdapterRunner;
  sandboxRunner?: V2SandboxRunner;
  probe?: (runtimeRoot: string) => Promise<V2Capabilities>;
}

function structuredError(error: unknown, fallback = "v2_review_failed"): StructuredError {
  const bridgeError = asBridgeError(error);
  return {
    code: bridgeError.code || fallback,
    message: bridgeError.message,
    retryable: false,
    ...(bridgeError.details === undefined ? {} : { details: bridgeError.details }),
  };
}

function failureClass(error: StructuredError): "protocol" | "isolation" | "model" | "runner" {
  if (/isolation|scope|reparse|hardlink|path_escape/u.test(error.code)) {
    return "isolation";
  }
  if (/model|codex|claude/u.test(error.code)) {
    return "model";
  }
  if (/sandbox|test|runner/u.test(error.code)) {
    return "runner";
  }
  return "protocol";
}

function inlineSources(request: V2ReviewRequest): V2EvidenceSource[] {
  return [{ path: request.artifactPath ?? "inline-artifact.txt", content: request.artifactContent }];
}

function evidenceReferencePaths(response: V2ModelResponse): string[] {
  const references = response.kind === "evidence_request"
    ? response.requests.flatMap((request) => request.references)
    : response.findings.flatMap((finding) => finding.evidence);
  return references.flatMap((reference) => reference.path === undefined ? [] : [reference.path]);
}

function assertInlineRepairEncoding(review: V2FinalReview): void {
  if (review.repairedArtifact === undefined) {
    return;
  }
  decodeStrictUtf8(Buffer.from(review.repairedArtifact, "utf8"), "repairedArtifact");
}

function assertResponseMatchesRequest(
  request: V2ReviewRequest,
  response: V2FinalReview,
): void {
  if (request.operation === "review_only" && response.repairedArtifact !== undefined) {
    throw new BridgeError(
      "review_only_repair_returned",
      "Protocol v2 review_only responses cannot carry a repairedArtifact.",
      { httpStatus: 409 },
    );
  }
  if (request.operation === "review_repair" && request.artifactMode === "inline" && response.repairedArtifact === undefined) {
    throw new BridgeError(
      "inline_repair_missing_artifact",
      "Protocol v2 inline review_repair must return a complete repairedArtifact.",
      { httpStatus: 409 },
    );
  }
  if (request.artifactMode === "workspace" && response.repairedArtifact !== undefined) {
    throw new BridgeError(
      "workspace_repair_inline_artifact_forbidden",
      "Protocol v2 workspace review_repair records changes only through the fixed workspace.",
      { httpStatus: 409 },
    );
  }
}

function adapterEvidence(
  request: V2ReviewRequest,
  outcome: Awaited<ReturnType<V2AdapterRunner["run"]>>,
): V2AdapterEvidence {
  return {
    classification: outcome.classification,
    requestedModel: outcome.details.requested_model ?? request.model,
    requestedReasoningEffort: outcome.details.requested_reasoning_effort ?? request.reasoningEffort,
    ...(outcome.details.reported_model === undefined ? {} : { reportedModel: outcome.details.reported_model }),
    ...(outcome.details.cli_version === undefined ? {} : { cliVersion: outcome.details.cli_version }),
    ...(outcome.details.requested_sandbox_mode === undefined
      ? {}
      : { requestedSandboxMode: outcome.details.requested_sandbox_mode }),
    ...(outcome.details.approval_policy === undefined ? {} : { approvalPolicy: outcome.details.approval_policy }),
    zeroTools: request.operation === "review_only" || request.artifactMode === "inline",
    nativeFileChangeOnly: request.artifactMode === "workspace",
  };
}

export class V2ReviewService {
  readonly #runtimeRoot: string;
  readonly #capabilityPath: string;
  readonly #store: V2SeriesStore;
  readonly #workspace: V2WorkspaceManager;
  readonly #runner: V2AdapterRunner;
  readonly #sandbox: V2SandboxRunner;
  readonly #probe: (runtimeRoot: string) => Promise<V2Capabilities>;
  #capabilities: V2Capabilities | undefined;

  constructor(options: V2ReviewServiceOptions) {
    this.#runtimeRoot = resolve(options.runtimeRoot);
    this.#capabilityPath = join(this.#runtimeRoot, "v2-capabilities.json");
    this.#store = new V2SeriesStore(this.#runtimeRoot);
    this.#workspace = new V2WorkspaceManager(this.#runtimeRoot);
    this.#runner = options.runner;
    this.#sandbox = options.sandboxRunner ?? new V2SandboxRunner();
    this.#probe = options.probe ?? probeV2WorkspaceSandbox;
  }

  static withBridgeRunner(runtimeRoot: string, peer: ConstructorParameters<typeof BridgeV2AdapterRunner>[0]): V2ReviewService {
    return new V2ReviewService({ runtimeRoot, runner: new BridgeV2AdapterRunner(peer) });
  }

  async initialize(options: { probe?: boolean } = {}): Promise<void> {
    await ensureProtectedDirectory(this.#runtimeRoot);
    await Promise.all([this.#store.initialize(), this.#workspace.initialize()]);
    await this.#store.recoverUncertain();
    if (options.probe === true) {
      const capabilities = await this.#probe(this.#runtimeRoot);
      this.#capabilities = capabilities;
      await atomicWriteJson(this.#capabilityPath, capabilities, { protect: true });
      return;
    }
    try {
      const saved = JSON.parse(await readFile(this.#capabilityPath, "utf8")) as V2Capabilities;
      if (typeof saved.v2WorkspaceTests === "boolean") {
        this.#capabilities = saved;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  capabilities(): V2Capabilities | undefined {
    return this.#capabilities;
  }

  isActive(): boolean {
    return this.#capabilities?.v2WorkspaceTests === true;
  }

  async submit(
    owner: V2Owner,
    value: unknown,
    configuration?: RoutingConfiguration,
  ): Promise<{ jobId: string; state: string; seriesVersion: number }> {
    if (!this.isActive()) {
      throw new BridgeError(
        "v2_capability_unavailable",
        "Protocol v2 is inactive until the bundled Codex sandbox probe proves workspace writes, containment, network denial, and process-tree cleanup.",
        { httpStatus: 503 },
      );
    }
    const request = parseV2ReviewRequest(value, owner, configuration);
    const submission = await this.#store.submit(request);
    void this.#execute(submission.job.jobId);
    return {
      jobId: submission.job.jobId,
      state: submission.job.state,
      seriesVersion: submission.series.seriesVersion,
    };
  }

  get(jobId: string): V2JobRecord {
    return this.#store.getJob(jobId);
  }

  async adjudicate(jobId: string, input: V2AdjudicationInput): Promise<V2JobRecord> {
    return this.#store.adjudicate(jobId, input);
  }

  async wait(jobId: string, timeoutMs: number): Promise<V2JobRecord> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 45_000) {
      throw new BridgeError("invalid_timeout", "timeout_ms must be an integer from 0 to 45000.", {
        httpStatus: 400,
      });
    }
    return this.#store.wait(jobId, timeoutMs);
  }

  async #execute(jobId: string): Promise<void> {
    let workspace: V2WorkspaceHandle | undefined;
    let request: V2ReviewRequest | undefined;
    try {
      let job = await this.#store.transition(jobId, "dispatching");
      request = job.request;
      if (request.artifactMode === "workspace") {
        workspace = await this.#workspace.prepare(jobId, request);
        job = await this.#store.transition(jobId, "sealed", {
          workspace: {
            targetRoot: workspace.targetRoot,
            workspaceRoot: workspace.workspaceRoot,
            retainedUntil: workspace.retainedUntil,
          },
        });
      }
      await this.#store.transition(jobId, "peer_running");
      const outcome = await this.#runner.run(request, workspace);
      if (outcome.classification !== "success" || outcome.result === undefined) {
        const error = structuredError(
          new BridgeError(
            outcome.classification === "isolation_breach"
              ? "reviewer_scope_violation"
              : outcome.classification === "model_mismatch"
                ? "model_mismatch"
                : "peer_runner_failure",
            outcome.details.stderr || `Peer adapter ended as ${outcome.classification}.`,
          ),
        );
        const kind = outcome.classification === "isolation_breach"
          ? "isolation"
          : outcome.classification === "model_mismatch"
            ? "model"
            : "runner";
        await this.#store.complete(jobId, {
          state: "failed",
          acceptedRound: false,
          error,
          adapterEvidence: adapterEvidence(request, outcome),
          ...(workspace === undefined ? {} : { workspace }),
          gate: deriveV2Gate({
            ...(kind === "isolation" ? { isolationFailure: error.code } : {}),
            ...(kind === "model" ? { modelFailure: error.code } : {}),
            ...(kind === "runner" ? { runnerFailure: error.code } : {}),
            artifactDelta: false,
          }),
        });
        return;
      }
      const response = parseV2ModelResponse(outcome.result);
      const sources = workspace === undefined
        ? inlineSources(request)
        : await this.#workspace.evidenceSources(workspace, evidenceReferencePaths(response));
      validateV2Evidence(response, sources);
      const workspaceChanges = workspace === undefined
        ? undefined
        : await this.#workspace.validate(workspace);
      await this.#store.transition(jobId, "result_validated", { modelResponse: response });
      if (response.kind === "evidence_request") {
        if (workspaceChanges?.artifactDelta === true) {
          throw new BridgeError(
            "evidence_request_workspace_delta",
            "Protocol v2 evidence requests cannot modify the fixed review workspace.",
            { httpStatus: 409 },
          );
        }
        const rendered = renderV2EvidenceRequest(request, response);
        await this.#store.complete(jobId, {
          state: "awaiting_evidence",
          acceptedRound: false,
          gate: { verdict: "needs_changes", reason: "reviewer_needs_changes", failedTests: [] },
          modelResponse: response,
          renderedReview: rendered.renderedReview,
          findings: rendered.findings,
          adapterEvidence: adapterEvidence(request, outcome),
          ...(workspace === undefined ? {} : { workspace }),
        });
        return;
      }

      assertResponseMatchesRequest(request, response);
      assertInlineRepairEncoding(response);
      let testResults: V2TestResult[] = [];
      if (workspace !== undefined && request.testCommands.length > 0) {
        testResults = await this.#sandbox.run(workspace.workspaceRoot, request.testCommands);
      }
      await this.#store.transition(jobId, "validation_complete", {
        modelResponse: response,
        ...(testResults.length === 0 ? {} : { testResults }),
      });
      const testsPassed = testResults.every((result) => result.passed);
      let artifactDelta = workspaceChanges?.artifactDelta
        ?? (response.repairedArtifact !== undefined && response.repairedArtifact !== request.artifactContent);
      if (workspace !== undefined && testsPassed) {
        const synced = await this.#workspace.sync(workspace, async (phase) => {
          const state = phase === "sealed"
            ? "validation_complete"
            : phase;
          if (state !== "validation_complete") {
            await this.#store.transition(jobId, state);
          }
        });
        artifactDelta = synced.artifactDelta;
      }
      const gate = deriveV2Gate({ review: response, testResults, artifactDelta });
      const rendered = renderV2Review(request, response, gate);
      // result is deliberately the bridge renderer, never raw model prose or a scanned report file.
      await this.#store.complete(jobId, {
        state: "succeeded",
        acceptedRound: true,
        gate,
        modelResponse: response,
        renderedReview: rendered.renderedReview,
        findings: rendered.findings,
        ...(testResults.length === 0 ? {} : { testResults }),
        ...(response.repairedArtifact === undefined ? {} : { repairedArtifact: response.repairedArtifact }),
        adapterEvidence: adapterEvidence(request, outcome),
        ...(workspace === undefined ? {} : { workspace }),
      });
    } catch (error) {
      const structured = structuredError(error);
      const kind = failureClass(structured);
      try {
        await this.#store.complete(jobId, {
          state: "failed",
          acceptedRound: false,
          error: structured,
          ...(workspace === undefined ? {} : { workspace }),
          gate: deriveV2Gate({
            ...(kind === "protocol" ? { protocolFailure: structured.code } : {}),
            ...(kind === "isolation" ? { isolationFailure: structured.code } : {}),
            ...(kind === "model" ? { modelFailure: structured.code } : {}),
            ...(kind === "runner" ? { runnerFailure: structured.code } : {}),
            artifactDelta: false,
          }),
        });
      } catch {
        // The protected v2 store may already have reached a terminal state.
      }
    }
  }
}
