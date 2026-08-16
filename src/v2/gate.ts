import type { V2FinalReview } from "./types.js";

export type V2GateVerdict = "pass" | "needs_changes" | "disagreement" | "failed";

export interface V2TestResult {
  command: string;
  passed: boolean;
  detail: string;
}

export interface V2GateInput {
  review?: V2FinalReview;
  protocolFailure?: string;
  isolationFailure?: string;
  modelFailure?: string;
  runnerFailure?: string;
  testResults?: readonly V2TestResult[];
  artifactDelta: boolean;
}

export interface V2GateResult {
  verdict: V2GateVerdict;
  reason:
    | "protocol_failure"
    | "isolation_failure"
    | "model_failure"
    | "runner_failure"
    | "substantive_disagreement"
    | "test_failure"
    | "artifact_delta"
    | "reviewer_needs_changes"
    | "pass";
  failedTests: string[];
}

export function deriveV2Gate(input: V2GateInput): V2GateResult {
  const failedTests = (input.testResults ?? [])
    .filter((result) => !result.passed)
    .map((result) => result.command);
  if (input.protocolFailure !== undefined) {
    return { verdict: "failed", reason: "protocol_failure", failedTests };
  }
  if (input.isolationFailure !== undefined) {
    return { verdict: "failed", reason: "isolation_failure", failedTests };
  }
  if (input.modelFailure !== undefined || input.review === undefined) {
    return { verdict: "failed", reason: "model_failure", failedTests };
  }
  if (input.runnerFailure !== undefined) {
    return { verdict: "failed", reason: "runner_failure", failedTests };
  }
  if (input.review.verdict === "disagreement") {
    return { verdict: "disagreement", reason: "substantive_disagreement", failedTests };
  }
  if (failedTests.length > 0) {
    return { verdict: "needs_changes", reason: "test_failure", failedTests };
  }
  if (input.artifactDelta) {
    return { verdict: "needs_changes", reason: "artifact_delta", failedTests };
  }
  if (input.review.verdict === "needs_changes") {
    return { verdict: "needs_changes", reason: "reviewer_needs_changes", failedTests };
  }
  return { verdict: "pass", reason: "pass", failedTests };
}
