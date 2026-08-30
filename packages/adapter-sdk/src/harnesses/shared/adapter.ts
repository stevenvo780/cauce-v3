import { createHash, randomUUID } from "node:crypto"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { FICHEROS_OPENCLAW, bloqueDePerfil } from "@cauce/protocol";
import {
  NativeProfileContext,
  nativeProfileContextEnabled,
} from "../../context/native-profile-context.js";
import { AdapterError, ProcessExecutionError } from "../../sdk/errors.js";
import {
  isCanonicalOpenCodeSessionId,
  isCanonicalOpenCodeScopeKey,
  type DurableStore,
  type SessionOrigin,
} from "../../sdk/durable-store.js";
import type {
  CommandRunner,
  HarnessCommandOverride,
  HarnessDefinition,
  HarnessExecutionContext,
  HarnessId,
  StructuredOutput,
} from "../../sdk/types.js";
import { validateDeliveryOutput } from "../../sdk/output-parser.js";
import { recordDegradation } from "../../shared-session/degradation-log.js";
import { annotateDegraded, degradationNotice } from "../../shared-session/notice.js";
import {
  isSharedSessionRunner,
  type SharedSessionDegradation,
} from "../../shared-session/types.js";
import {
  rutaDelContextoFijo,
  selloDesdeElDisco,
  sembrarContextoFijo,
  type SelloDeContextoFijo,
} from "../contexto-fijo.js";
import { planAttachments } from "./attachments.js";
import type {
  HarnessAdapterOptions,
  HarnessExecuteRequest,
  HarnessRequestContext,
  HarnessSessionReservation,
  RuntimeProfileMeasurement,
  SessionLane,
} from "../../contracts/harness.js";
import {
  abortReason,
  abortadoPorApagado,
  cancellationMessage,
  elTestigoDiceQueNoEmpezo,
  esInterrupcionDelDuenio,
  nuncaEmpezoElTurno,
  sanitizeProcessOutput,
  sinMarcaDeArranque,
} from "./errors.js";
import { protocolPrompt, textoFijoDelSobre } from "./prompt.js";
import { SessionReservation } from "./session-reservation.js";

/** Suffix distinguishing the agent lane's session key. */
const AGENT_LANE_SUFFIX = ".agent-lane";

export class HarnessAdapter {
  readonly definition: HarnessDefinition;
  private readonly runner: CommandRunner;
  private readonly store: DurableStore;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly commandOverride: HarnessCommandOverride | undefined;
  private readonly sessionNamespace: string | undefined;
  private readonly fallbackSessionKey: string | undefined;
  private readonly canonicalOpenCodeSession: boolean;
  private readonly resolveCredentialEnv: (() => Promise<Readonly<Record<string, string>>>) | undefined;
  private readonly sharedSession: HarnessAdapterOptions["sharedSession"];
  private readonly nativeProfileContext: NativeProfileContext | undefined;

  constructor(options: HarnessAdapterOptions) {
    this.sharedSession = options.sharedSession;
    this.definition = options.definition;
    this.runner = options.runner;
    this.store = options.store;
    this.commandOverride = options.commandOverride;
    this.sessionNamespace = options.sessionNamespace;
    this.fallbackSessionKey = options.fallbackSessionKey;
    this.canonicalOpenCodeSession = options.canonicalOpenCodeSession === true;
    this.resolveCredentialEnv = options.resolveCredentialEnv;
    const environment = options.environment ?? process.env;
    const nativeEnabled = nativeProfileContextEnabled(environment.CAUCE_NATIVE_PROFILE_CONTEXT);
    this.nativeProfileContext = nativeEnabled
      ? new NativeProfileContext(this.definition.id, this.sharedSession !== undefined, environment)
      : undefined;
    if (this.canonicalOpenCodeSession
      && (this.definition.id !== "opencode" || this.sessionNamespace !== "kant")) {
      throw new Error("Canonical OpenCode session publication is restricted to alias 'kant'");
    }
  }

