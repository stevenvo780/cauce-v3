import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionConfig } from "@muse-code/sdk/dist/src/msp.js";
import {
  MspError,
  readSessionDurability,
  spawnMspConnection,
  type TurnOutcome,
} from "@muse-code/sdk";
import { ProcessExecutionError } from "./errors.js";
import { childEnvironment } from "./process-runner.js";
import type { CommandRunRequest, CommandRunResult } from "./types.js";
import { sanitizeProcessOutput } from "../harnesses/shared/errors.js";
import { MuseMspSession, type MuseMspTelemetry } from "./muse-msp-session.js";
import { MuseMspFault, museObject, type MuseWait } from "./muse-msp-reconciliation.js";

export type MuseReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

const SESSION_OPEN_BUDGET_MS = 15_000;

export interface MuseRunnerConfig {
  readonly executable: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly workspace: string;
  readonly approvalMode: "denyUnmatched" | "onRequest" | "allowAll";
  readonly yolo?: boolean;
  readonly model?: string;
  readonly reasoningEffort?: MuseReasoningEffort;
  readonly onTelemetry?: (event: MuseMspTelemetry) => void;
}

class MuseDeadlineError extends Error {}
class MuseAbortError extends Error {}

function bounded<T>(promise: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MuseAbortError());
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new MuseDeadlineError());
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => { rejectResult(new MuseDeadlineError()); }, remaining);
    const onAbort = (): void => { rejectResult(new MuseAbortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolveResult, rejectResult).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
  });
}

/** Waits for `promise` while the turn keeps producing items; rejects once it goes quiet for `windowMs`. */
function untilStalled<T>(promise: Promise<T>, lastProgressAt: () => number, windowMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MuseAbortError());
  return new Promise<T>((resolveResult, rejectResult) => {
    const stop = (): void => {
      clearInterval(check);
      signal.removeEventListener("abort", onAbort);
    };
    const check = setInterval(() => {
      if (Date.now() - lastProgressAt() < windowMs) return;
      stop();
      rejectResult(new MuseDeadlineError());
    }, Math.max(10, Math.min(windowMs / 4, 30_000)));
    check.unref();
    const onAbort = (): void => { stop(); rejectResult(new MuseAbortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolveResult, rejectResult).finally(stop).catch(() => undefined);
  });
}

function result(
  stdout: string,
  options: {
    readonly stderr?: string;
    readonly exitCode?: number | null;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly harnessStarted?: boolean;
  } = {},
): CommandRunResult {
  return {
    stdout,
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
    signal: null,
    timedOut: options.timedOut ?? false,
    cancelled: options.cancelled ?? false,
    ...(options.harnessStarted === undefined ? {} : { harnessStarted: options.harnessStarted }),
  };
}

function safeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeProcessOutput(raw, 1_000);
}

function hostEnvironment(config: MuseRunnerConfig): NodeJS.ProcessEnv {
  const home = dirname(config.configHome);
  if (dirname(config.dataHome) !== home || config.configHome === config.dataHome) {
    throw new Error("Muse config and data homes must be distinct siblings under one alias HOME");
  }
  const allowed = [
    "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: config.configHome,
    XDG_DATA_HOME: config.dataHome,
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

async function validateWorkspace(config: MuseRunnerConfig): Promise<void> {
  for (const path of [config.executable, config.configHome, config.dataHome, config.workspace]) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error("Muse paths must be absolute and normalized");
    }
  }
  const workspace = await realpath(config.workspace);
  if (workspace !== config.workspace || !(await stat(workspace)).isDirectory()) {
    throw new Error("Muse workspace must be an existing canonical directory");
  }
  const home = dirname(config.configHome);
  if (!(await stat(home)).isDirectory() || !config.dataHome.startsWith(`${home}${sep}`)) {
    throw new Error("Muse alias HOME must exist and contain its XDG roots");
  }
  for (const path of [
    resolve(home, ".claude"), resolve(home, ".codex"),
    resolve(workspace, ".claude"), resolve(workspace, ".codex"),
  ]) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Muse workspace or HOME exposes foreign Claude/Codex context");
  }
  await access(config.executable, constants.X_OK);
}

async function sessionMcpConfig(endpoint: string | undefined): Promise<SessionConfig | undefined> {
  if (endpoint === undefined) return undefined;
  const binary = fileURLToPath(new URL("../bin/cauce-mcp.js", import.meta.url));
  try {
    if (!(await stat(binary)).isFile()) throw new Error("MCP entrypoint is not a file");
    await access(binary, constants.R_OK);
  } catch {
    throw new ProcessExecutionError("MUSE_MCP_UNAVAILABLE", "Cauce MCP entrypoint is unavailable", false);
  }
  return { mcpServers: { cauce: { transport: "stdio", command: process.execPath,
    args: [binary, endpoint], framing: "lineDelimitedJson", mode: "required" } } };
}

