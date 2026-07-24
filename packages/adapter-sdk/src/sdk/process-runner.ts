import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessExecutionError } from "./errors.js";
import type { CommandRunRequest, CommandRunResult, SafeRunnerLogger } from "./types.js";

export interface ProcessRunnerOptions {
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly logger?: SafeRunnerLogger;
}

const SAFE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  // Non-secret Hermes profile/model discovery only; Hermes resolves authentication from local storage.
  "HERMES_HOME",
  "HERMES_INFERENCE_MODEL",
  // Non-secret module discovery path consumed only by the OpenClaw bridge.
  "CAUCE_OPENCLAW_DIST_DIR",
];
const SECRET_ENVIRONMENT = /(?:secret|token|password|passwd|api[_-]?key|auth|credential|cookie|session)/iu;

function childEnvironment(additions: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (SECRET_ENVIRONMENT.test(key)) {
      throw new ProcessExecutionError("SECRET_ENV_REJECTED", "Secret-like environment keys are not accepted", false);
    }
    environment[key] = value;
  }
  return environment;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Shell-free runner. The prompt only reaches stdin; logs intentionally exclude argv,
 * environment, stdin, stdout and stderr.
 */
export class SpawnCommandRunner {
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly logger: SafeRunnerLogger;

  constructor(options: ProcessRunnerOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 250;
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.logger = options.logger ?? (() => undefined);
  }

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (request.command.length === 0) {
      return Promise.reject(new ProcessExecutionError("INVALID_COMMAND", "Command may not be empty", false));
    }
    if (request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
      return Promise.reject(new ProcessExecutionError("INVALID_TIMEOUT", "Timeout must be positive", false));
    }
    if (request.stdin.length > 0 && request.args.some((arg) => arg.includes(request.stdin))) {
      return Promise.reject(
        new ProcessExecutionError("PROMPT_IN_ARGV", "Harness prompt must never be present in argv", false),
      );
    }
    if (request.signal.aborted) {
      return Promise.reject(
        new ProcessExecutionError("CANCELLED", "Harness process was cancelled before spawn", false),
      );
    }

    return new Promise<CommandRunResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: childEnvironment(request.env),
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        if (error instanceof ProcessExecutionError) {
          reject(error);
          return;
        }
        reject(new ProcessExecutionError(
          "SPAWN_FAILED",
          "Harness process could not be started",
          true,
        ));
        return;
      }

      this.logger({ event: "spawn", harness: request.harness });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
      let settled = false;

      const terminate = (reason: "timeout" | "cancel" | "output"): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut ||= reason === "timeout";
        cancelled ||= reason === "cancel";
        outputExceeded ||= reason === "output";
        this.logger({ event: "terminate", harness: request.harness, timedOut, cancelled });
        signalProcessGroup(child, "SIGTERM");
        const killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), this.killGraceMs);
        killTimer.unref();
      };

      const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.byteLength > this.maxOutputBytes) {
          terminate("output");
          return next.subarray(0, this.maxOutputBytes);
        }
        return next;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = collect(stderr, chunk);
      });

      const timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
      timeout.unref();
      const onAbort = (): void => terminate("cancel");
      request.signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", onAbort);
        reject(new ProcessExecutionError("SPAWN_FAILED", "Harness process could not be started", true));
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", onAbort);
        this.logger({ event: "exit", harness: request.harness, exitCode, timedOut, cancelled });
        if (outputExceeded) {
          reject(new ProcessExecutionError(
            "OUTPUT_LIMIT_AMBIGUOUS",
            "Harness output exceeded the configured limit after execution began",
            false,
          ));
          return;
        }
        resolve({
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          exitCode,
          signal,
          timedOut,
          cancelled,
        });
      });

      if (request.signal.aborted) terminate("cancel");
      child.stdin.on("error", () => undefined);
      child.stdin.end(request.stdin, "utf8");
    });
  }
}
