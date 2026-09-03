import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AliasSchema, TenantSchema, verifyManagedContextEdit, type ManagedContextEditConflict,
} from '@cauce/protocol';
import {
  MAX_DOCUMENT_BYTES, type AgentDocument, type DocumentKind, type HarnessKind, type RuntimeFacts,
  documentForKind, resolveAgentDocuments, verifyReadableDocument, verifyWritablePath
} from './agent-documents.js';
import {
  admitGovernanceWrite, isRejectedWrite, SHA256_PATTERN, type GovernanceWritePrecondition,
} from './agent-documents/write-admission.js';
import {
  contextContamination, evaluarContaminacion, type ContextContaminationTelemetry,
} from './contaminacion-de-contexto.js';
import { CONTEXT_APPLY_POLICY, type ContextApplyState } from './context-apply-policy.js';
import type { TerminalAuditEntry } from '../terminal/audit.js';
import { UNATTRIBUTED_OPERATOR } from '../terminal/types.js';

export type { TerminalAuditEntry, GovernanceWritePrecondition };

/**
 * Governance files of an alias: the inventory says where each one lives and whether its
 * `facts_source` is a measurement; nothing is readable or writable while it is not.
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
   * Reads a governance file of the alias. The path MUST come from the closed set of
   * `resolveAgentDocuments`, never from the browser: no symlink is followed, no
   * `NEVER_SERVE_BASENAMES` or `NEVER_SERVE_SUFFIXES` name is opened, the read is capped at
   * `MAX_DOCUMENT_BYTES` (truncating past it) and it times out instead of hanging.
   */
  readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<GovernanceDocumentContent | GovernanceReadError>;

  /**
   * List the alias's memory directory (metadata only, never content). The root must be valid for this
   * harness (e.g.: ~/.claude/projects), and NEVER lists outside the allowed memory root.
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
   * `expectedSha` is the fingerprint of what was opened: a file changed while being edited comes back
   * as a conflict and is NOT written; a "last writer wins" loses prose that exists nowhere else.
   *
   * The same safeguards as read plus `verifyWritablePath` on the requested AND the resolved path: a
   * `CLAUDE.md` linked to `~/.claude/.credentials.json` passes any check made on the name alone.
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

/** Human behind the request, in the shape the PTY plane resolves it (`terminal/authority.ts`). */
export interface DocumentOperator {
  readonly operator_id: string;
  readonly attributed: boolean;
}

export interface AgentDocumentsDeps {
  /** Authenticates the principal and requires the role permission for the operation. */
  authorize(
    request: unknown, permission: 'read' | 'control'
  ): Promise<{ tenant_id: string; alias: string }>;
  /** Not wired means nobody is named, and that fails closed on every mutating route. */
  resolveOperator?: (request: unknown) => DocumentOperator | Promise<DocumentOperator>;
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
  recordAudit: (entry: TerminalAuditEntry) => Promise<void>;
  /** Overridable so a test counts on its own instance instead of the process-wide one. */
  telemetry?: Pick<ContextContaminationTelemetry, 'recordVerdict'>;
}

type AgentDocumentActor = Awaited<ReturnType<AgentDocumentsDeps['authorize']>>;
type AgentDocumentTarget = NonNullable<Awaited<ReturnType<AgentDocumentsDeps['authorizeTarget']>>>;

const ESTADO_TRAS_ESCRIBIR = 'written_pending_session' satisfies ContextApplyState;

type AuditChannel = 'read' | 'write';

/** A row can be written before the registry entry is resolved, hence the optional columns. */
interface AuditTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly harness_id?: string | null;
  readonly home_directory?: string | null;
}

const HECHOS_SIN_MEDIR = {
  facts_source: null, path: null, sha_before: null, sha_after: null, bytes: null,
} as const;

const SIN_PERSONA: DocumentOperator = {
  operator_id: UNATTRIBUTED_OPERATOR, attributed: false,
};

function motivoDetallado(cuerpo: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...(typeof cuerpo.conflict === 'string' ? { conflict: cuerpo.conflict } : {}),
    ...(typeof cuerpo.reason === 'string' ? { reason: cuerpo.reason } : {}),
  };
}

