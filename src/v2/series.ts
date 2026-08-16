import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeError, type StructuredError } from "../errors.js";
import { sha256Json } from "../hash.js";
import { atomicWriteJson, ensureProtectedDirectory } from "../daemon/atomic.js";
import type { V2GateResult, V2TestResult } from "./gate.js";
import type { V2RenderedFinding } from "./renderer.js";
import type { V2AdjudicationInput, V2ModelResponse, V2ReviewRequest } from "./types.js";
import type { V2WorkspaceHandle } from "./workspace.js";

export const V2_JOB_STATES = [
  "queued",
  "dispatching",
  "sealed",
  "peer_running",
  "result_validated",
  "validation_complete",
  "sync_prepared",
  "replace",
  "verify",
  "rollback",
  "succeeded",
  "failed",
  "awaiting_evidence",
  "awaiting_user_decision",
] as const;
export type V2JobState = (typeof V2_JOB_STATES)[number];

type V2TerminalState = "succeeded" | "failed" | "awaiting_evidence" | "awaiting_user_decision";
type V2NonTerminalState = Exclude<V2JobState, V2TerminalState>;

const V2_TERMINAL_STATES = new Set<V2JobState>([
  "succeeded",
  "failed",
  "awaiting_evidence",
  "awaiting_user_decision",
]);

const V2_ALLOWED_TRANSITIONS: Readonly<Record<V2NonTerminalState, readonly V2JobState[]>> = {
  queued: ["dispatching"],
  dispatching: ["sealed", "peer_running"],
  sealed: ["peer_running"],
  peer_running: ["result_validated"],
  result_validated: ["validation_complete"],
  validation_complete: ["sync_prepared", "rollback"],
  sync_prepared: ["replace", "rollback"],
  replace: ["replace", "verify", "rollback"],
  verify: ["rollback"],
  rollback: [],
};

export interface V2JobHistory {
  state: V2JobState;
  at: string;
  errorCode?: string;
}

export interface V2WorkspaceRecord {
  targetRoot: string;
  workspaceRoot: string;
  retainedUntil: string;
}

export interface V2AdapterEvidence {
  classification: string;
  requestedModel: string;
  requestedReasoningEffort: string;
  reportedModel?: string;
  cliVersion?: string;
  requestedSandboxMode?: string;
  approvalPolicy?: string;
  zeroTools: boolean;
  nativeFileChangeOnly: boolean;
}

export interface V2JobRecord {
  jobId: string;
  seriesKey: string;
  seriesVersion: number;
  round: number;
  attempt: number;
  state: V2JobState;
  request: V2ReviewRequest;
  createdAt: string;
  updatedAt: string;
  history: V2JobHistory[];
  successorJobId?: string;
  error?: StructuredError;
  modelResponse?: V2ModelResponse;
  renderedReview?: string;
  findings?: V2RenderedFinding[];
  gate?: V2GateResult;
  testResults?: V2TestResult[];
  repairedArtifact?: string;
  workspace?: V2WorkspaceRecord;
  adjudication?: V2AdjudicationRecord;
  adapterEvidence?: V2AdapterEvidence;
}

export interface V2AdjudicationRecord extends V2AdjudicationInput {
  jobId: string;
  decidedAt: string;
}

export interface V2SeriesRecord {
  key: string;
  owner: V2ReviewRequest["owner"];
  artifactId: string;
  fixedContractHash: string;
  latestJobId: string;
  seriesVersion: number;
  acceptedRounds: number[];
  attemptsByRound: Record<string, number>;
  status: "idle" | "running" | "awaiting_user_decision" | "completed";
  createdAt: string;
  updatedAt: string;
  adjudication?: V2AdjudicationRecord;
}

export interface V2Submission {
  job: V2JobRecord;
  series: V2SeriesRecord;
}

function isTerminal(state: V2JobState): state is V2TerminalState {
  return V2_TERMINAL_STATES.has(state);
}

function seriesKey(request: V2ReviewRequest): string {
  return `${request.owner}\u0000${request.seriesId}`;
}

