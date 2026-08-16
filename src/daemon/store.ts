import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./atomic.js";
import { AuditLog } from "./audit.js";
import { assertTransition } from "./state-machine.js";
import { BridgeError, type StructuredError } from "../errors.js";
import {
  BRIDGE_BUILD_ID,
  BRIDGE_LEGACY_PROTOCOL_VERSION,
  BRIDGE_VERSION,
} from "../constants.js";
import { sha256, sha256Json } from "../hash.js";
import {
  BridgeRequestSchema,
  HighRiskChangeSchema,
  JOB_STATES,
  isTerminalState,
  type AdapterDetails,
  type BridgeRequest,
  type JobRecord,
  type JobState,
  type WorkspaceManifest,
  SyncStatusSchema,
  SyncAuthorizationSchema,
  type HighRiskChange,
  type SyncAuthorization,
} from "../types.js";

const StructuredErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const JobRecordSchema = z.object({
  job_id: z.uuid(),
  version: z.string().optional(),
  build_id: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  protocol_version: z.number().int().positive().optional(),
  state: z.enum(JOB_STATES),
  request: BridgeRequestSchema,
  request_hash: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  history: z.array(
    z.object({
      state: z.enum(JOB_STATES),
      at: z.string(),
      error_code: z.string().optional(),
    }),
  ),
  result: z.string().optional(),
  result_hash: z.string().optional(),
  error: StructuredErrorSchema.optional(),
  claude_session_id: z.uuid().optional(),
  peer_session_id: z.string().min(1).max(256).optional(),
  context_reset: z.boolean().optional(),
  child_pid: z.number().int().positive().optional(),
  cancellation_requested_at: z.string().optional(),
  adapter_details: z.unknown().optional(),
  direction: z.enum(["codex_to_claude", "claude_to_codex"]).optional(),
  workspace_manifest: z.unknown().optional(),
  result_workspace_manifest: z.unknown().optional(),
  changed_files: z.array(z.string()).optional(),
  test_results: z.array(z.string()).optional(),
  sync_status: SyncStatusSchema.optional(),
  pending_high_risk: z.array(HighRiskChangeSchema).optional(),
  sync_authorization: SyncAuthorizationSchema.optional(),
  workspace_retained_until: z.string().optional(),
  sync_approval_expires_at: z.string().optional(),
});

export interface TransitionPatch {
  error?: StructuredError | null;
  result?: string;
  claude_session_id?: string;
  peer_session_id?: string;
  context_reset?: boolean;
  child_pid?: number;
  cancellation_requested_at?: string;
  adapter_details?: AdapterDetails;
  direction?: "codex_to_claude" | "claude_to_codex";
  workspace_manifest?: WorkspaceManifest;
  result_workspace_manifest?: WorkspaceManifest;
  changed_files?: string[];
  test_results?: string[];
  sync_status?: "not_requested" | "prepared" | "synced" | "awaiting_user" | "conflict" | "failed" | "discarded";
  pending_high_risk?: HighRiskChange[];
  sync_authorization?: SyncAuthorization;
  workspace_retained_until?: string;
  sync_approval_expires_at?: string;
}

export class JobStore {
  readonly #jobsDirectory: string;
  readonly #audit: AuditLog;
  readonly #records = new Map<string, JobRecord>();
  readonly #idempotency = new Map<string, string>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #events = new EventEmitter();
  #createLock: Promise<void> = Promise.resolve();

