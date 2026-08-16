import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HeadlessOutcome } from "../../src/adapter/claude.js";
import { BridgeError } from "../../src/errors.js";
import { sha256 } from "../../src/hash.js";
import { snapshotV2Tree } from "../../src/v2/path.js";
import { deriveV2Gate } from "../../src/v2/gate.js";
import { renderV2Review } from "../../src/v2/renderer.js";
import { V2ReviewService } from "../../src/v2/service.js";
import { V2SeriesStore } from "../../src/v2/series.js";
import { buildSandboxArguments } from "../../src/v2/sandbox.js";
import {
  parseV2ReviewRequest,
  type V2FinalReview,
  type V2ReviewRequest,
} from "../../src/v2/types.js";
import { V2WorkspaceManager } from "../../src/v2/workspace.js";

process.env.BRIDGE_SKIP_ACL = "1";

async function removeFixture(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function artifact(content = "# Plan\n\nKeep the artifact read-only.\n") {
  return {
    artifactContent: content,
    artifactBytes: Buffer.byteLength(content, "utf8"),
    artifactSha256: sha256(content),
  };
}

function inlineRequest(overrides: Record<string, unknown> = {}): V2ReviewRequest {
  const content = typeof overrides.artifactContent === "string"
    ? overrides.artifactContent
    : "# Plan\n\nKeep the artifact read-only.\n";
  return parseV2ReviewRequest({
    operation: "review_only",
    artifactMode: "inline",
    question: "Check this plan.",
    artifactId: "v2-unit-plan",
    artifactType: "plan",
    artifactName: "plan.md",
    artifactPath: "plan.md",
    ...artifact(content),
    acceptanceCriteria: ["The scope is coherent."],
    constraints: ["Do not write files."],
    ...overrides,
  }, "codex");
}

function successOutcome(result: string, request: V2ReviewRequest): HeadlessOutcome {
  return {
    classification: "success",
    is_error: false,
    result,
    details: {
      exit_code: 0,
      stderr: "",
      complete_stdout_lines: [],
      requested_model: request.model,
      requested_reasoning_effort: request.reasoningEffort,
      ...(request.target === "claude" ? { reported_model: request.model } : {}),
    },
  };
}

class StaticV2Runner {
  response: string;

  constructor(response: string) {
    this.response = response;
  }

  async run(request: V2ReviewRequest): Promise<HeadlessOutcome> {
    return successOutcome(this.response, request);
  }
}

const passingReview: V2FinalReview = {
  kind: "final_review",
  verdict: "pass",
  confirmed: ["The acceptance criterion is stated."],
  findings: [],
  requiredChanges: [],
  risks: ["No live model was used by this deterministic test."],
};

const evidenceRequest = {
  kind: "evidence_request" as const,
  requests: [{
    question: "State the rollback owner.",
    references: [{ path: "plan.md", quote: "# Plan" }],
  }],
};

const activeProbe = async () => ({
  at: new Date().toISOString(),
  v2WorkspaceTests: true,
  workspaceWrite: true,
  externalWriteDenied: true,
  loopbackDenied: true,
  internetDenied: true,
  childInheritanceDenied: true,
  childTreeTerminated: true,
});

const unavailableProbe = async () => ({
  at: new Date().toISOString(),
  v2WorkspaceTests: false,
  workspaceWrite: true,
  externalWriteDenied: true,
  loopbackDenied: false,
  internetDenied: false,
  childInheritanceDenied: false,
  childTreeTerminated: true,
});

test("v2 structured test sandbox disables network and proxy transport", () => {
  const profile = "bridge_test";
  const argumentsList = buildSandboxArguments(
    "C:\\workspace",
    { program: "C:\\tools\\test.exe", args: [] },
    profile,
  );
  assert.ok(argumentsList.includes(`permissions.${profile}.network.enabled=false`));
  assert.ok(argumentsList.includes(`permissions.${profile}.network.allow_upstream_proxy=false`));
  assert.ok(argumentsList.includes(`permissions.${profile}.network.enable_socks5=false`));
});

test("v2 derives the opposite target and rejects dummy workspace fields for review_only", () => {
  const request = inlineRequest();
  assert.equal(request.owner, "codex");
  assert.equal(request.target, "claude");
  assert.throws(
    () => inlineRequest({ targetRoot: "C:\\work", repairTargets: [{ path: "plan.md", action: "modify" }] }),
    (error: unknown) => error instanceof BridgeError && error.code === "review_only_contract_violation",
  );
});

test("v2 rejects a workspace repair before dispatch when artifactPath is absent", () => {
  const content = "# Plan\n";
  assert.throws(
    () => parseV2ReviewRequest({
      operation: "review_repair",
      artifactMode: "workspace",
      question: "Repair the plan.",
      artifactId: "missing-path-plan",
      artifactType: "deliverable",
      artifactName: "plan.md",
      ...artifact(content),
      acceptanceCriteria: ["The plan is coherent."],
      targetRoot: "C:\\workspace",
      repairTargets: [{ path: "plan.md", action: "modify" }],
      testCommands: [],
    }, "codex"),
    (error: unknown) => error instanceof BridgeError && error.code === "workspace_repair_contract_incomplete",
  );
});

test("v2 gate priority and renderer keep the literal PLAN_REVIEW contract", () => {
  const request = inlineRequest();
  const gate = deriveV2Gate({
    review: passingReview,
    protocolFailure: "invalid_schema",
    artifactDelta: true,
  });
  assert.deepEqual(gate, { verdict: "failed", reason: "protocol_failure", failedTests: [] });
  const rendered = renderV2Review(request, passingReview, deriveV2Gate({ review: passingReview, artifactDelta: false }));
  assert.match(rendered.renderedReview, /^PLAN_REVIEW\n结论：通过\n/u);
  for (const label of ["已确认事项：", "问题与理由：", "必须修改：", "剩余风险："]) {
    assert.match(rendered.renderedReview, new RegExp(label, "u"));
  }
});

test("v2 inline review stores bridge-rendered result and does not accept a repair payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-inline-"));
  const runner = new StaticV2Runner(JSON.stringify(passingReview));
  const service = new V2ReviewService({ runtimeRoot: root, runner, probe: activeProbe });
  try {
    await service.initialize({ probe: true });
    const submitted = await service.submit("codex", {
      operation: "review_only",
      artifactMode: "inline",
      question: "Check this plan.",
      artifactId: "inline-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(),
      acceptanceCriteria: ["The scope is coherent."],
      constraints: ["No writes."],
    });
    const result = await service.wait(submitted.jobId, 2_000);
    assert.equal(result.state, "succeeded");
    assert.match(result.renderedReview ?? "", /^PLAN_REVIEW/mu);
    assert.equal(result.adapterEvidence?.zeroTools, true);
    assert.equal(result.adapterEvidence?.reportedModel, "claude-opus-5");
  } finally {
    await removeFixture(root);
  }
});

