import type { FastifyInstance } from 'fastify';
import {
  type AgentDocument, type HarnessKind, type RuntimeFacts, resolveAgentDocuments
} from './agent-documents.js';

/**
 * `GET /v3/console/agents/:alias/documents` — el inventario de ficheros que gobiernan a un alias.
 *
 * SÓLO LECTURA, y ni siquiera del contenido: devuelve QUÉ fichero es cada cosa y DÓNDE vive. Hoy
 * la consola no enseña ninguna de estas rutas (medido el 23-ago contra el bundle desplegado
 * `index-Dnt3aJEt.js`: cero apariciones de «claude.md», «herramientas», «mcp» o «skill»), así que
 * el primer escalón útil es que Steven pueda ver el mapa antes de que exista el editor.
 *
 * La honestidad es el punto de esta ruta. Cada fila viaja con `facts_source`:
 *
 *  - `measured`: el pty-agent leyó el entorno del proceso del arnés DENTRO del contenedor. Sólo
 *    entonces la ruta es de fiar y `editable` puede ser `true`.
 *  - `registry`: viene de la presencia del pty-agent (arnés y usuario configurados en su bundle).
 *    Mejor que la base, pero sigue siendo configuración.
 *  - `database`: `agents.harness_id` / `agents.home_directory`. NO es de fiar y se marca así.
 *
 * Que la base no es de fiar está medido, no supuesto: el 23-ago, `agents.harness_id` no coincidía
 * con el binario en ejecución en 5 de 14 alias (argos, heraclito, kant, kratos, salva) y
 * `agents.home_directory` daba `/home/dev` para iza, que corre con `HOME=/home/claw`. Por eso
 * ninguna fila con `facts_source` distinto de `measured` sale nunca como editable.
 */

export type FactsSource = 'measured' | 'registry' | 'database';

export interface GovernanceDocumentContent {
  /** El contenido del fichero (puede estar truncado a MAX_DOCUMENT_BYTES). */
  readonly text: string;
  /** Tamaño real del fichero (aunque text esté truncado). */
  readonly bytes: number;
  /** true si `text` fue recortado. */
  readonly truncated: boolean;
  /** Timestamp ISO de la última modificación. */
  readonly modified_at: string;
}

export interface MemoryDirectoryListing {
  /** Raíz del directorio de memoria (~/.claude/projects, etc.) */
  readonly root: string;
  /** Total de ficheros en el directorio, aunque entries venga recortado. */
  readonly total: number;
  /** true si la lista fue recortada. */
  readonly truncated: boolean;
  /** Entrada de fichero: ruta relativa a root. */
  readonly entries: Array<{
    readonly path: string;
    readonly bytes: number;
    readonly modified_at: string;
  }>;
}

/**
 * Fallos en lectura de fichero de gobierno (no son HTTP 404, son lecturas que erraron).
 * Estos se devuelven al probe, que decide cómo responder al HTTP.
 */
export interface GovernanceReadError {
  readonly error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout'
    /** No hay por dónde preguntar: sin pty-agent conectado, o el que hay no sabe leer. */
    | 'unavailable'
    | 'unknown';
  readonly reason: string;
}

export interface AgentFactsProbe {
  /** Hechos del alias, o `undefined` si nadie los ha medido todavía. */
  factsFor(tenantId: string, alias: string): Promise<
    { facts: RuntimeFacts; source: FactsSource } | undefined
  >;

  /**
   * Leer un fichero de gobierno del alias (CLAUDE.md, AGENTS.md, memoria, etc.).
   * La ruta DEBE estar en el juego cerrado de resolveAgentDocuments().
   *
   * Seguridad crítica:
   * - NUNCA leer fuera de {resolveAgentDocuments(facts)}.paths
   * - NUNCA seguir symlinks (verificar realpath)
   * - NUNCA leer NEVER_SERVE_BASENAMES ni archivos que terminen en NEVER_SERVE_SUFFIXES
   * - Limitar a MAX_DOCUMENT_BYTES (256 KB) — truncar si es mayor
   * - Timeout de lectura (~5 segundos)
   *
   * Devuelve GovernanceDocumentContent o error si no se pudo leer.
   */
  readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<GovernanceDocumentContent | GovernanceReadError>;