function fixedContract(request: V2ReviewRequest): Record<string, unknown> {
  return {
    owner: request.owner,
    target: request.target,
    operation: request.operation,
    artifactMode: request.artifactMode,
    artifactId: request.artifactId,
    artifactType: request.artifactType,
    artifactName: request.artifactName,
    artifactPath: request.artifactPath,
    targetRoot: request.targetRoot,
    repairTargets: request.repairTargets,
    acceptanceCriteria: request.acceptanceCriteria,
    constraints: request.constraints,
    testCommands: request.testCommands,
    taskProfile: request.taskProfile,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    routingSource: request.routingSource,
    routingRuleId: request.routingRuleId,
  };
}

function errorFrom(code: string, message: string, details?: Record<string, unknown>): StructuredError {
  return {
    code,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  };
}

export class V2SeriesStore {
  readonly #root: string;
  readonly #jobsRoot: string;
  readonly #seriesPath: string;
  readonly #jobs = new Map<string, V2JobRecord>();
  readonly #series = new Map<string, V2SeriesRecord>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #events = new EventEmitter();

  constructor(runtimeRoot: string) {
    this.#root = join(resolve(runtimeRoot), "v2");
    this.#jobsRoot = join(this.#root, "jobs");
    this.#seriesPath = join(this.#root, "series.json");
    this.#events.setMaxListeners(100);
  }

