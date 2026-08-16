import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const installer = resolve(process.cwd(), "scripts", "Install-Bridge.ps1");

test("installer keeps protected release leaf files readable by the current user", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-install-script-"));
  const packageRoot = join(root, "package");
  const localAppData = join(root, "local-app-data");
  const buildId = "a".repeat(64);
  try {
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "claude-codex-bridge", version: "0.0.0-test" })}\n`,
      "utf8",
    );
    await writeFile(join(packageRoot, "package-lock.json"), "{}\n", "utf8");
    await writeFile(
      join(packageRoot, "dist", "build-manifest.json"),
      `${JSON.stringify({ version: "0.0.0-test", build_id: buildId })}\n`,
      "utf8",
    );

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-PackageRoot",
        packageRoot,
        "-SkipDependencyInstall",
      ],
      {
        env: { ...process.env, LOCALAPPDATA: localAppData },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const installedManifest = join(
      localAppData,
      "claude-codex-bridge",
      "releases",
      `0.0.0-test-${buildId.slice(0, 16)}`,
      "dist",
      "build-manifest.json",
    );
    assert.equal((await readFile(installedManifest, "utf8")).includes(buildId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
