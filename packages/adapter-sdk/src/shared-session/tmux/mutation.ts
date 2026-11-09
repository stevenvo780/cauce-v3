import { randomBytes } from "node:crypto";
import {
  PANE_ID_PATTERN,
  QUARANTINED_PANE_OPTION,
  SAFE_TMUX_NAME_PATTERN,
  SESSION_ID_PATTERN,
  WINDOW_ID_PATTERN,
  hasSessionId,
  paneGeneration,
  type PaneIdentity,
  type TmuxController,
  type TmuxResult,
  type TmuxRunControl,
} from "./identity.js";

/**
 * Runs a mutation only if tmux evaluates the generation within the SAME server command.
 *
 * `display-message` followed by `send-keys` has TOCTOU: `respawn-pane` keeps `%N`. `if-shell -F`
 * evaluates PID/session/pane and queues the mutation as a single server command. Each branch
 * signals a distinct cryptographic `wait-for` channel: `wait-for` doesn't write to the UI nor
 * has an `after-*` hook in tmux 3.4. Matters because failed `run-shell` and `display-message -p`
 * /`list-panes -F` can trigger view/copy-mode, inject keys, or tamper with stdout via hooks
 * even when the CAS rejected the mutation.
 */
export type TmuxMutationState = "applied" | "not_applied" | "ambiguous";

type CasBranch = "accepted" | "rejected";

interface CasWitness {
  readonly acceptedChannel: string;
  readonly rejectedChannel: string;
  readonly acceptedCommand: string;
  readonly rejectedCommand: string;
}

const CAS_WITNESS_SETTLE_MS = 100;
/**
 * Floor for the witness waiters. Above it they follow the deadline of the command they witness:
 * a waiter that gave up first turned a CAS that tmux DID run within its own deadline into
 * `ambiguous`. On a host starved of I/O (Praxis 9-nov, backup verification at load ~13)
 * just spawning the three clients took over a second. `finish` still reaps both waiters right
 * after the command returns, so a longer life never makes the happy path slower.
 */
const CAS_WITNESS_MIN_TIMEOUT_MS = 1_000;

function casWitness(): CasWitness {
  const nonce = randomBytes(32).toString("hex");
  const acceptedChannel = `cauce-cas-v2-${nonce}-accepted`;
  const rejectedChannel = `cauce-cas-v2-${nonce}-rejected`;
  return {
    acceptedChannel,
    rejectedChannel,
    acceptedCommand: `wait-for -S ${acceptedChannel}`,
    rejectedCommand: `wait-for -S ${rejectedChannel}`,
  };
}

function exactWaitForResult(result: TmuxResult): boolean {
  return result.exitCode === 0 && result.stdout === "" && result.stderr === "";
}

interface CasObservation {
  finish(): Promise<CasBranch | undefined>;
}

/**
 * Registers both waiters BEFORE the CAS. Signal doesn't depend on stdout and survives until its
 * waiter consumes it; pre-starting the clients also covers `kill-pane`/`kill-session` of the
 * last pane, where the server may disappear right after the mutation.
 */
function observeCasWitness(
  tmux: TmuxController,
  witness: CasWitness,
  commandTimeoutMs?: number,
): CasObservation {
  const acceptedAbort = new AbortController();
  const rejectedAbort = new AbortController();
  const waiterTimeoutMs = Math.max(CAS_WITNESS_MIN_TIMEOUT_MS, commandTimeoutMs ?? 0);
  const accepted = tmux.run(
    ["wait-for", witness.acceptedChannel],
    undefined,
    { signal: acceptedAbort.signal, timeoutMs: waiterTimeoutMs },
  );
  const rejected = tmux.run(
    ["wait-for", witness.rejectedChannel],
    undefined,
    { signal: rejectedAbort.signal, timeoutMs: waiterTimeoutMs },
  );
  let finished = false;
  return {
    async finish(): Promise<CasBranch | undefined> {
      if (finished) return undefined;
      finished = true;
      const successes = Promise.any([
        accepted.then((result) => {
          if (!exactWaitForResult(result)) throw new Error("accepted witness unavailable");
          return "accepted" as const;
        }),
        rejected.then((result) => {
          if (!exactWaitForResult(result)) throw new Error("rejected witness unavailable");
          return "rejected" as const;
        }),
      ]).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settleDeadline = new Promise<undefined>((resolveDeadline) => {
        timer = setTimeout(() => {
          resolveDeadline(undefined);
        }, CAS_WITNESS_SETTLE_MS);
      });
      const branch = await Promise.race([successes, settleDeadline]);
      if (timer !== undefined) clearTimeout(timer);
      acceptedAbort.abort();
      rejectedAbort.abort();
      // CliTmux reaps immediately on abort. A faulty wrapper may not forward `control`; that
      // wrapper must not turn an already-credited witness into a 10s wait. The promises keep
      // their handler and own timeout, so they don't leave rejections either.
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([accepted, rejected]),
        new Promise<void>((resolveReapDeadline) => {
          reapTimer = setTimeout(resolveReapDeadline, CAS_WITNESS_SETTLE_MS);
        }),
      ]);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      return branch;
    },
  };
}