test("v2 preserves zero-tool inline review when the workspace sandbox proof fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-inline-only-"));
  const service = new V2ReviewService({
    runtimeRoot: root,
    runner: new StaticV2Runner(JSON.stringify(passingReview)),
    probe: unavailableProbe,
  });
  try {
    await service.initialize({ probe: true });
    assert.equal(service.isActive(), true);
    assert.equal(service.workspaceRepairsAvailable(), false);
    assert.equal(service.capabilities()?.workspaceProbeState, "unavailable");
    assert.equal(service.capabilities()?.workspaceProbeReason, "sandbox_checks_failed");

    const inline = await service.submit("codex", {
      operation: "review_only",
      artifactMode: "inline",
      question: "Check the inline-only plan.",
      artifactId: "inline-only-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(),
      acceptanceCriteria: ["The scope is coherent."],
      constraints: ["No writes."],
    });
    assert.equal((await service.wait(inline.jobId, 2_000)).state, "succeeded");

    const jobsPath = join(root, "v2", "jobs");
    const beforeRejectedWorkspace = await readdir(jobsPath);
    await assert.rejects(
      () => service.submit("codex", {
        operation: "review_repair",
        artifactMode: "workspace",
        question: "Repair the plan in a workspace.",
        artifactId: "blocked-workspace-plan",
        artifactType: "plan",
        artifactName: "plan.md",
        artifactPath: "plan.md",
        ...artifact(),
        acceptanceCriteria: ["The scope is coherent."],
        constraints: ["Only the plan may change."],
        targetRoot: root,
        repairTargets: [{ path: "plan.md", action: "modify" }],
        testCommands: [],
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "v2_workspace_capability_unavailable",
    );
    assert.deepEqual(await readdir(jobsPath), beforeRejectedWorkspace);
  } finally {
    await removeFixture(root);
  }
});

