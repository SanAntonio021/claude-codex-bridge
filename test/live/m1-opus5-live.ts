import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitJob, waitJob } from "../../src/api.js";
import { REQUIRED_CLAUDE_MODEL } from "../../src/adapter/claude.js";
import { getDaemonPaths, type DaemonPaths } from "../../src/config.js";
import { BridgeDaemon } from "../../src/daemon/server.js";
import { sha256 } from "../../src/hash.js";
import { createBridgeRequest } from "../../src/request.js";
import type { PublicJobResult } from "../../src/types.js";

async function waitComplete(paths: DaemonPaths, jobId: string): Promise<PublicJobResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waited = await waitJob(jobId, 45_000, paths);
    if (waited.status === "complete" && waited.job !== undefined) {
      return waited.job;
    }
  }
  throw new Error(`Opus 5 review job ${jobId} remained pending after 180 seconds.`);
}

interface ProtectedJobDetails {
  adapter_details?: {
    reported_model?: string;
    requested_model?: string;
    requested_reasoning_effort?: string;
    task_profile?: string;
    routing_source?: string;
    workspace_path?: string;
    baseline_manifest_hash?: string;
    result_manifest_hash?: string;
  };
}

async function run(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The Opus 5 live acceptance test requires Windows M1 process-tree semantics.");
  }

  const liveBase = join(process.env.LOCALAPPDATA ?? tmpdir(), "claude-codex-bridge", "live-tests");
  await mkdir(liveBase, { recursive: true });
  const root = await mkdtemp(join(liveBase, "opus5-review-"));
  const paths = getDaemonPaths(root);
  const daemon = new BridgeDaemon({ paths });
  const targetRoot = join(root, "project");
  const artifactPath = join(targetRoot, "artifact.md");
  const initialArtifact = [
    "# Live review fixture",
    "",
    "status: draft",
    "",
    "The fixture is intentionally small and disposable.",
    "",
  ].join("\n");

  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(artifactPath, initialArtifact, "utf8");
    await daemon.start();
    const artifactBytes = Buffer.byteLength(initialArtifact, "utf8");
    const artifactSha256 = sha256(initialArtifact);
    const submitted = await submitJob(
      createBridgeRequest(
        {
          question:
            "Review and repair the supplied miniature deliverable in the isolated workspace. Make the required edit, run the stated verification command, then return a concise DELIVERABLE_REVIEW. The acceptance test requires the file to contain exactly `status: reviewed` instead of `status: draft`; do not modify any other file.",
          context: [
            "artifactId: opus5-live-acceptance",
            "artifactType: deliverable",
            "artifactName: artifact.md",
            "acceptanceCriteria: change only the status line from draft to reviewed; verify the resulting file contains status: reviewed; report changed files and test output.",
            `artifactBytes: ${String(artifactBytes)}`,
            `artifactSha256: ${artifactSha256}`,
            "artifactContent:",
            initialArtifact,
          ].join("\n"),
          operation: "review_repair",
          artifactId: "opus5-live-acceptance",
          artifactType: "deliverable",
          author: "Codex",
          reviewer: "Claude Opus 5",
          artifactName: "artifact.md",
          artifactPath: "artifact.md",
          artifactBytes,
          artifactSha256,
          artifactContent: initialArtifact,
          targetRoot,
          allowedPaths: ["artifact.md"],
          round: 1,
          maxRounds: 3,
          acceptanceCriteria: [
            "Change only artifact.md status from draft to reviewed.",
            "Verify the resulting file contains status: reviewed.",
            "Return a DELIVERABLE_REVIEW with changed files and tests.",
          ],
          testCommands: ["findstr reviewed artifact.md"],
          priorRounds: [],
          priorFindings: [],
          openItems: [],
          constraints: [
            "Work only in the bridge-owned fixed workspace.",
            "Do not modify files outside artifact.md or use a fallback model.",
          ],
          route: "headless",
        },
        { origin: "opus5-live-acceptance", target: "claude" },
      ),
      paths,
    );
    const result = await waitComplete(paths, submitted.job_id);
    assert.equal(result.state, "succeeded", JSON.stringify(result.error));
    assert.ok((result.result ?? "").trim().length > 0, "Opus 5 returned an empty review.");
    assert.equal(result.review_model, REQUIRED_CLAUDE_MODEL);
    assert.equal(result.requested_model, REQUIRED_CLAUDE_MODEL);
    assert.equal(result.requested_reasoning_effort, "max");
    assert.equal(result.task_profile, "quality");
    assert.equal(result.routing_source, "default");
    assert.equal(result.sync_status, "synced");
    assert.ok(result.changed_files?.includes("artifact.md"), "artifact.md was not synchronized.");

    const mainArtifact = await readFile(artifactPath, "utf8");
    assert.match(mainArtifact, /^status: reviewed$/mu);
    assert.doesNotMatch(mainArtifact, /^status: draft$/mu);

    const protectedDetails = JSON.parse(
      await readFile(join(paths.jobs, `${submitted.job_id}.json`), "utf8"),
    ) as ProtectedJobDetails;
    assert.equal(protectedDetails.adapter_details?.reported_model, REQUIRED_CLAUDE_MODEL);
    assert.equal(protectedDetails.adapter_details?.requested_model, REQUIRED_CLAUDE_MODEL);
    assert.equal(protectedDetails.adapter_details?.requested_reasoning_effort, "max");
    assert.equal(protectedDetails.adapter_details?.task_profile, "quality");
    assert.equal(protectedDetails.adapter_details?.routing_source, "default");
    assert.equal(typeof protectedDetails.adapter_details?.workspace_path, "string");
    assert.equal(typeof protectedDetails.adapter_details?.baseline_manifest_hash, "string");
    assert.equal(typeof protectedDetails.adapter_details?.result_manifest_hash, "string");
    const workspaceArtifact = await readFile(
      join(protectedDetails.adapter_details?.workspace_path as string, "artifact.md"),
      "utf8",
    );
    assert.equal(sha256(workspaceArtifact), sha256(mainArtifact));

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        suite: "Opus 5 isolated review_repair",
        request_model: REQUIRED_CLAUDE_MODEL,
        requested_reasoning_effort: result.requested_reasoning_effort,
        reported_model: result.review_model,
        sync_status: result.sync_status,
        changed_files: result.changed_files,
        main_sha256: sha256(mainArtifact),
        workspace_sha256: sha256(workspaceArtifact),
      })}\n`,
    );
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
