import { LIMITS } from "../constants.js";
import { BridgeError } from "../errors.js";

/**
 * `--timeout` is documented in seconds; `--timeout-ms` is the raw millisecond
 * escape hatch. Treating both as milliseconds made `--timeout 45` wait 45ms and
 * return a mid-flight state, so the unit must stay explicit here.
 */
export function resolveWaitTimeoutMs(
  readOption: (name: string) => string | undefined,
): number {
  const seconds = readOption("--timeout");
  const milliseconds = readOption("--timeout-ms");
  if (seconds !== undefined && milliseconds !== undefined) {
    throw new BridgeError(
      "conflicting_timeout_options",
      "Use either --timeout <seconds> or --timeout-ms <milliseconds>, not both.",
    );
  }
  if (milliseconds !== undefined) {
    const parsed = Number(milliseconds);
    if (!Number.isInteger(parsed)) {
      throw new BridgeError("invalid_timeout", "--timeout-ms requires an integer milliseconds.");
    }
    return parsed;
  }
  if (seconds === undefined) {
    return LIMITS.awaitMs;
  }
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BridgeError("invalid_timeout", "--timeout requires a non-negative seconds value.");
  }
  return Math.round(parsed * 1000);
}