test("v2 evidence requests receive the bridge-rendered five-section review contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-evidence-"));
  const service = new V2ReviewService({
    runtimeRoot: root,
    runner: new StaticV2Runner(JSON.stringify(evidenceRequest)),
    probe: activeProbe,
  });
  try {
    await service.initialize({ probe: true });
    const submitted = await service.submit("codex", {
      operation: "review_only",
      artifactMode: "inline",
      question: "Check this plan.",
      artifactId: "evidence-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(),
      acceptanceCriteria: ["The scope is coherent."],
      constraints: ["No writes."],
    });
    const result = await service.wait(submitted.jobId, 2_000);
    assert.equal(result.state, "awaiting_evidence");
    assert.match(result.renderedReview ?? "", /^PLAN_REVIEW\n结论：需修改\n/u);
    assert.match(result.renderedReview ?? "", /必须修改：/u);
    assert.equal(result.adapterEvidence?.zeroTools, true);
  } finally {
    await removeFixture(root);
  }
});

test("v2 series requires CAS and sends the third non-pass round to user adjudication", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-series-"));
  const store = new V2SeriesStore(root);
  const request = inlineRequest({ artifactId: "series-plan", seriesId: "series-plan" });
  const gate = deriveV2Gate({
    review: { ...passingReview, verdict: "needs_changes" },
    artifactDelta: false,
  });
  try {
    await store.initialize();
    const first = await store.submit(request);
    await store.complete(first.job.jobId, {
      state: "succeeded",
      acceptedRound: true,
      gate,
      findings: [{ id: "F-1234567890AB", summary: "Fix scope", rationale: "Scope is incomplete", evidence: [] }],
    });
    await assert.rejects(
      () => store.submit(request),
      (error: unknown) => error instanceof BridgeError && error.code === "series_cas_mismatch",
    );
    const second = await store.submit({
      ...request,
      seriesVersion: first.job.seriesVersion,
      latestJobId: first.job.jobId,
    });
    await store.complete(second.job.jobId, {
      state: "succeeded",
      acceptedRound: true,
      gate,
      findings: [{ id: "F-1234567890AB", summary: "Fix scope", rationale: "Scope is incomplete", evidence: [] }],
    });
    const third = await store.submit({
      ...request,
      seriesVersion: second.job.seriesVersion,
      latestJobId: second.job.jobId,
    });
    const completed = await store.complete(third.job.jobId, {
      state: "succeeded",
      acceptedRound: true,
      gate,
      findings: [{ id: "F-1234567890AB", summary: "Fix scope", rationale: "Scope is incomplete", evidence: [] }],
    });
    assert.equal(completed.state, "awaiting_user_decision");
    const adjudicated = await store.adjudicate(third.job.jobId, {
      decision: "accept_reviewer",
      summary: "Accept the only disputed finding.",
      acceptedFindingIds: ["F-1234567890AB"],
      rejectedFindingIds: [],
      additionalRequirements: ["Apply the scope fix before a new series."],
    });
    assert.equal(adjudicated.adjudication?.decision, "accept_reviewer");
  } finally {
    await removeFixture(root);
  }
});

test("v2 closes a passed series and never overwrites a terminal job", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-terminal-"));
  const store = new V2SeriesStore(root);
  const request = inlineRequest({ artifactId: "terminal-plan", seriesId: "terminal-plan" });
  const gate = deriveV2Gate({ review: passingReview, artifactDelta: false });
  try {
    await store.initialize();
    const first = await store.submit(request);
    await store.complete(first.job.jobId, {
      state: "succeeded",
      acceptedRound: true,
      gate,
    });
    await assert.rejects(
      () => store.submit({ ...request, seriesVersion: first.job.seriesVersion, latestJobId: first.job.jobId }),
      (error: unknown) => error instanceof BridgeError && error.code === "series_completed",
    );
    await assert.rejects(
      () => store.complete(first.job.jobId, { state: "failed", acceptedRound: false }),
      (error: unknown) => error instanceof BridgeError && error.code === "v2_job_terminal",
    );
  } finally {
    await removeFixture(root);
  }
});

