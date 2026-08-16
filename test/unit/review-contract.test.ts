import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeRequest } from "../../src/request.js";
import {
  peerReviewFailureReport,
  validateReviewRepairOutcome,
} from "../../src/review-contract.js";
import type { HeadlessOutcome } from "../../src/adapter/claude.js";
import { sha256 } from "../../src/hash.js";

const ARTIFACT_CONTENT = "review fixture artifact";

function report(
  marker: "PLAN_REVIEW" | "DELIVERABLE_REVIEW",
  conclusion: "通过" | "需修改" | "实质分歧" = "通过",
  issue = "无",
): string {
  return [
    marker,
    `结论：${conclusion}`,
    "已确认事项：",
    "- file and test verified",
    "问题与理由：",
    `- ${issue}`,
    "必须修改：",
    conclusion === "需修改" ? "- fix the documented issue" : "- 无",
    "剩余风险：",
    "- 无",
  ].join("\n");
}

function request(
  artifactType: "plan" | "deliverable" = "deliverable",
  operation: "ask" | "task" | "review_repair" = "review_repair",
) {
  return createBridgeRequest(
    {
      question: "review fixture",
      operation,
      artifactId: "review-contract-fixture",
      artifactType,
      artifactName: "artifact.md",
      artifactContent: ARTIFACT_CONTENT,
      artifactBytes: Buffer.byteLength(ARTIFACT_CONTENT),
      artifactSha256: sha256(ARTIFACT_CONTENT),
      targetRoot: "C:\\fixture\\project",
      allowedPaths: ["artifact.md"],
      round: 1,
      priorRounds: [],
      acceptanceCriteria: ["focused verification passes"],
      testCommands: [],
    },
    { origin: "review-contract-test", target: "codex" },
  );
}

function outcome(result: string, tests: string[] = []): HeadlessOutcome {
  return {
    classification: "success",
    is_error: false,
    result,
    session_id: "codex-session",
    details: {
      exit_code: 0,
      stderr: "",
      complete_stdout_lines: [],
      requested_model: "gpt-5.6-sol",
      requested_reasoning_effort: "max",
      cli_version: "codex-test",
      ...(tests.length === 0 ? {} : { tests }),
    },
  };
}

test("review_repair accepts a structured deliverable pass", () => {
  assert.equal(
    validateReviewRepairOutcome(
      request(),
      outcome(report("DELIVERABLE_REVIEW")),
    ),
    undefined,
  );
});

test("review_repair accepts Markdown section headings without colons", () => {
  const markdownReport = [
    "## DELIVERABLE_REVIEW",
    "**结论：通过**",
    "### 已确认事项",
    "- verified",
    "### 问题与理由",
    "- 无",
    "### 必须修改",
    "- 无",
    "### 剩余风险",
    "- 无",
  ].join("\n");
  assert.equal(validateReviewRepairOutcome(request(), outcome(markdownReport)), undefined);
});

test("review_repair accepts equivalent Traditional Chinese labels", () => {
  const traditionalReport = [
    "DELIVERABLE_REVIEW",
    "結論：通過",
    "已確認事項：",
    "- verified",
    "問題與理由：",
    "- 無",
    "必須修改：",
    "- 無",
    "剩餘風險：",
    "- 無",
  ].join("\n");
  assert.equal(validateReviewRepairOutcome(request(), outcome(traditionalReport)), undefined);
});

test("review_repair accepts documented sandbox modes and a known external read-only limit", () => {
  const result = [
    "DELIVERABLE_REVIEW",
    "结论：通过",
    "已确认事项：",
    '- Codex uses `sandboxMode: "workspace-write"` for writes and `"read-only"` for ask.',
    "- Task validation rejects reports containing `workspace is read-only`, `blocked by policy`, `permission denied`, or `OAuth failed`.",
    "问题与理由：",
    "- 已修复测试夹具中的环境变量隔离。",
    "必须修改：",
    "- 无",
    "剩余风险：",
    "- 嵌套 Codex Desktop 在外部只读策略下失败关闭；独立主机写入证明待定。",
  ].join("\n");

  assert.equal(validateReviewRepairOutcome(request(), outcome(result)), undefined);
});

