import { inputBoxState } from "../pane.js";
import { signalAborted } from "../../runtime-state.js";
import {
  CREATION_NONCE_OPTION,
  PANE_ID_PATTERN,
  SAFE_TMUX_NAME_PATTERN,
  SESSION_ID_PATTERN,
  WINDOW_ID_PATTERN,
  hasSessionId,
  paneIdentity,
  samePaneIdentity,
  type CreatedSessionOwnership,
  type PaneHarnessIdentity,
  type PaneIdentity,
  type TmuxController,
  type TmuxRunControl,
} from "./identity.js";
import {
  INPUT_BARRIER_TOKEN_PATTERN,
  atomicCas,
  exactPaneCondition,
  inputBarrierCondition,
  inputBarrierHooksAreEmpty,
  mutateExactPane,
  mutateUnderInputBarrier,
  probeTmuxFormat,
  type PaneInputBarrier,
  type TmuxMutationState,
} from "./mutation.js";

/**
 * ORIGINAL command that started the pane.
 *
 * For a legacy session it is stronger evidence than `pane_current_command`: the TUI often spawns
 * child processes and that last field can change during a turn. The exact window is listed first
 * because `display-message` silently falls back to another when the name does not exist.
 */
export async function paneStartCommand(
  tmux: TmuxController,
  session: string,
  window: string,
): Promise<string | undefined> {
  if (!await windowExists(tmux, session, window)) return undefined;
  const result = await tmux.run([
    "display-message", "-p", "-t", `${session}:${window}`, "#{pane_start_command}",
  ]);
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.replace(/\r?\n$/u, "");
  return value === "" ? undefined : value;
}

const PANE_HARNESS_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{pane_start_command}",
].join("\t");

export type PaneHarnessInspection =
  | { readonly state: "present"; readonly pane: PaneHarnessIdentity }
  | { readonly state: "absent" }
  | { readonly state: "ambiguous" }
  | { readonly state: "unreadable" };

/**
 * Observes the SOLE pane of a window without using `session:window` as an ambiguous target.
 *
 * `list-panes -s -t $N` enumerates all panes of the exact id; the window name is filtered in
 * memory and cardinality one is required. The row includes PID and original command in the same
 * snapshot, then `%pane_id` is read again: if a `respawn-pane` happened between both reads, the
 * generation no longer matches and it fails closed.
 */
export async function inspectSolePaneHarness(
  tmux: TmuxController,
  sessionId: string,
  windowName: string,
): Promise<PaneHarnessInspection> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return { state: "unreadable" };
  const listed = await tmux.run([
    "list-panes", "-s", "-t", sessionId, "-F", PANE_HARNESS_FORMAT,
  ]);
  if (listed.exitCode !== 0) return { state: "unreadable" };
  const matching = listed.stdout.split(/\r?\n/u).filter((line) => {
    if (line === "") return false;
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    const third = second < 0 ? -1 : line.indexOf("\t", second + 1);
    const fourth = third < 0 ? -1 : line.indexOf("\t", third + 1);
    return third >= 0 && fourth >= 0 && line.slice(third + 1, fourth) === windowName;
  });
  if (matching.length === 0) return { state: "absent" };
  if (matching.length !== 1) return { state: "ambiguous" };

  const fields = matching[0]?.split("\t") ?? [];
  if (fields.length < 8) return { state: "unreadable" };
  const [
    observedSessionId, sessionName, windowId, observedWindow, paneId, processId, dead,
    ...commandFields
  ]
    = fields;
  const command = commandFields.join("\t");
  if (observedSessionId !== sessionId
    || sessionName === undefined || sessionName === ""
    || windowId === undefined || !WINDOW_ID_PATTERN.test(windowId)
    || observedWindow !== windowName
    || paneId === undefined || !PANE_ID_PATTERN.test(paneId)
    || processId === undefined || !/^[0-9]+$/u.test(processId)
    || dead !== "0" || command === "") return { state: "unreadable" };
  const pane: PaneHarnessIdentity = {
    sessionId,
    sessionName,
    windowId,
    windowName,
    paneId,
    panePid: processId,
    paneStartCommand: command,
  };
  const current = await paneIdentity(tmux, paneId);
  return current !== undefined && samePaneIdentity(current, pane)
    ? { state: "present", pane }
    : { state: "unreadable" };
}

