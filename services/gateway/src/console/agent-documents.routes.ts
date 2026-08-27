import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import {
  type AgentDocument, type DocumentKind, type HarnessKind, type RuntimeFacts,
  documentForKind, resolveAgentDocuments, verifyReadableDocument, verifyWritablePath
} from './agent-documents.js';

/**
 * `GET /v3/console/tenants/:tenantId/agents/:alias/documents` — inventario de ficheros de gobierno
 * asociados al alias dentro del tenant especificado.
 *
 * Cada entrada incluye `facts_source` ('measured', 'registry', 'database') indicando el origen
 * de la información de entorno. Los documentos solo se marcan como editables cuando su origen es 'measured'.
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
  /** Huella SHA-256 de los bytes reales, no del prefijo visible si viene truncado. */
  readonly sha: string;
}

export type GovernanceWritePrecondition =
  | { readonly state: 'present'; readonly sha256: string }
  | { readonly state: 'absent' };

export type GovernanceBatchWrite =
  | {
      readonly mode: 'write';
      readonly path: string;
      readonly content: string;
      readonly precondition: GovernanceWritePrecondition;
    }
  | {
      /** Acredita presencia/ausencia sin abrir para escritura ni modificar mtime. */
      readonly mode: 'verify';
      readonly path: string;
      readonly precondition: GovernanceWritePrecondition;
    };

export interface GovernanceBatchWriteAck {
  readonly path: string;
  readonly operation: 'replace' | 'create' | 'unchanged' | 'absent';
  readonly sha: string | null;
  readonly bytes: number;
}

export interface MemoryDirectoryListing {
  /** Raíz del directorio de memoria (~/.claude/projects, etc.) */
  readonly root: string;
  /** Total exacto sólo cuando el barrido terminó; null si el cap dejó un límite inferior. */
  readonly total: number | null;
  /** Entradas realmente observadas, incluso si el total exacto no se conoce. */
  readonly observed_at_least: number;
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
    | 'too_large' | 'timeout' | 'cancelled' | 'busy'
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
    signal?: AbortSignal,
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
    signal?: AbortSignal,
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
    precondition: GovernanceWritePrecondition,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<{ sha: string; bytes: number } | GovernanceReadError | { error: 'conflict'; reason: string }>;

  /** Lote indivisible para los perfiles de varios ficheros (OpenClaw). */
  writeGovernanceBatch?(
    writes: readonly GovernanceBatchWrite[],
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<readonly GovernanceBatchWriteAck[] | GovernanceReadError | { error: 'conflict'; reason: string }>;
}

export interface AgentDocumentsDeps {
  /** Autentica al principal y exige el permiso de rol de la operación. */
  authorize(
    request: unknown, permission: 'read' | 'control'
  ): Promise<{ tenant_id: string; alias: string }>;
  /** Lookup y autorización exactos; nunca resuelve sólo por alias. */
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{
    tenant_id: string;
    alias: string;
    harness_id?: string | null;
    home_directory?: string | null;
    enabled?: boolean;
  } | undefined>;
  probe: AgentFactsProbe;
}

export interface DocumentRow extends AgentDocument {
  /** El contenido se puede pedir por `:kind/content`; no implica que se pueda escribir. */
  readonly readable: boolean;
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
  return value === 'claude' || value === 'codex' || value === 'openclaw' || value === 'hermes'
    ? value : 'unknown';
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
    items: resolved.map((doc) => {
      if (!medido) {
        return {
          ...doc,
          readable: false,
          editable: false,
          reason: doc.reason ?? 'los hechos de este alias no están medidos todavía',
        };
      }
      const verdict = verifyReadableDocument(facts, doc);
      if (!verdict.allowed) {
        return {
          ...doc,
          readable: false,
          reason: doc.reason ?? verdict.reason ?? 'el contenido no se sirve por esta vía',
        };
      }
      return { ...doc, readable: true };
    }),
  };
}

