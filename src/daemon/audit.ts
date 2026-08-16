import { readFile } from "node:fs/promises";
import { appendFlushedLine, atomicWriteFile } from "./atomic.js";
import { sha256 } from "../hash.js";
import { LIMITS } from "../constants.js";
import type { JobRecord, PermissionDenial } from "../types.js";

export interface PermissionDenialSummary {
  tool_name: string | null;
  tool_use_id: string | null;
  at: string;
  tool_input_sha256: string;
  tool_input_length: number;
}

export interface AuditEvent {
  at: string;
  event: string;
  job_id?: string;
  request_id?: string;
  idempotency_key_hash?: string;
  origin?: string;
  target?: string;
  route?: string;
  bridge_thread_id_hash?: string;
  request_hash?: string;
  result_hash?: string;
  state?: string;
  error_code?: string;
  permission_denials?: PermissionDenialSummary[];
  metadata?: Record<string, string | number | boolean | null>;
}

function serializeToolInput(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function summarizePermissionDenials(
  denials: PermissionDenial[] | undefined,
  at: string,
): PermissionDenialSummary[] | undefined {
  if (denials === undefined || denials.length === 0) {
    return undefined;
  }
  return denials.map((denial) => {
    const raw = serializeToolInput(denial.tool_input);
    return {
      tool_name: typeof denial.tool_name === "string" ? denial.tool_name : null,
      tool_use_id: typeof denial.tool_use_id === "string" ? denial.tool_use_id : null,
      at,
      tool_input_sha256: sha256(raw),
      tool_input_length: Buffer.byteLength(raw),
    };
  });
}

export class AuditLog {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async append(event: AuditEvent): Promise<void> {
    await appendFlushedLine(this.#path, JSON.stringify(event));
  }

  async prune(retentionMs = LIMITS.auditRetentionMs): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const cutoff = Date.now() - retentionMs;
    const kept = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => {
        try {
          const event = JSON.parse(line) as { at?: string };
          const timestamp = event.at === undefined ? Number.NaN : Date.parse(event.at);
          return !Number.isFinite(timestamp) || timestamp >= cutoff;
        } catch {
          return true;
        }
      });
    await atomicWriteFile(this.#path, kept.length === 0 ? "" : `${kept.join("\n")}\n`, {
      protect: true,
    });
  }

  async jobEvent(
    event: string,
    record: JobRecord,
    metadata?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const at = new Date().toISOString();
    const permissionDenials = summarizePermissionDenials(
      record.adapter_details?.permission_denials,
      at,
    );
    await this.append({
      at,
      event,
      job_id: record.job_id,
      request_id: record.request.request_id,
      idempotency_key_hash: sha256(record.request.idempotency_key),
      origin: record.request.origin,
      target: record.request.target,
      route: record.request.route,
      ...(record.request.bridge_thread_id === undefined
        ? {}
        : { bridge_thread_id_hash: sha256(record.request.bridge_thread_id) }),
      request_hash: record.request_hash,
      ...(record.result_hash === undefined ? {} : { result_hash: record.result_hash }),
      state: record.state,
      ...(record.error === undefined ? {} : { error_code: record.error.code }),
      ...(permissionDenials === undefined ? {} : { permission_denials: permissionDenials }),
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}
