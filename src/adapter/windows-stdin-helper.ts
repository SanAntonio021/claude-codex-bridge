import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

async function main(): Promise<number> {
  const [inputPath, executable, ...args] = process.argv.slice(2);
  if (inputPath === undefined || executable === undefined) {
    process.stderr.write("bridge stdin helper: missing launch arguments\n");
    return 126;
  }

  let input: string;
  try {
    input = readFileSync(inputPath, "utf8");
    unlinkSync(inputPath);
  } catch (error) {
    process.stderr.write(
      `bridge stdin helper: ${error instanceof Error ? `${error.name}:${error.message}` : "input error"}\n`,
    );
    return 126;
  }

  const claudeEnvironment = { ...process.env };
  delete claudeEnvironment.NODE_CHANNEL_FD;
  delete claudeEnvironment.NODE_UNIQUE_ID;
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: claudeEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin!.write(input, "utf8");
  child.stdin!.end();
  return await new Promise<number>((resolve) => {
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? err.name;
      process.stderr.write(`bridge stdin helper: ${code}\n`);
      resolve(126);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

process.exitCode = await main();