test("v2 workspace validates scope before test execution and synchronizes only explicit UTF-8 targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-workspace-"));
  const target = join(root, "target");
  const runtime = join(root, "runtime");
  const content = "# Original\n";
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "plan.md"), content, "utf8");
    await writeFile(join(target, "context.md"), "# Context\n", "utf8");
    const request = parseV2ReviewRequest({
      operation: "review_repair",
      artifactMode: "workspace",
      question: "Repair the plan.",
      artifactId: "workspace-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(content),
      acceptanceCriteria: ["The plan is complete."],
      constraints: ["Only the plan may change."],
      targetRoot: target,
      repairTargets: [{ path: "plan.md", action: "modify" }],
      testCommands: [],
    }, "codex");
    const manager = new V2WorkspaceManager(runtime);
    const handle = await manager.prepare("11111111-1111-4111-8111-111111111111", request);
    await writeFile(join(handle.workspaceRoot, "context.md"), "# Changed context\n", "utf8");
    await assert.rejects(
      () => manager.validate(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "reviewer_scope_violation",
    );
    await writeFile(join(handle.workspaceRoot, "context.md"), "# Context\n", "utf8");
    await mkdir(join(handle.workspaceRoot, ".git"));
    await assert.rejects(
      () => manager.validate(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "reviewer_scope_violation",
    );
    await rm(join(handle.workspaceRoot, ".git"), { recursive: true, force: true });
    await writeFile(join(handle.workspaceRoot, "plan.md"), "# Repaired\n", "utf8");
    const checked = await manager.validate(handle);
    assert.deepEqual(checked.changedFiles, ["plan.md"]);
    const synced = await manager.sync(handle);
    assert.equal(synced.artifactDelta, true);
    assert.equal(await readFile(join(target, "plan.md"), "utf8"), "# Repaired\n");
  } finally {
    await removeFixture(root);
  }
});

test("v2 rejects an actual hardlink without conflating distinct NTFS file identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-hardlink-"));
  const target = join(root, "target");
  const source = join(target, "source.md");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(source, "# Source\n", "utf8");
    await link(source, join(target, "linked.md"));
    await assert.rejects(
      () => snapshotV2Tree(target),
      (error: unknown) => error instanceof BridgeError && error.code === "hardlink_rejected",
    );
  } finally {
    await removeFixture(root);
  }
});

test("v2 accepts evidence from a sealed workspace context file without loading the full tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-context-evidence-"));
  const target = join(root, "target");
  const runtime = join(root, "runtime");
  const content = "# Plan\n";
  const contextReview: V2FinalReview = {
    kind: "final_review",
    verdict: "needs_changes",
    confirmed: [],
    findings: [{
      summary: "Rollback ownership is missing.",
      rationale: "The sealed context assigns no owner.",
      evidence: [{ path: "context.md", quote: "# Context" }],
    }],
    requiredChanges: ["Assign a rollback owner."],
    risks: [],
  };
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "plan.md"), content, "utf8");
    await writeFile(join(target, "context.md"), "# Context\n", "utf8");
    const request = {
      operation: "review_repair",
      artifactMode: "workspace",
      question: "Review the plan against its context.",
      artifactId: "context-evidence-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(content),
      acceptanceCriteria: ["The plan has an owner."],
      constraints: ["Only the plan may change."],
      targetRoot: target,
      repairTargets: [{ path: "plan.md", action: "modify" }],
      testCommands: [],
    };
    const service = new V2ReviewService({
      runtimeRoot: runtime,
      runner: new StaticV2Runner(JSON.stringify(contextReview)),
      probe: activeProbe,
    });
    await service.initialize({ probe: true });
    const submitted = await service.submit("codex", request);
    const result = await service.wait(submitted.jobId, 2_000);
    assert.equal(result.state, "succeeded");
    assert.match(result.renderedReview ?? "", /context\.md:引文/u);
  } finally {
    await removeFixture(root);
  }
});

