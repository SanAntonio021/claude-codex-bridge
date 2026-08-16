import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function error(reason) {
  return { ok: false, reason };
}

function relativePath(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || value.includes(":")) {
    return `${field} 必须是非空正斜杠相对路径`;
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || part.endsWith(".") || part.endsWith(" "))) {
    return `${field} 含受保护或含糊的路径段`;
  }
  return null;
}

function absoluteRoot(value) {
  return typeof value === "string" && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

function validateIdentity(envelope) {
  if (!Number.isInteger(envelope.artifactBytes) || envelope.artifactBytes < 0) {
    return error("artifactBytes 必须是非负整数");
  }
  if (typeof envelope.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.artifactSha256)) {
    return error("artifactSha256 必须是 64 位小写十六进制字符串");
  }
  if (typeof envelope.artifactContent !== "string" || envelope.artifactContent.length === 0) {
    return error("artifactContent 必须是非空字符串");
  }
  const bytes = Buffer.byteLength(envelope.artifactContent, "utf8");
  const hash = createHash("sha256").update(envelope.artifactContent, "utf8").digest("hex");
  if (envelope.artifactBytes !== bytes) {
    return error(`artifactBytes 与 artifactContent 的 UTF-8 字节数不符（期望 ${bytes}）`);
  }
  if (envelope.artifactSha256 !== hash) {
    return error("artifactSha256 与 artifactContent 的 SHA-256 不符");
  }
  return null;
}

function validateTestCommands(commands) {
  if (!Array.isArray(commands) || commands.length > 16) {
    return error("testCommands 必须是最多 16 项的结构化数组");
  }
  for (const command of commands) {
    if (
      command === null || typeof command !== "object"
      || typeof command.program !== "string"
      || !/^[A-Za-z]:[\\/].+\.exe$/iu.test(command.program)
      || !Number.isInteger(command.programBytes) || command.programBytes <= 0
      || typeof command.programSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(command.programSha256)
      || !Array.isArray(command.args) || command.args.length > 128
      || command.args.some((arg) => typeof arg !== "string" || arg.length > 8192)
      || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 900000
    ) {
      return error("testCommands[] 必须是带 .exe 身份哈希、参数数组和 100..900000ms 超时的结构化命令");
    }
  }
  return null;
}

export function validateProtocolV2Envelope(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return error("交接信封必须是 JSON 对象");
  }
  const required = [
    "tool", "question", "artifactId", "artifactType", "artifactName",
    "artifactBytes", "artifactSha256", "artifactContent", "acceptanceCriteria",
  ];
  for (const key of required) {
    if (!(key in envelope)) return error(`交接信封缺少字段: ${key}`);
  }
  if (!["review_peer", "review_repair_peer"].includes(envelope.tool)) {
    return error("tool 必须是 review_peer 或 review_repair_peer");
  }
  const forbidden = [
    "target", "owner", "operation", "reviewerAccess", "maxRounds", "author", "reviewer", "round",
    "allowedPaths", "priorRounds", "priorFindings", "openItems",
  ];
  for (const key of forbidden) {
    if (key in envelope) return error(`旧字段 ${key} 不属于 protocol-v2 工具输入；角色、操作、轮次和范围由 bridge 固定或校验`);
  }
  for (const key of ["question", "artifactId", "artifactType", "artifactName", "artifactContent"]) {
    if (typeof envelope[key] !== "string" || envelope[key].length === 0) return error(`字段 ${key} 必须是非空字符串`);
  }
  if (!["plan", "deliverable"].includes(envelope.artifactType)) return error("artifactType 必须是 plan 或 deliverable");
  if (!Array.isArray(envelope.acceptanceCriteria) || envelope.acceptanceCriteria.length === 0 || envelope.acceptanceCriteria.some((value) => typeof value !== "string" || value.length === 0)) {
    return error("acceptanceCriteria 至少需要一项字符串");
  }
  if (envelope.constraints !== undefined && (!Array.isArray(envelope.constraints) || envelope.constraints.some((value) => typeof value !== "string"))) {
    return error("constraints 必须是字符串数组");
  }
  if (envelope.artifactPath !== undefined) {
    const pathError = relativePath(envelope.artifactPath, "artifactPath");
    if (pathError) return error(pathError);
  }
  const identityError = validateIdentity(envelope);
  if (identityError) return identityError;

  if (envelope.tool === "review_peer") {
    if ("artifactMode" in envelope || "targetRoot" in envelope || "repairTargets" in envelope || "testCommands" in envelope) {
      return error("review_peer 固定 review_only + inline，不得提供 artifactMode、targetRoot、repairTargets 或 testCommands");
    }
  } else {
    if (!["inline", "workspace"].includes(envelope.artifactMode)) return error("review_repair_peer 必须明确 artifactMode=inline 或 workspace");
    if (envelope.artifactMode === "inline") {
      if ("targetRoot" in envelope || "repairTargets" in envelope || "testCommands" in envelope) {
        return error("inline review_repair_peer 不得提供 targetRoot、repairTargets 或 testCommands");
      }
    } else {
      if (!absoluteRoot(envelope.targetRoot)) return error("workspace review_repair_peer 的 targetRoot 必须是绝对路径");
      if (!Array.isArray(envelope.repairTargets) || envelope.repairTargets.length === 0) return error("workspace review_repair_peer 必须提供非空 repairTargets");
      const seen = new Set();
      for (const target of envelope.repairTargets) {
        if (target === null || typeof target !== "object" || !["modify", "create"].includes(target.action)) return error("repairTargets[] 必须包含 action=modify 或 create");
        const pathError = relativePath(target.path, "repairTargets[].path");
        if (pathError) return error(pathError);
        const folded = target.path.toLocaleLowerCase("en-US");
        if (seen.has(folded)) return error("repairTargets 不得包含大小写冲突的路径");
        seen.add(folded);
      }
      if (envelope.artifactType === "plan" && (typeof envelope.artifactPath !== "string" || envelope.repairTargets.length !== 1 || envelope.repairTargets[0].action !== "modify" || envelope.repairTargets[0].path !== envelope.artifactPath)) {
        return error("plan workspace review 必须只有一个与 artifactPath 相同的 modify repairTarget");
      }
      if (envelope.testCommands !== undefined) {
        const commandError = validateTestCommands(envelope.testCommands);
        if (commandError) return commandError;
      }
    }
  }
  if ((envelope.seriesVersion === undefined) !== (envelope.latestJobId === undefined)) return error("seriesVersion 与 latestJobId 必须成对提供");
  if (envelope.seriesVersion !== undefined && (!Number.isInteger(envelope.seriesVersion) || envelope.seriesVersion < 0)) return error("seriesVersion 必须是非负整数");
  if (envelope.latestJobId !== undefined && (typeof envelope.latestJobId !== "string" || !UUID.test(envelope.latestJobId))) return error("latestJobId 必须是 UUID");
  if (envelope.seriesId !== undefined && (typeof envelope.seriesId !== "string" || envelope.seriesId.length === 0)) return error("seriesId 如提供必须是非空字符串");
  return { ok: true, envelope };
}
