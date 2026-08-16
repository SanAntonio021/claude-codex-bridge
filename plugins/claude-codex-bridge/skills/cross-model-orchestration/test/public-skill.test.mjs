import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const skillRoot = dirname(root);
const pluginRoot = dirname(dirname(skillRoot));

test("public skill preserves the protocol-v2 review contract without local-machine references", async () => {
  const files = [
    join(skillRoot, "SKILL.md"),
    join(skillRoot, "references", "workflow-contract.md"),
    join(skillRoot, "references", "model-routing.md"),
    join(skillRoot, "evals", "trigger-evals.json"),
  ];
  const text = (await Promise.all(files.map(async (path) => readFile(path, "utf8")))).join("\n");
  assert.match(text, /review_peer/u);
  assert.match(text, /review_repair_peer/u);
  assert.match(text, /artifactContent/u);
  assert.match(text, /artifactMode/u);
  assert.match(text, /\/mcp\/codex/u);
  assert.match(text, /\/mcp\/claude/u);
  assert.match(text, /zero-tool/u);
  assert.match(text, /inlineReviews/u);
  assert.match(text, /workspaceRepairs/u);
  assert.match(text, /v2_workspace_capability_unavailable/u);
  assert.match(text, /seriesVersion/u);
  assert.match(text, /三轮|three-round|three rounds|round four/iu);
  assert.doesNotMatch(text, /[A-Za-z]:\\(?:Users|BaiduSyncdisk)\\/u);
});

test("public plugin declares independently authenticated protocol-v2 role endpoints", async () => {
  const value = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
  const servers = value.mcpServers ?? {};
  assert.equal(servers["claude-codex-bridge-codex"]?.url, "http://127.0.0.1:43123/mcp/codex");
  assert.equal(
    servers["claude-codex-bridge-codex"]?.headers?.["X-Bridge-Token"],
    "${CLAUDE_CODEX_BRIDGE_CODEX_TOKEN}",
  );
  assert.equal(servers["claude-codex-bridge-claude"]?.url, "http://127.0.0.1:43123/mcp/claude");
  assert.equal(
    servers["claude-codex-bridge-claude"]?.headers?.["X-Bridge-Token"],
    "${CLAUDE_CODEX_BRIDGE_CLAUDE_TOKEN}",
  );
});
