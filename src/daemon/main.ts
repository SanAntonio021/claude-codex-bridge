#!/usr/bin/env node
import { BridgeDaemon } from "./server.js";
import { asBridgeError } from "../errors.js";

async function main(): Promise<void> {
  if (process.argv[2] !== "serve") {
    process.stderr.write("Usage: bridge-daemon serve\n");
    process.exitCode = 2;
    return;
  }
  const testPort = process.env.BRIDGE_SKIP_ACL === "1"
    ? Number(process.env.CLAUDE_CODEX_BRIDGE_TEST_PORT)
    : Number.NaN;
  const daemon = new BridgeDaemon(
    Number.isInteger(testPort) && testPort > 0 && testPort <= 65_535
      ? { port: testPort }
      : {},
  );
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void daemon.stop().finally(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.start();
}

main().catch((error: unknown) => {
  const bridgeError = asBridgeError(error);
  process.stderr.write(`${bridgeError.code}: ${bridgeError.message}\n`);
  process.exitCode = bridgeError.code === "daemon_already_running" ? 0 : 1;
});
