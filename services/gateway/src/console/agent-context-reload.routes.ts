import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema, nombresDelArnes, type ContextoDeAlias } from '@cauce/protocol';
import { profileDocumentPaths, type DocumentKind } from './agent-documents.js';
import type {
  AgentFactsProbe, DocumentOperator, TerminalAuditEntry,
} from './agent-documents.routes.js';
import { DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN } from './agent-documents/write-admission.js';
import type {
  PreparedProfileRuntime, ProfileRuntimeAck, ProfileRuntimePreflight, ProfileRuntimeVerification,
} from './agent-profile.routes.js';
import { CONTEXT_APPLY_POLICY, type ContextApplyState } from './context-apply-policy.js';
import {
  contextContamination, evaluarContaminacion, type ContextContaminationTelemetry,
  type ContextContaminationVerdict, type MeasuredContext, type MeasuredContextDocument,
  type RecordedContextExpectation,
} from './contaminacion-de-contexto.js';

/**
 * Forced re-materialization of the context of an alias.
 *
 * It re-reads the durable profile and the MEASURED facts, projects them, runs the contamination
 * guard BEFORE touching anything, and then writes the governed batch through the canonical path
 * of the profile PUT — the same preflight, the same per-file CAS, the same read-back. It never
 * restarts the harness and never opens a shell: a live TUI belongs to its owner, and restarting
 * it destroys their conversation. It never bumps the profile revision either: a reload repairs
 * disk, it does not author.
 *
 * TWO CALLERS, TWO GATES. An operator reloading somebody else's alias performs the same act of
 * authority as writing into their HOME, so it carries a named person and a hand-typed reason. The
 * alias reloading ITSELF authenticates as itself over mTLS (the adapter SDK posts here when it
 * finds its contract stale) and carries no person at all — there is none to name. Both outcomes
 * are audited, and the row says which of the two it was.
 */

export interface ContextReloadDocument {
  readonly name: string;
  readonly path: string;
  /** Fingerprint measured BEFORE the batch; `null` when the file was absent. */
  readonly sha_before: string | null;
  readonly sha_after: string;
  readonly bytes: number;
}

export interface ContextReloadResponse {
  readonly ok: true;
  readonly state: ContextApplyState;
  readonly evidence: string;
  readonly message: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly runtime_verification: ProfileRuntimeVerification;
  readonly documents: readonly ContextReloadDocument[];
  readonly contaminacion: ContextContaminationVerdict;
}

/**
 * What the refusal is allowed to say about a delivery in flight: an identifier, its state and the
 * two instants an operator needs to decide whether to wait. Nothing else — no subject, no body, no
 * attachment, no prompt — ever crosses into a refusal that anyone with `control` can trigger.
 */
export interface InFlightDeliveryView {
  readonly delivery_id: string;
  readonly status: string;
  readonly claimed_at: string | null;
  readonly deadline_at: string | null;
}

/**
 * The count is the REAL one and the list is capped, so a fleet with a hundred deliveries in flight
 * still answers a bounded body while the audit row keeps the true number. Both come out of the
 * same read, which is what makes it impossible for the list and the refusal to disagree.
 */
export interface DeliveriesInFlight {
  readonly count: number;
  readonly deliveries: readonly InFlightDeliveryView[];
}

/** At most this many deliveries travel in the refusal, whatever the store hands over. */
export const DELIVERY_IN_FLIGHT_LISTED = 20;