  /**
   * Listar el directorio de memoria del alias (SIN leer contenido, sólo metadata).
   * La raíz debe ser válida para este arnés (ej: ~/.claude/projects).
   *
   * Seguridad: NUNCA listar fuera de la raíz de memoria permitida.
   */
  listMemoryDirectory(
    memoryRoot: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<MemoryDirectoryListing | GovernanceReadError>;
}

export interface AgentDocumentsDeps {
  /** Resuelve el principal y exige el permiso, igual que el resto de `/v3/console`. */
  authorize(request: unknown): Promise<{ tenant_id: string; alias: string }>;
  probe: AgentFactsProbe;
  /** Filas de `agents` visibles para el actor, para poder responder algo cuando no hay medición. */
  lookupAgent(alias: string, tenantId: string, actorAlias: string): Promise<
    { tenant_id: string; alias: string; harness_id?: string | null; home_directory?: string | null } | undefined
  >;
}

export interface DocumentRow extends AgentDocument {
  /** Nunca `true` si los hechos no están medidos: lo dice el propio campo, no un comentario. */
  readonly editable: boolean;
}

export interface DocumentsResponse {
  readonly tenant_id: string;
  readonly alias: string;
  readonly facts_source: FactsSource;
  readonly harness: HarnessKind;
  readonly home: string | null;
  /** Aviso en castellano cuando la fuente no es una medición. Se enseña arriba del todo. */
  readonly caveat?: string;
  readonly items: readonly DocumentRow[];
}

const CAVEAT_NO_MEDIDO =
  'Estas rutas están DEDUCIDAS del registro, no medidas dentro del contenedor. El 23-ago-2026 el ' +
  'registro se equivocaba de arnés en 5 de los 14 alias, así que trátalas como una pista y no ' +
  'como la verdad. Nada es editable hasta que el pty-agent mida el entorno del proceso.';

function harnessFromRegistry(value: string | null | undefined): HarnessKind {
  return value === 'claude' || value === 'codex' || value === 'openclaw' ? value : 'unknown';
}

export function buildDocumentsResponse(
  tenantId: string,
  alias: string,
  facts: RuntimeFacts,
  source: FactsSource,
): DocumentsResponse {
  const resolved = resolveAgentDocuments(facts);
  const medido = source === 'measured';
  return {
    tenant_id: tenantId,
    alias,
    facts_source: source,
    harness: facts.harness,
    home: facts.home || null,
    ...(medido ? {} : { caveat: CAVEAT_NO_MEDIDO }),
    items: resolved.map((doc) => (medido ? doc : {
      ...doc,
      editable: false,
      reason: doc.reason ?? 'los hechos de este alias no están medidos todavía',
    })),
  };
}

export function registerAgentDocumentRoutes(app: FastifyInstance, deps: AgentDocumentsDeps): void {
  app.get<{ Params: { alias: string } }>(
    '/v3/console/agents/:alias/documents',
    async (request, reply) => {
      const actor = await deps.authorize(request);
      const alias = request.params.alias;

      const medido = await deps.probe.factsFor(actor.tenant_id, alias);
      if (medido) {
        return buildDocumentsResponse(actor.tenant_id, alias, medido.facts, medido.source);
      }

      const fila = await deps.lookupAgent(alias, actor.tenant_id, actor.alias);
      if (!fila) {
        await reply.code(404).send({ error: 'not_found', message: 'ese alias no existe o no lo ves' });
        return undefined;
      }
      return buildDocumentsResponse(
        fila.tenant_id,
        fila.alias,
        { harness: harnessFromRegistry(fila.harness_id), home: fila.home_directory ?? '' },
        'database',
      );
    },
  );
}