function documentAuditMetadata(
  actor: AgentDocumentActor,
  target: AuditTarget,
  facts: RuntimeFacts | undefined,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    operator_id: `${actor.tenant_id}:${actor.alias}`,
    target_tenant: target.tenant_id,
    target_alias: target.alias,
    // The MEASURED facts resolved the path; the registry columns only fill in when none exist.
    harness_id: facts === undefined ? target.harness_id ?? null : facts.harness,
    home_directory: facts === undefined ? target.home_directory ?? null : facts.home,
    ...extra,
  };
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
  const telemetry = deps.telemetry ?? contextContamination;
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
  type Target = AgentDocumentTarget;

  async function filaDenegada(
    actor: AgentDocumentActor,
    target: AuditTarget,
    channel: AuditChannel,
    facts: RuntimeFacts | undefined,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await deps.recordAudit({
      tenant_id: actor.tenant_id,
      actor_alias: actor.alias,
      action: 'agent_document.denied',
      decision: 'deny',
      metadata: documentAuditMetadata(actor, target, facts, { channel, ...extra }),
    });
  }

  async function destino(
    request: FastifyRequest<{ Params: BaseParams | ContentParams }>,
    reply: FastifyReply,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{ actor: AgentDocumentActor; target: Target } | undefined> {
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
      // The alias-enumeration probe leaves a row too: an invisible target is a denial by state.
      const kind = 'kind' in request.params && kindValido(request.params.kind)
        ? request.params.kind : null;
      await filaDenegada(
        actor, { tenant_id: tenantResult.data, alias: aliasResult.data },
        permission === 'control' ? 'write' : 'read', undefined,
        { ...HECHOS_SIN_MEDIR, kind, reason: 'not_found' },
      );
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
      const { actor, target } = resuelto;

      // The read channel denies too: refusing `.claude.json` without a row leaves a sweep untraced.
      const hechos: Record<string, unknown> = { ...HECHOS_SIN_MEDIR, kind };
      let medidos: RuntimeFacts | undefined = undefined;
      const denegar = async (
        status: number, cuerpo: Readonly<Record<string, unknown>>,
      ): Promise<FastifyReply> => {
        await filaDenegada(actor, target, 'read', medidos, { ...hechos, reason: cuerpo.error });
        return reply.code(status).send(cuerpo);
      };

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      hechos.facts_source = medido?.source ?? null;
      if (medido?.source !== 'measured') {
        /*
         * 409 and not 404. `factsFor` returning a row does not prove measurement: `registry` and
         * `database` are still unaccredited configuration. Only `measured` allows resolving and
         * opening a path; otherwise we could serve ANOTHER harness's file.
         */
        return denegar(409, {
          error: 'no_medido',
          message: 'los hechos de este alias no están medidos dentro de su contenedor, así que no '
            + 'se sabe qué fichero es éste. No es que el fichero no exista: es que no se ha mirado.',
        });
      }
      medidos = medido.facts;

      const doc = documentForKind(medido.facts, kind);
      if (!doc) {
        return denegar(404, { error: 'not_found', message: 'ese alias no tiene ese documento' });
      }
      hechos.path = doc.path;

      // The inventory and the endpoint share this gate. A sensitive configuration row or a
      // directory does not become readable just because someone hand-builds the URL.
      const readable = verifyReadableDocument(medido.facts, doc);
      if (!readable.allowed) {
        return denegar(403, {
          error: 'not_readable',
          message: readable.reason ?? doc.reason ?? 'el contenido de este elemento no se sirve por esta vía',
        });
      }

      const leido = await deps.probe.readGovernanceDocument(
        doc.path, medido.facts, target.tenant_id, target.alias,
      );
      if (esError(leido)) {
        // Absence is an editable state with an explicit precondition, not a transport error: GET
        // observes `sha: null` and PUT demands `create_if_absent: true`, so a creation is never
        // confused with a replacement whose file disappeared mid-save.
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
        return denegar(codigoDe(leido.error), { error: leido.error, message: leido.reason });
      }

      if (!contenidoGobernadoValido(leido)) {
        return denegar(502, {
          error: 'invalid_probe_response',
          message: 'la sonda respondió, pero no acreditó un contenido completo y coherente',
        });
      }

      await deps.recordAudit({
        tenant_id: actor.tenant_id,
        actor_alias: actor.alias,
        action: 'agent_document.read',
        decision: 'allow',
        metadata: documentAuditMetadata(actor, target, medido.facts, {
          facts_source: medido.source,
          kind,
          path: doc.path,
          sha_before: leido.sha,
          sha_after: null,
          bytes: leido.bytes,
        }),
      });

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

      const resuelto = await destino(request, reply, 'control', legacySameTenant);
      if (!resuelto) return undefined;
      const { actor, target } = resuelto;

      const hechos: Record<string, unknown> = { ...HECHOS_SIN_MEDIR, kind };
      let medidos: RuntimeFacts | undefined = undefined;
      const denegar = async (
        status: number, cuerpo: Readonly<Record<string, unknown>>,
      ): Promise<FastifyReply> => {
        await filaDenegada(actor, target, 'write', medidos, {
          ...hechos, reason: cuerpo.error, ...motivoDetallado(cuerpo),
        });
        return reply.code(status).send(cuerpo);
      };

      // Same act of authority as opening a shell there, so the same gate: no person, no write.
      const operador = deps.resolveOperator === undefined
        ? SIN_PERSONA : await deps.resolveOperator(request);
      hechos.operator = operador.operator_id;
      hechos.attributed = operador.attributed;
      if (!operador.attributed) {
        return denegar(403, {
          error: 'forbidden',
          reason: 'writable_requires_attribution',
          message: 'escribir la gobernanza de un alias exige una persona con nombre; esta sesión '
            + 'no la tiene y su fila de auditoría no acusaría a nadie',
        });
      }

      if (target.enabled !== true) {
        return denegar(409, {
          error: 'agent_disabled',
          message: 'el alias está apagado; no se escribe contexto en un runtime que no debe estar activo',
        });
      }

      const admitido = admitGovernanceWrite(request.body);
      if (isRejectedWrite(admitido)) {
        return reply.code(400).send(admitido);
      }
      const { content: contenido, precondition } = admitido;
      hechos.operator_reason = admitido.reason;
      hechos.bytes = Buffer.byteLength(contenido, 'utf8');
      if (Buffer.byteLength(contenido, 'utf8') > MAX_DOCUMENT_BYTES) {
        return denegar(413, { error: 'too_large', message: 'el contenido se pasa del tope de 256 KiB' });
      }

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      hechos.facts_source = medido?.source ?? null;
      if (medido?.source !== 'measured') {
        return denegar(409, {
          error: 'no_medido',
          message: 'los hechos de este alias no están medidos dentro de su contenedor. Escribir sin '
            + 'saber qué fichero es sería escribir en el fichero de otro arnés.',
        });
      }
      medidos = medido.facts;

      // The write gate, BEFORE checking for a channel: a forbidden path is rejected either way,
      // and the reason the caller gets is the real one.
      const doc = documentForKind(medido.facts, kind);
      if (!doc) {
        return denegar(404, { error: 'not_found', message: 'ese alias no tiene ese documento' });
      }
      hechos.path = doc.path;
      const veredicto = verifyWritablePath(medido.facts, kind, doc.path);
      if (!veredicto.allowed) {
        return denegar(403, { error: 'forbidden', message: veredicto.reason ?? 'no se puede escribir ahí' });
      }

      // NO harness budget gate here: `project_doc_max_bytes` caps the AGGREGATE of the
      // WORKSPACE-scope manuals (as `agent-directive.routes.ts` applies it), and the only
      // document this channel writes for codex is the user-scope `$CODEX_HOME/AGENTS.md`, which
      // the process applies whole. Capping it 413s a legitimate write with a false message.
      if (deps.probe.writeGovernanceDocument === undefined) {
        return denegar(503, {
          error: 'unavailable',
          message: 'este gateway sabe leer los ficheros del alias pero no escribirlos: su sonda no '
            + 'tiene canal de escritura hasta el contenedor.',
        });
      }

      /*
       * FRESH PREFLIGHT. The browser's SHA alone does not tell whether what it saw was a truncated prefix:
       * create demands the file still absent, and replace demands a FULL read whose fingerprint is the one
       * edited. The pty-agent CASes again on the descriptor; this does not replace that, it is the gate that
       * stops a client holding 256 KiB of a larger file from replacing the whole file with that prefix.
       */
      const actual = await deps.probe.readGovernanceDocument(
        doc.path, medido.facts, target.tenant_id, target.alias,
      );
      let contenidoActual: string | undefined;
      if (precondition.state === 'absent') {
        if (!esError(actual)) {
          hechos.sha_before = actual.sha;
          return denegar(409, {
            error: 'conflict', message: 'el fichero ya existe; hay que abrirlo antes de reemplazarlo',
          });
        }
        if (actual.error !== 'not_found') {
          return denegar(codigoDe(actual.error), { error: actual.error, message: actual.reason });
        }
        contenidoActual = undefined;
      } else {
        if (esError(actual)) {
          if (actual.error === 'not_found') {
            return denegar(409, {
              error: 'conflict', message: 'el fichero desapareció desde que se abrió; no se recreó implícitamente',
            });
          }
          return denegar(codigoDe(actual.error), { error: actual.error, message: actual.reason });
        }
        hechos.sha_before = actual.sha;
        if (actual.truncated) {
          return denegar(409, {
            error: 'truncated_source',
            message: 'la lectura está recortada; un prefijo nunca se puede usar para reemplazar el fichero completo',
          });
        }
        if (actual.sha !== precondition.sha256) {
          return denegar(409, {
            error: 'conflict', message: 'el fichero cambió desde que se abrió; hay que releerlo',
          });
        }
        contenidoActual = actual.text;
      }

      /*
       * QUARANTINE BEFORE THE EDIT. A governance file that holds the managed block of ANOTHER
       * alias is not this alias' file, whatever the browser is trying to save into it: on the two
       * shared `$HOME` of the fleet, saving there is writing in somebody else's house. The verdict
       * names the owner in a structured field and never a byte of what the block says.
       */
      const contaminacion = evaluarContaminacion({
        owner: { tenant_id: target.tenant_id, alias: target.alias },
        generation: medido.facts.generation ?? null,
        documents: [{
          name: doc.path.slice(doc.path.lastIndexOf('/') + 1),
          path: doc.path,
          sha: esError(actual) ? null : actual.sha,
          text: contenidoActual ?? null,
        }],
      }, undefined);
      if (contaminacion.contaminated) {
        telemetry.recordVerdict(contaminacion);
        hechos.contamination = contaminacion.findings.map((finding) => ({
          reason: finding.reason, owner: finding.owner ?? null,
        }));
        return denegar(409, {
          error: 'context_contaminated',
          message: 'este fichero de gobierno contiene un bloque gestionado de otro alias; guardar '
            + 'aquí sería escribir en la casa de otro. Queda en cuarentena hasta que alguien mire '
            + 'ese contenedor.',
          contaminacion,
        });
      }

      if (kind === 'directive') {
        const managedContext = verifyManagedContextEdit(contenidoActual, contenido);
        if (!managedContext.allowed) {
          return denegar(409, {
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
          return denegar(409, { error: 'conflict', message: escrito.reason });
        }
        return denegar(codigoDe(escrito.error), { error: escrito.error, message: escrito.reason });
      }
      const raw = Buffer.from(contenido, 'utf8');
      const expectedAckSha = createHash('sha256').update(raw).digest('hex');
      if (escrito.sha !== expectedAckSha || escrito.bytes !== raw.byteLength) {
        return denegar(502, {
          error: 'invalid_ack',
          message: 'la sonda respondió, pero su ACK no acredita los bytes solicitados',
        });
      }

      hechos.sha_after = escrito.sha;
      hechos.bytes = escrito.bytes;
      // AFTER the disk mutation: an insert that throws answers 500 over a file already rewritten.
      await deps.recordAudit({
        tenant_id: actor.tenant_id,
        actor_alias: actor.alias,
        action: 'agent_document.write',
        decision: 'allow',
        metadata: documentAuditMetadata(actor, target, medido.facts, hechos),
      });

      return reply.code(202).send({
        ok: true,
        state: ESTADO_TRAS_ESCRIBIR,
        evidence: CONTEXT_APPLY_POLICY[ESTADO_TRAS_ESCRIBIR].evidence,
        message: CONTEXT_APPLY_POLICY[ESTADO_TRAS_ESCRIBIR].message,
        path: doc.path,
        sha: escrito.sha,
        bytes: escrito.bytes,
      });
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
