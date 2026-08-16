import { request as httpRequest } from "node:http";
import { LIMITS } from "../constants.js";
import { getDaemonPaths, type DaemonPaths } from "../config.js";
import { BridgeError } from "../errors.js";
import { readEndpoint, readToken } from "./runtime.js";

export interface DaemonEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}
export interface DaemonRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  paths?: DaemonPaths;
}

export async function requestDaemon<T>(
  path: string,
  options: DaemonRequestOptions = {},
): Promise<T> {
  const paths = options.paths ?? getDaemonPaths();
  const [endpoint, token] = await Promise.all([
    readEndpoint(paths.endpoint),
    readToken(paths.token),
  ]);
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  if (body !== undefined && body.length > LIMITS.requestBytes) {
    throw new BridgeError("request_too_large", "Request exceeds the 1 MiB limit.", {
      httpStatus: 413,
    });
  }

  const envelope = await new Promise<DaemonEnvelope<T>>((resolve, reject) => {
    const request = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path,
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(body.length),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length <= LIMITS.requestBytes) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DaemonEnvelope<T>;
            resolve(parsed);
          } catch (error) {
            reject(
              new BridgeError("invalid_daemon_response", "Daemon returned invalid JSON.", {
                httpStatus: 502,
                cause: error,
              }),
            );
          }
        });
      },
    );
    request.setTimeout(options.timeoutMs ?? 5_000, () => {
      request.destroy(new Error("daemon request timeout"));
    });
    request.on("error", (error) => {
      reject(
        new BridgeError("daemon_unavailable", "Unable to reach bridge daemon.", {
          httpStatus: 503,
          retryable: true,
          cause: error,
        }),
      );
    });
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });

  if (!envelope.ok) {
    const error = envelope.error;
    throw new BridgeError(
      error?.code ?? "daemon_error",
      error?.message ?? "Bridge daemon request failed.",
      {
        retryable: error?.retryable ?? false,
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    );
  }
  return envelope.data as T;
}

export async function daemonHealth(paths = getDaemonPaths()): Promise<Record<string, unknown>> {
  return requestDaemon<Record<string, unknown>>("/health", { paths, timeoutMs: 1_000 });
}
