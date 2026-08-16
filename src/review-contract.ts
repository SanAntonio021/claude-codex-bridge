import type { BridgeRequest } from "./types.js";
import type { HeadlessOutcome } from "./adapter/claude.js";

export interface ReviewContractIssue {
  code:
    | "missing_review_marker"
    | "missing_review_conclusion"
    | "missing_review_sections"
    | "invalid_review_conclusion"
    | "review_blocked"
    | "task_blocked"
    | "acceptance_not_met";
  message: string;
  details: {
    required_marker?: "PLAN_REVIEW" | "DELIVERABLE_REVIEW";
    conclusion?: string;
    failed_tests?: string[];
    response_excerpt?: string;
    missing_sections?: string[];
    missing_tests?: string[];
    permission_denial_count?: number;
  };
}

type ReviewConclusion = "pass" | "needs_changes" | "disagreement" | "blocked";

const MAX_RESPONSE_EXCERPT = 2_000;

function requiredMarker(request: BridgeRequest): "PLAN_REVIEW" | "DELIVERABLE_REVIEW" {
  return request.artifact_type === "plan" ? "PLAN_REVIEW" : "DELIVERABLE_REVIEW";
}

function excerpt(result: string): string {
  return result.replace(/\s+/gu, " ").trim().slice(0, MAX_RESPONSE_EXCERPT);
}

function withoutInlineMarkdown(result: string): string {
  return result.replace(/[*`]/gu, "");
}

function conclusionFrom(result: string): { raw?: string; value?: ReviewConclusion } {
  const match = withoutInlineMarkdown(result).match(
    /(?:^|\n)\s*(?:[-*#>`\s]*)(?:结论|結論|conclusion|verdict|status)\s*(?:[:：-]\s*)?([^\r\n]+)/iu,
  );
  if (match === null) {
    return {};
  }
  const raw = match[1]?.trim() ?? "";
  const statusTail = "(?:$|\\s|[([{：:，,.;])";
  if (new RegExp(`^(?:通过|通過|pass(?:ed)?|approved?|ok)${statusTail}`, "iu").test(raw)) {
    return { raw, value: "pass" };
  }
  if (new RegExp(`^(?:需修改|需要修改|修订|needs?\\s+changes?|revise|revision)${statusTail}`, "iu").test(raw)) {
    return { raw, value: "needs_changes" };
  }
  if (new RegExp(`^(?:实质分歧|實質分歧|分歧|substantive\\s+disagreement|disagreement)${statusTail}`, "iu").test(raw)) {
    return { raw, value: "disagreement" };
  }
  if (
    new RegExp(
      `^(?:阻塞|被阻塞|未完成|无法完成|無法完成|失败|失敗|blocked|incomplete|failed|failure|cannot\\s+complete|not\\s+completed)${statusTail}`,
      "iu",
    ).test(raw)
  ) {
    return { raw, value: "blocked" };
  }
  return { raw };
}

function failedTests(outcome: HeadlessOutcome): string[] {
  const failedRecordedTests = (outcome.details.tests ?? []).filter((entry) => {
    const exitCode = /\bexit\s+(-?\d+)\b/iu.exec(entry)?.[1];
    if (exitCode !== undefined && Number(exitCode) !== 0) {
      return true;
    }
    return /\b(?:failed|failure|error)\b|失败|失敗|不通过|不通過/iu.test(entry);
  });
  return [...new Set([...failedRecordedTests, ...(outcome.details.command_failures ?? [])])];
}