interface AtomicCasResult {
  readonly branch?: CasBranch;
  readonly result?: TmuxResult;
}

/** Runs compare-and-mutate and credits the branch with no pane-observable command. */
export async function atomicCas(
  tmux: TmuxController,
  target: string,
  condition: string,
  command: string,
  control?: TmuxRunControl,
): Promise<AtomicCasResult> {
  const witness = casWitness();
  const observation = observeCasWitness(tmux, witness, control?.timeoutMs);
  let result: TmuxResult | undefined;
  try {
    result = await tmux.run([
      "if-shell", "-F", "-t", target, condition,
      command === "" ? witness.acceptedCommand : `${command} ; ${witness.acceptedCommand}`,
      witness.rejectedCommand,
    ], undefined, control);
  } catch {
    const branch = await observation.finish();
    return branch === undefined ? {} : { branch };
  }
  const branch = await observation.finish();
  return branch === undefined ? { result } : { result, branch };
}

/** Evaluates a boolean format without `display-message`, `list-*`, stdout, or read hooks. */
export async function probeTmuxFormat(
  tmux: TmuxController,
  target: string,
  condition: string,
  control?: TmuxRunControl,
): Promise<boolean | undefined> {
  const observed = await atomicCas(tmux, target, condition, "", control);
  if (observed.branch === "accepted") return true;
  if (observed.branch === "rejected") return false;
  return undefined;
}

export function exactPaneCondition(
  identity: PaneIdentity,
  logicalIdentity: "process" | "full",
): string | undefined {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)
    || !WINDOW_ID_PATTERN.test(identity.windowId)
    || !PANE_ID_PATTERN.test(identity.paneId)
    || !/^[0-9]+$/u.test(identity.panePid)
    || (logicalIdentity === "full"
    && (!SAFE_TMUX_NAME_PATTERN.test(identity.sessionName)
      || !SAFE_TMUX_NAME_PATTERN.test(identity.windowName)))) return undefined;
  const processCondition = `#{&&:#{==:#{session_id},${identity.sessionId}},`
    + `#{&&:#{==:#{window_id},${identity.windowId}},#{&&:#{==:#{pane_id},${identity.paneId}},`
    + `#{==:#{pane_pid},${identity.panePid}}}}}`;
  return logicalIdentity === "process"
    ? processCondition
    : `#{&&:${processCondition},#{&&:#{==:#{session_name},${identity.sessionName}},`
      + `#{==:#{window_name},${identity.windowName}}}}`;
}

export async function mutateExactPane(
  tmux: TmuxController,
  identity: PaneIdentity,
  command: string,
  control?: TmuxRunControl,
  logicalIdentity: "process" | "full" = "process",
  additionalCondition?: string,
  acceptsSessionDisappearance = false,
): Promise<TmuxMutationState> {
  const paneCondition = exactPaneCondition(identity, logicalIdentity);
  if (paneCondition === undefined) return "ambiguous";
  const condition = additionalCondition === undefined
    ? paneCondition
    : `#{&&:${paneCondition},${additionalCondition}}`;
  const mutation = await atomicCas(tmux, identity.paneId, condition, command, control);
  if (mutation.branch === "accepted") return "applied";
  if (mutation.branch === "rejected") return "not_applied";
  // `kill-pane` on the last pane destroys the server before the final wait-for. Only that
  // surface accepts as alternative evidence: exit 0 + exact disappearance of the session id.
  if (acceptsSessionDisappearance && mutation.result?.exitCode === 0
    && !await hasSessionId(tmux, identity.sessionId)) return "applied";
  return "ambiguous";
}