test("review_repair rejects a passing report whose issue section says the workspace is blocked", () => {
  const issue = validateReviewRepairOutcome(
    request(),
    outcome(report("DELIVERABLE_REVIEW", "通过", "workspace is read-only here; writes were blocked by policy")),
  );

  assert.equal(issue?.code, "review_blocked");
});

test("review_repair rejects a missing review marker", () => {
  const issue = validateReviewRepairOutcome(request(), outcome("结论：通过\nlooks good"));
  assert.equal(issue?.code, "missing_review_marker");
});

test("review_repair rejects a report missing required sections", () => {
  const issue = validateReviewRepairOutcome(
    request(),
    outcome("DELIVERABLE_REVIEW\n结论：通过\n已确认事项：\n- verified"),
  );
  assert.equal(issue?.code, "missing_review_sections");
  assert.deepEqual(issue?.details.missing_sections, ["问题与理由", "必须修改", "剩余风险"]);
});

test("review_repair turns an explicit blocked response into a contract failure", () => {
  const issue = validateReviewRepairOutcome(request(), outcome("DELIVERABLE_REVIEW - Blocked\nOAuth login required"));
  assert.equal(issue?.code, "review_blocked");
});

test("review_repair treats protected permission-denial evidence as blocked", () => {
  const denied = outcome(report("DELIVERABLE_REVIEW"));
  denied.details.permission_denials = [{ tool_name: "Bash", tool_use_id: "denied-test" }];
  const issue = validateReviewRepairOutcome(request(), denied);
  assert.equal(issue?.code, "review_blocked");
  assert.equal(issue?.details.permission_denial_count, 1);
});

test("review_repair rejects passing a failed test or unmet acceptance", () => {
  const issue = validateReviewRepairOutcome(
    request(),
    outcome(
      `${report("DELIVERABLE_REVIEW")}\n验收未满足：the focused test failed`,
      ["npm test (exit 1)"],
    ),
  );
  assert.equal(issue?.code, "acceptance_not_met");
  assert.deepEqual(issue?.details.failed_tests, ["npm test (exit 1)"]);
});

test("review_repair rejects adapter-recorded command failures and missing tests", () => {
  const failed = outcome(report("DELIVERABLE_REVIEW"));
  failed.details.command_failures = ["python quick_validate.py skill (tool error)"];
  const failedIssue = validateReviewRepairOutcome(request(), failed);
  assert.equal(failedIssue?.code, "acceptance_not_met");
  assert.deepEqual(failedIssue?.details.failed_tests, [
    "python quick_validate.py skill (tool error)",
  ]);

  const missing = outcome(report("DELIVERABLE_REVIEW"));
  missing.details.missing_test_commands = ["npm.cmd test"];
  const missingIssue = validateReviewRepairOutcome(request(), missing);
  assert.equal(missingIssue?.code, "review_blocked");
  assert.deepEqual(missingIssue?.details.missing_tests, ["npm.cmd test"]);
});

test("review_repair permits a documented needs-changes conclusion", () => {
  assert.equal(
    validateReviewRepairOutcome(
      request(),
      outcome(report("DELIVERABLE_REVIEW", "需修改", "test still fails"), ["npm test (exit 1)"]),
    ),
    undefined,
  );
});

test("plan reviews require PLAN_REVIEW and ordinary asks skip the review gate", () => {
  const planIssue = validateReviewRepairOutcome(
    request("plan"),
    outcome("DELIVERABLE_REVIEW\n结论：通过"),
  );
  assert.equal(planIssue?.code, "missing_review_marker");
  assert.equal(
    validateReviewRepairOutcome(request("deliverable", "ask"), outcome("plain answer")),
    undefined,
  );
});

