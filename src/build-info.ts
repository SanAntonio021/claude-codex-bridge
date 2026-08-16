import { readFileSync } from "node:fs";

export interface BuildManifest {
  version: string;
  build_id: string;
  protocol_version: number;
  source_sha256: string;
  lockfile_sha256: string;
}

const manifestUrl = new URL("../build-manifest.json", import.meta.url);
const value = JSON.parse(readFileSync(manifestUrl, "utf8")) as Partial<BuildManifest>;

if (
  typeof value.version !== "string"
  || !/^[0-9a-f]{64}$/u.test(value.build_id ?? "")
  || !Number.isInteger(value.protocol_version)
  || !/^[0-9a-f]{64}$/u.test(value.source_sha256 ?? "")
  || !/^[0-9a-f]{64}$/u.test(value.lockfile_sha256 ?? "")
) {
  throw new Error("Bridge build manifest is missing or invalid.");
}

export const BUILD_MANIFEST = Object.freeze(value as BuildManifest);
