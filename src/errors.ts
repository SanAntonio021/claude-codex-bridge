export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
export class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      httpStatus?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BridgeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? 400;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  if (error instanceof Error) {
    return new BridgeError("internal_error", "Internal bridge error.", {
      httpStatus: 500,
      cause: error,
    });
  }
  return new BridgeError("internal_error", "Internal bridge error.", {
    httpStatus: 500,
  });
}

export function toStructuredError(error: unknown): StructuredError {
  const bridgeError = asBridgeError(error);
  return {
    code: bridgeError.code,
    message: bridgeError.message,
    retryable: bridgeError.retryable,
    ...(bridgeError.details === undefined ? {} : { details: bridgeError.details }),
  };
}
