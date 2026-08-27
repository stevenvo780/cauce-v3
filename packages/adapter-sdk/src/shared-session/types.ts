import type { CommandRunner, HarnessId } from "../sdk/types.js";

/**
 * Harnesses compatibles con el mecanismo de sesión compartida.
 */
export type SharedSessionHarness = Extract<HarnessId, "claude" | "codex">;

export function isSharedSessionHarness(harness: HarnessId): harness is SharedSessionHarness {
  return harness === "claude" || harness === "codex";
}

/**
 * Razones por las que un turno no pudo servirse mediante la sesión compartida.
 */
export type DegradationReason =
  /** No existe la sesión tmux, o no se pudo crear. */
  | "session_absent"
  /** La sesión existe pero no hay TUI viva del harness dentro. */
  | "tui_absent"
  /** La sesión exacta declara otro alias; nunca se reutiliza ni se destruye automáticamente. */
  | "session_alias_mismatch"
  /** La sesión exacta pertenece a otro harness (por ejemplo claude tras migrar a codex). */
  | "session_harness_mismatch"
  /** Una sesión legacy no dio evidencia suficiente para acreditar alias+harness. */
  | "session_identity_unverified"
  /** El dueño tenía texto a medio escribir en la caja y nunca la soltó dentro del plazo. */
  | "input_busy"
  /** La TUI está bloqueada esperando respuesta en un diálogo modal. */
  | "modal_blocking"
  /** El pegado no pudo enviarse o la TUI no registró el turno. */
  | "handshake_failed"
  /** La TUI se reinició entre turnos y la conversación comenzó en blanco. */
  | "context_reset"
  /** No había sesión compartida previa y se creó una nueva para este turno. */
  | "session_created"
  /** El contexto de la conversación fue limpiado deliberadamente (/clear o /new). */
  | "context_cleared"
  /** La terminal compactó su contexto de conversación. */
  | "context_compacted"
  /** El turno se fusionó con una ejecución ya en curso en la TUI. */
  | "turn_merged";

/**
 * Porción del transcript con entradas históricas y añadidas en el turno actual.
 */
export interface TranscriptSlice<E> {
  /** Lo que hace falta para correlacionar. Puede ser el fichero entero si el harness lo exige. */
  readonly entries: readonly E[];
  /** Sólo lo escrito después del corte, que es lo que pudo pasar durante este turno. */
  readonly appended: readonly E[];
}

/** El turno que creó nuestro pegado, ya identificado dentro del registro. */
export interface InjectedTurn {
  /** Con qué se sigue el turno: el uuid de la entrada en claude, el `turn_id` en codex. */
  readonly key: string;
  /** Identidad de la conversación, para detectar un vaciado y para el `session_id` del resultado. */
  readonly sessionId?: string;
}

/**
 * Cómo terminó el turno, cuando ya se puede afirmar que terminó.
 *
 * `failed` existe para que una interrupción del dueño (Esc en la TUI de codex) no se pague con
 * media hora de silencio: sin esto el turno agota el presupuesto y sale `timedOut`, que el
 * adaptador trata como AMBIGUO y no reintenta. Con esto se dice lo que pasó.
 */
export type TurnOutcome =
  | { readonly kind: "answer"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "failed"; readonly detail: string };

/** Una compactación ocurrida durante el turno, con un id estable para no repetir el aviso. */
export interface CompactionNotice {
  readonly id: string;
  readonly detail: string;
}

export interface TranscriptReader<E> {
  /** Los ficheros del registro. Recursivo si el harness los reparte en carpetas. */
  files(): Promise<readonly string[]>;
  /** Lee desde `offset`; `entries` es lo que hace falta para correlacionar, `appended` sólo lo nuevo. */
  read(file: string, offset: number): Promise<TranscriptSlice<E>>;
  /** La entrada que creó ESTE turno, identificada por el texto exacto que se pegó. */
  findInjected(file: string, entries: readonly E[], promptText: string): InjectedTurn | undefined;
  /** El desenlace de ese turno, o `undefined` mientras siga corriendo. */
  findAnswer(entries: readonly E[], key: string): TurnOutcome | undefined;
  /**
   * Busca un sobre estructurado correlacionado en las entradas del transcript.
   */
  findEnvelope?(
    entries: readonly E[],
    correlationId: string,
    desde?: string,
  ): TurnOutcome | undefined;
  compactions(appended: readonly E[]): readonly CompactionNotice[];
  /** Indica si se registró el inicio de algún turno en las entradas añadidas. */
  startedTurn?(appended: readonly E[]): boolean;
  /** El resultado con la forma nativa del harness, para ser procesado por el parser estándar. */
  stdout(text: string, sessionId: string | undefined): string;
}

export interface SharedSessionDegradation {
  readonly reason: DegradationReason;
  /** Texto descriptivo del motivo de degradación. */
  readonly detail: string;
  readonly occurredAt: string;
  /** `true` cuando el turno se sirvió por el ejecutor alternativo en lugar de la sesión compartida. */
  readonly fellBack: boolean;
}

/**
 * Ejecutor que expone información sobre degradación de la sesión compartida.
 */
export interface SharedSessionRunner extends CommandRunner {
  takeDegradation(): SharedSessionDegradation | undefined;
}

export function isSharedSessionRunner(runner: CommandRunner): runner is SharedSessionRunner {
  return typeof (runner as Partial<SharedSessionRunner>).takeDegradation === "function";
}

/** Nombre canónico de la sesión tmux para un alias dado. */
export function sessionName(alias: string): string {
  return `cauce-${alias}`;
}

/**
 * Especificación de reanudación de conversación para un harness.
 */
export interface ResumeSpec {
  /** Argumentos que reanudan: `resume --last` en codex, `--continue` en claude. */
  readonly args: readonly string[];
  /** ¿Hay algo que ese `args` pueda reanudar de verdad? */
  hasPreviousConversation(): Promise<boolean>;
}

/**
 * Socket tmux dedicado para Cauce.
 */
export const TMUX_SOCKET = "cauce";

/** Ventana donde vive la TUI del harness. */
export const TUI_WINDOW = "agente";

/** Nombre de ventana legacy utilizado en versiones anteriores. */
export const LEGACY_DEGRADED_WINDOW = "⚠ CAUCE-DEGRADADO";

