import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AliasSchema, TenantSchema, verifyManagedContextEdit, type ManagedContextEditConflict,
} from '@cauce/protocol';
import {
  MAX_DOCUMENT_BYTES, type AgentDocument, type DocumentKind, type HarnessKind, type RuntimeFacts,
  documentForKind, resolveAgentDocuments, verifyReadableDocument, verifyWritablePath
} from './agent-documents.js';

/**
 * `GET /v3/console/tenants/:tenantId/agents/:alias/documents` — inventory of governance files
 * associated with the alias inside the specified tenant.
 *
 * Each entry includes `facts_source` ('measured', 'registry', 'database') indicating the source
 * of the environment information. Documents are only marked editable when their source is
 * 'measured'.
 */

export type FactsSource = 'measured' | 'registry' | 'database';

export interface GovernanceDocumentContent {
  /** The file's content (may be truncated to MAX_DOCUMENT_BYTES). */
  readonly text: string;
  /** Actual file size (even if text is truncated). */
  readonly bytes: number;
  /** true if `text` was truncated. */
  readonly truncated: boolean;
  /** ISO timestamp of the last modification. */
  readonly modified_at: string;
  /** SHA-256 fingerprint of the actual bytes, not of the visible prefix if it comes truncated. */
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
      /** Accredits presence/absence without opening for write nor changing mtime. */
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
  /** Root of the memory directory (~/.claude/projects, etc.) */
  readonly root: string;
  /** Exact total only when the scan finished; null if the cap left a lower bound. */
  readonly total: number | null;
  /** Entries actually observed, even if the exact total is unknown. */
  readonly observed_at_least: number;
  /** true if the list was truncated. */
  readonly truncated: boolean;
  /** File entry: path relative to root. */
  readonly entries: {
    readonly path: string;
    readonly bytes: number;
    readonly modified_at: string;
  }[];
}

/**
 * Governance file read failures (these are NOT HTTP 404, they are reads that failed).
 * These are returned to the probe, which decides how to answer over HTTP.
 */
export interface GovernanceReadError {
  readonly error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout' | 'cancelled' | 'busy'
    /** Nowhere to ask: no pty-agent connected, or the one present does not know how to read. */
    | 'unavailable'
    | 'unknown';
  readonly reason: string;
}

export interface AgentFactsProbe {
  /** Facts about the alias, or `undefined` if nobody has measured them yet. */
  factsFor(tenantId: string, alias: string): Promise<
    { facts: RuntimeFacts; source: FactsSource } | undefined
  >;

  /**
   * Read a governance file of the alias (CLAUDE.md, AGENTS.md, memory, etc.).
   * The path MUST belong to the closed set from resolveAgentDocuments().
   *
   * Critical security:
   * - NEVER read outside {resolveAgentDocuments(facts)}.paths
   * - NEVER follow symlinks (verify realpath)
   * - NEVER read NEVER_SERVE_BASENAMES nor files ending in NEVER_SERVE_SUFFIXES
   * - Limit to MAX_DOCUMENT_BYTES (256 KB) — truncate if larger
   * - Read timeout (~5 seconds)
   *
   * Returns GovernanceDocumentContent or an error if it could not be read.
   */
  readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<GovernanceDocumentContent | GovernanceReadError>;

