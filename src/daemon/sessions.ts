import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./atomic.js";
import { BridgeError } from "../errors.js";
import { ReasoningEffortSchema, TaskProfileSchema } from "../model-routing.js";
import type { PeerTarget, SessionRecord } from "../types.js";

const SessionRecordSchema = z.object({
  bridge_thread_id: z.string().min(1),
  claude_session_id: z.uuid().optional(),
  peer_session_id: z.string().min(1).max(256).optional(),
  target: z.enum(["claude", "codex"]).default("claude"),
  model: z.string().min(1).max(256).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  task_profile: TaskProfileSchema.optional(),
  owner: z.literal("daemon"),
  status: z.enum(["idle", "running", "needs_attention"]),
  created_at: z.string(),
  last_active_at: z.string(),
});

const SessionFileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(SessionRecordSchema),
});

export class SessionStore {
  readonly #path: string;
  readonly #byThread = new Map<string, SessionRecord>();
  readonly #bySession = new Map<string, string>();
  #saveLock: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const parsed = SessionFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new BridgeError("session_store_corrupt", "Session mapping file is invalid.", {
        httpStatus: 500,
      });
    }
    for (const session of parsed.data.sessions) {
      const peerSessionId = session.peer_session_id ?? session.claude_session_id;
      if (peerSessionId === undefined) {
        throw new BridgeError("session_store_corrupt", "A session mapping lacks its peer session ID.", {
          httpStatus: 500,
        });
      }
      const existingThread = this.#bySession.get(peerSessionId);
      if (existingThread !== undefined && existingThread !== session.bridge_thread_id) {
        throw new BridgeError(
          "session_store_conflict",
          "A peer session is mapped to more than one bridge thread.",
          { httpStatus: 500 },
        );
      }
      const normalized: SessionRecord = {
        bridge_thread_id: session.bridge_thread_id,
        target: session.target,
        owner: "daemon",
        status: session.status,
        created_at: session.created_at,
        last_active_at: session.last_active_at,
        ...(session.claude_session_id === undefined
          ? {}
          : { claude_session_id: session.claude_session_id }),
        ...(session.peer_session_id === undefined
          ? {}
          : { peer_session_id: session.peer_session_id }),
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: session.reasoning_effort }),
        ...(session.task_profile === undefined
          ? {}
          : { task_profile: session.task_profile }),
      };
      this.#byThread.set(session.bridge_thread_id, normalized);
      this.#bySession.set(peerSessionId, session.bridge_thread_id);
    }
  }

  get(threadId: string): SessionRecord | undefined {
    return this.#byThread.get(threadId);
  }

  list(): SessionRecord[] {
    return [...this.#byThread.values()]
      .map((session) => ({ ...session }))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async assign(
    threadId: string,
    sessionId: string,
    options: { status?: SessionRecord["status"]; contextReset?: boolean } = {},
  ): Promise<SessionRecord> {
    return this.assignPeer(threadId, sessionId, "claude", options);
  }

  async assignPeer(
    threadId: string,
    sessionId: string,
    target: PeerTarget,
    options: {
      status?: SessionRecord["status"];
      contextReset?: boolean;
      model?: string;
      reasoningEffort?: SessionRecord["reasoning_effort"];
      taskProfile?: SessionRecord["task_profile"];
    } = {},
  ): Promise<SessionRecord> {
    const mappedThread = this.#bySession.get(sessionId);
    if (mappedThread !== undefined && mappedThread !== threadId) {
      throw new BridgeError(
        "session_mapping_conflict",
        "Claude session is already owned by another bridge thread.",
        { httpStatus: 409 },
      );
    }
    const existing = this.#byThread.get(threadId);
    if (existing !== undefined && existing.target !== target) {
      throw new BridgeError(
        "session_target_mismatch",
        "A bridge thread cannot switch between Claude and Codex targets.",
        { httpStatus: 409 },
      );
    }
    if (
      existing !== undefined &&
      (existing.peer_session_id ?? existing.claude_session_id) !== sessionId &&
      options.contextReset !== true
    ) {
        throw new BridgeError(
          "session_mapping_conflict",
          "Bridge thread unexpectedly returned a different peer session.",
        { httpStatus: 409 },
      );
    }

    if (
      existing !== undefined &&
      (existing.peer_session_id ?? existing.claude_session_id) !== sessionId
    ) {
      const previousSessionId = existing.peer_session_id ?? existing.claude_session_id;
      if (previousSessionId !== undefined) {
        this.#bySession.delete(previousSessionId);
      }
    }
    const now = new Date().toISOString();
    const model = options.model ?? existing?.model;
    const reasoningEffort = options.reasoningEffort ?? existing?.reasoning_effort;
    const taskProfile = options.taskProfile ?? existing?.task_profile;
    const record: SessionRecord = {
      bridge_thread_id: threadId,
      ...(target === "claude" ? { claude_session_id: sessionId } : { peer_session_id: sessionId }),
      target,
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...(taskProfile === undefined ? {} : { task_profile: taskProfile }),
      owner: "daemon",
      status: options.status ?? "idle",
      created_at: existing?.created_at ?? now,
      last_active_at: now,
    };
    this.#byThread.set(threadId, record);
    this.#bySession.set(sessionId, threadId);
    await this.#save();
    return record;
  }

  async setStatus(threadId: string, status: SessionRecord["status"]): Promise<void> {
    const existing = this.#byThread.get(threadId);
    if (existing === undefined) {
      return;
    }
    this.#byThread.set(threadId, {
      ...existing,
      status,
      last_active_at: new Date().toISOString(),
    });
    await this.#save();
  }

  async #save(): Promise<void> {
    let release!: () => void;
    const previous = this.#saveLock;
    this.#saveLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await atomicWriteJson(
        this.#path,
        { version: 1, sessions: this.list() },
        { protect: true },
      );
    } finally {
      release();
    }
  }
}
