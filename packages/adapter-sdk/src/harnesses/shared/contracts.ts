import type { DurableStore, SessionOrigin } from "../../sdk/durable-store.js";
import type {
  CommandRunner,
  HarnessAttachment,
  HarnessCommandOverride,
  HarnessDefinition,
  RelayOrigin,
} from "../../sdk/types.js";
import type { SelloDeContextoFijo } from "../contexto-fijo.js";
import type { SharedSessionHarness } from "../../shared-session/types.js";

export interface HarnessRequestContext {
  readonly self_alias: string;
  readonly sender_alias: string;
  readonly tenant_id: string;
  readonly room_id: string;
  readonly channel: string;
  readonly agent_message: boolean;
  readonly message_type: string;
  readonly routing_targets: readonly HarnessRoutingTarget[];
  /**
   * Rol declarado del alias (`agents.role_brief`). Ausente = sin rol declarado.
   */
  readonly self_role?: string;
  /**
   * Resumen del texto fijo tal y como está escrito HOY en el fichero de instrucciones del arnés
   * dentro del contenedor, medido por quien puede mirarlo. Cuando coincide con el texto que este
   * adaptador emitiría, el bloque fijo NO se repite en el sobre.
   *
   * Ausente = comportamiento de siempre, sobre entero. Ver `contexto-fijo.ts` para el porqué de
   * que sea un resumen y no una bandera.
   */
  readonly context_seal?: SelloDeContextoFijo;
  /**
   * Perfil gestionado leído de los bytes vivos justo antes del turno. En sesiones compartidas la
   * TUI pudo arrancar horas antes de la última edición; inyectarlo evita afirmar que adoptó un
   * fichero que ese proceso nunca recargó.
   */
  readonly runtime_profile?: RuntimeProfileMeasurement;
}

/** Exact live bytes measured by adapter code, never supplied by model output. */
export interface RuntimeProfileMeasurement {
  readonly source: "runtime-files";
  readonly sha256: string;
  readonly documents: readonly { readonly path: string; readonly sha256: string }[];
  readonly text: string;
}

export interface HarnessRoutingTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly online: boolean;
}

export interface HarnessAdapterOptions {
  readonly definition: HarnessDefinition;
  readonly runner: CommandRunner;
  readonly store: DurableStore;
  readonly commandOverride?: HarnessCommandOverride;
  /** Stable, non-secret alias namespace used to isolate persisted native sessions. */
  readonly sessionNamespace?: string;
  /** Trusted local fallback used when a harness requires a session selector. */
  readonly fallbackSessionKey?: string;
  /** Exact Kant/OpenCode-only opt-in for the canonical native-session pointer. */
  readonly canonicalOpenCodeSession?: boolean;
  /**
   * Resuelve las variables de entorno de credenciales rotativas antes de cada ejecución.
   */
  readonly resolveCredentialEnv?: () => Promise<Readonly<Record<string, string>>>;
  /**
   * Configuración de sesión compartida cuando está habilitada para el alias.
   */
  readonly sharedSession?: {
    readonly alias: string;
    readonly harness: SharedSessionHarness;
    readonly stateDirectory: string;
  };
}

/**
 * Carriles de sesión para separar la atención a personas de la interacción entre agentes.
 */
export type SessionLane = "human" | "agent";

export interface HarnessExecuteRequest {
  readonly prompt: string;
  readonly attachments?: readonly HarnessAttachment[];
  readonly context?: HarnessRequestContext;
  readonly sessionKey?: string;
  /** Carril de sesión. Ausente = `human`, que es el comportamiento de siempre. */
  readonly sessionLane?: SessionLane;
  /**
   * Descripción en claro de la conversación que produjo `sessionKey`. Sólo se persiste; no
   * cambia qué sesión se elige ni qué candado se toma. Ausente cuando el sobre no traía
   * conversación (`fallbackSessionKey`), y entonces la entrada queda sin `origin`.
   */
  readonly sessionOrigin?: SessionOrigin;
  readonly sessionReservation?: HarnessSessionReservation;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly origin?: RelayOrigin;
  /**
   * Observador opcional del testigo. Nunca gobierna la durabilidad ni el reintento: el engine
   * cruza ese gate antes de llamar a `execute`.
   */
  readonly onHarnessStart?: () => void;
  /**
   * Called only after a real harness run returned valid structured output. The engine still has to
   * match this measurement against the delivery's trusted runtime contract before emitting it.
   */
  readonly onRuntimeProfileConsumed?: (profile: RuntimeProfileMeasurement) => void;
}

export interface HarnessSessionReservation {
  readonly key: string;
  wait(signal: AbortSignal): Promise<void>;
  release(): void;
}