const INPUT_BARRIER_OPTION = "@cauce_input_barrier";
export const INPUT_BARRIER_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export interface PaneInputBarrier {
  readonly identity: PaneIdentity;
  /** Non-sensitive token preventing a foreign `finally` from unlocking the pane. */
  readonly token: string;
}

export function inputBarrierCondition(barrier: PaneInputBarrier): string | undefined {
  return INPUT_BARRIER_TOKEN_PATTERN.test(barrier.token)
    ? `#{&&:#{==:#{pane_input_off},1},`
      + `#{&&:#{==:#{pane_in_mode},0},`
      + `#{==:#{${INPUT_BARRIER_OPTION}},${barrier.token}}}}`
    : undefined;
}

/**
 * Runs technical input without opening an interleavable window to human clients.
 *
 * The pane stays `input_off` between operations. Inside this single queue: enable, run exactly
 * one mutation, disable again. The relevant hooks were rejected before acquiring the barrier:
 * without a hook waiting, tmux processes the whole queue before reading another client's input.
 * A hookless `if-shell` probe then credits that nothing remained enabled.
 */
export async function mutateUnderInputBarrier(
  tmux: TmuxController,
  barrier: PaneInputBarrier,
  command: string,
  control?: TmuxRunControl,
  logicalIdentity: "process" | "full" = "process",
): Promise<TmuxMutationState> {
  const { identity } = barrier;
  // Re-reading just before each mutation also covers hooks added during settle. tmux does not
  // offer a transactional lock against an administrator running `set-hook` on the same socket
  // AFTER this read and BEFORE the if-shell; that privileged control-plane access is the real
  // protocol limit. On observable hooks, fail closed without opening input.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "not_applied";
  const paneCondition = exactPaneCondition(identity, logicalIdentity);
  const barrierCondition = inputBarrierCondition(barrier);
  if (paneCondition === undefined || barrierCondition === undefined) return "ambiguous";
  const condition = `#{&&:${paneCondition},${barrierCondition}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `select-pane -e -t ${identity.paneId} ; ${command}`
      + ` ; select-pane -d -t ${identity.paneId}`,
    control,
  );
  // The `accepted` witness is queued AFTER returning to `input_off`; if paste/send/select fails,
  // tmux cuts the list before signalling it. The postcondition is credited with another atomic
  // format, not with a read that could trigger a hook.
  if (mutation.branch === "accepted") {
    // Names are human metadata and can change as soon as the paste finishes. The `full`
    // precondition blocked pasting into another conversation; the postcondition must follow the
    // SAME process, like release, so a later rename isn't declared ambiguous after an applied mutation.
    const processCondition = exactPaneCondition(identity, "process");
    if (processCondition === undefined) return "ambiguous";
    const postcondition = `#{&&:${processCondition},${barrierCondition}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? "applied"
      : "ambiguous";
  }
  if (mutation.branch === "rejected") return "not_applied";
  return "ambiguous";
}

type PaneInputBarrierAcquireResult =
  | { readonly state: "acquired"; readonly barrier: PaneInputBarrier }
  | { readonly state: "busy" }
  | { readonly state: "not_applied" }
  | { readonly state: "unsafe_hooks" }
  | {
    readonly state: "ambiguous";
    /**
     * False when the uncertainty came before the barrier CAS was sent, or the CAS witnessed its
     * rejected branch: then the pane was provably left untouched. True only when the CAS may have
     * run (lost witness, or accepted without a credited postcondition); see
     * `resolveAmbiguousBarrierAcquisition`.
     */
    readonly mutationMayHaveApplied: boolean;
  };

/** tmux format true when ANY input exclusion (barrier option, `input_off`, copy/view-mode) is present. */
const INPUT_BARRIER_BUSY_CONDITION = `#{||:#{!=:#{pane_input_off},0},`
  + `#{||:#{!=:#{pane_in_mode},0},#{!=:#{${INPUT_BARRIER_OPTION}},}}}`;

const EMPTY_TMUX_HOOK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * A tmux queue only excludes other clients if there is NO effective hook that can run commands
 * while the barrier lives. Enumerating the obvious commands is not enough: `after-load-buffer`
 * can paste and send the prompt before our paste, `after-capture-pane` can mutate the box during
 * its verification, and async events like `client-focus-in` can fire without Cauce invoking the
 * command that names them.
 *
 * Therefore the full catalog that tmux itself publishes in the four scopes is inspected. A bare
 * line is only the name of an empty hook; any index/command, continuation, or unknown form means
 * executable configuration and fails closed. The catalog is discovered at runtime so a hook
 * added by a future tmux version is not left out of a static list again. Cauce never uninstalls
 * or restores hooks: they are the administrator's foreign state.
 */
