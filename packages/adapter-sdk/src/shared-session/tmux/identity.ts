import { spawn } from "node:child_process";
import { signalAborted } from "../../runtime-state.js";
import { TMUX_SOCKET } from "../types.js";

export interface TmuxResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TmuxRunControl {
  /** Cancels and reaps the tmux client; never means the server didn't get to mutate. */
  readonly signal?: AbortSignal;
  /** Client process ceiling. On expiry TERM is sent, then KILL, and `close` is awaited. */
  readonly timeoutMs?: number;
}

/**
 * The tmux surface used by the shared session, as an interface so it can be substituted.
 *
 * It exists separately from the runner because it is the ONLY part that needs a real tmux: with
 * this behind an interface, transcript harvesting, input-box arbitration, and degradation are
 * tested with real files and without a terminal.
 */
export interface TmuxController {
  run(args: readonly string[], stdin?: string, control?: TmuxRunControl): Promise<TmuxResult>;
}

export function withoutLifecycleIdentity(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  delete copy.CAUCE_ALIAS;
  delete copy.CAUCE_STATE_DIR;
  delete copy.CAUCE_CONTROL_DIR;
  delete copy.CAUCE_CONTAINER_ID;
  delete copy.CAUCE_CONTAINER_GENERATION;
  return copy;
}

/**
 * Real tmux, no shell.
 *
 * `shell: false` is not decoration: the protocol prompt enters via `load-buffer` from stdin, and
 * never via argv, like `SpawnCommandRunner` does. Nothing from a delivery is interpolated into a
 * command line.
 */
export class CliTmux implements TmuxController {
  constructor(
    private readonly socket: string = TMUX_SOCKET,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly defaultTimeoutMs = 10_000,
    private readonly executable = "tmux",
  ) {}

  run(
    args: readonly string[],
    stdin?: string,
    control: TmuxRunControl = {},
  ): Promise<TmuxResult> {
    if (signalAborted(control.signal)) {
      return Promise.resolve({ exitCode: null, stdout: "", stderr: "tmux client aborted" });
    }
    return new Promise<TmuxResult>((resolveRun) => {
      const child = spawn(this.executable, ["-L", this.socket, ...args], {
        shell: false,
        env: withoutLifecycleIdentity(this.environment),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let spawnError: Error | undefined;
      let termination: "aborted" | "timed_out" | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      const timeoutMs = Math.max(1, control.timeoutMs ?? this.defaultTimeoutMs);
      const stopClient = (reason: "aborted" | "timed_out"): void => {
        if (termination !== undefined) return;
        termination = reason;
        child.stdin.destroy();
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          child.kill("SIGKILL");
        }, TMUX_CLIENT_TERM_GRACE_MS);
      };
      const aborted = (): void => {
        stopClient("aborted");
      };
      control.signal?.addEventListener("abort", aborted, { once: true });
      // The signal can abort between the pre-spawn check and the listener registration. Re-reading
      // it after registering closes that window without leaving an orphan client.
      if (signalAborted(control.signal)) aborted();
      const timeout = setTimeout(() => {
        stopClient("timed_out");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error: Error) => {
        spawnError = error;
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        control.signal?.removeEventListener("abort", aborted);
        if (termination !== undefined) {
          resolveRun({
            exitCode: null,
            stdout,
            stderr: stderr === "" ? `tmux client ${termination}` : stderr,
          });
          return;
        }
        resolveRun({
          exitCode: spawnError === undefined ? exitCode : 127,
          stdout,
          stderr: stderr === "" && spawnError !== undefined ? spawnError.message : stderr,
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "", "utf8");
    });
  }
}

const TMUX_CLIENT_TERM_GRACE_MS = 50;

export async function hasSession(tmux: TmuxController, session: string): Promise<boolean> {
  const result = await tmux.run(["has-session", "-t", `=${session}`]);
  return result.exitCode === 0;
}

export const SESSION_ID_PATTERN = /^\$[0-9]+$/u;
export const WINDOW_ID_PATTERN = /^@[0-9]+$/u;
export const PANE_ID_PATTERN = /^%[0-9]+$/u;
export const SAFE_TMUX_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/u;

/**
 * Full identity of one pane generation.
 *
 * Neither the session name, nor `$N`, nor `%N` is enough on its own: tmux keeps the pane id
 * across `respawn-pane`, and renumbers sessions/panes from zero after the server restarts. The
 * full tuple lets us target by `%pane_id` and, at the same time, detect that the target now
 * belongs to another conversation or another process.
 */
export interface PaneIdentity {
  readonly sessionId: string;
  readonly sessionName: string;
  /** Stable window id; the name is mutable metadata and doesn't fence respawn/rename. */
  readonly windowId: string;
  readonly windowName: string;
  readonly paneId: string;
  readonly panePid: string;
}

/** Process identity together with the ORIGINAL command observed for that same generation. */
export interface PaneHarnessIdentity extends PaneIdentity {
  readonly paneStartCommand: string;
}

/** Non-transferable identity of a session created by ONE `ensure` attempt. */
export interface CreatedSessionOwnership extends PaneHarnessIdentity {
  readonly creationNonce: string;
}

export const CREATION_NONCE_OPTION = "@cauce_creation_nonce";

const PANE_IDENTITY_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
].join("\t");

export const QUARANTINED_PANE_OPTION = "@cauce_quarantined_pane";

/** A tmux `$N` id is exact; unlike a name, it never allows prefix-matching. */
export async function hasSessionId(tmux: TmuxController, sessionId: string): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  const result = await tmux.run(["has-session", "-t", sessionId]);
  return result.exitCode === 0;
}

/** Resolves a name by exact equality to tmux's stable id (`$0`, `$1`, ...). */
export async function exactSessionTarget(
  tmux: TmuxController,
  session: string,
): Promise<string | undefined> {
  const result = await tmux.run(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
  if (result.exitCode !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("\t");
    if (separator < 0 || line.slice(0, separator) !== session) continue;
    const identifier = line.slice(separator + 1);
    return SESSION_ID_PATTERN.test(identifier) ? identifier : undefined;
  }
  return undefined;
}

/**
 * Credits both life and identity at once: the name still resolves to the SAME `$N`.
 *
 * `has-session -t =name` only proves something with that name exists. If the TUI died and
 * another session took the name between two awaits, operating by name pastes into the new one.
 */
export async function sessionIdStillNamed(
  tmux: TmuxController,
  session: string,
  sessionId: string,
): Promise<boolean> {
  return SESSION_ID_PATTERN.test(sessionId)
    && await exactSessionTarget(tmux, session) === sessionId;
}

/** Reads once all the identity tmux attributes to the exact target. */
export async function paneIdentity(
  tmux: TmuxController,
  target: string,
  control?: TmuxRunControl,
): Promise<PaneIdentity | undefined> {
  const result = await tmux.run(
    ["display-message", "-p", "-t", target, PANE_IDENTITY_FORMAT],
    undefined,
    control,
  );
  if (result.exitCode !== 0) return undefined;
  return parsePaneIdentity(result.stdout);
}

function parsePaneIdentity(stdout: string): PaneIdentity | undefined {
  const fields = stdout.replace(/\r?\n$/u, "").split("\t");
  if (fields.length !== 7) return undefined;
  const [sessionId, sessionName, windowId, windowName, paneId, processId, dead] = fields;
  if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)
    || sessionName === undefined || sessionName === ""
    || windowId === undefined || !WINDOW_ID_PATTERN.test(windowId)
    || windowName === undefined || windowName === ""
    || paneId === undefined || !PANE_ID_PATTERN.test(paneId)
    || processId === undefined || !/^[0-9]+$/u.test(processId)
    || dead !== "0") return undefined;
  return { sessionId, sessionName, windowId, windowName, paneId, panePid: processId };
}