export interface AgentContextReloadDeps {
  /** Authenticates the principal and requires the role permission for the operation. */
  authorize(
    request: unknown, permission: 'read' | 'control',
  ): Promise<{ tenant_id: string; alias: string }>;
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{ tenant_id: string; alias: string; enabled?: boolean } | undefined>;
  /** Not wired means nobody is named, and the operator form then fails closed. */
  resolveOperator?: (request: unknown) => DocumentOperator | Promise<DocumentOperator>;
  readContext(tenantId: string, alias: string): Promise<{
    contexto: ContextoDeAlias;
    exists: boolean;
    revision: number | null;
    applied_revision: number | null;
  }>;
  prepareRuntime(
    tenantId: string, alias: string, contexto: ContextoDeAlias,
  ): Promise<ProfileRuntimePreflight>;
  /**
   * Live governance bytes, measured and never projected. The canonical preflight REFUSES a foreign
   * managed block by throwing, so the bytes that say whose block it is never reach the guard
   * through it; this is what turns that refusal into a named verdict.
   */
  measureContext(tenantId: string, alias: string): Promise<MeasuredContext | undefined>;
  /** The expectation recorded for this alias, whichever generation it belongs to. */
  readRuntimeExpectation(
    tenantId: string, alias: string,
  ): Promise<RecordedContextExpectation | undefined>;
  recordRuntimeExpectation(
    tenantId: string, alias: string, revision: number, verification: ProfileRuntimeVerification,
  ): Promise<void>;
  /** A reload rewrites the files a delivery in flight may be reading right now. */
  deliveryInFlight(tenantId: string, alias: string): Promise<DeliveriesInFlight>;
  recordDocumentRevision(input: {
    readonly tenantId: string;
    readonly alias: string;
    readonly kind: string;
    readonly path: string;
    readonly sha256: string | null;
    readonly bytes: number;
    readonly actorTenant: string | null;
    readonly actorAlias: string | null;
  }): Promise<unknown>;
  recordAudit(entry: TerminalAuditEntry): Promise<void>;
  /** Overridable so a test counts on its own instance instead of the process-wide one. */
  telemetry?: Pick<ContextContaminationTelemetry, 'recordVerdict'>;
}

/**
 * Journal kind of each profile file, in the SAME vocabulary the history route serves. The batch
 * travels by name and the catalog resolves kinds from measured paths; every name the harness table
 * can produce has exactly one kind here, and a name with none is left out of the journal rather
 * than recorded under a category no reader accepts.
 */
export const RELOAD_DOCUMENT_KINDS: ReadonlyMap<string, DocumentKind> = new Map<string, DocumentKind>([
  ['CLAUDE.md', 'directive'], ['AGENTS.md', 'directive'], ['SOUL.md', 'prompts'],
  ['IDENTITY.md', 'identity'], ['USER.md', 'human'], ['TOOLS.md', 'tools'],
  ['MEMORY.md', 'memory'], ['HEARTBEAT.md', 'heartbeat'],
]);

type ReloadPrincipal = 'operator' | 'alias_self';

interface ReloadCaller {
  readonly principal: ReloadPrincipal;
  readonly actor: { tenant_id: string; alias: string };
  readonly operator_id: string | null;
  readonly attributed: boolean;
  readonly reason: string | null;
}

interface ReloadTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly enabled?: boolean;
}

