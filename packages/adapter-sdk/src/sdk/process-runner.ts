import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessExecutionError } from "./errors.js";
import type { CommandRunRequest, CommandRunResult, SafeRunnerLogger } from "./types.js";

export interface ProcessRunnerOptions {
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /** Grace period for closing pipes after the child process exits. */
  readonly orphanPipeGraceMs?: number;
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
  "CAUCE_HERMES_RUNTIME_DIR",
  "CAUCE_HERMES_SOURCE_DIR",
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

/**
 * Sends the signal to the process group to ensure descendant subprocesses terminate.
 */
function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // A child that died between the check and the signal is not a runner failure.
    }
  }
}

/**
 * Shell-free runner. The prompt only reaches stdin; logs intentionally exclude argv,
 * environment, stdin, stdout and stderr.
 */
export class SpawnCommandRunner {
  readonly witnessesHarnessStart = true;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly orphanPipeGraceMs: number;
  private readonly logger: SafeRunnerLogger;

  constructor(options: ProcessRunnerOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 250;
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.orphanPipeGraceMs = options.orphanPipeGraceMs ?? 2_000;
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
      const pid = child.pid;
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const witness = request.startWitness;
      let harnessStarted: boolean | undefined = witness === undefined ? undefined : false;
      const noteHarnessStart = (): void => {
        if (harnessStarted !== false) return;
        harnessStarted = true;
        try {
          request.onHarnessStart?.();
        } catch {
          // Optional observer; does not alter execution.
        }
      };
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
      let settled = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let reapTimer: NodeJS.Timeout | undefined;
      let reapDeadline = Number.POSITIVE_INFINITY;

      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
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
          signal: exitSignal,
          timedOut,
          cancelled,
          ...(harnessStarted === undefined ? {} : { harnessStarted }),
        });
      };

      /** Schedules pipe collection for the nearest deadline. */
      const armReap = (delayMs: number): void => {
        if (settled) return;
        const deadline = Date.now() + delayMs;
        if (deadline >= reapDeadline) return;
        reapDeadline = deadline;
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        reapTimer = setTimeout(reapInheritedPipes, delayMs);
        reapTimer.unref();
      };

      /**
       * Forces termination of the process group and destroys the pipes if they remain open after
       * the grace period expires.
       */
      const reapInheritedPipes = (): void => {
        reapTimer = undefined;
        if (settled) return;
        this.logger({ event: "orphaned_pipes", harness: request.harness, exitCode, timedOut, cancelled });
        signalProcessGroup(child, pid, "SIGKILL");
        for (const stream of [child.stdout, child.stderr, child.stdin]) {
          try {
            stream.destroy();
          } catch {
            // Does not alter the outcome if the descriptor was already closed.
          }
        }
        settle();
      };

      /**
       * Terminates the process by sending SIGTERM and escalating to SIGKILL after the grace period.
       */
      const terminate = (reason: "timeout" | "cancel" | "output"): void => {
        if (settled) return;
        timedOut ||= reason === "timeout";
        cancelled ||= reason === "cancel";
        outputExceeded ||= reason === "output";
        this.logger({ event: "terminate", harness: request.harness, timedOut, cancelled });
        signalProcessGroup(child, pid, "SIGTERM");
        const killTimer = setTimeout(() => signalProcessGroup(child, pid, "SIGKILL"), this.killGraceMs);
        killTimer.unref();
        armReap(this.killGraceMs + this.orphanPipeGraceMs);
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
        if (witness?.kind === "stdout-first-byte" && chunk.byteLength > 0) noteHarnessStart();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = collect(stderr, chunk);
        // Search the marker over the accumulated stderr in case it arrives split across reads.
        if (witness?.kind === "stderr-marker" && stderr.includes(witness.marker)) noteHarnessStart();
      });

      const timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
      timeout.unref();
      const onAbort = (): void => terminate("cancel");
      request.signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        request.signal.removeEventListener("abort", onAbort);
        reject(new ProcessExecutionError("SPAWN_FAILED", "Harness process could not be started", true));
      });

      child.once("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        armReap(this.orphanPipeGraceMs);
      });

      child.once("close", (code, signal) => {
        if (exitCode === null) exitCode = code;
        if (exitSignal === null) exitSignal = signal;
        settle();
      });

      if (request.signal.aborted) terminate("cancel");
      child.stdin.on("error", () => undefined);
      child.stdin.end(request.stdin, "utf8");
    });
  }
}