  constructor(jobsDirectory: string, audit: AuditLog) {
    this.#jobsDirectory = jobsDirectory;
    this.#audit = audit;
    this.#events.setMaxListeners(100);
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#jobsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const path = join(this.#jobsDirectory, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        throw new BridgeError("job_store_corrupt", `Unable to read protected job file ${name}.`, {
          httpStatus: 500,
          cause: error,
        });
      }
      const checked = JobRecordSchema.safeParse(parsed);
      if (!checked.success) {
        throw new BridgeError("job_store_corrupt", `Protected job file ${name} is invalid.`, {
          httpStatus: 500,
        });
      }
      const record = checked.data as JobRecord;
      this.#records.set(record.job_id, record);
      this.#idempotency.set(this.#idempotencyKey(record.request), record.job_id);
    }
  }

  list(): JobRecord[] {
    return [...this.#records.values()].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
  }

  get(jobId: string): JobRecord | undefined {
    return this.#records.get(jobId);
  }

  require(jobId: string): JobRecord {
    const record = this.get(jobId);
    if (record === undefined) {
      throw new BridgeError("job_not_found", "Bridge job was not found.", {
        httpStatus: 404,
      });
    }
    return record;
  }

  count(state: JobState): number {
    return this.list().filter((record) => record.state === state).length;
  }

  async create(request: BridgeRequest): Promise<{ record: JobRecord; created: boolean }> {
    let releaseCreate!: () => void;
    const previous = this.#createLock;
    this.#createLock = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await previous;
    try {
      const requestHash = sha256Json(request);
      const existingId = this.#idempotency.get(this.#idempotencyKey(request));
      if (existingId !== undefined) {
        const existing = this.require(existingId);
        if (existing.request_hash !== requestHash) {
          throw new BridgeError(
            "idempotency_conflict",
            "Idempotency key was already used for a different request.",
            { httpStatus: 409 },
          );
        }
        return { record: existing, created: false };
      }

      const now = new Date().toISOString();
      const record: JobRecord = {
        job_id: randomUUID(),
        version: BRIDGE_VERSION,
        build_id: BRIDGE_BUILD_ID,
        protocol_version: BRIDGE_LEGACY_PROTOCOL_VERSION,
        state: "queued",
        request,
        request_hash: requestHash,
        created_at: now,
        updated_at: now,
        history: [{ state: "queued", at: now }],
        direction: request.target === "claude" ? "codex_to_claude" : "claude_to_codex",
        sync_status: "not_requested",
      };
      this.#records.set(record.job_id, record);
      this.#idempotency.set(this.#idempotencyKey(request), record.job_id);
      await this.#save(record);
      await this.#audit.jobEvent("job_created", record);
      this.#notify(record);
      return { record, created: true };
    } finally {
      releaseCreate();
    }
  }

  async transition(jobId: string, state: JobState, patch: TransitionPatch = {}): Promise<JobRecord> {
    return this.#withLock(jobId, async () => {
      const current = this.require(jobId);
      assertTransition(current.state, state);
      const now = new Date().toISOString();
      const { error: patchError, ...fields } = patch;
      const record: JobRecord = {
        ...current,
        ...fields,
        ...(patchError === undefined || patchError === null ? {} : { error: patchError }),
        state,
        updated_at: now,
        history: [
          ...current.history,
          {
            state,
            at: now,
            ...(patchError === undefined || patchError === null
              ? {}
              : { error_code: patchError.code }),
          },
        ],
        ...(patch.result === undefined ? {} : { result_hash: sha256(patch.result) }),
      };
      if (patchError === null) {
        delete record.error;
      }
      this.#records.set(jobId, record);
      await this.#save(record);
      await this.#audit.jobEvent("job_state_changed", record);
      this.#notify(record);
      return record;
    });
  }

  async patch(jobId: string, patch: TransitionPatch): Promise<JobRecord> {
    return this.#withLock(jobId, async () => {
      const current = this.require(jobId);
      const { error: patchError, ...fields } = patch;
      const record: JobRecord = {
        ...current,
        ...fields,
        ...(patchError === undefined || patchError === null ? {} : { error: patchError }),
        updated_at: new Date().toISOString(),
      };
      if (patchError === null) {
        delete record.error;
      }
      this.#records.set(jobId, record);
      await this.#save(record);
      const metadata = this.#patchMetadata(current, patch);
      if (metadata !== undefined) {
        await this.#audit.jobEvent("job_patched", record, metadata);
      }
      this.#notify(record);
      return record;
    });
  }

  #patchMetadata(
    previous: JobRecord,
    patch: TransitionPatch,
  ): Record<string, string | number | boolean | null> | undefined {
    const metadata: Record<string, string | number | boolean | null> = {};
    if (patch.child_pid !== undefined && patch.child_pid !== previous.child_pid) {
      metadata["child_pid"] = patch.child_pid;
    }
    if (
      patch.cancellation_requested_at !== undefined &&
      patch.cancellation_requested_at !== previous.cancellation_requested_at
    ) {
      metadata["cancellation_requested_at"] = patch.cancellation_requested_at;
    }
    if (patch.claude_session_id !== undefined && patch.claude_session_id !== previous.claude_session_id) {
      metadata["claude_session_id_hash"] = sha256(patch.claude_session_id);
    }
    if (patch.context_reset !== undefined && patch.context_reset !== previous.context_reset) {
      metadata["context_reset"] = patch.context_reset;
    }
    return Object.keys(metadata).length === 0 ? undefined : metadata;
  }

  async wait(jobId: string, timeoutMs: number): Promise<JobRecord> {
    const current = this.require(jobId);
    if (isTerminalState(current.state) || timeoutMs <= 0) {
      return current;
    }
    return new Promise<JobRecord>((resolve) => {
      const eventName = `job:${jobId}`;
      const listener = (record: JobRecord): void => {
        if (isTerminalState(record.state)) {
          clearTimeout(timer);
          this.#events.off(eventName, listener);
          resolve(record);
        }
      };
      const timer = setTimeout(() => {
        this.#events.off(eventName, listener);
        resolve(this.require(jobId));
      }, timeoutMs);
      timer.unref();
      this.#events.on(eventName, listener);
    });
  }

  async recoverUncertain(): Promise<JobRecord[]> {
    const recovered: JobRecord[] = [];
    for (const record of this.list()) {
      if (["dispatching", "transport_delivered", "running"].includes(record.state)) {
        recovered.push(
          await this.transition(record.job_id, "needs_attention", {
            error: {
              code: "daemon_restarted",
              message: "Daemon restarted while delivery or execution was uncertain.",
              retryable: false,
            },
          }),
        );
      } else if (record.state === "queued" && Date.parse(record.request.deadline) <= Date.now()) {
        recovered.push(
          await this.transition(record.job_id, "expired", {
            error: {
              code: "deadline_expired",
              message: "Job expired before dispatch after daemon restart.",
              retryable: false,
            },
          }),
        );
      }
    }
    return recovered;
  }

  async deleteTerminal(jobId: string): Promise<void> {
    await this.#withLock(jobId, async () => {
      const record = this.require(jobId);
      if (!isTerminalState(record.state)) {
        throw new BridgeError("job_not_terminal", "Only terminal jobs may be removed by cleanup.", {
          httpStatus: 409,
        });
      }
      await unlink(join(this.#jobsDirectory, `${record.job_id}.json`));
      this.#records.delete(record.job_id);
      if (this.#idempotency.get(this.#idempotencyKey(record.request)) === record.job_id) {
        this.#idempotency.delete(this.#idempotencyKey(record.request));
      }
      this.#notify(record);
    });
  }

  async #save(record: JobRecord): Promise<void> {
    await atomicWriteJson(join(this.#jobsDirectory, `${record.job_id}.json`), record, {
      protect: true,
    });
  }

  #idempotencyKey(request: BridgeRequest): string {
    return `${request.origin}\u0000${request.idempotency_key}`;
  }

  #notify(record: JobRecord): void {
    this.#events.emit(`job:${record.job_id}`, record);
    this.#events.emit("change", record);
  }

  async #withLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(jobId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#locks.get(jobId) === current) {
        this.#locks.delete(jobId);
      }
    }
  }
}
