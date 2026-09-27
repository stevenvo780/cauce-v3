import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  MspError,
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
  type Session,
  type TurnOutcome,
} from "@muse-code/sdk";
import { ProcessExecutionError } from "./errors.js";
import type { CommandRunRequest, CommandRunResult } from "./types.js";
import { sanitizeProcessOutput } from "../harnesses/shared/errors.js";

export type MuseReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface MuseRunnerConfig {
  readonly executable: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly workspace: string;
  readonly approvalMode: "denyUnmatched";
  readonly model?: string;
  readonly reasoningEffort?: MuseReasoningEffort;
}

class MuseDeadlineError extends Error {}
class MuseAbortError extends Error {}

function bounded<T>(promise: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MuseAbortError());
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new MuseDeadlineError());
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new MuseDeadlineError()), remaining);
    const onAbort = (): void => rejectResult(new MuseAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolveResult, rejectResult).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
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
    this.config = config;
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (request.harness !== "muse") throw new Error("MuseMspRunner only handles Muse");
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("Muse timeout must be a positive safe integer");
    }
    if (request.signal.aborted) return result("", { cancelled: true, harnessStarted: false });
    const deadline = Date.now() + request.timeoutMs;
    let handshake: ReturnType<typeof spawnMspConnection> | undefined;
    let client: MuseClient | undefined;
    let turnAttempted = false;
    let turnAdmitted = false;
    let resumeAttempted = false;
    try {
      await bounded(validateWorkspace(this.config), deadline, request.signal);
      handshake = spawnMspConnection({
        command: this.config.executable,
        args: ["serve", "--trust-workspace"],
        cwd: this.config.workspace,
        env: hostEnvironment(this.config),
        shutdownTimeoutMs: 2_000,
      });
      handshake.onServerRequest(async (serverRequest) => {
        if (serverRequest.method === "approval/request") return {};
        throw new Error(`Unsupported Muse server request: ${serverRequest.method}`);
      });
      const connection = await bounded(handshake.initialize({
        clientInfo: { name: "cauce_muse", version: "0.2.0" },
        capabilities: { userInputDialogs: false },
      }), deadline, request.signal);
      const durability = readSessionDurability(connection.initializeResult);
      if (durability.kind !== "durable") {
        throw new Error("Muse serve must provide durable sessions");
      }
      client = new MuseClient(connection.connection, { durability, host: connection });
      const sessionId = request.sessionId;
      let session: Session;
      if (request.resumeSession) {
        if (sessionId === undefined) throw new Error("Muse resume requires a durable session id");
        resumeAttempted = true;
        session = await bounded(client.resumeSession({ sessionId, excludeItems: true }), deadline, request.signal);
      } else {
        try {
          session = await bounded(client.startSession({
            ...(sessionId === undefined ? {} : { sessionId }),
            workspaceRoot: this.config.workspace,
            approvalMode: this.config.approvalMode,
            ...(this.config.model === undefined ? {} : { modelId: this.config.model }),
          }), deadline, request.signal);
        } catch (error) {
          if (!(error instanceof MspError) || error.kind !== "commandRejected"
            || error.data.reason !== "session_id_conflict" || sessionId === undefined) throw error;
          resumeAttempted = true;
          session = await bounded(client.resumeSession({ sessionId, excludeItems: true }), deadline, request.signal);
        }
      }
      if (sessionId !== undefined && session.sessionId !== sessionId) {
        throw new Error("Muse returned a different native session id");
      }
      const opened = session.opening?.result.session;
      if (opened?.workspaceRoot !== this.config.workspace) {
        throw new Error("Muse session workspace differs from the configured alias workspace");
      }
      const mode = await bounded(connection.connection.command("session/setApprovalMode", {
        sessionId: session.sessionId,
        mode: this.config.approvalMode,
      }), deadline, request.signal);
      const effective = mode.effectiveMode as { mode?: unknown } | undefined;
      if (mode.status !== "accepted" || effective?.mode !== this.config.approvalMode) {
        throw new Error("Muse did not confirm denyUnmatched approval mode");
      }
      if (this.config.model !== undefined && opened.modelId !== this.config.model) {
        const model = await bounded(connection.connection.command("session/setModel", {
          sessionId: session.sessionId,
          model: { modelId: this.config.model },
        }), deadline, request.signal);
        if (model.status !== "accepted") throw new Error("Muse did not accept the configured model");
      }
      let approvalError: (error: Error) => void = () => undefined;
      const approvalFailed = new Promise<never>((_resolve, rejectApproval) => {
        approvalError = rejectApproval;
      });
      session.onApproval((approval) => {
        const denial = approval.availableChoices.find((choice) =>
          choice.scope === "once" && (choice.decision === "denied" || choice.decision === "abort"));
        if (denial === undefined) throw new Error("Muse approval request offered no denying choice");
        return { choiceId: denial.choiceId };
      });
      session.onApprovalError(() => approvalError(new Error("Muse approval could not be denied")));
      let finalText = "";
      turnAttempted = true;
      const turn = await bounded(session.sendUserTurn({
        input: [{ type: "text", text: request.stdin }],
        ifBusy: "queue",
        ...(this.config.reasoningEffort === undefined
          ? {} : { reasoningEffort: this.config.reasoningEffort }),
      }), deadline, request.signal);
      turnAdmitted = true;
      request.onHarnessStart?.();
      const collect = (async (): Promise<void> => {
        for await (const item of turn.items()) {
          if (item.kind === "agentMessage" && item.status !== "inProgress") {
            finalText = item.text ?? "";
          }
        }
      })();
      const outcome = await bounded(Promise.race([turn.completed, approvalFailed]), deadline, request.signal);
      await bounded(collect, deadline, request.signal);
      return terminalResult(session.sessionId, finalText, outcome);
    } catch (error) {
      if (error instanceof MuseDeadlineError) {
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
      throw new ProcessExecutionError(
        turnAttempted ? "MUSE_EXECUTION_AMBIGUOUS" : "MUSE_PREFLIGHT_FAILED",
        turnAttempted
          ? "Muse turn submission or completion was interrupted; execution state is unknown"
          : `Muse preflight failed: ${safeFailure(error)}`,
        !turnAttempted && error instanceof MspError && error.kind === "sessionInUse",
      );
    } finally {
      if (client !== undefined) await client.close().catch(() => undefined);
      else if (handshake !== undefined) await handshake.close().catch(() => undefined);
    }
  }
}