test("v2 workspace rollback restores every target after each transaction-phase fault", async () => {
  for (const faultPhase of ["sealed", "sync_prepared", "replace", "verify", "rollback"] as const) {
    const root = await mkdtemp(join(tmpdir(), `bridge-v2-rollback-${faultPhase}-`));
    const target = join(root, "target");
    const runtime = join(root, "runtime");
    const content = "# Original\n";
    try {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "plan.md"), content, "utf8");
      await writeFile(join(target, "second.md"), "# Second\n", "utf8");
      const request = parseV2ReviewRequest({
        operation: "review_repair",
        artifactMode: "workspace",
        question: "Repair the files.",
        artifactId: `rollback-${faultPhase}`,
        artifactType: "deliverable",
        artifactName: "plan.md",
        artifactPath: "plan.md",
        ...artifact(content),
        acceptanceCriteria: ["Both files are updated."],
        constraints: ["Only explicit targets may change."],
        targetRoot: target,
        repairTargets: [
          { path: "plan.md", action: "modify" },
          { path: "second.md", action: "modify" },
        ],
        testCommands: [],
      }, "codex");
      const manager = new V2WorkspaceManager(runtime);
      const handle = await manager.prepare("33333333-3333-4333-8333-333333333333", request);
      await writeFile(join(handle.workspaceRoot, "plan.md"), "# Repaired\n", "utf8");
      await writeFile(join(handle.workspaceRoot, "second.md"), "# Repaired second\n", "utf8");
      const triggerPhase = faultPhase === "rollback" ? "sync_prepared" : faultPhase;
      await assert.rejects(
        () => manager.sync(handle, (phase) => {
          if (phase === triggerPhase || (faultPhase === "rollback" && phase === "rollback")) {
            throw new Error(`injected ${phase}`);
          }
        }),
        (error: unknown) => error instanceof BridgeError && error.code === "workspace_sync_failed",
      );
      assert.equal(await readFile(join(target, "plan.md"), "utf8"), content);
      assert.equal(await readFile(join(target, "second.md"), "utf8"), "# Second\n");
    } finally {
      await removeFixture(root);
    }
  }
});

test("v2 recovery fails closed from every persisted execution stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-recovery-"));
  const stages: Array<readonly [string, readonly string[]]> = [
    ["sealed", ["dispatching", "sealed"]],
    ["peer_running", ["dispatching", "sealed", "peer_running"]],
    ["result_validated", ["dispatching", "sealed", "peer_running", "result_validated"]],
    ["validation_complete", ["dispatching", "sealed", "peer_running", "result_validated", "validation_complete"]],
    ["sync_prepared", ["dispatching", "sealed", "peer_running", "result_validated", "validation_complete", "sync_prepared"]],
    ["replace", ["dispatching", "sealed", "peer_running", "result_validated", "validation_complete", "sync_prepared", "replace"]],
    ["verify", ["dispatching", "sealed", "peer_running", "result_validated", "validation_complete", "sync_prepared", "replace", "verify"]],
    ["rollback", ["dispatching", "sealed", "peer_running", "result_validated", "validation_complete", "sync_prepared", "rollback"]],
  ];
  try {
    for (const [name, transitions] of stages) {
      const runtime = join(root, name);
      const original = new V2SeriesStore(runtime);
      await original.initialize();
      const submitted = await original.submit(inlineRequest({ artifactId: `recovery-${name}`, seriesId: `recovery-${name}` }));
      for (const state of transitions) {
        await original.transition(submitted.job.jobId, state as Parameters<V2SeriesStore["transition"]>[1]);
      }
      const restarted = new V2SeriesStore(runtime);
      await restarted.initialize();
      const recovered = await restarted.recoverUncertain();
      assert.equal(recovered.length, 1, name);
      const record = restarted.getJob(submitted.job.jobId);
      assert.equal(record.state, "failed", name);
      assert.equal(record.error?.code, "v2_recovery_required", name);
    }
  } finally {
    await removeFixture(root);
  }
});

test("v2 reserves declared workspace bytes before copying another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-v2-capacity-"));
  const target = join(root, "target");
  const runtime = join(root, "runtime");
  const content = "# Original\n";
  try {
    await mkdir(target, { recursive: true });
    await mkdir(join(runtime, "v2-reservations"), { recursive: true });
    await writeFile(join(target, "plan.md"), content, "utf8");
    await writeFile(
      join(runtime, "v2-reservations", "occupied.json"),
      `${JSON.stringify({ job_id: "other", bytes: 5 * 1024 * 1024 * 1024 })}\n`,
      "utf8",
    );
    const request = parseV2ReviewRequest({
      operation: "review_repair",
      artifactMode: "workspace",
      question: "Repair the plan.",
      artifactId: "capacity-plan",
      artifactType: "plan",
      artifactName: "plan.md",
      artifactPath: "plan.md",
      ...artifact(content),
      acceptanceCriteria: ["The plan is complete."],
      constraints: ["Only the plan may change."],
      targetRoot: target,
      repairTargets: [{ path: "plan.md", action: "modify" }],
      testCommands: [],
    }, "codex");
    const manager = new V2WorkspaceManager(runtime);
    await assert.rejects(
      () => manager.prepare("22222222-2222-4222-8222-222222222222", request),
      (error: unknown) => error instanceof BridgeError && error.code === "workspace_capacity_reached",
    );
  } finally {
    await removeFixture(root);
  }
});
