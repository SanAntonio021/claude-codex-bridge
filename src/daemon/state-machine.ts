import { BridgeError } from "../errors.js";
import type { JobState } from "../types.js";

const TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  queued: new Set(["dispatching", "cancelled", "expired", "failed"]),
  dispatching: new Set([
    "transport_delivered",
    "running",
    "failed",
    "cancelled",
    "expired",
    "needs_attention",
  ]),
  transport_delivered: new Set([
    "running",
    "failed",
    "cancelled",
    "expired",
    "needs_attention",
  ]),
  running: new Set(["succeeded", "failed", "cancelled", "expired", "needs_attention"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  needs_attention: new Set(["succeeded", "failed"]),
};

export function assertTransition(from: JobState, to: JobState): void {
  if (!TRANSITIONS[from].has(to)) {
    throw new BridgeError(
      "invalid_state_transition",
      `Invalid job state transition: ${from} -> ${to}.`,
      { httpStatus: 409 },
    );
  }
}