/**
 * Undoes only the exact session/pane this call created and marked with its nonce.
 *
 * The tuple of ids/names/PID is fenced inside the `if-shell` together with the cryptographic
 * creation nonce. A `respawn-pane` changes PID and a rename changes logical identity; both pick
 * the rejected branch without first running list/display/show or any other hookable command. The
 * original command still belongs to the persisted ownership, but it does not need to be
 * interpolated (it could contain any shell syntax) because PID + nonce already distinguish the
 * created generation.
 */
export async function killSessionIdIfNamed(
  tmux: TmuxController,
  ownership: CreatedSessionOwnership,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!INPUT_BARRIER_TOKEN_PATTERN.test(ownership.creationNonce)) return false;
  const paneCondition = exactPaneCondition(ownership, "full");
  if (paneCondition === undefined) return false;
  const condition = `#{&&:${paneCondition},`
    + `#{==:#{${CREATION_NONCE_OPTION}},${ownership.creationNonce}}}`;
  // Cryptographic nonce + ids/PID + full names credit the creation attempt. Re-reading
  // list-panes/display/show-options beforehand added no identity: it only opened three hooks
  // before the CAS and allowed effects on a session that would then be rejected.
  const mutation = await atomicCas(
    tmux,
    ownership.paneId,
    condition,
    `kill-session -t ${ownership.sessionId}`,
    control,
  );
  if (mutation.branch === "accepted") return true;
  if (mutation.branch === "rejected") return false;
  // If it was the last session, the server may disappear before the final wait-for. Result 0 +
  // absence of the stable id is the exact postcondition; any other combination fails closed.
  return mutation.result?.exitCode === 0
    && !await hasSessionId(tmux, ownership.sessionId);
}

export async function capturePane(
  tmux: TmuxController,
  target: string,
  options?: { readonly styled?: boolean; readonly control?: TmuxRunControl },
): Promise<string | undefined> {
  // `-e` keeps SGR codes to distinguish style attributes in the pane.
  const args = options?.styled === true
    ? ["capture-pane", "-e", "-p", "-t", target]
    : ["capture-pane", "-p", "-t", target];
  const result = await tmux.run(args, undefined, options?.control);
  return result.exitCode === 0 ? result.stdout : undefined;
}

export async function panePid(tmux: TmuxController, target: string): Promise<string | undefined> {
  const separator = target.lastIndexOf(":");
  if (separator > 0) {
    const session = target.slice(0, separator);
    const window = target.slice(separator + 1);
    if (!await windowExists(tmux, session, window)) return undefined;
  }
  const result = await tmux.run(["display-message", "-p", "-t", target, "#{pane_pid}"]);
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return /^[0-9]+$/u.test(value) ? value : undefined;
}