  async initialize(): Promise<void> {
    await ensureProtectedDirectory(this.#root);
    await ensureProtectedDirectory(this.#jobsRoot);
    try {
      const raw = JSON.parse(await readFile(this.#seriesPath, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new BridgeError("v2_store_corrupt", "Protocol v2 series store is invalid.", { httpStatus: 500 });
      }
      const entries = (raw as Record<string, unknown>)["series"];
      if (!Array.isArray(entries)) {
        throw new BridgeError("v2_store_corrupt", "Protocol v2 series store has no series list.", { httpStatus: 500 });
      }
      this.#series.clear();
      for (const entry of entries) {
        const parsed = entry as Partial<V2SeriesRecord>;
        if (
          typeof parsed.key !== "string"
          || typeof parsed.latestJobId !== "string"
          || !Number.isInteger(parsed.seriesVersion)
          || !Array.isArray(parsed.acceptedRounds)
          || parsed.attemptsByRound === undefined
        ) {
          throw new BridgeError("v2_store_corrupt", "Protocol v2 series record is invalid.", { httpStatus: 500 });
        }
        this.#series.set(parsed.key, parsed as V2SeriesRecord);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let names: string[] = [];
    try {
      names = await readdir(this.#jobsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.#jobs.clear();
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
      const record = JSON.parse(await readFile(join(this.#jobsRoot, name), "utf8")) as Partial<V2JobRecord>;
      if (typeof record.jobId !== "string" || typeof record.seriesKey !== "string" || !V2_JOB_STATES.includes(record.state as V2JobState)) {
        throw new BridgeError("v2_store_corrupt", "Protocol v2 job record is invalid.", { httpStatus: 500 });
      }
      this.#jobs.set(record.jobId, record as V2JobRecord);
    }
  }

  getJob(jobId: string): V2JobRecord {
    const record = this.#jobs.get(jobId);
    if (record === undefined) {
      throw new BridgeError("job_not_found", "Protocol v2 job was not found.", { httpStatus: 404 });
    }
    return record;
  }

  getSeries(key: string): V2SeriesRecord | undefined {
    return this.#series.get(key);
  }

  async submit(request: V2ReviewRequest): Promise<V2Submission> {
    const key = seriesKey(request);
    return this.#withLock(key, async () => {
      const previous = this.#series.get(key);
      const contractHash = sha256Json(fixedContract(request));
      const now = new Date().toISOString();
      let round: number;
      let attempt: number;
      let series: V2SeriesRecord;
      if (previous === undefined) {
        if (request.seriesVersion !== undefined || request.latestJobId !== undefined) {
          throw new BridgeError("series_cas_invalid", "A new protocol v2 series cannot carry a prior CAS value.", {
            httpStatus: 409,
          });
        }
        round = 1;
        attempt = 1;
        series = {
          key,
          owner: request.owner,
          artifactId: request.artifactId,
          fixedContractHash: contractHash,
          latestJobId: "",
          seriesVersion: 0,
          acceptedRounds: [],
          attemptsByRound: { "1": 1 },
          status: "running",
          createdAt: now,
          updatedAt: now,
        };
      } else {
        if (previous.status === "completed") {
          throw new BridgeError("series_completed", "A passed protocol v2 series cannot create another round.", {
            httpStatus: 409,
          });
        }
        if (previous.status === "awaiting_user_decision") {
          throw new BridgeError("series_user_decision_required", "This protocol v2 series is awaiting user adjudication.", {
            httpStatus: 409,
          });
        }
        if (
          request.seriesVersion !== previous.seriesVersion
          || request.latestJobId !== previous.latestJobId
        ) {
          throw new BridgeError("series_cas_mismatch", "latestJobId and seriesVersion must match the current series.", {
            httpStatus: 409,
            details: { latest_job_id: previous.latestJobId, series_version: previous.seriesVersion },
          });
        }
        if (previous.fixedContractHash !== contractHash) {
          throw new BridgeError("series_contract_changed", "Protocol v2 locks operation, roles, routing, acceptance, and constraints within a series.", {
            httpStatus: 409,
          });
        }
        const current = this.getJob(previous.latestJobId);
        if (!isTerminal(current.state) || current.successorJobId !== undefined) {
          throw new BridgeError("series_successor_conflict", "A protocol v2 job already has an active or recorded successor.", {
            httpStatus: 409,
          });
        }
        round = previous.acceptedRounds.length + 1;
        attempt = (previous.attemptsByRound[String(round)] ?? 0) + 1;
        if (round > 3 || attempt > 2) {
          throw new BridgeError("series_attempts_exhausted", "Protocol v2 permits at most three accepted rounds and two attempts per round.", {
            httpStatus: 409,
          });
        }
        await this.#saveJob({ ...current, successorJobId: "pending" });
        this.#jobs.set(current.jobId, { ...current, successorJobId: "pending" });
        series = {
          ...previous,
          attemptsByRound: { ...previous.attemptsByRound, [String(round)]: attempt },
          status: "running",
          updatedAt: now,
        };
      }
      const jobId = randomUUID();
      const job: V2JobRecord = {
        jobId,
        seriesKey: key,
        seriesVersion: series.seriesVersion + 1,
        round,
        attempt,
        state: "queued",
        request,
        createdAt: now,
        updatedAt: now,
        history: [{ state: "queued", at: now }],
      };
      if (previous !== undefined) {
        const current = this.getJob(previous.latestJobId);
        const linked: V2JobRecord = { ...current, successorJobId: jobId };
        await this.#saveJob(linked);
        this.#jobs.set(linked.jobId, linked);
      }
      series = { ...series, latestJobId: jobId, seriesVersion: job.seriesVersion, updatedAt: now };
      this.#series.set(key, series);
      this.#jobs.set(jobId, job);
      await Promise.all([this.#saveSeries(), this.#saveJob(job)]);
      this.#notify(job);
      return { job, series };
    });
  }

  async transition(
    jobId: string,
    state: V2JobState,
    patch: Partial<Omit<V2JobRecord, "jobId" | "seriesKey" | "seriesVersion" | "round" | "attempt" | "state" | "request" | "createdAt" | "updatedAt" | "history">> = {},
  ): Promise<V2JobRecord> {
    const current = this.getJob(jobId);
    return this.#withLock(current.seriesKey, async () => {
      const latest = this.getJob(jobId);
      if (isTerminal(latest.state)) {
        throw new BridgeError("v2_job_terminal", "Protocol v2 terminal jobs cannot transition again.", { httpStatus: 409 });
      }
      if (!V2_ALLOWED_TRANSITIONS[latest.state].includes(state)) {
        throw new BridgeError("v2_transition_invalid", "Protocol v2 rejected an invalid state transition.", {
          httpStatus: 409,
          details: { from: latest.state, to: state },
        });
      }
      const now = new Date().toISOString();
      const next: V2JobRecord = {
        ...latest,
        ...patch,
        state,
        updatedAt: now,
        history: [
          ...latest.history,
          { state, at: now, ...(patch.error === undefined ? {} : { errorCode: patch.error.code }) },
        ],
      };
      this.#jobs.set(jobId, next);
      await this.#saveJob(next);
      this.#notify(next);
      return next;
    });
  }

  async complete(
    jobId: string,
    input: {
      state: "succeeded" | "failed" | "awaiting_evidence";
      acceptedRound: boolean;
      gate?: V2GateResult;
      error?: StructuredError;
      modelResponse?: V2ModelResponse;
      renderedReview?: string;
      findings?: V2RenderedFinding[];
      testResults?: V2TestResult[];
      repairedArtifact?: string;
      workspace?: V2WorkspaceHandle;
      adapterEvidence?: V2AdapterEvidence;
    },
  ): Promise<V2JobRecord> {
    const current = this.getJob(jobId);
    return this.#withLock(current.seriesKey, async () => {
      const latest = this.getJob(jobId);
      const series = this.#series.get(latest.seriesKey);
      if (series === undefined) {
        throw new BridgeError("v2_store_corrupt", "Protocol v2 job has no parent series.", { httpStatus: 500 });
      }
      if (isTerminal(latest.state)) {
        throw new BridgeError("v2_job_terminal", "Protocol v2 terminal jobs cannot complete again.", { httpStatus: 409 });
      }
      const acceptedRounds = input.acceptedRound
        ? [...new Set([...series.acceptedRounds, latest.round])].sort((left, right) => left - right)
        : series.acceptedRounds;
      const thirdRoundFailed = latest.round === 3
        && input.acceptedRound
        && input.gate?.verdict !== "pass";
      const attemptsExhausted = !input.acceptedRound && latest.attempt >= 2;
      const terminalState: V2JobState = thirdRoundFailed || attemptsExhausted
        ? "awaiting_user_decision"
        : input.state;
      const now = new Date().toISOString();
      const next: V2JobRecord = {
        ...latest,
        ...(input.gate === undefined ? {} : { gate: input.gate }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.modelResponse === undefined ? {} : { modelResponse: input.modelResponse }),
        ...(input.renderedReview === undefined ? {} : { renderedReview: input.renderedReview }),
        ...(input.findings === undefined ? {} : { findings: input.findings }),
        ...(input.testResults === undefined ? {} : { testResults: input.testResults }),
        ...(input.repairedArtifact === undefined ? {} : { repairedArtifact: input.repairedArtifact }),
        ...(input.adapterEvidence === undefined ? {} : { adapterEvidence: input.adapterEvidence }),
        ...(input.workspace === undefined
          ? {}
          : {
              workspace: {
                targetRoot: input.workspace.targetRoot,
                workspaceRoot: input.workspace.workspaceRoot,
                retainedUntil: input.workspace.retainedUntil,
              },
            }),
        state: terminalState,
        updatedAt: now,
        history: [
          ...latest.history,
          {
            state: terminalState,
            at: now,
            ...(input.error === undefined ? {} : { errorCode: input.error.code }),
          },
        ],
      };
      const seriesStatus: V2SeriesRecord["status"] = terminalState === "awaiting_user_decision"
        ? "awaiting_user_decision"
        : input.acceptedRound && input.gate?.verdict === "pass"
          ? "completed"
          : "idle";
      const nextSeries: V2SeriesRecord = {
        ...series,
        acceptedRounds,
        status: seriesStatus,
        updatedAt: now,
      };
      this.#jobs.set(jobId, next);
      this.#series.set(nextSeries.key, nextSeries);
      await Promise.all([this.#saveJob(next), this.#saveSeries()]);
      this.#notify(next);
      return next;
    });
  }

  async adjudicate(jobId: string, input: V2AdjudicationInput): Promise<V2JobRecord> {
    const current = this.getJob(jobId);
    return this.#withLock(current.seriesKey, async () => {
      const latest = this.getJob(jobId);
      const series = this.#series.get(latest.seriesKey);
      if (series === undefined) {
        throw new BridgeError("v2_store_corrupt", "Protocol v2 job has no parent series.", { httpStatus: 500 });
      }
      if (latest.state !== "awaiting_user_decision" || series.status !== "awaiting_user_decision") {
        throw new BridgeError(
          "v2_adjudication_unavailable",
          "Only a protocol v2 series awaiting user decision can be adjudicated.",
          { httpStatus: 409 },
        );
      }
      const findingIds = (latest.findings ?? []).map((finding) => finding.id).sort();
      const accepted = [...new Set(input.acceptedFindingIds)].sort();
      const rejected = [...new Set(input.rejectedFindingIds)].sort();
      if (
        accepted.length !== input.acceptedFindingIds.length
        || rejected.length !== input.rejectedFindingIds.length
        || accepted.some((id) => rejected.includes(id))
      ) {
        throw new BridgeError(
          "v2_adjudication_findings_invalid",
          "Accepted and rejected finding IDs must be unique and mutually exclusive.",
          { httpStatus: 400 },
        );
      }
      const covered = [...new Set([...accepted, ...rejected])].sort();
      if (
        covered.length !== findingIds.length
        || covered.some((id, index) => id !== findingIds[index])
      ) {
        throw new BridgeError(
          "v2_adjudication_findings_incomplete",
          "Accepted and rejected finding IDs must completely cover the series' disputed findings.",
          { httpStatus: 400, details: { finding_ids: findingIds } },
        );
      }
      if (
        (input.decision === "accept_author" && accepted.length !== 0)
        || (input.decision === "accept_reviewer" && rejected.length !== 0)
      ) {
        throw new BridgeError(
          "v2_adjudication_decision_mismatch",
          "accept_author rejects every finding and accept_reviewer accepts every finding.",
          { httpStatus: 400 },
        );
      }
      const decidedAt = new Date().toISOString();
      const adjudication: V2AdjudicationRecord = { ...input, jobId, decidedAt };
      const next: V2JobRecord = { ...latest, adjudication, updatedAt: decidedAt };
      const nextSeries: V2SeriesRecord = {
        ...series,
        status: "idle",
        adjudication,
        updatedAt: decidedAt,
      };
      this.#jobs.set(jobId, next);
      this.#series.set(nextSeries.key, nextSeries);
      await Promise.all([this.#saveJob(next), this.#saveSeries()]);
      this.#notify(next);
      return next;
    });
  }

  async wait(jobId: string, timeoutMs: number): Promise<V2JobRecord> {
    const record = this.getJob(jobId);
    if (isTerminal(record.state) || timeoutMs <= 0) {
      return record;
    }
    return new Promise<V2JobRecord>((resolveWait) => {
      const event = `job:${jobId}`;
      const listener = (next: V2JobRecord): void => {
        if (isTerminal(next.state)) {
          clearTimeout(timer);
          this.#events.off(event, listener);
          resolveWait(next);
        }
      };
      const timer = setTimeout(() => {
        this.#events.off(event, listener);
        resolveWait(this.getJob(jobId));
      }, timeoutMs);
      timer.unref();
      this.#events.on(event, listener);
    });
  }

  async recoverUncertain(): Promise<V2JobRecord[]> {
    const recovered: V2JobRecord[] = [];
    for (const record of [...this.#jobs.values()]) {
      if (!isTerminal(record.state)) {
        recovered.push(await this.complete(record.jobId, {
          state: "failed",
          acceptedRound: false,
          error: errorFrom(
            "v2_recovery_required",
            "Daemon restart interrupted a protocol v2 stage; retained materials were preserved and the series failed closed.",
            { stage: record.state },
          ),
        }));
      }
    }
    return recovered;
  }

  #notify(job: V2JobRecord): void {
    this.#events.emit(`job:${job.jobId}`, job);
  }

  async #saveJob(job: V2JobRecord): Promise<void> {
    await atomicWriteJson(join(this.#jobsRoot, `${job.jobId}.json`), job, { protect: true });
  }

  async #saveSeries(): Promise<void> {
    await atomicWriteJson(this.#seriesPath, { version: 2, series: [...this.#series.values()] }, { protect: true });
  }

  async #withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.#locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#locks.get(key) === current) {
        this.#locks.delete(key);
      }
    }
  }
}
