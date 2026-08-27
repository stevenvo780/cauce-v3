import type { CommandRunResult, CommandRunner } from "../../sdk/types.js";
import type { PaneIdentity, TmuxController } from "../tmux.js";
import type {
  ResumeSpec,
  SharedSessionDegradation,
  SharedSessionHarness,
  TranscriptReader,
} from "../types.js";

export interface PasteSessionOptions<E> {
  readonly alias: string;
  /** Qué TUI corre en el panel. Determina el binario de la sesión compartida. */
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. */
  readonly workspace: string;
  /** Lector de transcript del harness para obtener los sobres estructurados. */
  readonly transcript: TranscriptReader<E>;
  /** Variables de entorno fijadas al crear el panel. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly tmux: TmuxController;
  /** Runner de respaldo utilizado cuando la sesión compartida se degrada. */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que la caja de entrada quede libre antes de degradar. */
  readonly acquireTimeoutMs?: number;
  /**
   * Recorte opcional del turno inyectado por debajo de `request.timeoutMs`.
   * Si vence el plazo, el estado de ejecución se reporta como ambiguo sin reintento automático.
   */
  readonly turnTimeoutMs?: number;
  /** Espera terminal máxima tras interrumpir un turno cancelado antes de poner el pane en cuarentena. */
  readonly cancelDrainTimeoutMs?: number;
  /** Marca durable de cuarentena; producción la ubica dentro del state directory del alias. */
  readonly quarantineFile?: string;
  /** Presupuesto acotado para cada operación de cuarentena. */
  readonly quarantineOperationTimeoutMs?: number;
  /** Persistencia inyectable para acreditar fallos y bloqueos de disco en pruebas. */
  readonly quarantinePersistence?: QuarantinePersistence;
  /** Tiempo de espera entre el pegado y el envío de Enter. */
  readonly settleMs?: number;
  /** Tiempo de espera para que la TUI registre el turno pegado. */
  readonly injectTimeoutMs?: number;
  /** Tiempo límite para correlacionar el pegado. */
  readonly correlationTimeoutMs?: number;
  /** Tiempo de inactividad para considerar perdido un pegado sin correlacionar. */
  readonly quietTimeoutMs?: number;
  /** Techo absoluto de la espera por un turno fundido. */
  readonly mergedGraceMs?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  /** Cómo se reanuda la conversación si es necesario recrear el panel. Ver `ResumeSpec`. */
  readonly resume?: ResumeSpec;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
  /** Notificación de incidencias durante la inicialización o reanudación. */
  readonly onNotice?: (detail: string) => void;
}

export interface CommittedRunResult {
  readonly result: CommandRunResult;
  /** Transcript correlacionado o desaparición/cambio exacto: ya es seguro retirar pending. */
  readonly terminalBoundary: boolean;
}

export type FileQuarantineState = "current" | "stale" | "absent" | "unreadable";

/** Operaciones mínimas de la barrera durable, separadas para poder probar I/O colgado. */
export interface QuarantinePersistence {
  readonly inspect: (path: string, identity: PaneIdentity) => Promise<FileQuarantineState>;
  readonly persist: (path: string, identity: PaneIdentity) => Promise<boolean>;
  /**
   * Publica una preparación pre-paste mediante CAS de nombre: nunca reemplaza un pending que ya
   * exista. El llamador no abandona esta frontera atómica; sólo se pega después de `true`.
   */
  readonly commitPrepared: (
    preparedPath: string,
    pendingPath: string,
    identity: PaneIdentity,
  ) => Promise<boolean>;
  readonly clear: (path: string) => Promise<boolean>;
}

export interface PendingQuarantine {
  readonly identity: PaneIdentity;
  readonly correlationId: string;
  readonly file?: string;
}