function reviewProblemScope(normalized: string): string {
  const lines = normalized.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    /^(?:[-#>\s]*)(?:问题与理由|問題與理由|issues?\s+(?:and|&)\s+reasons?)\s*(?:(?:[:：])(?:\s*.*)?)?$/iu.test(line.trim()),
  );
  if (start < 0) {
    return normalized;
  }
  const relativeEnd = lines.slice(start + 1).findIndex((line) =>
    /^(?:[-#>\s]*)(?:剩余风险|剩餘風險|(?:remaining|residual)\s+risks?)\s*(?:(?:[:：])(?:\s*.*)?)?$/iu.test(line.trim()),
  );
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function reportsAcceptanceFailure(result: string, reviewSectionsOnly = false): boolean {
  const normalized = withoutInlineMarkdown(result);
  const scope = reviewSectionsOnly ? reviewProblemScope(normalized) : normalized;
  const labeledFailure = scope.split(/\r?\n/u).some((line) =>
    /^(?:[-#>\s]*)(?:unmet|unsatisfied|failed)\s+(?:acceptance\s+)?criteria\s*[:：-](?!\s*(?:none|n\/a|not\s+applicable|无)(?:\s|[.。]|$))\s*.+/iu.test(
      line.trim(),
    ),
  );
  return labeledFailure || /(?:acceptance|验收|驗收|criteria|判定).{0,100}(?:not\s+met|unsatisfied|failed|failure|未满足|未滿足|不通过|不通過|失败|失敗)/iu.test(
    scope,
  );
}

function reportsRuntimeBlock(result: string, reviewSectionsOnly = false): boolean {
  const normalized = withoutInlineMarkdown(result);
  const lines = normalized.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const scope = reviewSectionsOnly ? reviewProblemScope(normalized) : normalized;
  const scopeLines = scope.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const markerHeading = lines.slice(0, 12).some((line) =>
    /^(?:[-*#>`\s]*)(?:PLAN_REVIEW|DELIVERABLE_REVIEW)\b.*(?:blocked|阻塞|未完成|无法完成|無法完成|incomplete|failed)/iu.test(
      line,
    ),
  );
  const statusHeading = lines.slice(0, 12).some((line) =>
    /^(?:[-*#>`\s]*)(?:status|状态|狀態|result|结果|結果)\s*[:：-].*(?:blocked|阻塞|未完成|无法完成|無法完成|incomplete|failed)/iu.test(
      line,
    ),
  );
  const blockingHeading = lines.some((line) =>
    /^(?:[-#>\s]*)(?:blocking\s+error|blocker|阻塞错误|阻塞原因)\s*[:：-](?!\s*(?:none|n\/a|not\s+applicable|无)(?:\s|[.。]|$))\s*.+/iu.test(
      line,
    ),
  );
  const readOnlyRuntime =
    scopeLines.some((line) =>
      /^(?:[-*#>`\s]*)(?:(?:the|this|current)\s+)?(?:workspace|working\s+directory|repository|sandbox|工作区|工作區)(?:\s*(?:status\s*)?[:：=]\s*|.{0,40}(?:\bis\b|\bwas\b|\bremains?\b|为|為|是).{0,20})(?:read[- ]only|not\s+writable|write[- ]protected|只读|只讀|不可写|不可寫)/iu.test(
        line,
      ),
    );
  const runtimeError =
    /\b(?:permission\s+denied|refresh_token_reused|token_expired|oauth(?:entication)?\s+(?:required|failed)|authentication\s+failed)\b/iu.test(
      scope,
    )
    || /(?:sandbox|exec(?:ution)?\s+policy|执行策略|執行策略).{0,60}(?:denied|blocked|rejected|拒绝|拒絕|失败|失敗)/iu.test(scope)
    || readOnlyRuntime
    || /(?:blocked|rejected|denied).{0,40}(?:by|under)\s+(?:the\s+)?(?:policy|sandbox|permissions?)/iu.test(scope);
  return markerHeading || statusHeading || blockingHeading || runtimeError;
}

function missingReviewSections(result: string): string[] {
  const normalized = withoutInlineMarkdown(result);
  const sections: ReadonlyArray<readonly [string, RegExp]> = [
    ["已确认事项", /^\s*(?:[-#>\s]*)(?:已确认事项|已確認事項|confirmed\s+(?:items|facts))\s*(?:(?:[:：])(?:\s*.*)?)?$/imu],
    ["问题与理由", /^\s*(?:[-#>\s]*)(?:问题与理由|問題與理由|issues?\s+(?:and|&)\s+reasons?)\s*(?:(?:[:：])(?:\s*.*)?)?$/imu],
    ["必须修改", /^\s*(?:[-#>\s]*)(?:必须修改|必須修改|required\s+(?:changes?|revisions?))\s*(?:(?:[:：])(?:\s*.*)?)?$/imu],
    ["剩余风险", /^\s*(?:[-#>\s]*)(?:剩余风险|剩餘風險|(?:remaining|residual)\s+risks?)\s*(?:(?:[:：])(?:\s*.*)?)?$/imu],
  ];
  return sections.filter(([, pattern]) => !pattern.test(normalized)).map(([name]) => name);
}

export function validateReviewRepairOutcome(
  request: BridgeRequest,
  outcome: HeadlessOutcome,
): ReviewContractIssue | undefined {
  return validatePeerOutcome(request, outcome);
}

export function validatePeerOutcome(
  request: BridgeRequest,
  outcome: HeadlessOutcome,
): ReviewContractIssue | undefined {
  const result = outcome.result?.trim() ?? "";
  const parsed = conclusionFrom(result);
  const permissionDenialCount = outcome.details.permission_denials?.length ?? 0;
  const missingTestCommands = outcome.details.missing_test_commands ?? [];
  if (request.operation === "task") {
    const baseDetails = result === "" ? {} : { response_excerpt: excerpt(result) };
    if (
      permissionDenialCount > 0
      || missingTestCommands.length > 0
      || reportsRuntimeBlock(result)
      || reportsAcceptanceFailure(result)
      || parsed.value === "blocked"
    ) {
      return {
        code: "task_blocked",
        message: "Peer reported a blocked, incomplete, or unmet task operation.",
        details: {
          ...baseDetails,
          ...(permissionDenialCount === 0
            ? {}
            : { permission_denial_count: permissionDenialCount }),
          ...(missingTestCommands.length === 0 ? {} : { missing_tests: missingTestCommands }),
          ...(parsed.raw === undefined ? {} : { conclusion: parsed.raw }),
        },
      };
    }
    const failed = failedTests(outcome);
    if (failed.length > 0) {
      return {
        code: "acceptance_not_met",
        message: "Peer reported success although tests or acceptance criteria were not met.",
        details: {
          ...baseDetails,
          conclusion: parsed.raw ?? "pass",
          ...(failed.length === 0 ? {} : { failed_tests: failed }),
        },
      };
    }
    return undefined;
  }
  if (request.operation !== "review_repair") {
    return undefined;
  }

  const marker = requiredMarker(request);
  const baseDetails = {
    required_marker: marker,
    ...(result === "" ? {} : { response_excerpt: excerpt(result) }),
  };
  if (permissionDenialCount > 0) {
    return {
      code: "review_blocked",
      message: "Peer review encountered one or more denied tool operations.",
      details: {
        ...baseDetails,
        permission_denial_count: permissionDenialCount,
        ...(parsed.raw === undefined ? {} : { conclusion: parsed.raw }),
      },
    };
  }
  if (missingTestCommands.length > 0) {
    return {
      code: "review_blocked",
      message: "Peer review did not execute every required test command.",
      details: {
        ...baseDetails,
        missing_tests: missingTestCommands,
        ...(parsed.raw === undefined ? {} : { conclusion: parsed.raw }),
      },
    };
  }
  if (!new RegExp(`\\b${marker}\\b`, "u").test(result)) {
    return {
      code: "missing_review_marker",
      message: `review_repair result must contain ${marker}.`,
      details: baseDetails,
    };
  }

  if (reportsRuntimeBlock(result, true) || parsed.value === "blocked") {
    return {
      code: "review_blocked",
      message: "Peer reported a blocked or incomplete review_repair operation.",
      details: {
        ...baseDetails,
        ...(parsed.raw === undefined ? {} : { conclusion: parsed.raw }),
      },
    };
  }
  if (parsed.raw === undefined) {
    return {
      code: "missing_review_conclusion",
      message: `review_repair result must include a ${marker} conclusion.`,
      details: baseDetails,
    };
  }
  if (parsed.value === undefined) {
    return {
      code: "invalid_review_conclusion",
      message: `review_repair result has an unsupported ${marker} conclusion.`,
      details: { ...baseDetails, conclusion: parsed.raw },
    };
  }

  const missingSections = missingReviewSections(result);
  if (missingSections.length > 0) {
    return {
      code: "missing_review_sections",
      message: `${marker} is missing one or more required sections.`,
      details: {
        ...baseDetails,
        conclusion: parsed.raw,
        missing_sections: missingSections,
      },
    };
  }

  const failed = failedTests(outcome);
  if (parsed.value === "pass" && (failed.length > 0 || reportsAcceptanceFailure(result, true))) {
    return {
      code: "acceptance_not_met",
      message: "Peer reported success although tests or acceptance criteria were not met.",
      details: {
        ...baseDetails,
        conclusion: parsed.raw,
        ...(failed.length === 0 ? {} : { failed_tests: failed }),
      },
    };
  }
  return undefined;
}

export function peerReviewFailureReport(
  jobId: string,
  request: BridgeRequest,
  outcome: HeadlessOutcome,
  issue: ReviewContractIssue,
): string {
  const direction = request.target === "claude"
    ? `Codex -> Claude (${request.model ?? "unavailable"})`
    : `Claude -> Codex (${request.model ?? "unavailable"})`;
  const phase = request.operation === "task"
    ? "对方执行"
    : request.artifact_type === "plan"
      ? "计划复核"
      : "交付物复核";
  const model = outcome.details.requested_model ?? "unavailable";
  const reported = outcome.details.reported_model ?? "unavailable";
  const peerRole = request.operation === "task" ? "对方" : "审查者";
  return [
    "PEER_REVIEW_FAILURE_REPORT",
    `方向：${direction}`,
    `阶段：${phase}`,
    `jobId：${jobId}`,
    `请求模型：${model}`,
    `实际模型：${reported}`,
    "decisiveError：peer_contract_error",
    `原因：${issue.code}; ${issue.message}`,
    `已完成：已接收并保留${peerRole}终态及受保护适配器证据。`,
    `未完成：未接受该结果，未同步任何${peerRole}变更回作者主项目。`,
    `恢复条件：修正${peerRole}输出或执行环境后，以明确的 job/artifact 请求重新提交；本结果不代表通过。`,
  ].join("\n");
}