export function registerAgentDocumentRoutes(app: FastifyInstance, deps: AgentDocumentsDeps): void {
  /*
   * EL CONTENIDO — las dos rutas que la consola llamaba y el servidor NO SERVÍA.
   *
   * `apps/console/src/api/client.ts` tiene `getAgentDocumentContent` y `putAgentDocumentContent`
   * desde hace semanas, apuntando a `.../documents/:kind/content`. En el servidor no existía
   * ninguna de las dos: `agent-documents.routes.ts` sólo declaraba el inventario. O sea que el
   * editor de la consola pedía un 404 y guardaba contra un 404.
   *
   * Se implementan acá, y cuando no hay hechos medidos contestan 409 con el motivo. Si el probe no
   * ofrece escritura, el PUT contesta 503: la función HTTP existe, pero no hay un canal que pueda
   * acreditar la aplicación. Un 404 del manejador queda reservado para un destino ausente o no
   * autorizado; la consola no lo disfraza como una ruta sin publicar.
   */
  const KINDS: readonly DocumentKind[] = [
    'directive', 'tools', 'prompts', 'mcp', 'identity', 'human',
    'memory', 'heartbeat', 'configuration',
  ];

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

  function contenidoGobernadoValido(valor: GovernanceDocumentContent): boolean {
    const raw = valor as unknown as Record<string, unknown>;
    if (typeof raw.text !== 'string'
        || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0
        || typeof raw.truncated !== 'boolean'
        || typeof raw.modified_at !== 'string' || raw.modified_at.length === 0
        || typeof raw.sha !== 'string' || !SHA256_PATTERN.test(raw.sha)) return false;
    const visibleBytes = Buffer.byteLength(raw.text, 'utf8');
    if (visibleBytes > Number(raw.bytes)) return false;
    return raw.truncated === true
      || (visibleBytes === Number(raw.bytes)
        && createHash('sha256').update(raw.text, 'utf8').digest('hex') === raw.sha);
  }

  type BaseParams = { tenantId?: string; alias: string };
  type ContentParams = BaseParams & { kind: string };
  type Target = NonNullable<Awaited<ReturnType<AgentDocumentsDeps['authorizeTarget']>>>;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;

  async function destino(
    request: FastifyRequest<{ Params: BaseParams | ContentParams }>,
    reply: FastifyReply,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{ actor: { tenant_id: string; alias: string }; target: Target } | undefined> {
    const aliasResult = AliasSchema.safeParse(request.params.alias);
    if (!aliasResult.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'alias is invalid' });
      return undefined;
    }
    const actor = await deps.authorize(request, permission);
    const tenantCrudo = legacySameTenant ? actor.tenant_id : request.params.tenantId;
    const tenantResult = TenantSchema.safeParse(tenantCrudo);
    if (!tenantResult.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'tenantId is invalid' });
      return undefined;
    }
    const target = await deps.authorizeTarget(
      actor, tenantResult.data, aliasResult.data, permission, legacySameTenant,
    );
    if (!target || target.tenant_id !== tenantResult.data || target.alias !== aliasResult.data) {
      await reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      return undefined;
    }
    if (legacySameTenant) reply.header('Deprecation', 'true');
    return { actor, target };
  }

  async function mapa(
    request: FastifyRequest<{ Params: BaseParams }>, reply: FastifyReply, legacySameTenant: boolean,
  ) {
    const resuelto = await destino(request, reply, 'read', legacySameTenant);
    if (!resuelto) return undefined;
    const { target } = resuelto;
    const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
    if (medido) {
      return buildDocumentsResponse(target.tenant_id, target.alias, medido.facts, medido.source);
    }
    return buildDocumentsResponse(
      target.tenant_id,
      target.alias,
      { harness: harnessFromRegistry(target.harness_id), home: target.home_directory ?? '' },
      'database',
    );
  }

  async function contenido(
    request: FastifyRequest<{ Params: ContentParams }>, reply: FastifyReply, legacySameTenant: boolean,
  ) {
      const { kind } = request.params;
      if (!kindValido(kind)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'ese tipo de documento no existe' });
      }

      const resuelto = await destino(request, reply, 'read', legacySameTenant);
      if (!resuelto) return undefined;
      const { target } = resuelto;

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      if (medido?.source !== 'measured') {
        /*
         * 409 y no 404. Que `factsFor` devuelva una fila no prueba medición: `registry` y
         * `database` siguen siendo configuración no acreditada. Sólo `measured` permite resolver
         * y abrir un path; de otro modo podríamos servir el fichero de OTRO arnés.
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

      // El inventario y el endpoint comparten esta puerta. Una fila de configuración sensible o
      // un directorio no se convierte en lectura sólo porque alguien construya la URL a mano.
      const readable = verifyReadableDocument(medido.facts, doc);
      if (!readable.allowed) {
        return reply.code(403).send({
          error: 'not_readable',
          message: readable.reason ?? doc.reason ?? 'el contenido de este elemento no se sirve por esta vía',
        });
      }

      const leido = await deps.probe.readGovernanceDocument(
        doc.path, medido.facts, target.tenant_id, target.alias,
      );
      if (esError(leido)) {
        // La ausencia es un estado editable con precondición explícita, no un error de transporte.
        // Así la creación nunca se confunde con un reemplazo cuyo fichero desapareció a mitad del
        // guardado: GET observa `sha: null`; PUT exige `create_if_absent: true`.
        if (leido.error === 'not_found') {
          return {
            tenant_id: target.tenant_id,
            alias: target.alias,
            kind,
            path: doc.path,
            format: doc.format,
            exists: false,
            content: '',
            sha: null,
            bytes: 0,
            editable: doc.editable,
            projected: false,
            ...(doc.warning === undefined ? {} : { warning: doc.warning }),
            truncated: false,
          };
        }
        return reply.code(codigoDe(leido.error)).send({ error: leido.error, message: leido.reason });
      }

      if (!contenidoGobernadoValido(leido)) {
        return reply.code(502).send({
          error: 'invalid_probe_response',
          message: 'la sonda respondió, pero no acreditó un contenido completo y coherente',
        });
      }

      return {
        tenant_id: target.tenant_id,
        alias: target.alias,
        kind,
        path: doc.path,
        format: doc.format,
        exists: true,
        content: leido.text,
        sha: leido.sha,
        bytes: leido.bytes,
        // Un prefijo no es un documento. Aunque la ruta sea escribible, el navegador no puede
        // transformar un recorte en un reemplazo sin borrar silenciosamente el resto.
        editable: doc.editable && !leido.truncated,
        projected: false,
        ...(doc.warning === undefined ? {} : { warning: doc.warning }),
        truncated: leido.truncated,
        modified_at: leido.modified_at,
      };
  }

  async function escribir(
    request: FastifyRequest<{ Params: ContentParams; Body: unknown }>,
    reply: FastifyReply,
    legacySameTenant: boolean,
  ) {
      const { kind } = request.params;
      if (!kindValido(kind)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'ese tipo de documento no existe' });
      }

      const resuelto = await destino(request, reply, 'control', legacySameTenant);
      if (!resuelto) return undefined;
      const { target } = resuelto;
      if (target.enabled !== true) {
        return reply.code(409).send({
          error: 'agent_disabled',
          message: 'el alias está apagado; no se escribe contexto en un runtime que no debe estar activo',
        });
      }

      const cuerpo = request.body;
      if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'el cuerpo tiene que ser un objeto' });
      }
      const source = cuerpo as Record<string, unknown>;
      const allowedFields = new Set(['content', 'expected_sha', 'create_if_absent']);
      if (Object.keys(source).some((field) => !allowedFields.has(field))) {
        return reply.code(400).send({ error: 'invalid_input', message: 'el cuerpo trae campos desconocidos' });
      }
      const contenido = source.content;
      if (typeof contenido !== 'string') {
        return reply.code(400).send({ error: 'invalid_input', message: '`content` tiene que ser texto' });
      }
      if (Buffer.byteLength(contenido, 'utf8') > 256 * 1024) {
        return reply.code(413).send({ error: 'too_large', message: 'el contenido se pasa del tope de 256 KiB' });
      }

      const expectedSha = source.expected_sha;
      const createIfAbsent = source.create_if_absent;
      let precondition: GovernanceWritePrecondition;
      if (createIfAbsent === true && expectedSha === undefined) {
        precondition = { state: 'absent' };
      } else if ((createIfAbsent === undefined || createIfAbsent === false)
        && typeof expectedSha === 'string' && SHA256_PATTERN.test(expectedSha)) {
        precondition = { state: 'present', sha256: expectedSha };
      } else {
        return reply.code(400).send({
          error: 'invalid_input',
          message: 'para reemplazar hace falta `expected_sha`; para crear, `create_if_absent: true` sin SHA',
        });
      }

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      if (medido?.source !== 'measured') {
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

      /*
       * PREFLIGHT FRESCO. El SHA del navegador por sí solo no dice si el contenido que vio era un
       * prefijo truncado. Volver a leer antes de escribir sirve para dos garantías distintas:
       *
       *  - create exige que el fichero siga ausente;
       *  - replace exige una lectura ENTERA cuya huella sea exactamente la que se editó.
       *
       * El pty-agent vuelve a hacer CAS al abrir el descriptor; esta lectura no lo reemplaza. Es la
       * puerta que evita que un cliente que recibió 256 KiB de un fichero mayor use su SHA real para
       * reemplazar el fichero completo con ese prefijo.
       */
      const actual = await deps.probe.readGovernanceDocument(
        doc.path, medido.facts, target.tenant_id, target.alias,
      );
      if (precondition.state === 'absent') {
        if (!esError(actual)) {
          return reply.code(409).send({
            error: 'conflict', message: 'el fichero ya existe; hay que abrirlo antes de reemplazarlo',
          });
        }
        if (actual.error !== 'not_found') {
          return reply.code(codigoDe(actual.error)).send({ error: actual.error, message: actual.reason });
        }
      } else {
        if (esError(actual)) {
          if (actual.error === 'not_found') {
            return reply.code(409).send({
              error: 'conflict', message: 'el fichero desapareció desde que se abrió; no se recreó implícitamente',
            });
          }
          return reply.code(codigoDe(actual.error)).send({ error: actual.error, message: actual.reason });
        }
        if (actual.truncated) {
          return reply.code(409).send({
            error: 'truncated_source',
            message: 'la lectura está recortada; un prefijo nunca se puede usar para reemplazar el fichero completo',
          });
        }
        if (actual.sha !== precondition.sha256) {
          return reply.code(409).send({
            error: 'conflict', message: 'el fichero cambió desde que se abrió; hay que releerlo',
          });
        }
      }

      const escrito = await deps.probe.writeGovernanceDocument(
        doc.path, contenido, precondition, medido.facts, target.tenant_id, target.alias,
      );
      if ('error' in escrito) {
        if (escrito.error === 'conflict') {
          return reply.code(409).send({ error: 'conflict', message: escrito.reason });
        }
        return reply.code(codigoDe(escrito.error)).send({ error: escrito.error, message: escrito.reason });
      }
      const raw = Buffer.from(contenido, 'utf8');
      const expectedAckSha = createHash('sha256').update(raw).digest('hex');
      if (escrito.sha !== expectedAckSha || escrito.bytes !== raw.byteLength) {
        return reply.code(502).send({
          error: 'invalid_ack',
          message: 'la sonda respondió, pero su ACK no acredita los bytes solicitados',
        });
      }
      return {
        ok: true,
        state: 'applied',
        evidence: 'probe_write_ack',
        path: doc.path,
        sha: escrito.sha,
        bytes: escrito.bytes,
      };
  }

  app.get<{ Params: BaseParams }>(
    '/v3/console/tenants/:tenantId/agents/:alias/documents',
    (request, reply) => mapa(request, reply, false),
  );
  app.get<{ Params: ContentParams }>(
    '/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content',
    (request, reply) => contenido(request, reply, false),
  );
  app.put<{ Params: ContentParams; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content',
    (request, reply) => escribir(request, reply, false),
  );

  // Compatibilidad de transición: estas rutas nunca salen del tenant autenticado y se marcan.
  app.get<{ Params: { alias: string } }>(
    '/v3/console/agents/:alias/documents',
    (request, reply) => mapa(request, reply, true),
  );
  app.get<{ Params: { alias: string; kind: string } }>(
    '/v3/console/agents/:alias/documents/:kind/content',
    (request, reply) => contenido(request, reply, true),
  );
  app.put<{ Params: { alias: string; kind: string }; Body: unknown }>(
    '/v3/console/agents/:alias/documents/:kind/content',
    (request, reply) => escribir(request, reply, true),
  );
}