function codigoDeError(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function mensajeDeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusDeRuntime(error: unknown): number {
  const code = codigoDeError(error);
  if (code === 'conflict' || code === 'truncated' || code === 'invalid_path') return 409;
  if (code === 'unavailable' || code === 'timeout') return 503;
  if (code === 'too_large') return 413;
  return 502;
}

function motivoAdmitido(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= DOCUMENT_REASON_MIN && value.length <= DOCUMENT_REASON_MAX
    ? trimmed
    : undefined;
}

/**
 * What the guard judges: the live bytes the preflight read and the fingerprints it measured. A
 * name the preflight could not read whole enters with `text: null`, and the guard then declines
 * to claim anything about its ownership rather than judging a prefix.
 */
function contextoMedido(
  target: ReloadTarget, prepared: PreparedProfileRuntime,
  existentes: ReadonlyMap<string, string> | undefined,
): MeasuredContext {
  return {
    owner: { tenant_id: target.tenant_id, alias: target.alias },
    generation: prepared.verification.generation,
    documents: prepared.verification.documents.map((document) => {
      const texto = existentes?.get(document.name);
      return {
        name: document.name,
        path: document.path,
        sha: document.observed_sha,
        text: texto === undefined || texto.length === 0 ? null : texto,
        intended: prepared.preview.find((fichero) => fichero.nombre === document.name)?.texto ?? null,
      };
    }),
  };
}

/**
 * Reads the profile files of an alias without projecting anything, so the guard can judge bytes
 * the preflight refused to hand over. Anything it cannot read whole and attribute comes back
 * `undefined` or with `text: null`: this function never guesses ownership.
 */
export async function medirContextoDeGobierno(
  probe: AgentFactsProbe, tenantId: string, alias: string,
): Promise<MeasuredContext | undefined> {
  const medido = await probe.factsFor(tenantId, alias);
  if (medido?.source !== 'measured') return undefined;
  const rutaPorNombre = new Map(
    profileDocumentPaths(medido.facts).map((path) => [path.slice(path.lastIndexOf('/') + 1), path]),
  );
  const documents: MeasuredContextDocument[] = [];
  for (const name of nombresDelArnes(medido.facts.harness)) {
    const path = rutaPorNombre.get(name);
    if (path === undefined) return undefined;
    const leido = await probe.readGovernanceDocument(path, medido.facts, tenantId, alias);
    if ('error' in leido) {
      if (leido.error !== 'not_found') return undefined;
      documents.push({ name, path, sha: null, text: null });
      continue;
    }
    documents.push({ name, path, sha: leido.sha, text: leido.truncated ? null : leido.text });
  }
  const generation = medido.facts.generation;
  return {
    owner: { tenant_id: tenantId, alias },
    generation: typeof generation === 'string' && generation.length > 0 ? generation : null,
    documents,
  };
}

export function registerAgentContextReloadRoutes(
  app: FastifyInstance, deps: AgentContextReloadDeps,
): void {
  const telemetry = deps.telemetry ?? contextContamination;

  function metadatos(
    caller: ReloadCaller, target: ReloadTarget, extra: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      principal: caller.principal,
      operator_id: caller.operator_id,
      attributed: caller.attributed,
      operator_reason: caller.reason,
      actor: `${caller.actor.tenant_id}:${caller.actor.alias}`,
      target_tenant: target.tenant_id,
      target_alias: target.alias,
      operation: 'context_reload',
      ...extra,
    };
  }

  /** Verdict over the live bytes, for the refusal that carried no bytes with it. */
  async function juzgarNegativa(
    target: ReloadTarget,
  ): Promise<ContextContaminationVerdict | undefined> {
    const medido = await deps.measureContext(target.tenant_id, target.alias);
    if (medido === undefined) return undefined;
    return evaluarContaminacion(
      medido, await deps.readRuntimeExpectation(target.tenant_id, target.alias),
    );
  }

  async function fila(
    caller: ReloadCaller, target: ReloadTarget, decision: 'allow' | 'deny',
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await deps.recordAudit({
      tenant_id: caller.actor.tenant_id,
      actor_alias: caller.actor.alias,
      action: decision === 'allow' ? 'agent_document.write' : 'agent_document.denied',
      decision,
      metadata: metadatos(caller, target, extra),
    });
  }

  /**
   * Resolves who is calling and whether they may. The tenant-less form is ONLY the alias itself:
   * an operator reaching it for somebody else would be an unattributed cross-alias write.
   */
  async function quienLlama(
    request: FastifyRequest<{ Params: { tenantId?: string; alias: string }; Body: unknown }>,
    reply: FastifyReply, propia: boolean,
  ): Promise<{ caller: ReloadCaller; target: ReloadTarget } | undefined> {
    const alias = AliasSchema.safeParse(request.params.alias);
    if (!alias.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'alias is invalid' });
      return undefined;
    }
    const permission = propia ? 'read' as const : 'control' as const;
    const actor = await deps.authorize(request, permission);
    const tenant = TenantSchema.safeParse(propia ? actor.tenant_id : request.params.tenantId);
    if (!tenant.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'tenantId is invalid' });
      return undefined;
    }
    const target = await deps.authorizeTarget(actor, tenant.data, alias.data, permission, propia);
    if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
      await reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      return undefined;
    }

    if (propia) {
      const caller: ReloadCaller = {
        principal: 'alias_self', actor, operator_id: null, attributed: false, reason: null,
      };
      if (actor.tenant_id !== target.tenant_id || actor.alias !== target.alias) {
        await fila(caller, target, 'deny', { reason: 'self_reload_only' });
        await reply.code(403).send({
          error: 'forbidden',
          reason: 'self_reload_only',
          message: 'esta forma sin tenant es sólo para que un alias recargue su propio contexto; '
            + 'recargar el de otro exige la forma con tenant, una persona y un motivo',
        });
        return undefined;
      }
      const body: unknown = request.body;
      if (typeof body === 'object' && body !== null && Object.keys(body).length > 0) {
        await reply.code(400).send({
          error: 'invalid_input',
          message: 'la recarga propia no lleva cuerpo: no hay nada que interpretar en ella',
        });
        return undefined;
      }
      return { caller, target };
    }

    const operador = await (deps.resolveOperator?.(request)
      ?? { operator_id: 'sin-persona', attributed: false });
    const body = request.body;
    const source = body === null || typeof body !== 'object' || Array.isArray(body)
      ? {} : body as Record<string, unknown>;
    const reason = motivoAdmitido(source.reason);
    const caller: ReloadCaller = {
      principal: 'operator', actor,
      operator_id: operador.operator_id, attributed: operador.attributed,
      reason: reason ?? null,
    };
    if (!operador.attributed) {
      await fila(caller, target, 'deny', { reason: 'writable_requires_attribution' });
      await reply.code(403).send({
        error: 'forbidden',
        reason: 'writable_requires_attribution',
        message: 'recargar el contexto de un alias reescribe sus ficheros de gobierno: exige una '
          + 'persona con nombre, y esta sesión no la tiene',
      });
      return undefined;
    }
    if (Object.keys(source).some((field) => field !== 'reason') || reason === undefined) {
      await reply.code(400).send({
        error: 'invalid_input',
        message: '`reason` tiene que ser un motivo escrito a mano de entre '
          + `${String(DOCUMENT_REASON_MIN)} y ${String(DOCUMENT_REASON_MAX)} caracteres; `
          + 'la auditoría no inventa uno por nadie',
      });
      return undefined;
    }
    return { caller, target };
  }

  async function recargar(
    request: FastifyRequest<{ Params: { tenantId?: string; alias: string }; Body: unknown }>,
    reply: FastifyReply, propia: boolean,
  ): Promise<unknown> {
    const resuelto = await quienLlama(request, reply, propia);
    if (resuelto === undefined) return undefined;
    const { caller, target } = resuelto;

    const denegar = async (
      status: number, cuerpo: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, unknown>> = {},
    ): Promise<FastifyReply> => {
      await fila(caller, target, 'deny', { reason: cuerpo.error, ...extra });
      return reply.code(status).send(cuerpo);
    };

    /** The one place a contaminated verdict becomes an answer: same code, row and counter. */
    const cuarentena = async (
      veredicto: ContextContaminationVerdict, revision: number,
    ): Promise<FastifyReply> => {
      telemetry.recordVerdict(veredicto);
      return denegar(409, {
        error: 'context_contaminated',
        message: 'los ficheros de gobierno de este alias contienen algo que no es suyo; la '
          + 'recarga queda en cuarentena hasta que alguien mire ese contenedor',
        revision,
        contaminacion: veredicto,
      }, { findings: veredicto.findings.map((finding) => finding.reason) });
    };

    if (target.enabled !== true) {
      return denegar(409, {
        error: 'agent_disabled',
        message: 'el alias está apagado; una recarga no reanima un runtime que debe estar quieto',
      });
    }
    const enVuelo = await deps.deliveryInFlight(target.tenant_id, target.alias);
    if (enVuelo.count > 0) {
      return denegar(409, {
        error: 'delivery_in_flight',
        message: 'hay una entrega en vuelo para este alias: reescribir sus ficheros de gobierno '
          + 'ahora cambiaría el contexto por debajo de un turno que ya empezó. Reintentá cuando '
          + 'termine.',
        deliveries: enVuelo.deliveries.slice(0, DELIVERY_IN_FLIGHT_LISTED).map((entrega) => ({
          delivery_id: entrega.delivery_id,
          status: entrega.status,
          claimed_at: entrega.claimed_at,
          deadline_at: entrega.deadline_at,
        })),
      }, { deliveries_in_flight: enVuelo.count });
    }

    const lectura = await deps.readContext(target.tenant_id, target.alias);
    if (!lectura.exists || lectura.revision === null) {
      return denegar(409, {
        error: 'profile_absent',
        message: 'este alias no tiene un perfil guardado que re-materializar; primero hay que '
          + 'guardarlo desde Contexto',
      });
    }
    const revision = lectura.revision;

    let prepared: PreparedProfileRuntime;
    let existentes: ReadonlyMap<string, string> | undefined;
    try {
      const preflight = await deps.prepareRuntime(
        target.tenant_id, target.alias, lectura.contexto,
      );
      existentes = preflight.existentes;
      prepared = preflight.materialize(revision);
    } catch (error) {
      /*
       * The canonical preflight refuses a foreign managed block with a bare `conflict` that names
       * no owner and leaves no reason worth alarming on. Re-measure and let the guard say WHOSE
       * block it is; only that refusal pays for the second read, and a race that clears the block
       * in between falls back to the generic conflict instead of inventing a verdict.
       */
      const veredicto = codigoDeError(error) === 'conflict'
        ? await juzgarNegativa(target)
        : undefined;
      if (veredicto?.contaminated === true) return cuarentena(veredicto, revision);
      return denegar(statusDeRuntime(error), {
        error: codigoDeError(error) ?? 'runtime_preflight_failed',
        message: mensajeDeError(error, 'no se pudo preparar el runtime sin modificarlo'),
        revision,
      });
    }
    if (prepared.verification.generation === null) {
      return denegar(409, {
        error: 'runtime_unverified',
        message: 'la presencia medida no publica una generación acreditable, y sin ella el ACK del '
          + 'lote no se puede cercar: no se escribe nada',
        revision,
      });
    }

    const medido = contextoMedido(target, prepared, existentes);
    const contaminacion = evaluarContaminacion(
      medido, await deps.readRuntimeExpectation(target.tenant_id, target.alias),
    );
    if (contaminacion.contaminated) return cuarentena(contaminacion, revision);

    let acknowledgements: readonly ProfileRuntimeAck[];
    try {
      acknowledgements = await prepared.apply();
    } catch (error) {
      return denegar(statusDeRuntime(error), {
        error: codigoDeError(error) ?? 'runtime_apply_failed',
        message: mensajeDeError(error, 'el runtime no acreditó el lote de la recarga'),
        revision,
      });
    }

    const ackByName = new Map(acknowledgements.map((ack) => [ack.name, ack]));
    const verification: ProfileRuntimeVerification = {
      ...prepared.verification,
      state: 'current',
      observed_at: new Date().toISOString(),
      documents: prepared.verification.documents.map((document) => ({
        ...document,
        observed_sha: ackByName.get(document.name)?.sha ?? null,
        observed_bytes: ackByName.get(document.name)?.bytes ?? null,
        current: ackByName.get(document.name)?.sha === document.expected_sha,
      })),
    };
    if (verification.documents.some((document) => !document.current)) {
      return denegar(502, {
        error: 'runtime_ack_incomplete',
        message: 'el runtime no acreditó exactamente todos los documentos de la recarga',
        revision,
      });
    }

    try {
      await deps.recordRuntimeExpectation(target.tenant_id, target.alias, revision, verification);
    } catch (error) {
      return denegar(codigoDeError(error) === 'conflict' ? 409 : 503, {
        error: codigoDeError(error) ?? 'runtime_expectation_not_recorded',
        message: mensajeDeError(
          error, 'los ficheros quedaron escritos pero no se pudo registrar su expectativa',
        ),
        revision,
      });
    }

    const documents: ContextReloadDocument[] = [];
    const anotables: { readonly kind: DocumentKind; readonly ack: ProfileRuntimeAck }[] = [];
    for (const document of prepared.verification.documents) {
      const ack = ackByName.get(document.name);
      if (ack === undefined) continue;
      documents.push({
        name: document.name,
        path: document.path,
        sha_before: document.observed_sha,
        sha_after: ack.sha,
        bytes: ack.bytes,
      });
      const kind = RELOAD_DOCUMENT_KINDS.get(document.name);
      /*
       * A `preserved` file belongs to the agent and the batch only VERIFIED it. Journaling it
       * would make the diary read as if the reload had rewritten MEMORY.md, which is the one
       * thing this path promises never to do.
       */
      if (kind === undefined || ack.state === 'preserved') continue;
      anotables.push({ kind, ack });
    }

    /*
     * `pending_session_refresh` and not `applied`: the batch proves bytes on disk and nothing
     * more. Only the adapter's own adoption ACK, which arrives on its next delivery, says the
     * process is reading them — and this route deliberately does not go and fetch it, because
     * making the reload wait for it would tempt somebody into restarting the harness to hurry it.
     */
    const state: ContextApplyState = 'pending_session_refresh';
    await fila(caller, target, 'allow', {
      revision,
      state,
      generation: verification.generation,
      documents: documents.map((document) => ({
        name: document.name, path: document.path,
        sha_before: document.sha_before, sha_after: document.sha_after, bytes: document.bytes,
      })),
    });

    /*
     * The journal goes AFTER the audit row on purpose. Both describe a reload that already put
     * bytes on somebody's disk, and if only one of them can exist, it has to be the one that
     * accuses a person. Fingerprint and size only: no column here can hold a body.
     */
    try {
      for (const anotable of anotables) {
        await deps.recordDocumentRevision({
          tenantId: target.tenant_id,
          alias: target.alias,
          kind: anotable.kind,
          path: anotable.ack.path,
          sha256: anotable.ack.sha,
          bytes: anotable.ack.bytes,
          actorTenant: caller.actor.tenant_id,
          actorAlias: caller.actor.alias,
        });
      }
    } catch {
      return reply.code(503).send({
        error: 'context_journal_not_recorded',
        message: 'los ficheros quedaron escritos y la fila de auditoría los acusa, pero el diario '
          + 'de documentos no anotó la reescritura: el histórico de esta recarga queda incompleto',
        revision,
        state,
        documents,
      });
    }

    const response: ContextReloadResponse = {
      ok: true,
      state,
      evidence: CONTEXT_APPLY_POLICY[state].evidence,
      message: CONTEXT_APPLY_POLICY[state].message,
      tenant_id: target.tenant_id,
      alias: target.alias,
      revision,
      runtime_verification: verification,
      documents,
      contaminacion,
    };
    return reply.send(response);
  }

  app.post<{ Params: { tenantId: string; alias: string }; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/context/reload',
    (request, reply) => recargar(request, reply, false),
  );

  // The alias healing ITSELF over mTLS. No tenant in the URL can only mean its own.
  app.post<{ Params: { alias: string }; Body: unknown }>(
    '/v3/console/agents/:alias/context/reload',
    (request, reply) => recargar(request, reply, true),
  );
}
