import { BUILD_MANIFEST } from "./build-info.js";

export const BRIDGE_NAME = "claude-codex-bridge";
export const BRIDGE_VERSION = BUILD_MANIFEST.version;
export const BRIDGE_BUILD_ID = BUILD_MANIFEST.build_id;
export const BRIDGE_PROTOCOL_VERSION = BUILD_MANIFEST.protocol_version;
export const LOOPBACK_HOST = "127.0.0.1";
export const BRIDGE_HTTP_PORT = 43_123;
export const BRIDGE_MCP_PATH = "/mcp";
export const BRIDGE_CODEX_MCP_PATH = "/mcp/codex";
export const BRIDGE_CLAUDE_MCP_PATH = "/mcp/claude";
export const BRIDGE_TOKEN_ENV = "CLAUDE_CODEX_BRIDGE_TOKEN";
export const BRIDGE_CODEX_TOKEN_ENV = "CLAUDE_CODEX_BRIDGE_CODEX_TOKEN";
export const BRIDGE_CLAUDE_TOKEN_ENV = "CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN";
export const BRIDGE_TOKEN_HEADER = "x-bridge-token";
export const BRIDGE_LEGACY_PROTOCOL_VERSION = 1;
export const BRIDGE_SUPPORTED_PROTOCOL_VERSIONS = [BRIDGE_LEGACY_PROTOCOL_VERSION, BRIDGE_PROTOCOL_VERSION] as const;

export const LIMITS = {
  requestBytes: 1024 * 1024,
  activeJobs: 3,
  queuedJobs: 20,
  jobRuntimeMs: 15 * 60 * 1000,
  awaitMs: 45_000,
  stderrBytes: 1024 * 1024,
  streamBytes: 16 * 1024 * 1024,
  workspaceBytes: 5 * 1024 * 1024 * 1024,
  workspaceRetentionMs: 7 * 24 * 60 * 60 * 1000,
  legacySyncApprovalLeaseMs: 24 * 60 * 60 * 1000,
  jobRetentionMs: 30 * 24 * 60 * 60 * 1000,
  tombstoneRetentionMs: 90 * 24 * 60 * 60 * 1000,
  auditRetentionMs: 180 * 24 * 60 * 60 * 1000,
} as const;
