import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedOutput = process.argv.slice(2).find((value) => value.startsWith("--output="));
const output = resolve(
  projectRoot,
  requestedOutput === undefined ? "artifacts/sbom.cdx.json" : requestedOutput.slice("--output=".length),
);
if (!output.startsWith(`${projectRoot}\\`) && !output.startsWith(`${projectRoot}/`)) {
  throw new Error("SBOM output must remain within the project root.");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function componentName(path, value) {
  if (typeof value.name === "string" && value.name !== "") {
    return value.name;
  }
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index < 0 ? path : path.slice(index + marker.length);
}

const [packageText, lockText] = await Promise.all([
  readFile(join(projectRoot, "package.json"), "utf8"),
  readFile(join(projectRoot, "package-lock.json"), "utf8"),
]);
const packageJson = JSON.parse(packageText);
const lock = JSON.parse(lockText);
const components = Object.entries(lock.packages ?? {})
  .filter(([path, value]) => path !== "" && value !== null && typeof value === "object")
  .map(([path, value]) => ({
    type: "library",
    name: componentName(path, value),
    version: typeof value.version === "string" ? value.version : "unknown",
    properties: [
      { name: "cdx:npm:path", value: path },
      { name: "cdx:npm:dev", value: value.dev === true ? "true" : "false" },
    ],
  }))
  .sort((left, right) => left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en"));
const generatedAt = process.env.SOURCE_DATE_EPOCH === undefined
  ? new Date().toISOString()
  : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString();
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      type: "application",
      name: packageJson.name,
      version: packageJson.version,
      hashes: [{ alg: "SHA-256", content: sha256(lockText) }],
    },
    properties: [{ name: "bridge:lockfile_sha256", value: sha256(lockText) }],
  },
  components,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