export async function windowExists(
  tmux: TmuxController,
  session: string,
  window: string,
): Promise<boolean> {
  const target = SESSION_ID_PATTERN.test(session) ? session : `=${session}`;
  const result = await tmux.run(["list-windows", "-t", target, "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split(/\r?\n/u).some((name) => name.trim() === window);
}

export interface PastePromptResult {
  /** `ambiguous` only appears if the transport lost the atomic mutation result. */
  readonly state: "not_pasted" | "pasted" | "ambiguous";
  readonly reason?: "cancelled" | "identity_changed" | "input_busy" | "mutation_rejected";
  /** Postcondition verified: the buffer no longer exists or contains only the harmless marker. */
  readonly bufferScrubbed: boolean;
}

export interface PastePromptOptions extends TmuxRunControl {
  /** Verifies the input box twice: before load-buffer and just before the pane mutation. */
  readonly verifyInputEmpty?: boolean;
  /** Already-acquired exclusion; mandatory when verifying the input box. */
  readonly inputBarrier?: PaneInputBarrier;
}

const SCRUBBED_BUFFER_CONTENT = "CAUCE_BUFFER_SCRUBBED";

async function namedBufferState(
  tmux: TmuxController,
  buffer: string,
  control?: TmuxRunControl,
): Promise<"absent" | "present" | "unreadable"> {
  try {
    const listed = await tmux.run(
      ["list-buffers", "-F", "#{buffer_name}"],
      undefined,
      control,
    );
    if (listed.exitCode !== 0) return "unreadable";
    return listed.stdout.split(/\r?\n/u).some((name) => name === buffer)
      ? "present"
      : "absent";
  } catch {
    return "unreadable";
  }
}

/**
 * Deletes the global buffer, or if tmux refuses, replaces its content with a marker.
 *
 * Never returns the read content: the prompt can contain private data. The `show-buffer` only
 * credits locally that the harmless overwrite happened; any other value is discarded.
 */
async function scrubNamedBuffer(
  tmux: TmuxController,
  buffer: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  try {
    await tmux.run(["delete-buffer", "-b", buffer], undefined, control);
    const afterDelete = await namedBufferState(tmux, buffer, control);
    if (afterDelete === "absent") return true;

    const overwritten = await tmux.run(
      ["load-buffer", "-b", buffer, "-"],
      SCRUBBED_BUFFER_CONTENT,
      control,
    );
    if (overwritten.exitCode !== 0) return false;
    const verified = await tmux.run(["show-buffer", "-b", buffer], undefined, control);
    if (verified.exitCode !== 0 || verified.stdout !== SCRUBBED_BUFFER_CONTENT) return false;

    // The marker is already safe, but the stronger postcondition is also attempted.
    await tmux.run(["delete-buffer", "-b", buffer], undefined, control);
    const finalState = await namedBufferState(tmux, buffer, control);
    if (finalState === "absent") return true;
    if (finalState !== "present") return false;
    const finalVerification = await tmux.run(
      ["show-buffer", "-b", buffer],
      undefined,
      control,
    );
    return finalVerification.exitCode === 0
      && finalVerification.stdout === SCRUBBED_BUFFER_CONTENT;
  } catch {
    return false;
  }
}

export async function pastePrompt(
  tmux: TmuxController,
  identity: PaneIdentity,
  buffer: string,
  text: string,
  options: PastePromptOptions = {},
): Promise<PastePromptResult> {
  if (!SAFE_TMUX_NAME_PATTERN.test(buffer)) {
    return { state: "not_pasted", bufferScrubbed: false };
  }
  let state: PastePromptResult["state"] = "not_pasted";
  let reason: PastePromptResult["reason"];
  const mutationControl: TmuxRunControl = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  // Cleanup ignores the delivery's cancellation: it must still delete or neutralize the buffer.
  const cleanupControl: TmuxRunControl = options.timeoutMs === undefined
    ? {}
    : { timeoutMs: options.timeoutMs };
  try {
    if (signalAborted(options.signal)) {
      reason = "cancelled";
    } else {
      const firstGuard = options.verifyInputEmpty === false
        ? "ready"
        : await pastePrecondition(tmux, identity, options.inputBarrier, mutationControl);
      if (firstGuard !== "ready") {
        state = firstGuard === "unreadable" ? "ambiguous" : "not_pasted";
        reason = firstGuard === "unreadable" ? undefined : pasteGuardReason(firstGuard);
      } else {
        // `capture-pane` from the previous guard has its own hook. The catalog is re-read after the
        // capture and just before `load-buffer`, the surface that originated R11.
        const hooksSafeBeforeLoad = options.inputBarrier === undefined
          || await inputBarrierHooksAreEmpty(tmux, identity.paneId, mutationControl);
        const load = hooksSafeBeforeLoad
          ? await tmux.run(
            ["load-buffer", "-b", buffer, "-"],
            text,
            mutationControl,
          )
          : { exitCode: 78, stdout: "", stderr: "unsafe_hooks" };
        if (load.exitCode !== 0) {
          // Only 78 is an explicit denial. null, exception, and any other result may have reached the
          // server and are treated as ambiguous.
          state = load.exitCode === 78 ? "not_pasted" : "ambiguous";
          reason = load.exitCode === 78 ? "mutation_rejected" : undefined;
        } else if (signalAborted(options.signal)) {
          // load-buffer finished, but paste-buffer has not yet been invoked: no input reached the pane.
          state = "not_pasted";
          reason = "cancelled";
        } else {
          const finalGuard = options.verifyInputEmpty === false
            ? "ready"
            : await pastePrecondition(tmux, identity, options.inputBarrier, mutationControl);
          if (finalGuard !== "ready") {
            state = finalGuard === "unreadable" ? "ambiguous" : "not_pasted";
            reason = finalGuard === "unreadable" ? undefined : pasteGuardReason(finalGuard);
          } else {
            const mutation = options.inputBarrier === undefined
              ? await mutateExactPane(
                tmux,
                identity,
                `paste-buffer -b ${buffer} -t ${identity.paneId} -p -d`,
                mutationControl,
                "full",
              )
              : await mutateUnderInputBarrier(
                tmux,
                options.inputBarrier,
                `paste-buffer -b ${buffer} -t ${identity.paneId} -p -d`,
                mutationControl,
                "full",
              );
            state = mutation === "applied"
              ? "pasted"
              : mutation === "not_applied" ? "not_pasted" : "ambiguous";
            if (mutation === "not_applied") reason = "mutation_rejected";
          }
        }
      }
    }
  } catch {
    state = "ambiguous";
  }
  // Scrub is part of the result, even with abort, replaced target, or exception.
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    bufferScrubbed: await scrubNamedBuffer(tmux, buffer, cleanupControl),
  };
}

type PastePrecondition = "ready" | "identity_changed" | "input_busy" | "unreadable";

/**
 * Snapshot immediately before the paste, already under human-keyboard exclusion.
 *
 * `select-pane -d` already blocks a client from delivering keystrokes. Then generation, token,
 * mode and flag are compared before capturing; `paste-buffer` itself re-fences those values and
 * enables→pastes→disables inside its `if-shell`. If anyone releases/replaces the barrier between
 * capture and paste, the negative witness credits the rejection and does not paste.
 */
async function pastePrecondition(
  tmux: TmuxController,
  identity: PaneIdentity,
  barrier: PaneInputBarrier | undefined,
  control: TmuxRunControl,
): Promise<PastePrecondition> {
  if (barrier === undefined || !samePaneIdentity(barrier.identity, identity)) return "unreadable";
  // `capture-pane` triggers `after-capture-pane`; all effective configuration must be rejected
  // before reading the input box, not just before the final paste.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "unreadable";
  const paneCondition = exactPaneCondition(identity, "full");
  const barrierCondition = inputBarrierCondition(barrier);
  if (paneCondition === undefined || barrierCondition === undefined) return "unreadable";
  const ready = await probeTmuxFormat(
    tmux,
    identity.paneId,
    `#{&&:${paneCondition},${barrierCondition}}`,
    control,
  );
  if (ready !== true) {
    // Exact denial doesn't use display/list/show: it distinguishes a replacement from a changed
    // barrier without offering `after-display-message` a surface to mutate the TUI.
    if (ready === false
      && await probeTmuxFormat(tmux, identity.paneId, paneCondition, control) === false) {
      return "identity_changed";
    }
    return "unreadable";
  }
  const pane = await capturePane(tmux, identity.paneId, { styled: true, control });
  if (pane === undefined) return "unreadable";
  return inputBoxState(pane).occupied ? "input_busy" : "ready";
}

function pasteGuardReason(
  guard: Exclude<PastePrecondition, "ready" | "unreadable">,
): PastePromptResult["reason"] {
  return guard === "input_busy" ? "input_busy" : "identity_changed";
}

export async function sendEnter(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
  barrier?: PaneInputBarrier,
): Promise<TmuxMutationState> {
  return barrier === undefined
    ? mutateExactPane(
      tmux,
      identity,
      `send-keys -t ${identity.paneId} Enter`,
      control,
      "process",
    )
    : mutateUnderInputBarrier(
      tmux,
      barrier,
      `send-keys -t ${identity.paneId} Enter`,
      control,
      "process",
    );
}

/** Interrupts the TUI by its exact pane id; never by session or window name. */
export async function interruptPane(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  return mutateExactPane(
    tmux,
    identity,
    `send-keys -t ${identity.paneId} Escape`,
    control,
  );
}

/** Kills only the credited generation; used when neither tmux nor disk can persist quarantine. */
export async function killPaneGeneration(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  return mutateExactPane(
    tmux,
    identity,
    `kill-pane -t ${identity.paneId}`,
    control,
    "process",
    undefined,
    true,
  );
}

/**
 * Announces a degradation in the tmux session by applying visual warning styles.
 */
export async function announceDegradation(
  tmux: TmuxController,
  session: string,
  window: string,
  summary: string,
  control?: TmuxRunControl,
): Promise<void> {
  await announceNotice(tmux, session, window, summary, control);
  await tmux.run([
    "set-option", "-w", "-t", `${session}:${window}`, "window-status-style", "bg=red,fg=white",
  ], undefined, control).catch(() => undefined);
  await tmux.run(
    ["set-option", "-t", session, "status-style", "bg=red,fg=white"],
    undefined,
    control,
  )
    .catch(() => undefined);
}

/**
 * EPHEMERAL notice, no red.
 *
 * For events that are NOT a fallback: the turn did go through the terminal, but its memory
 * changed (cleared with `/clear`, compacted, or the session had just been created). Tinting the
 * bar red there would be lying the other way —the mechanism works— and would leave red stuck on
 * a healthy pane.
 */
export async function announceNotice(
  tmux: TmuxController,
  session: string,
  window: string,
  summary: string,
  control?: TmuxRunControl,
): Promise<void> {
  const oneLine = summary.replace(/\s+/gu, " ").slice(0, 200);
  await tmux.run(
    ["display-message", "-t", `${session}:${window}`, "-d", "15000", oneLine],
    undefined,
    control,
  )
    .catch(() => undefined);
}

/** Removes the red when a turn returns to the shared session. */
export async function clearDegradation(
  tmux: TmuxController,
  session: string,
  window: string,
  control?: TmuxRunControl,
): Promise<void> {
  await tmux.run(
    ["set-option", "-w", "-t", `${session}:${window}`, "-u", "window-status-style"],
    undefined,
    control,
  )
    .catch(() => undefined);
  await tmux.run(
    ["set-option", "-t", session, "-u", "status-style"],
    undefined,
    control,
  ).catch(() => undefined);
}

/**
 * Undoes the lock-in left by the previous version.
 *
 * A session that already degraded with the old build has its window renamed to
 * `⚠ CAUCE-DEGRADADO` and is doomed: it will never find the TUI again. It is repaired by giving
 * the name back, and only in the exact case —the good window absent and the renamed one
 * present— so a window the owner has named themselves is never touched.
 *
 * Returns `true` if anything was repaired, so it can be said instead of being silently fixed.
 */
export async function repairLegacyDegradedWindow(
  tmux: TmuxController,
  session: string,
  window: string,
  legacyName: string,
): Promise<boolean> {
  const target = SESSION_ID_PATTERN.test(session) ? session : `=${session}`;
  const result = await tmux.run(["list-windows", "-t", target, "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return false;
  const names = result.stdout.split(/\r?\n/u).map((name) => name.trim());
  if (names.includes(window) || !names.includes(legacyName)) return false;
  const renamed = await tmux.run([
    "rename-window", "-t", `${session}:${legacyName}`, window,
  ]).catch(() => undefined);
  return renamed?.exitCode === 0;
}
