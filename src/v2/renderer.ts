import { sha256 } from "../hash.js";
import { BridgeError } from "../errors.js";
import type { V2GateResult } from "./gate.js";
import type {
  V2EvidenceReference,
  V2EvidenceRequest,
  V2FinalReview,
  V2ModelResponse,
  V2ReviewRequest,
} from "./types.js";
import { normalizeV2RelativePath } from "./types.js";

export interface V2EvidenceSource {
  path: string;
  content: string;
}

export interface V2RenderedFinding {
  id: string;
  summary: string;
  rationale: string;
  evidence: V2EvidenceReference[];
}

export interface V2RenderedReview {
  marker: "PLAN_REVIEW" | "DELIVERABLE_REVIEW";
  renderedReview: string;
  findings: V2RenderedFinding[];
}

function sourceKey(path: string): string {
  return normalizeV2RelativePath(path, "evidence path").toLocaleLowerCase("en-US");
}

function sourceFor(
  reference: V2EvidenceReference,
  sources: readonly V2EvidenceSource[],
): V2EvidenceSource {
  if (sources.length === 0) {
    throw new BridgeError("evidence_unavailable", "No bridge-controlled evidence source is available.", {
      httpStatus: 409,
    });
  }
  if (reference.path === undefined) {
    if (sources.length !== 1) {
      throw new BridgeError("evidence_path_required", "Evidence must name its source path when multiple files exist.", {
        httpStatus: 409,
      });
    }
    return sources[0]!;
  }
  const key = sourceKey(reference.path);
  const source = sources.find((candidate) => sourceKey(candidate.path) === key);
  if (source === undefined) {
    throw new BridgeError("evidence_path_invalid", "Evidence cited a path outside the controlled review material.", {
      httpStatus: 409,
      details: { path: reference.path },
    });
  }
  return source;
}

function validateReference(reference: V2EvidenceReference, sources: readonly V2EvidenceSource[]): void {
  const source = sourceFor(reference, sources);
  const lines = source.content.split(/\r?\n/u);
  if (reference.startLine !== undefined || reference.endLine !== undefined) {
    if (reference.startLine === undefined || reference.endLine === undefined || reference.endLine < reference.startLine) {
      throw new BridgeError("evidence_range_invalid", "Evidence line ranges must have an ordered startLine and endLine.", {
        httpStatus: 409,
      });
    }
    if (reference.endLine > lines.length) {
      throw new BridgeError("evidence_range_invalid", "Evidence line range exceeds the cited source.", {
        httpStatus: 409,
        details: { path: source.path, line_count: lines.length },
      });
    }
    if (reference.quote !== undefined) {
      const selected = lines.slice(reference.startLine - 1, reference.endLine).join("\n");
      if (!selected.includes(reference.quote)) {
        throw new BridgeError("evidence_quote_mismatch", "Evidence quote is not present in its cited line range.", {
          httpStatus: 409,
          details: { path: source.path },
        });
      }
    }
    return;
  }
  if (reference.quote === undefined || !source.content.includes(reference.quote)) {
    throw new BridgeError("evidence_unverifiable", "Evidence must contain a valid line range or an exact source quote.", {
      httpStatus: 409,
      details: { path: source.path },
    });
  }
}

export function validateV2Evidence(
  response: V2ModelResponse,
  sources: readonly V2EvidenceSource[],
): void {
  if (response.kind === "evidence_request") {
    for (const request of response.requests) {
      for (const reference of request.references) {
        validateReference(reference, sources);
      }
    }
    return;
  }
  for (const finding of response.findings) {
    for (const reference of finding.evidence) {
      validateReference(reference, sources);
    }
  }
}

function findingId(review: V2FinalReview, index: number): string {
  const finding = review.findings[index]!;
  return `F-${sha256(JSON.stringify({ index, finding })).slice(0, 12).toUpperCase()}`;
}

function bulletLines(values: readonly string[], fallback: string): string[] {
  return values.length === 0 ? [`- ${fallback}`] : values.map((value) => `- ${value}`);
}

function evidenceLabel(reference: V2EvidenceReference): string {
  const path = reference.path === undefined ? "当前产物" : normalizeV2RelativePath(reference.path, "evidence path");
  if (reference.startLine !== undefined && reference.endLine !== undefined) {
    return `${path}:${String(reference.startLine)}-${String(reference.endLine)}`;
  }
  return `${path}:引文`;
}

function conclusion(gate: V2GateResult): "通过" | "需修改" | "实质分歧" {
  if (gate.verdict === "pass") {
    return "通过";
  }
  return gate.verdict === "disagreement" ? "实质分歧" : "需修改";
}

export function renderV2Review(
  request: V2ReviewRequest,
  review: V2FinalReview,
  gate: V2GateResult,
): V2RenderedReview {
  const marker = request.artifactType === "plan" ? "PLAN_REVIEW" : "DELIVERABLE_REVIEW";
  const findings = review.findings.map((finding, index) => ({
    id: findingId(review, index),
    summary: finding.summary,
    rationale: finding.rationale,
    evidence: finding.evidence,
  }));
  const problems = findings.length === 0
    ? ["- 无。"]
    : findings.map((finding) =>
      `- [${finding.id}] ${finding.summary}；${finding.rationale}；证据：${finding.evidence.map(evidenceLabel).join(", ")}`,
    );
  const requiredChanges = [
    ...review.requiredChanges,
    ...(gate.reason === "test_failure" ? ["修复失败的受控测试后重新提交本轮产物。"] : []),
    ...(gate.reason === "artifact_delta" ? ["作者必须检查本轮返回或同步的修订正文后再提交下一轮。"] : []),
  ];
  const risks = [
    ...review.risks,
    ...(gate.verdict === "failed" ? ["协议或运行环境失败，结果不构成审查结论。"] : []),
  ];
  const renderedReview = [
    marker,
    `结论：${conclusion(gate)}`,
    "已确认事项：",
    ...bulletLines(review.confirmed, "无。"),
    "问题与理由：",
    ...problems,
    "必须修改：",
    ...bulletLines(requiredChanges, "无。"),
    "剩余风险：",
    ...bulletLines(risks, "无。"),
  ].join("\n");
  return { marker, renderedReview, findings };
}

/** Render an evidence request without treating it as a model verdict. */
export function renderV2EvidenceRequest(
  request: V2ReviewRequest,
  response: V2EvidenceRequest,
): V2RenderedReview {
  const marker = request.artifactType === "plan" ? "PLAN_REVIEW" : "DELIVERABLE_REVIEW";
  const problems = response.requests.map((item) => {
    const evidence = item.references.length === 0
      ? "当前受控材料中未给出可核验引用"
      : item.references.map(evidenceLabel).join(", ");
    return `- 需要补充证据：${item.question}；现有引用：${evidence}`;
  });
  const renderedReview = [
    marker,
    "结论：需修改",
    "已确认事项：",
    "- 审查者未在证据不足时作出通过结论。",
    "问题与理由：",
    ...problems,
    "必须修改：",
    ...response.requests.map((item) => `- 提供或澄清：${item.question}`),
    "剩余风险：",
    "- 本轮处于补充证据状态，尚未形成最终审查结论。",
  ].join("\n");
  return { marker, renderedReview, findings: [] };
}
