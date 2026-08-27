/**
 * Tipos re-exportados del frontend para mantener consistencia.
 * La fuente de verdad es console/src/api/types.ts.
 * Estos tipos se usan en el gateway cuando devuelve GET /v3/console/agents/:tenant/:alias/directive.
 */

export interface AgentDirectiveFile {
  path?: string | null;
  /** 'user' = ~/.claude/CLAUDE.md; 'workspace' = ~/CLAUDE.md o /workspace/CLAUDE.md. */
  scope?: 'user' | 'workspace' | null;
  /** Orden de carga efectivo, de menor a mayor. */
  precedence?: number | null;
  /** SHA-256 real; permite detectar contenido duplicado entre niveles sin comparar texto truncado. */
  sha?: string | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** El texto del fichero. Puede estar truncado a MAX_DOCUMENT_BYTES (256 KB). */
  text?: string | null;
  /** true si `text` fue recortado. */
  truncated?: boolean | null;
  /** Un fallo distinto de not_found conserva su discriminante; no se presenta como ausencia. */
  error?:
    | 'permission_denied' | 'invalid_path' | 'symlink_detected' | 'too_large'
    | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown' | null;
  reason?: string | null;
}

export interface AgentMemoryIndexAvailable {
  root?: string | null;
  /** Total exacto; null significa que sólo se conoce `observed_at_least`. */
  total?: number | null;
  /** Límite inferior medido, incluso cuando el barrido fue cortado. */
  observed_at_least?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
  error?: never;
  reason?: never;
}

export interface AgentMemoryIndexUnavailable {
  root?: string | null;
  total?: null;
  observed_at_least?: null;
  truncated?: null;
  entries?: null;
  error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';
  reason: string;
}

/** `error` es el discriminante: un fallo de medición nunca vuelve a convertirse en `null`. */
export type AgentMemoryIndex = AgentMemoryIndexAvailable | AgentMemoryIndexUnavailable;

export interface AgentDirective {
  /**
   * false = este gateway no publica el endpoint (404).
   * true = sí publica, pero los ficheros pueden estar vacíos si no se pudieron leer.
   */
  publicado: boolean;
  /** Indica si la lectura se ejecutó contra el contenedor con hechos de entorno medidos. */
  medido?: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  /** Codex aplica precedencia; Claude expone únicamente su orden de carga. */
  manual_order?: 'codex_precedence' | 'claude_load_order' | 'workspace_only' | null;
  /** Esta ruta mide manuales estándar; no afirma que cubra todas las fuentes de contexto del arnés. */
  context_coverage?: 'standard_manuals' | null;
  context_limitations?: string[] | null;
  memory?: AgentMemoryIndex | null;
}
