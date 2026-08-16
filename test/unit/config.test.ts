import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  applyConfigMutation,
  bridgeConfigHash,
  defaultBridgeConfig,
  ensureBridgeConfig,
  mutateBridgeConfig,
  readBridgeConfig,
} from "../../src/config.js";
import { BridgeError } from "../../src/errors.js";
import { resolveModelRoute, validateResolvedModelRoute } from "../../src/model-routing.js";
import { temporaryPaths } from "../helpers.js";

process.env.BRIDGE_SKIP_ACL = "1";

test("config uses a canonical hash and permits an explicitly configured future model", async () => {
  const paths = await temporaryPaths("bridge-config-");
  try {
    const first = await ensureBridgeConfig(paths);
    const again = await readBridgeConfig(paths);
    assert.equal(first.hash, again.hash);
    assert.equal(first.config.schemaVersion, 1);
    assert.match(first.hash, /^[0-9a-f]{64}$/u);

    const updated = await mutateBridgeConfig(paths, {
      action: "allow-model",
      model: "claude-future-1",
      target: "claude",
      efforts: ["high", "max"],
    });
    const profile = await mutateBridgeConfig(paths, {
      action: "set-profile",
      profile: "quality",
      target: "claude",
      model: "claude-future-1",
      reasoningEffort: "max",
      ruleId: "test-future-route-v1",
    });
    const route = resolveModelRoute({ target: "claude" }, profile.config);
    assert.equal(route.model, "claude-future-1");
    assert.equal(route.reasoningEffort, "max");
    assert.notEqual(updated.hash, profile.hash);
    assert.doesNotMatch(await readFile(paths.config, "utf8"), /token|C:\\Users|LOCALAPPDATA/iu);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("config mutations preserve profile integrity and revoked routes fail closed", () => {
  const config = defaultBridgeConfig();
  assert.throws(
    () => applyConfigMutation(config, { action: "remove-model", model: "claude-opus-5" }),
    (error: unknown) => error instanceof BridgeError && error.code === "model_in_use_by_profile",
  );
  const route = resolveModelRoute({ target: "claude" }, config);
  const modified = JSON.parse(JSON.stringify(config)) as typeof config;
  for (const profile of Object.values(modified.profiles)) {
    profile.claude.model = "claude-opus-4-6";
  }
  delete modified.models[route.model];
  assert.throws(
    () => validateResolvedModelRoute(route, modified),
    (error: unknown) => error instanceof BridgeError && error.code === "model_route_revoked",
  );
  assert.equal(bridgeConfigHash(config), bridgeConfigHash(JSON.parse(JSON.stringify(config))));
});

test("invalid config never silently falls back to built-in routing", async () => {
  const paths = await temporaryPaths("bridge-config-invalid-");
  try {
    await ensureBridgeConfig(paths);
    await writeFile(paths.config, "{not-json", "utf8");
    await assert.rejects(
      readBridgeConfig(paths),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_config",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
