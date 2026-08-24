/**
 * Tipos re-exportados del frontend para mantener consistencia.
 * La fuente de verdad es apps/console/src/api/types.ts.
 * Estos tipos se usan en el gateway cuando devuelve GET /v3/console/agents/:tenant/:alias/directive.
 */

export interface AgentDirectiveFile {
  path?: string | null;
  /** 'user' = ~/.claude/CLAUDE.md; 'workspace' = ~/CLAUDE.md o /workspace/CLAUDE.md. */
  scope?: 'user' | 'workspace' | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** El texto del fichero. Puede estar truncado a MAX_DOCUMENT_BYTES (256 KB). */
  text?: string | null;
  /** true si `text` fue recortado. */
  truncated?: boolean | null;
}

export interface AgentMemoryIndex {
  root?: string | null;
  /** Cuántas entradas hay DE VERDAD, aunque `entries` venga recortado. */
  total?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
}

export interface AgentDirective {
  /**
   * false = este gateway no publica el endpoint (404).
   * true = sí publica, pero los ficheros pueden estar vacíos si no se pudieron leer.
   */
  publicado: boolean;
  /**
   * ¿Ocurrió la lectura DE VERDAD? `publicado` sólo dice que la ruta existe; se puede contestar
   * 200 sin haber mirado el contenedor (sin hechos de entorno, o con rutas deducidas del
   * registro, que falla en 5 de 14 alias). Sin este campo, quien pinta confunde «no se miró» con
   * «no hay», y afirma que un alias arranca sin manual cuando el fichero está y tiene contenido.
   */
  medido?: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  memory?: AgentMemoryIndex | null;
}