test("task turns an explicit blocked response into a contract failure", () => {
  const issue = validateReviewRepairOutcome(
    request("deliverable", "task"),
    outcome("DELIVERABLE_REVIEW - Blocked\nStatus: incomplete because the exec policy denied writes"),
  );
  assert.equal(issue?.code, "task_blocked");
});

test("task recognizes Markdown-formatted blocked status before synchronization", () => {
  const issue = validateReviewRepairOutcome(
    request("deliverable", "task"),
    outcome(
      "**DELIVERABLE_REVIEW**\n\n`status`: blocked\n\n`summary`: writing is blocked by read-only sandbox",
    ),
  );
  assert.equal(issue?.code, "task_blocked");
  assert.match(issue?.details.conclusion ?? "", /^blocked/iu);
});

test("task rejects the exact read-only policy response from the live Codex fixture", () => {
  const liveResponse = [
    "DELIVERABLE_REVIEW",
    "",
    "- Changed files: none.",
    "- Tests: `Get-Content -Encoding UTF8 verify-result.mjs`; `Get-ChildItem -Force result.txt`.",
    "- Unmet criteria: `result.txt` was not created, so `node verify-result.mjs` could not be completed successfully.",
    "- Blocking error: the workspace is read-only here; both `apply_patch` and direct write attempts were blocked by policy.",
  ].join("\n");

  const issue = validateReviewRepairOutcome(
    request("deliverable", "task"),
    outcome(liveResponse),
  );

  assert.equal(issue?.code, "task_blocked");
  assert.match(issue?.details.response_excerpt ?? "", /workspace is read-only/iu);
  assert.match(issue?.details.response_excerpt ?? "", /blocked by policy/iu);
});

test("task rejects a non-empty unmet-criteria field even without another blocker", () => {
  assert.equal(
    validateReviewRepairOutcome(
      request("deliverable", "task"),
      outcome("Unmet criteria: result.txt was not created."),
    )?.code,
    "task_blocked",
  );
  assert.equal(
    validateReviewRepairOutcome(
      request("deliverable", "task"),
      outcome("Unmet criteria: none."),
    ),
    undefined,
  );
});

test("task treats authentication and permission failures as blocked", () => {
  for (const result of [
    "OAuth failed: refresh_token_reused",
    "Execution policy denied the requested file write",
    "permission denied while applying the change",
  ]) {
    assert.equal(
      validateReviewRepairOutcome(request("deliverable", "task"), outcome(result))?.code,
      "task_blocked",
    );
  }
});

test("task does not require a file change or review marker when no block is reported", () => {
  assert.equal(
    validateReviewRepairOutcome(
      request("deliverable", "task"),
      outcome("Verification completed; no source changes were necessary."),
    ),
    undefined,
  );
});

test("task rejects a passing conclusion when recorded tests failed", () => {
  const issue = validateReviewRepairOutcome(
    request("deliverable", "task"),
    outcome("DELIVERABLE_REVIEW\n结论：通过", ["npm test (exit 1)"]),
  );
  assert.equal(issue?.code, "acceptance_not_met");
});

test("contract failure report contains direction, job, models, and no-sync statement", () => {
  const reviewRequest = request();
  const reviewOutcome = outcome("DELIVERABLE_REVIEW - Blocked");
  const issue = validateReviewRepairOutcome(reviewRequest, reviewOutcome);
  assert.ok(issue);
  const report = peerReviewFailureReport("job-123", reviewRequest, reviewOutcome, issue);
  assert.match(report, /^PEER_REVIEW_FAILURE_REPORT/mu);
  assert.match(report, /方向：Claude -> Codex/u);
  assert.match(report, /jobId：job-123/u);
  assert.match(report, /请求模型：gpt-5\.6-sol/u);
  assert.match(report, /未同步任何审查者变更/u);
});