  prepareContext(context: HarnessRequestContext): HarnessRequestContext;
  prepareContext(context: undefined): undefined;
  prepareContext(
    context: HarnessRequestContext | undefined,
  ): HarnessRequestContext | undefined;
  prepareContext(
    context: HarnessRequestContext | undefined,
  ): HarnessRequestContext | undefined {
    return this.nativeProfileContext?.prepare(context) ?? context;
  }

  /**
   * Can this harness+transport combination tell when the turn started?
   *
   * BOTH are needed: the harness must declare which of its bytes means "already running", and the
   * transport must be in a position to see it. The same `codex` can run via a process —which
   * witnesses— or via the shared session —which harvests a tmux pane and sees no bytes—. This
   * capability only lets us detect preflight failures; the durable execution barrier always sits
   * before `execute` and does not depend on the witness.
   */
  get witnessesHarnessStart(): boolean {
    return this.definition.startWitness !== undefined
      && this.runner.witnessesHarnessStart === true;
  }

  async execute(request: HarnessExecuteRequest): Promise<StructuredOutput> {
    if (request.context?.message_type === "agent.fanin") {
      throw new AdapterError(
        "FANIN_HARNESS_EXECUTION_FORBIDDEN",
        "agent.fanin must use the SDK's pure deterministic synthesizer, never a provider harness",
        false,
      );
    }
    const effectiveSessionKey = this.laneSessionKey(request.sessionKey, request.sessionLane);
    if (effectiveSessionKey !== undefined && this.definition.sessionStrategy.kind !== "none") {
      const key = this.sessionStoreKey(effectiveSessionKey);
      const reservation = request.sessionReservation ?? this.reserveResolved(effectiveSessionKey);
      if (reservation.key !== key) {
        reservation.release();
        throw new Error(`Session reservation mismatch for ${key}`);
      }
      try {
        await reservation.wait(request.signal);
        return await this.executeUnlocked(request, effectiveSessionKey);
      } finally {
        reservation.release();
      }
    }
    return this.executeUnlocked(request, effectiveSessionKey);
  }

  /**
   * Takes a turn on a session lock. `lane` decides WHICH lock: the agent lane uses another
   * session key, so it runs in parallel with the person's lock instead of waiting for it.
   *
   * Fallback also carries a lane. Otherwise, openclaw —which has `fallbackSessionKey:
   * "alias-default"`— would keep stuffing every delivery without a usable origin into one
   * global lock.
   */
  reserveSession(
    sessionKey: string | undefined,
    lane: SessionLane = "human",
  ): HarnessSessionReservation | undefined {
    const effectiveSessionKey = this.laneSessionKey(sessionKey, lane);
    if (effectiveSessionKey === undefined || this.definition.sessionStrategy.kind === "none") {
      return undefined;
    }
    return this.reserveResolved(effectiveSessionKey);
  }

  private laneSessionKey(
    sessionKey: string | undefined,
    lane: SessionLane = "human",
  ): string | undefined {
    const base = sessionKey ?? this.fallbackSessionKey;
    if (base === undefined) return undefined;
    return lane === "agent" ? `${base}${AGENT_LANE_SUFFIX}` : base;
  }

