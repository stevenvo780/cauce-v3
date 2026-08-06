import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessExecutionError } from "./errors.js";
import type { CommandRunRequest, CommandRunResult, SafeRunnerLogger } from "./types.js";

export interface ProcessRunnerOptions {
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /**
   * Ventana que se le concede a las tuberías para cerrarse DESPUÉS de que el hijo salió.
   * Vencida, las tuberías que siguen abiertas se consideran heredadas por un descendiente
   * y se cosechan: ver `reapInheritedPipes`.
   */
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
 * Señala al GRUPO de procesos, no al pid.
 *
 * El hijo se lanza con `detached`, así que es líder de su propio grupo y el grupo sobrevive al
 * líder mientras quede un descendiente vivo: `kill(-pgid)` sigue alcanzando a los nietos aunque
 * el hijo ya haya salido y Node ya lo haya cosechado. Por eso el pid se captura al spawn y no se
 * lee de `child.pid`, y por eso el respaldo a `child.kill()` —que apunta a un pid suelto y podría
 * haber sido reasignado— sólo se usa mientras el hijo sigue vivo.
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
      // Un hijo que murió entre la comprobación y la señal no es un fallo del runner.
    }
  }
}

/**
 * Shell-free runner. The prompt only reaches stdin; logs intentionally exclude argv,
 * environment, stdin, stdout and stderr.
 */
export class SpawnCommandRunner {
  /**
   * Éste es el único transporte que ve los bytes del harness mientras salen, así que es el único
   * que puede cumplir un `startWitness`. Ver `CommandRunner.witnessesHarnessStart`.
   */
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
      // El testigo arranca en `false` —o sea «hasta ahora consta que NO empezó»— y sólo pasa a
      // `true` cuando el byte declarado aparece. Sin testigo declarado queda `undefined`, que
      // río abajo significa «no sé» y se trata como ambiguo.
      const witness = request.startWitness;
      let harnessStarted: boolean | undefined = witness === undefined ? undefined : false;
      const noteHarnessStart = (): void => {
        if (harnessStarted !== false) return;
        harnessStarted = true;
        try {
          request.onHarnessStart?.();
        } catch {
          // Sellar la marca de arranque es un efecto colateral del transporte: si el llamador
          // falla al anotarla, la ejecución del turno no se toca. Fallar acá convertiría un
          // problema de observabilidad en una entrega perdida.
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

      /** Arma la cosecha para el vencimiento MÁS PRÓXIMO; nunca lo aleja. */
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
       * `close` sólo llega cuando el hijo salió Y las tres tuberías se cerraron. Un descendiente
       * que heredó stdout/stderr las mantiene abiertas indefinidamente, así que `close` no llega
       * NUNCA y la entrega queda colgada para siempre. Cuando vence la ventana se mata el grupo
       * —el nieto vive ahí— y se destruyen NUESTROS extremos de las tuberías: matar el pid no
       * alcanza porque los descriptores son de otro proceso. Después se cierra la promesa con lo
       * que ya se recolectó, que es la salida real del harness.
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
            // Un extremo ya destruido no cambia el desenlace de la entrega.
          }
        }
        settle();
      };

      /**
       * Ya no se rinde cuando el hijo salió: ese retorno temprano era el bug. Un hijo muerto con las
       * tuberías tomadas por un nieto deja la entrega viva, así que el timeout y la cancelación
       * tienen que seguir valiendo — y la señal tiene que ir al GRUPO, que es donde está el nieto.
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
        // Se busca sobre el acumulado y no sobre el trozo: la marca puede llegar partida en dos
        // lecturas, y buscarla sólo en el trozo la perdería justo cuando el turno SÍ arrancó —
        // el lado caro del error.
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