export type ExactPaneInspection =
  | { readonly state: "present"; readonly identity: PaneIdentity }
  | { readonly state: "absent" }
  | { readonly state: "unreadable" };

/**
 * Distinguishes a credited disappearance from a read failure.
 *
 * `display-message` uses the exact `%N` target; on failure, `list-panes -a` checks whether the
 * server can still enumerate panes. Only that enumeration succeeding WITHOUT `%N` asserts `absent`.
 */
export async function inspectExactPane(
  tmux: TmuxController,
  paneId: string,
  control?: TmuxRunControl,
): Promise<ExactPaneInspection> {
  if (!PANE_ID_PATTERN.test(paneId)) return { state: "unreadable" };
  try {
    const displayed = await tmux.run([
      "display-message", "-p", "-t", paneId, PANE_IDENTITY_FORMAT,
    ], undefined, control);
    if (displayed.exitCode === 0) {
      const identity = parsePaneIdentity(displayed.stdout);
      return identity === undefined
        ? { state: "unreadable" }
        : { state: "present", identity };
    }
    const listed = await tmux.run(
      ["list-panes", "-a", "-F", "#{pane_id}"],
      undefined,
      control,
    );
    if (listed.exitCode !== 0) return { state: "unreadable" };
    return listed.stdout.split(/\r?\n/u).some((candidate) => candidate === paneId)
      ? { state: "unreadable" }
      : { state: "absent" };
  } catch {
    return { state: "unreadable" };
  }
}

/** Also compares PID: `respawn-pane` keeps `%N` but no longer keeps the conversation. */
export function samePaneIdentity(left: PaneIdentity, right: PaneIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.sessionName === right.sessionName
    && left.windowId === right.windowId
    && left.windowName === right.windowName
    && left.paneId === right.paneId
    && left.panePid === right.panePid;
}

/** Same process/pane even if a human renamed the session or the window. */
export function samePaneProcess(left: PaneIdentity, right: PaneIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.windowId === right.windowId
    && left.paneId === right.paneId
    && left.panePid === right.panePid;
}

/** Revalidates using `%pane_id`, which admits no name/prefix fallback. */
export async function paneIdentityStillCurrent(
  tmux: TmuxController,
  expected: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  const current = await paneIdentity(tmux, expected.paneId, control);
  return current !== undefined && samePaneIdentity(current, expected);
}

export function paneGeneration(identity: PaneIdentity): string {
  return `${identity.sessionId}:${identity.windowId}:${identity.paneId}:${identity.panePid}`;
}

/** Non-sensitive stable key used by both disk and tmux to identify the same generation. */
export function paneGenerationKey(identity: PaneIdentity): string {
  return paneGeneration(identity);
}
