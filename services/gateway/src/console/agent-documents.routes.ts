import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  type AgentDocument, type DocumentKind, type HarnessKind, type RuntimeFacts,
  documentForKind, resolveAgentDocuments, verifyWritablePath
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

  /**
   * Escribir un documento de gobierno del alias. OPCIONAL: una sonda que sólo sabe leer no lo trae,
   * y el PUT contesta 503 en vez de fingir que guardó.
   *
   * `expectedSha` es la huella de lo que se abrió: si el fichero cambió mientras se editaba, se
   * devuelve conflicto y NO se escribe. Lo que se pierde en un «gana el último» es prosa que no
   * está en ningún otro sitio.
   *
   * Las mismas guardas que la lectura, y una más: `verifyWritablePath` sobre la ruta pedida Y la
   * resuelta. Un `CLAUDE.md` que sea un enlace a `~/.claude/.credentials.json` pasa cualquier
   * comprobación hecha sólo sobre el nombre.
   */
  writeGovernanceDocument?(
    path: string,
    contenido: string,
    expectedSha: string | undefined,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<{ sha: string; bytes: number } | GovernanceReadError | { error: 'conflict'; reason: string }>;
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

  /*
   * EL CONTENIDO — las dos rutas que la consola llamaba y el servidor NO SERVÍA.
   *
   * `apps/console/src/api/client.ts` tiene `getAgentDocumentContent` y `putAgentDocumentContent`
   * desde hace semanas, apuntando a `.../documents/:kind/content`. En el servidor no existía
   * ninguna de las dos: `agent-documents.routes.ts` sólo declaraba el inventario. O sea que el
   * editor de la consola pedía un 404 y guardaba contra un 404.
   *
   * Se implementan acá, y lo que contestan cuando no hay canal NO es 404: es 409 con el motivo.
   * La diferencia no es cosmética y el propio cliente la documenta — un 404 dice «este gateway no
   * tiene la función» y un 409 dice «la función está, pero nadie ha medido el contenedor». Con el
   * 404, la consola concluía lo primero cuando pasaba lo segundo, que es exactamente la queja de
   * «las directivas no se muestran, dicen que no están en capa 2 y 3».
   */
  const KINDS: readonly DocumentKind[] = ['directive', 'tools', 'prompts', 'mcp'];

  function kindValido(valor: string): valor is DocumentKind {
    return (KINDS as readonly string[]).includes(valor);
  }

  /** El error de lectura traducido al código HTTP que lo describe, no a un 500 genérico. */
  function codigoDe(error: GovernanceReadError['error']): number {
    if (error === 'not_found') return 404;
    if (error === 'permission_denied' || error === 'symlink_detected') return 403;
    if (error === 'invalid_path') return 400;
    if (error === 'too_large') return 413;
    if (error === 'timeout' || error === 'unavailable') return 503;
    return 500;
  }

  function esError(valor: object): valor is GovernanceReadError {
    return 'error' in valor;
  }

  app.get<{ Params: { alias: string; kind: string } }>(
    '/v3/console/agents/:alias/documents/:kind/content',
    async (request, reply) => {
      const actor = await deps.authorize(request);
      const { alias, kind } = request.params;
      if (!kindValido(kind)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'ese tipo de documento no existe' });
      }

      const medido = await deps.probe.factsFor(actor.tenant_id, alias);
      if (!medido) {
        /*
         * 409 y no 404. Sin hechos medidos NO se puede saber qué fichero es «la directiva» de este
         * alias: el registro se equivocaba de arnés en 5 de los 14 el 23-ago, así que deducirlo
         * serviría el fichero de OTRO arnés. Se dice que no se midió, con esas palabras.
         */
        return reply.code(409).send({
          error: 'no_medido',
          message: 'los hechos de este alias no están medidos dentro de su contenedor, así que no '
            + 'se sabe qué fichero es éste. No es que el fichero no exista: es que no se ha mirado.',
        });
      }

      const doc = documentForKind(medido.facts, kind);
      if (!doc) {
        return reply.code(404).send({ error: 'not_found', message: 'ese alias no tiene ese documento' });
      }

      const leido = await deps.probe.readGovernanceDocument(doc.path, medido.facts, actor.tenant_id, alias);
      if (esError(leido)) {
        return reply.code(codigoDe(leido.error)).send({ error: leido.error, message: leido.reason });
      }

      return {
        tenant_id: actor.tenant_id,
        alias,
        kind,
        path: doc.path,
        format: doc.format,
        exists: true,
        content: leido.text,
        sha: shaDe(leido.text),
        bytes: leido.bytes,
        editable: doc.editable,
        truncated: leido.truncated,
        modified_at: leido.modified_at,
      };
    },
  );

  app.put<{ Params: { alias: string; kind: string }; Body: unknown }>(
    '/v3/console/agents/:alias/documents/:kind/content',
    async (request, reply) => {
      const actor = await deps.authorize(request);
      const { alias, kind } = request.params;
      if (!kindValido(kind)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'ese tipo de documento no existe' });
      }

      const cuerpo = request.body;
      if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'el cuerpo tiene que ser un objeto' });
      }
      const contenido = (cuerpo as Record<string, unknown>).content;
      if (typeof contenido !== 'string') {
        return reply.code(400).send({ error: 'invalid_input', message: '`content` tiene que ser texto' });
      }
      const expectedShaCrudo = (cuerpo as Record<string, unknown>).expected_sha;
      const expectedSha = typeof expectedShaCrudo === 'string' ? expectedShaCrudo : undefined;

      const medido = await deps.probe.factsFor(actor.tenant_id, alias);
      if (!medido) {
        return reply.code(409).send({
          error: 'no_medido',
          message: 'los hechos de este alias no están medidos dentro de su contenedor. Escribir sin '
            + 'saber qué fichero es sería escribir en el fichero de otro arnés.',
        });
      }

      // La puerta de escritura, ANTES de mirar si hay canal: una ruta prohibida se rechaza igual
      // aunque el canal exista, y aunque no exista queremos que el motivo sea el de verdad.
      const doc = documentForKind(medido.facts, kind);
      if (!doc) {
        return reply.code(404).send({ error: 'not_found', message: 'ese alias no tiene ese documento' });
      }
      const veredicto = verifyWritablePath(medido.facts, kind, doc.path);
      if (!veredicto.allowed) {
        return reply.code(403).send({ error: 'forbidden', message: veredicto.reason ?? 'no se puede escribir ahí' });
      }

      if (deps.probe.writeGovernanceDocument === undefined) {
        return reply.code(503).send({
          error: 'unavailable',
          message: 'este gateway sabe leer los ficheros del alias pero no escribirlos: su sonda no '
            + 'tiene canal de escritura hasta el contenedor.',
        });
      }

      const escrito = await deps.probe.writeGovernanceDocument(
        doc.path, contenido, expectedSha, medido.facts, actor.tenant_id, alias,
      );
      if ('error' in escrito) {
        if (escrito.error === 'conflict') {
          return reply.code(409).send({ error: 'conflict', message: escrito.reason });
        }
        return reply.code(codigoDe(escrito.error)).send({ error: escrito.error, message: escrito.reason });
      }
      return { ok: true, path: doc.path, sha: escrito.sha, bytes: escrito.bytes };
    },
  );
}

/**
 * La huella de lo servido, para que dos personas no se pisen en silencio.
 *
 * sha256 del texto tal cual se sirvió. Se calcula sobre el TEXTO y no sobre el fichero del disco
 * porque es el texto lo que el operador tiene delante: si el servidor truncó, la huella tiene que
 * ser la del recorte o el guardado siguiente creería que el fichero cambió cuando no cambió.
 */
function shaDe(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}