  /**
   * List the alias's memory directory (WITHOUT reading content, metadata only). The root must be valid for
   * this harness (e.g.: ~/.claude/projects).
   *
   * Security: NEVER list outside the allowed memory root.
   */
  listMemoryDirectory(
    memoryRoot: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<MemoryDirectoryListing | GovernanceReadError>;

  /**
   * Write a governance document of the alias. OPTIONAL: a probe that can only read does not bring this, and
   * PUT answers 503 instead of pretending it saved.
   *
   * `expectedSha` is the fingerprint of what was opened: if the file changed while being edited, a conflict
   * is returned and it is NOT written. What is lost in a "last writer wins" is prose that exists nowhere else.
   *
   * The same safeguards as read, and one more: `verifyWritablePath` on both the requested and the resolved
   * path. A `CLAUDE.md` that is a link to `~/.claude/.credentials.json` passes any check made on the name
   * alone.
   */
  writeGovernanceDocument?(
    path: string,
    contenido: string,
    precondition: GovernanceWritePrecondition,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<{ sha: string; bytes: number } | GovernanceReadError | { error: 'conflict'; reason: string }>;

  /** Indivisible batch for multi-file profiles (OpenClaw). */
  writeGovernanceBatch?(
    writes: readonly GovernanceBatchWrite[],
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<readonly GovernanceBatchWriteAck[] | GovernanceReadError | { error: 'conflict'; reason: string }>;
}

interface AgentDocumentsDeps {
  /** Authenticates the principal and requires the role permission for the operation. */
  authorize(
    request: unknown, permission: 'read' | 'control'
  ): Promise<{ tenant_id: string; alias: string }>;
  /** Exact lookup and authorization; never resolves by alias alone. */
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

interface DocumentRow extends AgentDocument {
  /** The content can be requested via `:kind/content`; it does not imply it can be written. */
  readonly readable: boolean;
  /** Never `true` if the facts are not measured: this is stated by the field itself, not by a comment. */
  readonly editable: boolean;
}

export interface DocumentsResponse {
  readonly tenant_id: string;
  readonly alias: string;
  readonly facts_source: FactsSource;
  readonly harness: HarnessKind;
  readonly home: string | null;
  /** Notice written in Spanish when the source is not a measurement. It is displayed at the very top. */
  readonly caveat?: string;
  readonly items: readonly DocumentRow[];
}

const CAVEAT_NO_MEDIDO =
  'Estas rutas están DEDUCIDAS del registro, no medidas dentro del contenedor. El 23-ago-2026 el ' +
  'registro se equivocaba de arnés en 5 de los 14 alias, así que trátalas como una pista y no ' +
  'como la verdad. Nada es editable hasta que el pty-agent mida el entorno del proceso.';

const MANAGED_CONTEXT_CONFLICT_MESSAGES: Record<ManagedContextEditConflict, string> = {
  malformed_current: 'el fichero actual tiene marcadores CAUCE malformados; no se modifica manualmente',
  malformed_proposed: 'la edición crea o malforma marcadores CAUCE gestionados',
  managed_fixed_context_changed: 'la edición altera o retira el bloque CAUCE de contexto fijo',
  managed_profile_changed: 'la edición altera, crea o retira el bloque CAUCE de campos canónicos de Contexto',
  managed_profile_revision_changed: 'la edición altera, crea o retira la revisión CAUCE de Contexto',
  reserved_markers_changed: 'la edición altera, crea, retira o reordena marcadores CAUCE reservados',
  reserved_markers_on_create: 'un fichero nuevo no puede crear marcadores CAUCE reservados desde el manual',
  unknown_reserved_markers_in_current: 'el fichero usa marcadores CAUCE de una versión más nueva; actualizá el gateway antes de editarlo',
  unknown_reserved_markers_in_proposed: 'la edición introduce marcadores CAUCE que este gateway no conoce',
};

function harnessFromRegistry(value: string | null | undefined): HarnessKind {
  return value === 'claude' || value === 'codex' || value === 'openclaw' || value === 'hermes'
    ? value : 'unknown';
}

function buildDocumentsResponse(
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
  // Read and write routes for governed content (:kind/content).
  const KINDS: readonly DocumentKind[] = [
    'directive', 'tools', 'prompts', 'mcp', 'identity', 'human',
    'memory', 'heartbeat', 'configuration',
  ];

  function kindValido(valor: string): valor is DocumentKind {
    return (KINDS as readonly string[]).includes(valor);
  }

  /** The read error translated into the HTTP code that describes it, not a generic 500. */
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
    return raw.truncated
      || (visibleBytes === Number(raw.bytes)
        && createHash('sha256').update(raw.text, 'utf8').digest('hex') === raw.sha);
  }

  interface BaseParams { tenantId?: string; alias: string }
  type ContentParams = BaseParams & { kind: string };
  type Target = NonNullable<Awaited<ReturnType<AgentDocumentsDeps['authorizeTarget']>>>;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;

  async function destino(
    request: FastifyRequest<{ Params: BaseParams | ContentParams }>,
    reply: FastifyReply,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<Target | undefined> {
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
    if (target?.tenant_id !== tenantResult.data || target.alias !== aliasResult.data) {
      await reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      return undefined;
    }
    if (legacySameTenant) reply.header('Deprecation', 'true');
    return target;
  }

  async function mapa(
    request: FastifyRequest<{ Params: BaseParams }>, reply: FastifyReply, legacySameTenant: boolean,
  ) {
    const target = await destino(request, reply, 'read', legacySameTenant);
    if (!target) return undefined;
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

      const target = await destino(request, reply, 'read', legacySameTenant);
      if (!target) return undefined;

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      if (medido?.source !== 'measured') {
        /*
         * 409 and not 404. `factsFor` returning a row does not prove measurement: `registry` and
         * `database` are still unaccredited configuration. Only `measured` allows resolving and
         * opening a path; otherwise we could serve ANOTHER harness's file.
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

      // The inventory and the endpoint share this gate. A sensitive configuration row or a
      // directory does not become readable just because someone hand-builds the URL.
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
        // Absence is an editable state with explicit precondition, not a transport error. This
        // way creation is never confused with a replacement whose file disappeared mid-save: GET
        // observes `sha: null`; PUT requires `create_if_absent: true`.
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
        // A prefix is not a document. Even if the path is writable, the browser cannot turn a
        // snippet into a replacement without silently deleting the rest.
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

      const target = await destino(request, reply, 'control', legacySameTenant);
      if (!target) return undefined;
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
      if (Buffer.byteLength(contenido, 'utf8') > MAX_DOCUMENT_BYTES) {
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

      // The write gate, BEFORE checking whether there is a channel: a forbidden path is rejected
      // regardless of whether the channel exists, and even if it does not we want the reason to
      // be the real one.
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
       * FRESH PREFLIGHT. The browser's SHA alone does not tell whether the content it saw was a truncated
       * prefix. Re-reading before writing serves two distinct guarantees: create demands that the file is
       * still absent, and replace demands a FULL read whose fingerprint is exactly the one edited.
       *
       * The pty-agent CASes again when opening the descriptor; this read does not replace it. It is the gate
       * that prevents a client that received 256 KiB of a larger file from using its real SHA to replace the
       * whole file with that prefix.
       */
      const actual = await deps.probe.readGovernanceDocument(
        doc.path, medido.facts, target.tenant_id, target.alias,
      );
      let contenidoActual: string | undefined;
      if (precondition.state === 'absent') {
        if (!esError(actual)) {
          return reply.code(409).send({
            error: 'conflict', message: 'el fichero ya existe; hay que abrirlo antes de reemplazarlo',
          });
        }
        if (actual.error !== 'not_found') {
          return reply.code(codigoDe(actual.error)).send({ error: actual.error, message: actual.reason });
        }
        contenidoActual = undefined;
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
        contenidoActual = actual.text;
      }

      if (kind === 'directive') {
        const managedContext = verifyManagedContextEdit(contenidoActual, contenido);
        if (!managedContext.allowed) {
          return reply.code(409).send({
            error: 'managed_context_conflict',
            conflict: managedContext.conflict,
            message: MANAGED_CONTEXT_CONFLICT_MESSAGES[managedContext.conflict],
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

  // Transition compatibility: these routes never leave the authenticated tenant and are marked.
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