export async function inputBarrierHooksAreEmpty(
  tmux: TmuxController,
  paneId: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  const scopes = [
    ["-g"],
    [],
    ["-w"],
    ["-p"],
  ] as const;
  try {
    for (const scope of scopes) {
      const result = await tmux.run(
        ["show-hooks", ...scope, "-t", paneId],
        undefined,
        control,
      );
      if (result.exitCode !== 0) return false;
      const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== "");
      // The global scope enumerates the built-in catalog even when empty. A 0 without that catalog
      // does not credit that the read was complete.
      if (scope[0] === "-g" && lines.length === 0) return false;
      if (lines.some((line) => !EMPTY_TMUX_HOOK_NAME_PATTERN.test(line))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** `show-hooks` has no `after-show-hooks` hook; the side-effect-free preflight of the control plane. */
async function tmuxHooksAreEmpty(
  tmux: TmuxController,
  paneId: string,
  hooks: readonly string[],
  control?: TmuxRunControl,
): Promise<boolean> {
  const scopes = [
    ["-g"],
    [],
    ["-w"],
    ["-p"],
  ] as const;
  try {
    for (const hook of hooks) {
      for (const scope of scopes) {
        const result = await tmux.run(
          ["show-hooks", ...scope, "-t", paneId, hook],
          undefined,
          control,
        );
        if (result.exitCode !== 0) return false;
        const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== "");
        if (lines.some((line) => line !== hook)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Excludes the keyboard of ALL human clients before the final capture.
 *
 * `select-pane -d` drops both human keyboard and `paste-buffer`/`send-keys`. If both arrive at
 * once, Cauce wins the exclusion and the human byte is discarded (not queued for later); it is
 * never concatenated nor produces a second execution. Hence every technical mutation enables,
 * mutates, and disables again inside ONE hookless queue. The 0→1 transition and the token live
 * in the same `if-shell` fenced by session/window/pane/PID; two runners cannot acquire it at
 * once. A pane already `input_off` is treated as busy: a foreign barrier is never adopted.
 */
export async function acquirePaneInputBarrier(
  tmux: TmuxController,
  identity: PaneIdentity,
  token: string,
  control?: TmuxRunControl,
): Promise<PaneInputBarrierAcquireResult> {
  const barrier = { identity, token } as const;
  const paneCondition = exactPaneCondition(identity, "full");
  const barrierCondition = inputBarrierCondition(barrier);
  // Every `ambiguous` before the CAS below carries `mutationMayHaveApplied: false`: up to there
  // only hookless probes (`if-shell -F` + `wait-for`) and `show-hooks` ran.
  const untouched = { state: "ambiguous", mutationMayHaveApplied: false } as const;
  if (paneCondition === undefined || barrierCondition === undefined) return untouched;

  // A foreign barrier / copy-mode is a credit-worthy denial even if the administrator has hooks.
  // Classifying it before the inventory preserves guarantee R6: no hookable command is run, and
  // a busy human pane is not confused with an unsafe configuration that Cauce would only need
  // to evaluate if it were truly a candidate to acquire.
  const sameIdentity = await probeTmuxFormat(
    tmux,
    identity.paneId,
    paneCondition,
    control,
  );
  if (sameIdentity === false) return { state: "not_applied" };
  if (sameIdentity !== true) return untouched;
  const busyCondition = INPUT_BARRIER_BUSY_CONDITION;
  const busyBeforeHooks = await probeTmuxFormat(
    tmux,
    identity.paneId,
    busyCondition,
    control,
  );
  if (busyBeforeHooks === true) return { state: "busy" };
  if (busyBeforeHooks !== false) return untouched;

  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) {
    return { state: "unsafe_hooks" };
  }
  const condition = `#{&&:${paneCondition},#{&&:#{==:#{pane_input_off},0},`
    + `#{&&:#{==:#{pane_in_mode},0},#{==:#{${INPUT_BARRIER_OPTION}},}}}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `set-option -p -t ${identity.paneId} ${INPUT_BARRIER_OPTION} ${token}`
      + ` ; select-pane -d -t ${identity.paneId}`,
    control,
  );
  // `accepted` can only be signalled after BOTH mutations finished. The hooks that could alter
  // that postcondition were checked empty just before the CAS. Even if the main client's exit
  // status was lost, the independent waiter + this exact format credit ownership without
  // invoking `display-message`.
  if (mutation.branch === "accepted") {
    const postcondition = `#{&&:${paneCondition},${barrierCondition}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? { state: "acquired", barrier }
      : { state: "ambiguous", mutationMayHaveApplied: true };
  }
  if (mutation.branch !== "rejected") return { state: "ambiguous", mutationMayHaveApplied: true };

  // The rejected branch did not run any pane command. Classifying the reason is also done with
  // `if-shell`+`wait-for`: neither `display-message` nor `list-panes` can fire adversary hooks.
  const sameIdentityAfterRejection = await probeTmuxFormat(
    tmux,
    identity.paneId,
    paneCondition,
    control,
  );
  if (sameIdentityAfterRejection === false) return { state: "not_applied" };
  if (sameIdentityAfterRejection !== true) return untouched;
  const busyAfterRejection = await probeTmuxFormat(
    tmux,
    identity.paneId,
    busyCondition,
    control,
  );
  return busyAfterRejection === true ? { state: "busy" } : untouched;
}

/** How an acquisition whose result tmux lost was finally classified. */
export type AmbiguousBarrierResolution =
  /** Our token was on the exact generation and `releasePaneInputBarrier` restored the pane. */
  | { readonly state: "released" }
  /** The exact generation is free (no barrier, input enabled, no mode): the CAS never applied. */
  | { readonly state: "not_applied" }
  /** A FOREIGN exclusion protects the pane (another token, `input_off` without ours, a mode). */
  | { readonly state: "busy" }
  /** The process generation the CAS was fenced to is no longer the one in the pane. */
  | { readonly state: "replaced" }
  /** Our token is there, but tmux refused to release it (hooks appeared): nothing more is tried. */
  | { readonly state: "held" }
  /** Still undeterminable when the budget ran out or the signal aborted. */
  | { readonly state: "ambiguous" };

export interface AmbiguousBarrierResolutionOptions {
  /** Total time to keep re-probing; 0 disables the resolution and answers `ambiguous` at once. */
  readonly budgetMs: number;
  /** tmux deadline of each probe and of the release (generous: a starved host is the usual cause). */
  readonly probeTimeoutMs: number;
  /** Pause between rounds that could not classify the pane. */
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Aborts the PROBES; a release already sent runs to its end, like the commit's own release. */
  readonly signal?: AbortSignal;
}

/**
 * Re-classifies the exact generation after `acquirePaneInputBarrier` returned `ambiguous` with
 * `mutationMayHaveApplied`, instead of quarantining the TUI on the first lost answer.
 *
 * Nothing is pasted until the barrier is held, so the only open question is whether OUR barrier
 * ended up on the pane. Each round asks, with the same hookless `if-shell -F` + `wait-for` probes
 * the acquisition uses, and stops at the first credited answer:
 * 1. exact process generation AND `@cauce_input_barrier` == our token → the barrier is ours (the
 *    postcondition the accepted branch credits; see `ambiguousBarrierAcquisitionState`). It is
 *    released with `releasePaneInputBarrier`, itself a CAS on that token that re-checks hooks.
 * 2. the process generation is gone → `replaced` (the CAS was fenced to the old one);
 * 3. free: no barrier, input enabled, no mode → `not_applied`;
 * 4. a foreign exclusion (any token but ours, `input_off`, a mode) → `busy`, left untouched.
 * A probe without an answer, or a state that moved between probes, starts another round after
 * `intervalMs`, until `budgetMs` runs out.
 *
 * Why a lost CAS should not land AFTER a "free" verdict: CliTmux resolves only once the CAS
 * client exited, so every probe here is a later client, and tmux serves client command queues in
 * connection order and frees the queue of a client it lost: whatever the dead client delivered
 * ran before the probe or never runs. That ordering is tmux's, not something this code proves. If
 * it ever failed, our token would appear after a `not_applied` verdict: a fenced pane that later
 * acquisitions read as busy and never paste into, i.e. no worse than the quarantine it replaces.
 */
export async function resolveAmbiguousBarrierAcquisition(
  tmux: TmuxController,
  identity: PaneIdentity,
  token: string,
  options: AmbiguousBarrierResolutionOptions,
): Promise<AmbiguousBarrierResolution> {
  const processCondition = exactPaneCondition(identity, "process");
  if (processCondition === undefined || !INPUT_BARRIER_TOKEN_PATTERN.test(token)
    || options.budgetMs <= 0) return { state: "ambiguous" };
  const ownedCondition = `#{&&:${processCondition},#{==:#{${INPUT_BARRIER_OPTION}},${token}}}`;
  const freeCondition = `#{&&:${processCondition},#{&&:#{==:#{pane_input_off},0},`
    + `#{&&:#{==:#{pane_in_mode},0},#{==:#{${INPUT_BARRIER_OPTION}},}}}}`;
  // Our own token is excluded explicitly: a late look at it must never be mistaken for a foreign one.
  const foreignCondition = `#{&&:${processCondition},`
    + `#{&&:#{!=:#{${INPUT_BARRIER_OPTION}},${token}},${INPUT_BARRIER_BUSY_CONDITION}}}`;
  const deadline = Date.now() + options.budgetMs;
  const probe = async (condition: string): Promise<boolean | undefined> => probeTmuxFormat(
    tmux,
    identity.paneId,
    condition,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: Math.max(1, Math.min(options.probeTimeoutMs, deadline - Date.now())),
    },
  );
  let releaseSent = false;
  let releaseRefused = false;
  for (let round = 0; ; round += 1) {
    if (round > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal?.aborted === true) return { state: "ambiguous" };
      await options.sleep(Math.min(Math.max(0, options.intervalMs), remaining));
    }
    if (options.signal?.aborted === true || Date.now() >= deadline) return { state: "ambiguous" };
    const owned = await probe(ownedCondition);
    if (owned === undefined) continue;
    if (owned) {
      // A second refusal means hooks (or a token that moved and came back): stop and let the
      // caller keep the durable quarantine instead of spinning on a barrier it cannot restore.
      if (releaseRefused) return { state: "held" };
      releaseSent = true;
      const released = await releasePaneInputBarrier(
        tmux,
        { identity, token },
        { timeoutMs: Math.max(1, options.probeTimeoutMs) },
      );
      if (released === "applied") return { state: "released" };
      if (released === "not_applied") releaseRefused = true;
      continue;
    }
    const alive = await probe(processCondition);
    if (alive === undefined) continue;
    if (!alive) return { state: "replaced" };
    const free = await probe(freeCondition);
    // Free after a release whose own answer was lost: that release is what freed it.
    if (free === true) return { state: releaseSent ? "released" : "not_applied" };
    if (free === undefined) continue;
    if (await probe(foreignCondition) === true) return { state: "busy" };
  }
}

/**
 * Restores input only if the generation AND the token acquired by this call are still alive.
 *
 * A rename/respawn selects the negative witness; no option of the new generation is enabled or
 * deleted. The positive witness comes after enabling and removing the token: credits the
 * postcondition without running a hookable read command.
 */
export async function releasePaneInputBarrier(
  tmux: TmuxController,
  barrier: PaneInputBarrier,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  const { identity, token } = barrier;
  // Releasing also triggers `after-select-pane` and `after-set-option`. If any hook appeared
  // since the last mutation, it is neither run nor uninstalled: the barrier stays durable and
  // the caller enters exact quarantine/termination. That preserves both the TUI and foreign state.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "not_applied";
  // Session/window names are mutable metadata. Stable ids + PID + token credit that it is the
  // same generation even if a human renamed it while fenced.
  const paneCondition = exactPaneCondition(identity, "process");
  if (paneCondition === undefined || !INPUT_BARRIER_TOKEN_PATTERN.test(token)) return "ambiguous";
  const condition = `#{&&:${paneCondition},#{==:#{${INPUT_BARRIER_OPTION}},${token}}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `select-pane -e -t ${identity.paneId}`
      + ` ; set-option -pu -t ${identity.paneId} ${INPUT_BARRIER_OPTION}`,
    control,
  );
  if (mutation.branch === "accepted") {
    const postcondition = `#{&&:${paneCondition},#{&&:#{==:#{pane_input_off},0},`
      + `#{&&:#{==:#{pane_in_mode},0},#{==:#{${INPUT_BARRIER_OPTION}},}}}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? "applied"
      : "ambiguous";
  }
  if (mutation.branch === "rejected") return "not_applied";
  return "ambiguous";
}

/**
 * Prevents reusing a TUI whose cancelled turn did not reach an observable terminal boundary.
 *
 * The mark lives in the tmux session and therefore survives adapter restarts. It contains no
 * delivery text. When pane/PID changes it becomes stale and the runner can remove it safely.
 */
export async function markPaneQuarantined(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  return setSessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    paneGeneration(identity),
    control,
  );
}

type PaneQuarantineState = "current" | "stale" | "absent" | "unreadable";

/** Distinguishes real absence from a failed read: in doubt the runner cannot reuse the pane. */
export async function paneQuarantineState(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<PaneQuarantineState> {
  const option = await sessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    control,
  );
  if (!option.ok) return "unreadable";
  if (option.value === undefined) return "absent";
  return option.value === paneGeneration(identity) ? "current" : "stale";
}

/** Removes an old mark or a generation already observed as terminal. */
export async function clearPaneQuarantine(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)) return false;
  // The exact value is needed so a NEW stale mark, written after the read, is not deleted as if
  // it were the observed one. `after-show-options` is rejected beforehand: the read can no
  // longer be converted by existing config into copy/view-mode, keys, or any other mutation.
  if (!await tmuxHooksAreEmpty(tmux, identity.paneId, ["after-show-options"], control)) return false;
  const option = await sessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    control,
  );
  if (!option.ok || option.value === undefined) return option.ok;
  if (option.value === paneGeneration(identity)
    || !/^\$[0-9]+:@[0-9]+:%[0-9]+:[0-9]+$/u.test(option.value)) return false;
  const condition = `#{==:#{${QUARANTINED_PANE_OPTION}},${option.value}}`;
  const mutation = await atomicCas(
    tmux,
    identity.sessionId,
    condition,
    `set-option -u -t ${identity.sessionId} ${QUARANTINED_PANE_OPTION}`,
    control,
  );
  if (mutation.branch === "accepted") {
    return await probeTmuxFormat(
      tmux,
      identity.sessionId,
      `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
      control,
    ) === true;
  }
  if (mutation.branch !== "rejected") return false;
  // Prior absence already satisfies the postcondition; a current, invalid, or changed mark is kept.
  return await probeTmuxFormat(
    tmux,
    identity.sessionId,
    `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
    control,
  ) === true;
}

/** Removes only THIS generation's mark after a correlated terminal boundary. */
export async function clearCurrentPaneQuarantine(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)) return false;
  const generation = paneGeneration(identity);
  const condition = `#{==:#{${QUARANTINED_PANE_OPTION}},${generation}}`;
  const mutation = await atomicCas(
    tmux,
    identity.sessionId,
    condition,
    `set-option -u -t ${identity.sessionId} ${QUARANTINED_PANE_OPTION}`,
    control,
  );
  if (mutation.branch !== "accepted" && mutation.branch !== "rejected") return false;
  // accepted demands the unset finished before the witness; rejected is only success if the
  // mark was already absent. A foreign mark is kept and returns false.
  return await probeTmuxFormat(
    tmux,
    identity.sessionId,
    `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
    control,
  ) === true;
}

/**
 * Reads a PRIVATE session option without confusing "was not there" with a valid empty value.
 *
 * `-q` prevents tmux from writing the name of an absent option. Identity markers never accept
 * the empty value, so empty stdout means legacy/unmarked. A real error (dead socket, vanished
 * session) is kept separate: crediting an identity must not turn into "legacy" from a read
 * failure.
 */
export async function sessionOption(
  tmux: TmuxController,
  sessionTarget: string,
  option: string,
  control?: TmuxRunControl,
): Promise<{ readonly ok: true; readonly value?: string } | { readonly ok: false }> {
  // `show-options`/`set-option` do NOT accept the `=` prefix that `has-session`, `list-windows`
  // and `kill-session` do (verified against tmux 3.4). The caller passes the `$N` id resolved
  // by `exactSessionTarget`, which is exact and does not admit prefix collisions.
  const result = await tmux.run(
    ["show-options", "-qv", "-t", sessionTarget, option],
    undefined,
    control,
  );
  if (result.exitCode !== 0) return { ok: false };
  const value = result.stdout.replace(/\r?\n$/u, "");
  return value === "" ? { ok: true } : { ok: true, value };
}

/** Sets a private session option without shell or value expansion. */
export async function setSessionOption(
  tmux: TmuxController,
  sessionTarget: string,
  option: string,
  value: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  const result = await tmux.run(
    ["set-option", "-t", sessionTarget, option, value],
    undefined,
    control,
  );
  return result.exitCode === 0;
}