  private reserveResolved(effectiveSessionKey: string): HarnessSessionReservation {
    const key = this.sessionStoreKey(effectiveSessionKey);
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolveCompleted) => {
      release = resolveCompleted;
    });
    const tail = previous.catch(() => undefined).then(() => completed);
    this.sessionLocks.set(key, tail);
    void tail.finally(() => {
      if (this.sessionLocks.get(key) === tail) this.sessionLocks.delete(key);
    });
    return new SessionReservation(key, previous, release);
  }

  /**
   * Adds the seal of the instructions file that is NOW on disk to the context.
   *
   * Done here, in the adapter, because it already runs INSIDE the alias's container: the file
   * is in front of it. Having the gateway measure it would require gateway → relay → pty-agent
   * —not in production today— and a network trip per delivery.
   *
   * Cache is by `mtime`, NOT by time: a file that didn't change isn't reread, and one that
   * changed is noticed on the next delivery without waiting for anything to expire. Seeding the
   * context takes effect on the next turn, which is what is expected from a config.
   *
   * If anything fails —no `HOME`, the harness has no file, the disk won't read— returns the
   * context unchanged and the envelope goes whole. Never throws: a read failure cannot cost a
   * turn.
   */
  private conSelloDelArnes(context: HarnessRequestContext | undefined): HarnessRequestContext | undefined {
    if (!context) return context;
    if (context.native_profile_context === true) return context;
    // An external seal only credits the fixed contract; the shared TUI still needs the live
    // profile because it could have loaded the file before that measurement.
    if (this.sharedSession) return this.conPerfilVivoDeSesionCompartida(context);
    // A seal already in the envelope overrides ours: it was placed by whoever measures outside.
    if (context.context_seal) return context;
    /*
     * IN SHARED SESSION THE TRIM DOES NOT HAPPEN — not out of caution: correctness.
     *
     * Trimming relies on the harness loading its instructions from the file. On the headless
     * path that is true by construction: the process starts AFTER we write, in this same turn.
     * In shared session it is not: the TUI was launched when the pane was created —hours or days
     * ago— and read its `CLAUDE.md` then. Writing the file now tells nobody.
     *
     * If we trimmed anyway, the agent would be left without a contract and would NOT error: it
     * would answer wrongly and look like the model worsened. That is exactly the failure the seal
     * came to prevent.
     *
     * What is missing to lift this guard is comparing the file's timestamp with the pane's
     * process start (`/proc/<pid>/stat`). Until that is measured, everything is sent here.
     */
    const home = process.env.HOME;
    if (!home) return context;
    const ruta = rutaDelContextoFijo(this.definition.id, home);
    if (!ruta) return context;
    /*
     * That the file does NOT exist is not an exit: it is exactly the case of a freshly created
     * alias, which needs seeding most. Continue with marker -1, which never matches a prior
     * cache and therefore forces the attempt.
     */
    let marca = -1;
    try {
      marca = statSync(ruta).mtimeMs;
    } catch {
      marca = -1;
    }
    if (this.selloEnCache?.ruta !== ruta || this.selloEnCache.marca !== marca) {
      let sello = selloDesdeElDisco(ruta, (r) => readFileSync(r, "utf8"));
      if (!sello) {
        /*
         * There is no block, or the one there is not this one. Seeding is attempted and reread.
         * Seeding decides for itself whether it should run (see `sembrarContextoFijo`): off, no
         * path, or with a block from another alias, it writes nothing and this stays as before.
         *
         * Behind a switch because writing an alias's file is an action with effect outside this
         * process, and turning it on is a deployment decision, not a code one.
         */
        const motivo = sembrarContextoFijo(ruta, textoFijoDelSobre(context), {
          habilitado: process.env.CAUCE_SEMBRAR_CONTEXTO === "1",
          leer: (r) => readFileSync(r, "utf8"),
          escribir: (r, contenido) => { writeFileSync(r, contenido, "utf8"); },
        });
        if (motivo === "sembrado") sello = selloDesdeElDisco(ruta, (r) => readFileSync(r, "utf8"));
      }
      this.selloEnCache = { ruta, marca, sello };
    }
    const sello = this.selloEnCache.sello;
    return sello ? { ...context, context_seal: sello } : context;
  }

  /**
   * A shared TUI is not restarted to apply a profile: that would destroy the owner's conversation.
   * Instead only the managed block is extracted (never the rest of the manual) and incorporated
   * into EVERY turn's envelope. The read happens after taking the session lock and right next
   * to the `run`, so a gateway write becomes behavioral on the next turn even if the pane PID
   * stays the same.
   */
  private perfilVivoDelRuntime(context: HarnessRequestContext): RuntimeProfileMeasurement | undefined {
    const home = process.env.HOME;
    if (!home?.startsWith("/")) return undefined;

    const paths: string[] = [];
    const instructionPath = rutaDelContextoFijo(this.definition.id, home);
    if (instructionPath !== undefined) {
      paths.push(instructionPath);
    } else if (this.definition.id === "openclaw") {
      const workspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
      if (!workspace?.startsWith("/")) return undefined;
      for (const name of FICHEROS_OPENCLAW) {
        // MEMORY/HEARTBEAT belong to the agent, not an authored facet of the profile.
        if (name !== "MEMORY.md" && name !== "HEARTBEAT.md") paths.push(`${workspace}/${name}`);
      }
    } else {
      return undefined;
    }

    const owner = `<!-- alias: ${context.tenant_id}/${context.self_alias} -->`;
    const documents: { path: string; sha256: string; block: string }[] = [];
    for (const path of paths) {
      let file: string;
      try {
        file = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const block = bloqueDePerfil(file);
      // A shared HOME never authorizes injecting a neighbor's profile.
      if (!block?.trimStart().startsWith(owner)) continue;
      documents.push({
        path,
        sha256: createHash("sha256").update(file, "utf8").digest("hex"),
        block,
      });
    }
    if (documents.length === 0) return undefined;

    const text = documents.map((document) =>
      `## ${document.path.slice(document.path.lastIndexOf("/") + 1)}\n\n${document.block}`).join("\n\n");
    return {
      source: "runtime-files",
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      documents: documents.map(({ path, sha256 }) => ({ path, sha256 })),
      text,
    };
  }

  private conPerfilVivoDeSesionCompartida(context: HarnessRequestContext): HarnessRequestContext {
    const runtimeProfile = this.perfilVivoDelRuntime(context);
    return runtimeProfile === undefined ? context : { ...context, runtime_profile: runtimeProfile };
  }

  private selloEnCache: { ruta: string; marca: number; sello: SelloDeContextoFijo | undefined } | undefined;

  private async executeUnlocked(
    request: HarnessExecuteRequest,
    effectiveSessionKey: string | undefined,
  ): Promise<StructuredOutput> {
    const session = await this.resolveSession(effectiveSessionKey, request.sessionOrigin);
    if (request.signal.aborted) throw abortReason(request.signal);
    const sessionContext: HarnessExecutionContext = session.context;
    const attachmentPlan = planAttachments(this.definition.id, request.attachments ?? []);
    const invocation = this.invocation(sessionContext, attachmentPlan.args);
    // The account is resolved AFTER taking the session lock and just before spending: minutes may
    // pass between the delivery being admitted and getting here, and in that time the preferred
    // account may have run out. Resolving earlier would return the stale answer.
    //
    // A resolver failure MUST NOT take down execution: if the gateway doesn't reply, continue
    // with `{}` — the always-on behavior, the CLI uses the already-logged-in credential. Failing
    // to dispatch because we couldn't ask WHICH account to use would trade a cost problem for
    // an outage.
    const credentialEnv = this.resolveCredentialEnv === undefined
      ? {}
      : await this.resolveCredentialEnv().catch(() => ({}));
    const effectivePrompt = attachmentPlan.prompt.length === 0
      ? request.prompt
      : `${request.prompt}\n\n${attachmentPlan.prompt}`;
    const preparedContext = this.prepareContext(request.context);
    const effectiveContext = this.conSelloDelArnes(preparedContext);
    await request.beforeHarnessInvoke?.();
    // Re-read after the durable intent; a crash here can conservatively leave pre-provider intent.
    const invocationContext = effectiveContext?.native_profile_context === true
      ? this.prepareContext(effectiveContext)
      : effectiveContext;
    // Shared TUIs receive this block explicitly. Headless harnesses load the same measured file at
    // process start; in both cases evidence is emitted only after the run returns valid output.
    const measuredProfileAtStart = invocationContext?.native_profile_measurement
      ?? invocationContext?.runtime_profile
      ?? (request.context === undefined ? undefined : this.perfilVivoDelRuntime(request.context));
    const result = await this.runner.run({
      ...invocation,
      ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
      stdin: protocolPrompt(effectivePrompt, request.origin, invocationContext),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      ...(session.context.sessionId === undefined ? {} : { sessionId: session.context.sessionId }),
      // The start witness and its notice travel together to the transport: it is the only thing
      // that sees the harness's bytes, and therefore the only one that can tell when it actually
      // started. A runner that doesn't understand them ignores them and everything continues.
      ...(this.definition.startWitness === undefined
        ? {}
        : { startWitness: this.definition.startWitness }),
      ...(request.onHarnessStart === undefined ? {} : { onHarnessStart: request.onHarnessStart }),
    });
    // Consumed RIGHT NEXT to execution, not later: if the turn fails and an exception is thrown,
    // the notice cannot stay stored and contaminate the next turn, which might have actually shared.
    const degradation = isSharedSessionRunner(this.runner)
      ? this.runner.takeDegradation()
      : undefined;

    if (result.timedOut) {
      throw new ProcessExecutionError(
        "EXECUTION_TIMEOUT_AMBIGUOUS",
        "Harness exceeded its execution deadline; completion state is unknown and requires manual replay",
        false,
      );
    }
    if (result.cancelled || request.signal.aborted) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- AbortSignal can change while the harness run is pending.
      if (abortadoPorApagado(request.signal) && elTestigoDiceQueNoEmpezo(result)) {
        throw new ProcessExecutionError(
          "EXECUTION_CANCELLED_PREFLIGHT",
          `Adapter shutdown cancelled the delivery before the harness began; nothing was executed (${
            cancellationMessage(request.signal)})`,
          true,
        );
      }
      throw new ProcessExecutionError(
        "EXECUTION_CANCELLED_AMBIGUOUS",
        cancellationMessage(request.signal),
        false,
      );
    }

    let parsed;
    try {
      parsed = this.definition.parse(result.stdout);
    } catch (error) {
      if (result.exitCode !== 0) {
        // Extract real cause from stderr, sanitized to avoid leaking secrets
        const causeDetail = sanitizeProcessOutput(sinMarcaDeArranque(result.stderr));
        if (nuncaEmpezoElTurno(result, causeDetail)) {
          const detalle = causeDetail
            ? `: ${causeDetail}`
            : "; the transport witnessed that it never started";
          throw new ProcessExecutionError(
            "PROCESS_EXIT_PREFLIGHT",
            `Harness exited with code ${String(result.exitCode)} before beginning the turn,`
            + ` without producing any output${detalle}`,
            true,
          );
        }
        const message = causeDetail
          ? `Harness exited with code ${String(result.exitCode)} without structured output: ${causeDetail}`
          : "Harness exited after execution began without structured output; completion state is unknown";
        throw new ProcessExecutionError(
          "PROCESS_EXIT_AMBIGUOUS",
          message,
          esInterrupcionDelDuenio(causeDetail),
        );
      }
      throw error;
    }
    if (result.exitCode !== 0 && parsed.output.status !== "failed") {
      const causeDetail = sanitizeProcessOutput(sinMarcaDeArranque(result.stderr));
      const message = causeDetail
        ? `Harness exited with code ${String(result.exitCode)}: ${causeDetail}`
        : "Harness exited with a non-zero status after execution began; completion state is unknown";
      throw new ProcessExecutionError(
        "PROCESS_EXIT_AMBIGUOUS",
        message,
        esInterrupcionDelDuenio(causeDetail),
      );
    }
    const output = validateDeliveryOutput(parsed.output, {
      ...(request.context === undefined
        ? {}
        : {
            messageType: request.context.message_type,
            senderAlias: request.context.sender_alias,
            selfAlias: request.context.self_alias,
            routingTargets: request.context.routing_targets,
          }),
    });

    if (effectiveSessionKey !== undefined) {
      const origin = request.sessionOrigin === undefined
        ? {}
        : { origin: request.sessionOrigin };
      if (this.definition.sessionStrategy.kind === "generated" && session.nativeId !== undefined) {
        const record = {
          native_id: session.nativeId,
          initialized: true,
          ...origin,
        };
        if (this.definition.id === "openclaw"
          && this.sessionNamespace !== undefined
          && request.sessionLane !== "agent") {
          await this.store.setCanonicalOpenClawTerminalSession(
            this.sessionNamespace,
            this.sessionStoreKey(effectiveSessionKey),
            record,
          );
        } else {
          await this.store.setSession(this.sessionStoreKey(effectiveSessionKey), record);
        }
      }
      if (this.definition.sessionStrategy.kind === "observed" && parsed.nativeSessionId !== undefined) {
        if (this.canonicalOpenCodeSession) {
          if (result.exitCode === 0
            && isCanonicalOpenCodeScopeKey(effectiveSessionKey)
            && isCanonicalOpenCodeSessionId(parsed.nativeSessionId)) {
            await this.store.setCanonicalOpenCodeSession(effectiveSessionKey, parsed.nativeSessionId);
          }
        } else {
          await this.store.setSession(this.sessionStoreKey(effectiveSessionKey), {
            native_id: parsed.nativeSessionId,
            initialized: true,
            ...origin,
          });
        }
      }
    }

    const announced = await this.announceSharedSession(output, degradation);
    let consumedProfile = measuredProfileAtStart;
    if (invocationContext?.native_profile_context === true) {
      try {
        consumedProfile = this.nativeProfileContext?.revalidate(invocationContext);
      } catch {
        consumedProfile = undefined;
      }
    }
    if (consumedProfile !== undefined) request.onRuntimeProfileConsumed?.(consumedProfile);
    return announced;
  }

  /**
   * Records and annotates the degradation notice in the shared session's structured output.
   */
  private async announceSharedSession(
    output: StructuredOutput,
    degradation: SharedSessionDegradation | undefined,
  ): Promise<StructuredOutput> {
    const shared = this.sharedSession;
    if (degradation === undefined || shared === undefined) return output;
    await recordDegradation(shared.stateDirectory, {
      ...degradation,
      alias: shared.alias,
      harness: shared.harness,
    });
    return annotateDegraded(
      output,
      degradationNotice(shared.alias, shared.harness, degradation),
    );
  }

  private invocation(context: HarnessExecutionContext, attachmentArgs: readonly string[]): {
    command: string;
    args: readonly string[];
    harness: HarnessId;
  } {
    const prefix = this.commandOverride?.prefixArgs ?? [];
    const baseArgs = this.commandOverride?.baseArgs ?? this.definition.baseArgs;
    const sessionArgs = this.definition.sessionArgs(context);
    const args = this.definition.id === "codex"
      ? [...prefix, ...baseArgs, ...attachmentArgs, ...sessionArgs]
      : [...prefix, ...baseArgs, ...sessionArgs, ...attachmentArgs];
    return {
      command: this.commandOverride?.command ?? this.definition.command,
      args,
      harness: this.definition.id,
    };
  }

  private sessionStoreKey(sessionKey: string): string {
    const namespace = this.sessionNamespace === undefined ? "" : `${this.sessionNamespace}:`;
    return `${this.definition.id}:${namespace}${sessionKey}`;
  }

  private async resolveSession(
    sessionKey: string | undefined,
    sessionOrigin: SessionOrigin | undefined,
  ): Promise<{
    context: HarnessExecutionContext;
    nativeId?: string;
  }> {
    if (sessionKey === undefined || this.definition.sessionStrategy.kind === "none") {
      return { context: { resume: false } };
    }
    const existing = this.store.getSession(this.sessionStoreKey(sessionKey));
    if (existing !== undefined) {
      if (this.canonicalOpenCodeSession
        && (!isCanonicalOpenCodeScopeKey(sessionKey)
          || !isCanonicalOpenCodeSessionId(existing.native_id))) {
        return { context: { resume: false } };
      }
      return {
        context: { sessionId: existing.native_id, resume: existing.initialized },
        nativeId: existing.native_id,
      };
    }
    if (this.definition.sessionStrategy.kind === "generated") {
      const nativeId = randomUUID();
      await this.store.setSession(this.sessionStoreKey(sessionKey), {
        native_id: nativeId,
        initialized: false,
        ...(sessionOrigin === undefined ? {} : { origin: sessionOrigin }),
      });
      return { context: { sessionId: nativeId, resume: false }, nativeId };
    }
    return { context: { resume: false } };
  }
}
