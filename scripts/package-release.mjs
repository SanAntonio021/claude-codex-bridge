import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(projectRoot, "artifacts");
const skipBuild = process.argv.includes("--skip-build");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (code !== 0) {
    throw new Error(`${command} exited with code ${String(code)}.`);
  }
}

async function copyIfPresent(relativePath, destination) {
  const source = join(projectRoot, relativePath);
  try {
    await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await cp(source, join(destination, relativePath), { recursive: true, force: true });
}

await mkdir(artifactRoot, { recursive: true });
if (!skipBuild) {
  await run(process.execPath, [join(projectRoot, "scripts", "build.mjs")]);
}
await run(process.execPath, [join(projectRoot, "scripts", "generate-sbom.mjs")]);

const [packageText, lockfile, buildText, sbomText] = await Promise.all([
  readFile(join(projectRoot, "package.json"), "utf8"),
  readFile(join(projectRoot, "package-lock.json")),
  readFile(join(projectRoot, "dist", "build-manifest.json"), "utf8"),
  readFile(join(artifactRoot, "sbom.cdx.json"), "utf8"),
]);
const packageJson = JSON.parse(packageText);
const build = JSON.parse(buildText);
if (packageJson.version !== build.version || !/^[0-9a-f]{64}$/u.test(build.build_id ?? "")) {
  throw new Error("Package metadata and build manifest do not match.");
}
const releaseName = `${packageJson.name}-${packageJson.version}-windows-x64`;
const staging = join(artifactRoot, `.${releaseName}-${process.pid}`);
const archive = join(artifactRoot, `${releaseName}.zip`);
const releaseManifest = join(artifactRoot, `${releaseName}.manifest.json`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  const files = [
    ".github",
    "dist",
    "plugins",
    "schemas",
    "scripts",
    "src",
    "test",
    ".gitignore",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
  ];
  await Promise.all(files.map(async (path) => copyIfPresent(path, staging)));
  const provenance = {
    schema_version: 1,
    package: packageJson.name,
    version: packageJson.version,
    build_id: build.build_id,
    protocol_version: build.protocol_version,
    source_sha256: build.source_sha256,
    lockfile_sha256: sha256(lockfile),
    sbom_sha256: sha256(sbomText),
    generated_at: process.env.SOURCE_DATE_EPOCH === undefined
      ? new Date().toISOString()
      : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString(),
  };
  await Promise.all([
    writeFile(join(staging, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8"),
    writeFile(join(staging, "sbom.cdx.json"), sbomText, "utf8"),
  ]);
  await rm(archive, { force: true });
  if (process.platform !== "win32") {
    throw new Error("Release ZIP generation is supported by this Windows preview only.");
  }
  await run("tar.exe", ["-a", "-c", "-f", archive, "-C", staging, "."]);
  const archiveHash = sha256(await readFile(archive));
  const manifest = {
    schema_version: 1,
    archive: basename(archive),
    archive_sha256: archiveHash,
    version: packageJson.version,
    build_id: build.build_id,
    provenance_sha256: sha256(JSON.stringify(provenance, null, 2) + "\n"),
  };
  await writeFile(releaseManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(artifactRoot, "checksums.sha256"),
    `${archiveHash}  ${basename(archive)}\n${sha256(await readFile(releaseManifest))}  ${basename(releaseManifest)}\n`,
    "utf8",
  );
  process.stdout.write(`${archive}\n${releaseManifest}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
