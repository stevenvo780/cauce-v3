import type { PaneHarnessIdentity } from "../tmux.js";
import type { ResumeSpec, SharedSessionHarness } from "../types.js";

export interface SharedSessionSpec {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. Es también lo que determina el directorio de transcripts. */
  readonly workspace: string;
  /** Binario del harness. Se separa para poder apuntarlo a un doble en las pruebas. */
  readonly command?: string;
  /**
   * Variables de entorno aplicadas en el comando de arranque del panel (`env K=V ...`).
   */
  readonly environment?: Readonly<Record<string, string>>;
  /** Especificación de reanudación de conversación previa si existe. Ver `ResumeSpec`. */
  readonly resume?: ResumeSpec;
}

export interface EnsureOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** Cancela el preflight antes de que una entrega toque la caja de entrada. */
  readonly signal?: AbortSignal;
  /** Cuánto se espera a que la TUI esté lista tras crearla. */
  readonly readyTimeoutMs?: number;
  /** Ancho/alto con que nace la sesión sin clientes enganchados. */
  readonly width?: number;
  readonly height?: number;
  /** Función de registro para eventos de reanudación o incidencias. */
  readonly log?: (detail: string) => void;
}

export interface EnsureResult {
  readonly ready: boolean;
  /** True si esta llamada tuvo que crear la sesión (no existía). */
  readonly created: boolean;
  /** PID del proceso del panel de la TUI, cuando se pudo leer. */
  readonly pid?: string;
  /** Id exacto `$N` acreditado. Todo uso posterior de la TUI se dirige a él, nunca al nombre. */
  readonly sessionId?: string;
  /** Generación exacta acreditada (session/pane/PID) y comando observado para esa misma foto. */
  readonly pane?: PaneHarnessIdentity;
  readonly detail: string;
  /** El preflight fue interrumpido; no es una degradación ni autoriza a ejecutar el fallback. */
  readonly cancelled?: boolean;
  /** Causa del fallo durante el proceso de ensure. */
  readonly failure?: EnsureFailure;
  /** Indica si la sesión fue creada reanudando una conversación previa. */
  readonly resumed?: boolean;
}

export type EnsureFailure =
  | "session_absent"
  | "tui_absent"
  /** El nombre exacto de la sesion y el alias grabado en ella no coinciden. */
  | "session_alias_mismatch"
  /** La sesion pertenece a otro harness; reutilizarla mezclaria dos conversaciones. */
  | "session_harness_mismatch"
  /** Una sesion legacy no dio evidencia suficiente para poder marcar alias+harness. */
  | "session_identity_unverified";

export interface SharedSessionStatus {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  readonly session: string;
  readonly present: boolean;
  readonly pid?: string;
}
