import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(projectRoot, ".bridge-runtime");
const suffix = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
const staging = join(runtimeRoot, `build-${suffix}`);
const stale = join(runtimeRoot, `dist-stale-${suffix}`);
const requestedOutput = process.env.BRIDGE_BUILD_OUTPUT?.trim();
const output = requestedOutput === undefined || requestedOutput === ""
  ? join(projectRoot, "dist")
  : resolve(projectRoot, requestedOutput);
const compiler = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const protocolVersion = 2;

function assertProjectChild(path) {
  const child = relative(projectRoot, path);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Refusing build path outside project: ${path}`);
  }
}

for (const path of [runtimeRoot, staging, stale, output, compiler]) {
  assertProjectChild(path);
}

async function runCompiler() {
  const child = spawn(
    process.execPath,
    [compiler, "-p", join(projectRoot, "tsconfig.json"), "--outDir", staging],
    {
      cwd: projectRoot,
      windowsHide: true,
      shell: false,
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (code !== 0) {
    throw new Error(`TypeScript compiler exited with code ${String(code)}.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function createBuildManifest() {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const lockfile = await readFile(join(projectRoot, "package-lock.json"));
  const source = createHash("sha256");
  for (const path of await sourceFiles(join(projectRoot, "src"))) {
    const relativePath = relative(projectRoot, path).replaceAll("\\", "/");
    const content = await readFile(path);
    source.update(`${relativePath}\0${content.length}\0`);
    source.update(content);
    source.update("\0");
  }
  const sourceSha256 = source.digest("hex");
  const lockfileSha256 = sha256(lockfile);
  const identity = JSON.stringify({
    version: packageJson.version,
    protocol_version: protocolVersion,
    source_sha256: sourceSha256,
    lockfile_sha256: lockfileSha256,
  });
  return {
    version: packageJson.version,
    build_id: sha256(identity),
    protocol_version: protocolVersion,
    source_sha256: sourceSha256,
    lockfile_sha256: lockfileSha256,
  };
}

async function removeGenerated(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 7) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
    }
  }
}

async function renameGenerated(from, to, allowMissing = false) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      await rename(from, to);
      return true;
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") {
        return false;
      }
      if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code) || attempt === 15) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(2_000, 200 * (attempt + 1))),
      );
    }
  }
  return false;
}

await mkdir(runtimeRoot, { recursive: true });
try {
  const buildManifest = await createBuildManifest();
  await runCompiler();
  await writeFile(
    join(staging, "build-manifest.json"),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
    "utf8",
  );
  const oldMoved = await renameGenerated(output, stale, true);
  try {
    await renameGenerated(staging, output);
  } catch (error) {
    if (oldMoved) {
      await renameGenerated(stale, output).catch(() => undefined);
    }
    throw error;
  }
  if (oldMoved) {
    await removeGenerated(stale);
  }
} catch (error) {
  await removeGenerated(staging);
  throw error;
}
