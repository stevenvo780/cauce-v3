import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { FICHEROS_OPENCLAW, bloqueDePerfil } from "@cauce/protocol";
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
} from "./contracts.js";
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

/**
 * Sufijo para diferenciar la clave de sesión del carril de agentes.
 */
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
    if (this.canonicalOpenCodeSession
      && (this.definition.id !== "opencode" || this.sessionNamespace !== "kant")) {
      throw new Error("Canonical OpenCode session publication is restricted to alias 'kant'");
    }
  }

  /**
   * ¿Esta combinación de harness y transporte puede decir cuándo arrancó el turno?
   *
   * Hacen falta LOS DOS: el harness tiene que declarar qué byte suyo significa «ya estoy
   * ejecutando», y el transporte tiene que estar en condiciones de verlo. El mismo `codex` puede
   * correr por un proceso —que atestigua— o por la sesión compartida —que cosecha un panel de
   * tmux y no ve bytes—. Esta capacidad sólo permite probar fallos preflight; la barrera durable
   * de ejecución es siempre previa a `execute` y no depende del testigo.
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
      if (reservation === undefined) throw new Error(`Missing session reservation for ${key}`);
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
   * Toma turno en el candado de una sesión. `lane` decide EN QUÉ candado: el carril de agentes
   * usa otra clave de sesión, así que corre en paralelo al de la persona en vez de esperarlo.
   *
   * El fallback también lleva carril. Sin eso, openclaw —que tiene
   * `fallbackSessionKey: "alias-default"`— seguiría metiendo en un único candado global toda
   * entrega sin origen utilizable, humana o no.
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
   * Le añade al contexto el sello del fichero de instrucciones que hay AHORA en el disco.
   *
   * Se hace acá, en el adaptador, porque el adaptador ya corre DENTRO del contenedor del alias:
   * el fichero lo tiene delante. Que lo midiera el gateway exigiría la cadena
   * gateway → relay → pty-agent —que hoy no existe en producción— y un viaje de red por entrega.
   *
   * La caché es por `mtime` y NO por tiempo: un fichero que no cambió no se vuelve a leer, y uno
   * que cambió se nota en la entrega siguiente sin esperar a que expire nada. Sembrar el contexto
   * tiene efecto en el turno siguiente, que es lo que se espera de una configuración.
   *
   * Si algo falla —no hay `HOME`, el arnés no tiene fichero, el disco no deja leer— devuelve el
   * contexto tal cual y el sobre va entero. Nunca lanza: un fallo de lectura no puede costar un
   * turno.
   */
  private conSelloDelArnes(context: HarnessRequestContext | undefined): HarnessRequestContext | undefined {
    if (!context) return context;
    // Un sello externo sólo acredita el contrato fijo; la TUI compartida igualmente necesita el
    // perfil vivo porque pudo cargar el fichero antes de esa medición.
    if (this.sharedSession) return this.conPerfilVivoDeSesionCompartida(context);
    // Un sello que ya venga en el sobre manda sobre el nuestro: lo puso quien mide desde fuera.
    if (context.context_seal) return context;
    /*
     * EN SESIÓN COMPARTIDA NO SE RECORTA, y esto no es prudencia: es corrección.
     *
     * El recorte se apoya en que el arnés cargue sus instrucciones del fichero. En el camino
     * headless eso es cierto por construcción: el proceso arranca DESPUÉS de que escribimos, en
     * este mismo turno. En sesión compartida no: la TUI se lanzó al crear el panel —horas o días
     * antes— y leyó su `CLAUDE.md` entonces. Escribir el fichero ahora no se lo cuenta a nadie.
     *
     * Si recortáramos igual, el agente se quedaría sin contrato y NO daría error: contestaría mal
     * y parecería que el modelo empeoró. Es exactamente el fallo que el sello venía a impedir.
     *
     * Lo que falta para levantar esta guarda es comparar la fecha del fichero con el arranque del
     * proceso del panel (`/proc/<pid>/stat`). Mientras eso no esté medido, aquí se manda todo.
     */
    const home = process.env.HOME;
    if (!home) return context;
    const ruta = rutaDelContextoFijo(this.definition.id, home);
    if (!ruta) return context;
    /*
     * Que el fichero NO exista no es una salida: es justamente el caso de un alias recién creado,
     * que es el que más necesita la siembra. Se sigue con marca -1, que nunca coincide con una
     * caché previa y por tanto fuerza el intento.
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
         * No hay bloque, o el que hay no es éste. Se intenta sembrar y se vuelve a leer. La
         * siembra decide sola si le toca (ver `sembrarContextoFijo`): apagada, sin ruta, o con un
         * bloque que es de otro alias, no escribe nada y esto queda igual que antes.
         *
         * Va detrás de un interruptor porque escribir en el fichero de un alias es una acción con
         * efecto fuera de este proceso, y encenderla es una decisión de despliegue, no del código.
         */
        const motivo = sembrarContextoFijo(ruta, textoFijoDelSobre(context), {
          habilitado: process.env.CAUCE_SEMBRAR_CONTEXTO === "1",
          leer: (r) => readFileSync(r, "utf8"),
          escribir: (r, contenido) => writeFileSync(r, contenido, "utf8"),
        });
        if (motivo === "sembrado") sello = selloDesdeElDisco(ruta, (r) => readFileSync(r, "utf8"));
      }
      this.selloEnCache = { ruta, marca, sello };
    }
    const sello = this.selloEnCache.sello;
    return sello ? { ...context, context_seal: sello } : context;
  }

  /**
   * Una TUI compartida no se reinicia para aplicar un perfil: destruiría la conversación del
   * dueño. En su lugar se extrae únicamente el bloque gestionado (nunca el resto del manual) y se
   * incorpora al sobre de CADA turno. La lectura ocurre después de tomar el candado de sesión y
   * pegada al `run`, por lo que una escritura del gateway se vuelve conductual en el siguiente
   * turno aunque el PID del panel sea el mismo.
   */
  private perfilVivoDelRuntime(context: HarnessRequestContext): RuntimeProfileMeasurement | undefined {
    const home = process.env.HOME;
    if (home === undefined || !home.startsWith("/")) return undefined;

    const paths: string[] = [];
    const instructionPath = rutaDelContextoFijo(this.definition.id, home);
    if (instructionPath !== undefined) {
      paths.push(instructionPath);
    } else if (this.definition.id === "openclaw") {
      const workspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
      if (workspace === undefined || !workspace.startsWith("/")) return undefined;
      for (const name of FICHEROS_OPENCLAW) {
        // MEMORY/HEARTBEAT son del agente, no una cara autorada del perfil.
        if (name !== "MEMORY.md" && name !== "HEARTBEAT.md") paths.push(`${workspace}/${name}`);
      }
    } else {
      return undefined;
    }

    const owner = `<!-- alias: ${context.tenant_id}/${context.self_alias} -->`;
    const documents: Array<{ path: string; sha256: string; block: string }> = [];
    for (const path of paths) {
      let file: string;
      try {
        file = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const block = bloqueDePerfil(file);
      // Un HOME compartido nunca autoriza a inyectar el perfil del vecino.
      if (block === undefined || !block.trimStart().startsWith(owner)) continue;
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
    // La cuenta se resuelve DESPUÉS de tomar el candado de sesión y justo antes de gastar: entre
    // que la entrega se admitió y que llega acá pueden pasar minutos, y en ese rato la cuenta
    // preferida se puede haber agotado. Resolver antes daría la respuesta vieja.
    //
    // Un fallo del resolutor NO puede tumbar la ejecución: si el gateway no contesta, se sigue con
    // `{}` — o sea el comportamiento de siempre, el CLI usa la credencial ya logueada. Quedarse
    // sin despachar porque no se pudo consultar QUÉ cuenta usar sería cambiar un problema de
    // costos por una caída.
    const credentialEnv = this.resolveCredentialEnv === undefined
      ? {}
      : await this.resolveCredentialEnv().catch(() => ({}));
    const effectivePrompt = attachmentPlan.prompt.length === 0
      ? request.prompt
      : `${request.prompt}\n\n${attachmentPlan.prompt}`;
    const effectiveContext = this.conSelloDelArnes(request.context);
    // Shared TUIs receive this block explicitly. Headless harnesses load the same measured file at
    // process start; in both cases evidence is emitted only after the run returns valid output.
    const measuredProfile = effectiveContext?.runtime_profile
      ?? (request.context === undefined ? undefined : this.perfilVivoDelRuntime(request.context));
    const result = await this.runner.run({
      ...invocation,
      ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
      stdin: protocolPrompt(effectivePrompt, request.origin, effectiveContext),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      ...(session.context.sessionId === undefined ? {} : { sessionId: session.context.sessionId }),
      // El testigo de arranque y su aviso viajan juntos hasta el transporte: es el transporte el
      // único que ve los bytes del harness, y por lo tanto el único que puede decir cuándo
      // empezó de verdad. Un runner que no los entienda los ignora y todo sigue como antes.
      ...(this.definition.startWitness === undefined
        ? {}
        : { startWitness: this.definition.startWitness }),
      ...(request.onHarnessStart === undefined ? {} : { onHarnessStart: request.onHarnessStart }),
    });
    // Se consume PEGADO a la ejecución, no más tarde: si el turno falla y se lanza una excepción,
    // el aviso no puede quedarse guardado y contaminar el turno siguiente, que quizá sí compartió.
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
    if (result.cancelled || request.signal.aborted) {
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
            `Harness exited with code ${result.exitCode} before beginning the turn,`
            + ` without producing any output${detalle}`,
            true,
          );
        }
        const message = causeDetail
          ? `Harness exited with code ${result.exitCode} without structured output: ${causeDetail}`
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
        ? `Harness exited with code ${result.exitCode}: ${causeDetail}`
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
    if (measuredProfile !== undefined) request.onRuntimeProfileConsumed?.(measuredProfile);
    return announced;
  }

  /**
   * Registra y anota el aviso de degradación en el resultado estructurado de la sesión compartida.
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