function terminalResult(sessionId: string, text: string, outcome: TurnOutcome): CommandRunResult {
  if (outcome.kind === "terminalUnknown") {
    throw new ProcessExecutionError(
      "MUSE_TURN_AMBIGUOUS",
      "Muse host died before a durable turn terminal was observed",
      false,
    );
  }
  if (outcome.kind === "unqueued") {
    throw new ProcessExecutionError("MUSE_TURN_UNQUEUED", "Muse turn was reclaimed before execution", true);
  }
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw new ProcessExecutionError("MUSE_OUTPUT_TOO_LARGE", "Muse final answer exceeded the bounded output budget", false);
  }
  const terminal = outcome.params.terminal;
  if (terminal === "completed") {
    return result(JSON.stringify({ session_id: sessionId, result: text }), { harnessStarted: true });
  }
  const detail = sanitizeProcessOutput(
    outcome.params.error?.message ?? outcome.params.reason ?? `terminal ${terminal}`,
    1_000,
  );
  return result(JSON.stringify({
    session_id: sessionId,
    status: "failed",
    result: text,
    error: { message: `Muse turn ${terminal}: ${detail}` },
  }), { harnessStarted: outcome.observedStart });
}

export class MuseMspRunner {
  readonly witnessesHarnessStart = false;
  private readonly config: MuseRunnerConfig;

  constructor(config: MuseRunnerConfig) {
    if ((config.approvalMode === "allowAll") !== (config.yolo === true)) {
      throw new Error("Muse allowAll approval mode and disabled sandbox must be configured together");
    }
    this.config = config;
  }

