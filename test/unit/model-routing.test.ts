import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeError } from "../../src/errors.js";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  resolveModelRoute,
  reviewerLabel,
} from "../../src/model-routing.js";
import { createBridgeRequest } from "../../src/request.js";
import { sha256 } from "../../src/hash.js";
import { parseBridgeRequest } from "../../src/types.js";

test("quality defaults select Opus 5/max and GPT-5.6 Sol/max", () => {
  const claude = resolveModelRoute({ target: "claude" });
  assert.equal(claude.taskProfile, "quality");
  assert.equal(claude.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(claude.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.equal(claude.selectionSource, "default");

  const codex = resolveModelRoute({ target: "codex" });
  assert.equal(codex.taskProfile, "quality");
  assert.equal(codex.model, DEFAULT_CODEX_MODEL);
  assert.equal(codex.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.equal(codex.selectionSource, "default");
});

test("task profiles route deterministically without changing the peer target", () => {
  const writing = resolveModelRoute({ target: "claude", taskProfile: "writing" });
  assert.equal(writing.model, "claude-opus-5");
  assert.equal(writing.reasoningEffort, "max");
  assert.equal(writing.selectionSource, "profile");

  const balancedClaude = resolveModelRoute({ target: "claude", taskProfile: "balanced" });
  assert.equal(balancedClaude.model, "claude-sonnet-5");
  assert.equal(balancedClaude.reasoningEffort, "high");

  const balancedCodex = resolveModelRoute({ target: "codex", taskProfile: "balanced" });
  assert.equal(balancedCodex.model, "gpt-5.6-terra");
  assert.equal(balancedCodex.reasoningEffort, "max");

  const volumeCodex = resolveModelRoute({ target: "codex", taskProfile: "high_volume" });
  assert.equal(volumeCodex.model, "gpt-5.6-luna");
  assert.equal(volumeCodex.reasoningEffort, "max");
});

test("explicit model selection permits Opus 4.6/max and rejects invalid combinations", () => {
  const explicit = resolveModelRoute({
    target: "claude",
    taskProfile: "writing",
    model: "claude-opus-4-6",
    reasoningEffort: "max",
  });
  assert.equal(explicit.selectionSource, "explicit");
  assert.equal(explicit.model, "claude-opus-4-6");
  assert.equal(reviewerLabel("claude", explicit.model), "Claude Opus 4.6");

  assert.throws(
    () => resolveModelRoute({
      target: "claude",
      model: "claude-opus-4-6",
      reasoningEffort: "xhigh",
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "model_effort_mismatch",
  );
  assert.throws(
    () => resolveModelRoute({ target: "codex", model: "claude-opus-5" }),
    (error: unknown) => error instanceof BridgeError && error.code === "model_target_mismatch",
  );
  assert.throws(
    () => resolveModelRoute({
      target: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "ultra",
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "model_effort_mismatch",
  );
});

test("requests persist the resolved route and reject forged audit metadata", () => {
  const request = createBridgeRequest(
    {
      question: "review the writing",
      taskProfile: "writing",
      model: "claude-opus-4-6",
      reasoningEffort: "max",
    },
    { origin: "test", target: "claude" },
  );
  assert.equal(request.task_profile, "writing");
  assert.equal(request.model, "claude-opus-4-6");
  assert.equal(request.reasoning_effort, "max");
  assert.equal(request.routing_source, "explicit");
  assert.equal(request.routing_rule_id, "explicit-claude-model-selection-v1");

  const artifactContent = "review me";
  const review = createBridgeRequest(
    {
      question: "review and repair",
      operation: "review_repair",
      taskProfile: "writing",
      model: "claude-opus-4-6",
      reasoningEffort: "max",
      artifactId: "explicit-reviewer-label",
      artifactType: "deliverable",
      artifactName: "artifact.md",
      artifactBytes: Buffer.byteLength(artifactContent),
      artifactSha256: sha256(artifactContent),
      artifactContent,
      targetRoot: join(tmpdir(), "bridge-model-route-review"),
      allowedPaths: ["artifact.md"],
      round: 1,
      acceptanceCriteria: ["review completes"],
      testCommands: [],
    },
    { origin: "test", target: "claude" },
  );
  assert.equal(review.reviewer, "Claude Opus 4.6");

  assert.throws(
    () => parseBridgeRequest({ ...request, routing_rule_id: "forged-route" }),
    (error: unknown) => error instanceof BridgeError && error.code === "model_route_mismatch",
  );
});