  private telemetry(event: MuseMspTelemetry): void {
    try {
      if (this.config.onTelemetry !== undefined) this.config.onTelemetry(event);
      else process.stderr.write(`${JSON.stringify(event)}\n`);
    } catch { /* Telemetry cannot change the execution outcome. */ }
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (request.harness !== "muse") throw new Error("MuseMspRunner only handles Muse");
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("Muse timeout must be a positive safe integer");
    }
    if (request.signal.aborted) return result("", { cancelled: true, harnessStarted: false });
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "MUSE_NO_AUTO_UPDATE",
      "CODEX_HOME", "CLAUDE_CONFIG_DIR", "USERPROFILE"]) {
      if (request.env !== undefined && Object.hasOwn(request.env, key)) {
        throw new ProcessExecutionError("RESERVED_ENVIRONMENT_OVERRIDE", "Muse alias environment cannot be overridden", false);
      }
    }
    const environment = {
      ...childEnvironment(request.env, request.emissionSocketPath, {}),
      ...hostEnvironment(this.config),
    };
    const deadline = Date.now() + request.timeoutMs;
    let handshake: ReturnType<typeof spawnMspConnection> | undefined;
    let session: MuseMspSession | undefined;
    let turnAttempted = false;
    let turnAdmitted = false;
    let resumeAttempted = false;
    let preflightPhase = "workspace";
    try {
      await bounded(validateWorkspace(this.config), deadline, request.signal);
      const mcpConfig = await bounded(sessionMcpConfig(request.emissionSocketPath), deadline, request.signal);
      const sessionConfig = mcpConfig === undefined ? {} : { config: mcpConfig };
      handshake = spawnMspConnection({
        command: this.config.executable,
        args: ["serve", ...(this.config.yolo === true ? ["--disable-sandbox"] : []), "--trust-workspace"],
        cwd: this.config.workspace,
        env: environment,
        shutdownTimeoutMs: 2_000,
      });
      handshake.onServerRequest(async (serverRequest) => {
        if (serverRequest.method === "approval/request") return {};
        throw new Error(`Unsupported Muse server request: ${serverRequest.method}`);
      });
      let rejectProtocol!: (fault: MuseMspFault) => void;
      const protocolFailure = new Promise<never>((_resolve, reject) => { rejectProtocol = reject; });
      handshake.onProtocolError(() => {
        rejectProtocol(new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse protocol framing failed during initialization"));
      });
      preflightPhase = "initialize";
      const connection = await bounded(Promise.race([handshake.initialize({
        clientInfo: { name: "cauce_muse", version: "0.2.0" },
        capabilities: { userInputDialogs: false,
          ...(mcpConfig === undefined ? {} : { requestedCapabilities: ["sessionMcp"] }),
        },
      }), protocolFailure]), Math.min(deadline, Date.now() + 5_000), request.signal);
      if (mcpConfig !== undefined && !connection.initializeResult.grantedCapabilities.includes("sessionMcp")) {
        throw new ProcessExecutionError("MUSE_MCP_CAPABILITY_REQUIRED", "Muse host did not grant session MCP registration", false);
      }
      const version = connection.initializeResult.serverInfo.version;
      const fingerprint = connection.initializeResult.schema.fingerprint;
      this.telemetry({
        event: "muse_host_initialized",
        ...(typeof version === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(version)
          ? { server_version: version } : {}),
        ...(/^sha256:[a-f0-9]{64}$/u.test(fingerprint) ? { schema_fingerprint: fingerprint } : {}),
        fingerprint_warning: connection.fingerprintWarning !== undefined,
      });
      const durability = readSessionDurability(connection.initializeResult);
      if (durability.kind !== "durable") {
        throw new Error("Muse serve must provide durable sessions");
      }
      const wait: MuseWait = (promise, budgetMs) => bounded(promise,
        budgetMs === undefined ? deadline : Math.min(deadline, Date.now() + budgetMs), request.signal);
      if (request.resumeSession && request.sessionId === undefined) {
        throw new Error("Muse resume requires a durable session id");
      }
      const sessionId = request.sessionId ?? connection.connection.mintCommandId();
      session = new MuseMspSession(connection.connection, sessionId, durability, (event) => { this.telemetry(event); });
      const activeSession = session;
      void connection.child.exit.then((exit) => { activeSession.hostExited(exit); }).catch(() => {
        activeSession.hostExited({ kind: "transportEof" });
      });
      let opening: Record<string, unknown>;
      if (request.resumeSession) {
        resumeAttempted = true;
        opening = await session.preflight(connection.connection.command("session/resume", {
          sessionId, excludeItems: true, ...sessionConfig,
        }), wait, "session/resume", SESSION_OPEN_BUDGET_MS);
      } else {
        try {
          opening = await session.preflight(connection.connection.command("session/start", {
            sessionId,
            workspaceRoot: this.config.workspace,
            ...sessionConfig,
            approvalMode: this.config.approvalMode,
            ...(this.config.model === undefined ? {} : { modelId: this.config.model }),
          }), wait, "session/start", SESSION_OPEN_BUDGET_MS);
        } catch (error) {
          if (!(error instanceof MspError) || error.kind !== "commandRejected"
            || error.data.reason !== "session_id_conflict") throw error;
          resumeAttempted = true;
          opening = await session.preflight(connection.connection.command("session/resume", {
            sessionId, excludeItems: true, ...sessionConfig,
          }), wait, "session/resume", SESSION_OPEN_BUDGET_MS);
        }
      }
      const opened = museObject(opening.session);
      if (opened.sessionId !== sessionId) {
        throw new Error("Muse returned a different native session id");
      }
      if (opened.workspaceRoot !== this.config.workspace) {
        throw new Error("Muse session workspace differs from the configured alias workspace");
      }
      const configured = await session.configure(this.config.model, this.config.reasoningEffort,
        this.config.approvalMode, wait);
      if (configured.workspace !== this.config.workspace) {
        throw new Error("Muse read workspace differs from the configured alias workspace");
      }
      turnAttempted = true;
      await session.submit(request.stdin, this.config.reasoningEffort, wait);
      turnAdmitted = true;
      request.onHarnessStart?.();
      const waitTurn: MuseWait = (promise) => request.timeoutKind === "no-progress"
        ? untilStalled(promise, () => activeSession.lastProgressAt, request.timeoutMs, request.signal)
        : bounded(promise, deadline, request.signal);
      const waitRecovery: MuseWait = (promise, budgetMs = 5_000) => bounded(promise,
        Math.min(request.timeoutKind === "no-progress" ? Infinity : deadline, Date.now() + budgetMs), request.signal);
      const completed = await session.complete(configured.viewCursor, waitTurn, waitRecovery);
      return terminalResult(sessionId, completed.text, completed.outcome);
    } catch (error) {
      if (error instanceof MuseDeadlineError) {
        if (!turnAttempted) {
          throw new ProcessExecutionError("MUSE_PREFLIGHT_TIMEOUT",
            `Muse preflight exceeded its bounded read budget at ${session?.lastPreflightPhase ?? preflightPhase}`, true);
        }
        return result("", { timedOut: true, ...(turnAdmitted ? { harnessStarted: true } : {}) });
      }
      if (error instanceof MuseAbortError) {
        return result("", { cancelled: true, ...(turnAdmitted ? { harnessStarted: true } : {}) });
      }
      if (resumeAttempted && error instanceof MspError && error.kind === "sessionNotFound") {
        return result("", {
          stderr: "Muse session not found: no conversation found with session id",
          exitCode: 1,
          harnessStarted: false,
        });
      }
      if (error instanceof ProcessExecutionError) throw error;
      if (error instanceof MuseMspFault) {
        throw new ProcessExecutionError(turnAttempted ? "MUSE_EXECUTION_AMBIGUOUS" : error.code,
          `Muse ${error.code}: ${safeFailure(error)}`, false);
      }
      throw new ProcessExecutionError(
        turnAttempted ? "MUSE_EXECUTION_AMBIGUOUS" : "MUSE_PREFLIGHT_FAILED",
        turnAttempted
          ? "Muse turn submission or completion was interrupted; execution state is unknown"
          : `Muse preflight failed: ${safeFailure(error)}`,
        !turnAttempted && error instanceof MspError && error.kind === "sessionInUse",
      );
    } finally {
      session?.close();
      if (handshake !== undefined) await handshake.close().catch(() => undefined);
    }
  }
}
