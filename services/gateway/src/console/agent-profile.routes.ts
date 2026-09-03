import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENT_PROFILE_LIMITS, AliasSchema, TenantSchema, agentProfileUnits,
  clampToRoleBriefLimit, ficherosDelArnes, nombresDelArnes,
  measureStrictestUnits,
  type AgentProfile, type ContextoDeAlias, type FicheroGenerado, type PresupuestoDeContexto
} from '@cauce/protocol';
import type { DocumentOperator } from './agent-documents.routes.js';
import {
  PERFIL_SIN_PERSONA, SIN_PERSONA, acksCompletos, admitProfileWrite, isRejectedProfileWrite,
  perfilAuditMetadata, topeSuperadoDe, veredictoDeContaminacion,
  type ProfileContextMeasure, type ProfileExpectationReader, type ProfileWriteContext,
} from './agent-profile/write-gates.js';
import {
  contextContamination,
  type ContextContaminationTelemetry, type ContextContaminationVerdict,
} from './contaminacion-de-contexto.js';
import type { TerminalAuditEntry } from '../terminal/audit.js';

export type { TopeSuperado } from './agent-profile/write-gates.js';

/**
 * Preview and management of the agent profile: generates and projects the exact content of
 * the governance files (`CLAUDE.md`, `AGENTS.md`, OpenClaw workspaces) for each harness
 * from `ficherosDelArnes()`.
 */

/** Where the profile and facts come from. Injectable to test the route without a database. */
export interface AgentProfileDeps {
  /** Authenticates the principal and enforces the operation's role permission. */
  authorize(
    request: unknown, permission: 'read' | 'control'
  ): Promise<{ tenant_id: string; alias: string }>;
  /**
   * Authorizes the actor→target pair using the CANONICAL identity of the target. `undefined`
   * does not reveal whether the alias does not exist or the ACL hides it.
   */
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{ tenant_id: string; alias: string; enabled?: boolean } | undefined>;
  /** Not wired means nobody is named, and the profile PUT then fails closed. */
  resolveOperator?: (request: unknown) => DocumentOperator | Promise<DocumentOperator>;
  recordAudit(entry: TerminalAuditEntry): Promise<void>;
  measureContext?: ProfileContextMeasure;
  readRuntimeExpectation?: ProfileExpectationReader;
  telemetry?: Pick<ContextContaminationTelemetry, 'recordVerdict'>;
  /** The authored profile plus derived facts and the actual presence of its row. */
  readContext(tenantId: string, alias: string): Promise<{
    contexto: ContextoDeAlias;
    exists: boolean;
    revision: number | null;
    applied_revision: number | null;
  }>;
  /** Durable CAS: NULL requires absence; a number requires that exact revision. */
  replaceProfile?(
    profile: AgentProfile,
    expectedRevision: number | null,
    actor: { tenant_id: string; alias: string },
  ): Promise<{
    perfil: AgentProfile;
    exists: true;
    revision: number;
    applied_revision: number | null;
  }>;
  /** Read-only runtime snapshot that is materialized only after the durable CAS returns a revision. */
  prepareRuntime?(
    tenantId: string, alias: string, contexto: ContextoDeAlias,
  ): Promise<ProfileRuntimePreflight>;
  /**
   * Persists the exact expectation that travels in capability-aware deliveries. Only the write
   * paths call it: reading never re-registers the row, and only a later ACK converts it into adoption.
   */
  recordRuntimeExpectation?(
    tenantId: string,
    alias: string,
    revision: number,
    verification: ProfileRuntimeVerification,
  ): Promise<void>;
  /**
   * ACK emitted by the adapter AFTER delivering the profile to the shared TUI. A file-write
   * ACK does not replace this evidence: the process could have loaded it hours earlier.
   */
  readRuntimeAdoption?(
    tenantId: string,
    alias: string,
    revision: number,
    verification: ProfileRuntimeVerification,
  ): Promise<ProfileRuntimeAdoptionAck | undefined>;
  /** Records applied only after the adapter's behavioral ACK. */
  markProfileApplied?(
    tenantId: string,
    alias: string,
    revision: number,
    actor: { tenant_id: string; alias: string },
  ): Promise<{
    perfil: AgentProfile;
    exists: true;
    revision: number;
    applied_revision: number | null;
  }>;
}

export interface ProfileRuntimeAck {
  readonly name: string;
  readonly path: string;
  readonly state: 'written' | 'already_current' | 'preserved';
  readonly sha: string;
  readonly bytes: number;
  /** Runtime generation revalidated AFTER the batch. */
  readonly generation: string;
  /** Container of that same measured presence, when it published it. */
  readonly container_id: string | null;
}

export interface ProfileRuntimeDocumentEvidence {
  readonly name: string;
  readonly path: string;
  readonly expected_sha: string;
  readonly observed_sha: string | null;
  readonly expected_bytes: number;
  readonly observed_bytes: number | null;
  readonly current: boolean;
}

export interface ProfileRuntimeVerification {
  readonly state: 'current' | 'drifted' | 'unverified';
  readonly generation: string | null;
  readonly container_id: string | null;
  readonly observed_at: string | null;
  readonly documents: readonly ProfileRuntimeDocumentEvidence[];
  readonly reason?: string;
}

interface ProfileRuntimeAdoptionAck {
  readonly evidence: 'adapter_delivery';
  readonly revision: number;
  readonly generation: string;
  readonly adopted_at: string;
  readonly documents: readonly {
    readonly name: string;
    readonly path: string;
    readonly sha: string;
  }[];
}

export interface PreparedProfileRuntime {
  /** Durable profile revision rendered into the native file. */
  readonly revision: number;
  /** Exact names the batch must attest; partial or extra ACKs are not accepted. */
  readonly documents: readonly string[];
  /** Measured harness, which may differ from the column declared in the database. */
  readonly harness: string;
  /** Preview composed against live bytes, not against an imagined empty file. */
  readonly preview: readonly FicheroDeLaVistaPrevia[];
  /** Live evidence BEFORE the batch; `current` is required for a GET `applied`. */
  readonly verification: ProfileRuntimeVerification;
  apply(): Promise<readonly ProfileRuntimeAck[]>;
}

export interface ProfileRuntimePreflight {
  readonly harness: string;
  /** Budget the runtime applied: the per-alias measured fact, or the harness default. */
  readonly topes?: PresupuestoDeContexto;
  /** Live bytes the runtime read, so the preview never composes against an imagined file. */
  readonly existentes?: ReadonlyMap<string, string>;
  materialize(revision: number): PreparedProfileRuntime;
}

/** What the preview is composed of: never an unmeasured measurement. */
type BaseDeLaVistaPrevia = 'fichero-vacio' | 'runtime-medido';

export interface FicheroDeLaVistaPrevia {
  readonly nombre: string;
  readonly politica: FicheroGenerado['politica'];
  readonly texto: string;
  /** Text length in the strictest unit: the count the Postgres CHECK and the openclaw caps use. */
  readonly unidades: number;
}

export interface RespuestaDelPerfil {
  readonly tenant_id: string;
  readonly alias: string;
  /** Durable state of the agent record; editing/controlling a disabled one fails closed. */
  readonly agent_enabled: boolean;
  /** Derives from the presence of the row, never from whether the fields have content. */
  readonly exists: boolean;
  /** The profile's own revision; NULL if the row does not exist. */
  readonly revision: number | null;
  /** Latest revision attested by the runtime. */
  readonly applied_revision: number | null;
  readonly runtime_state:
    | 'absent' | 'pending' | 'pending_session_refresh' | 'applied' | 'disabled'
    | 'drifted' | 'runtime_unverified';
  /** Live evidence; revision equality without this never produces `applied`. */
  readonly runtime_verification: ProfileRuntimeVerification | null;
  /** Session adoption evidence, distinct from the on-disk ACK. */
  readonly runtime_adoption: ProfileRuntimeAdoptionAck | null;
  readonly runtime_reason?: string;
  /** Exact projection that a capability-aware delivery receives as `self_role`. */
  readonly self_role: string | null;
  /** The harness declared in the base facts. `null` when the record declares none. */
  readonly harness: string | null;
  readonly perfil: AgentProfile;
  readonly hechos: ContextoDeAlias['hechos'];
  readonly limites: typeof AGENT_PROFILE_LIMITS;
  /** What the whole profile measures against its ceiling. The browser draws the bar with this. */
  readonly medida: { readonly unidades: number; readonly tope: number };
  readonly base: BaseDeLaVistaPrevia;
  /** Always present: an empty verdict is a measurement that found nothing, and it says so. */
  readonly contaminacion: ContextContaminationVerdict;
  readonly ficheros: readonly FicheroDeLaVistaPrevia[];
  /**
   * Why there are no files, when there aren't any. An empty array without explanation reads as
   * "this alias has no context", when what really happens is that its harness is not one
   * Cauce knows how to write — which is a very different thing and is fixed elsewhere.
   */
  readonly aviso?: string;
}

export interface PerfilAplicado {
  readonly ok: true;
  readonly state: 'applied';
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly applied_revision: number;
  readonly acknowledgements: readonly ProfileRuntimeAck[];
  /** Exact behavioral ACK that allowed advancing `applied_revision`. */
  readonly runtime_adoption: ProfileRuntimeAdoptionAck;
}

function verificacionSinProyeccion(motivo: string): ProfileRuntimeVerification {
  return {
    state: 'unverified', generation: null, container_id: null, observed_at: null,
    documents: [], reason: motivo,
  };
}

function hasAdapterDeliveryEvidence(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && Reflect.get(value, 'evidence') === 'adapter_delivery';
}

function adoptionMatches(
  adoption: ProfileRuntimeAdoptionAck | undefined,
  revision: number | null,
  verification: ProfileRuntimeVerification | undefined,
): adoption is ProfileRuntimeAdoptionAck {
  if (revision === null || verification?.state !== 'current' || verification.generation === null
    || adoption?.revision !== revision || !hasAdapterDeliveryEvidence(adoption)
    || adoption.generation !== verification.generation
    || !Number.isFinite(Date.parse(adoption.adopted_at))
    || adoption.documents.length !== verification.documents.length) return false;
  const expected = new Map(verification.documents.map((document) => [
    document.name, { path: document.path, sha: document.expected_sha },
  ]));
  for (const document of adoption.documents) {
    const wanted = expected.get(document.name);
    if (wanted?.path !== document.path || wanted.sha !== document.sha) return false;
    expected.delete(document.name);
  }
  return expected.size === 0;
}

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileDeps): void {
  interface CanonicalParams { tenantId: string; alias: string }
  interface LegacyParams { alias: string }
  const telemetry = deps.telemetry ?? contextContamination;

  const contaminacionDe = async (
    tenantId: string, alias: string,
  ): Promise<ContextContaminationVerdict> => veredictoDeContaminacion(
    deps.measureContext, deps.readRuntimeExpectation, tenantId, alias,
  );

  async function fila(
    escritura: ProfileWriteContext,
    decision: 'allow' | 'deny',
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await deps.recordAudit({
      tenant_id: escritura.actor.tenant_id,
      actor_alias: escritura.actor.alias,
      action: decision === 'allow' ? 'agent_profile.write' : 'agent_document.denied',
      decision,
      metadata: perfilAuditMetadata(escritura, extra),
    });
  }

  async function responder(
    request: FastifyRequest<{ Params: CanonicalParams | LegacyParams }>,
    reply: FastifyReply,
    legacySameTenant: boolean,
  ) {
      const aliasResult = AliasSchema.safeParse(request.params.alias);
      if (!aliasResult.success) {
        return reply.code(400).send({ error: 'invalid_input', message: 'alias is invalid' });
      }
      const actor = await deps.authorize(request, 'read');
      const tenantIdCrudo = legacySameTenant
        ? actor.tenant_id
        : (request.params as CanonicalParams).tenantId;
      const tenantResult = TenantSchema.safeParse(tenantIdCrudo);
      if (!tenantResult.success) {
        return reply.code(400).send({ error: 'invalid_input', message: 'tenantId is invalid' });
      }
      const tenantId = tenantResult.data;
      const alias = aliasResult.data;
      const target = await deps.authorizeTarget(actor, tenantId, alias, 'read', legacySameTenant);
      if (target?.tenant_id !== tenantId || target.alias !== alias) {
        return reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      }

      if (legacySameTenant) {
        reply.header('Deprecation', 'true');
        reply.header(
          'Link',
          `</v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil>; rel="successor-version"`,
        );
      }

      const contaminacion = await contaminacionDe(tenantId, alias);
      const lectura = await deps.readContext(tenantId, alias);
      const contexto = lectura.contexto;
      if (contexto.perfil.tenant_id !== tenantId || contexto.perfil.alias !== alias) {
        throw new Error('agent profile repository returned a non-canonical identity');
      }
      let prepared: PreparedProfileRuntime | undefined;
      let preflight: ProfileRuntimePreflight | undefined;
      let topeDelRuntime: ReturnType<typeof topeSuperadoDe>;
      let runtimeReason: string | undefined;
      if (target.enabled === true && lectura.exists && deps.prepareRuntime !== undefined) {
        try {
          if (lectura.revision === null) {
            throw new Error('an existing profile must have a durable revision');
          }
          preflight = await deps.prepareRuntime(tenantId, alias, contexto);
          prepared = preflight.materialize(lectura.revision);
        } catch (error) {
          runtimeReason = mensajeDeError(error, 'no se pudo verificar el runtime vivo');
          topeDelRuntime = topeSuperadoDe(error);
        }
      }
      const harness = prepared?.harness ?? contexto.hechos.arnes.harness;
      const nombres = nombresDelArnes(harness);
      const revisionCoincide = lectura.revision !== null
        && lectura.applied_revision === lectura.revision;
      let adoption: ProfileRuntimeAdoptionAck | undefined;
      if (prepared?.verification.state === 'current'
        && lectura.revision !== null && deps.readRuntimeAdoption !== undefined) {
        try {
          adoption = await deps.readRuntimeAdoption(
            tenantId, alias, lectura.revision, prepared.verification,
          );
        } catch (error) {
          runtimeReason = mensajeDeError(error, 'no se pudo verificar la adopción por la sesión');
        }
      }
      const validAdoption = adoptionMatches(adoption, lectura.revision, prepared?.verification)
        ? adoption
        : undefined;
      const adopted = validAdoption !== undefined;
      const runtimeState: RespuestaDelPerfil['runtime_state'] = target.enabled !== true
        ? 'disabled'
        : !lectura.exists
          ? 'absent'
          : prepared?.verification.state === 'current'
            ? adopted && revisionCoincide
              ? 'applied'
              : adopted
                ? 'pending'
                : 'pending_session_refresh'
            : !revisionCoincide
              ? 'pending'
              : prepared?.verification.state === 'drifted'
                ? 'drifted'
                : 'runtime_unverified';

      const normalizedRole = contexto.perfil.role_summary === null
        ? ''
        : contexto.perfil.role_summary.trim();
      const selfRole = normalizedRole.length === 0 ? null : clampToRoleBriefLimit(normalizedRole);
      let ficheros: readonly FicheroDeLaVistaPrevia[] = [];
      let tope = topeDelRuntime;
      if (nombres.length > 0 && tope === undefined) {
        try {
          /* Without a live measurement `existentes` is empty and `base` says so on the screen. */
          ficheros = prepared?.preview
            ?? ficherosDelArnes(
              harness, contexto, preflight?.existentes ?? new Map(),
              {
                ...(lectura.revision === null ? {} : { revision: lectura.revision }),
                ...(preflight?.topes === undefined ? {} : { topes: preflight.topes }),
              },
            ).map((fichero) => ({
              nombre: fichero.nombre,
              politica: fichero.politica,
              texto: fichero.texto,
              unidades: measureStrictestUnits(fichero.texto),
            }));
        } catch (error) {
          const superado = topeSuperadoDe(error);
          if (superado === undefined) throw error;
          tope = superado;
          runtimeReason = mensajeDeError(error, superado.message);
        }
      }
      /* Over budget the operator still gets the profile: the editor is the only screen that can
       * shrink it, so the verification names the file, the numbers, the unit and the source. */
      const motivoDelTope = tope === undefined
        ? undefined
        : 'el perfil no entra en el tope del arnés, así que no se compone su vista previa: '
          + (runtimeReason ?? tope.message);
      if (motivoDelTope !== undefined) runtimeReason = motivoDelTope;

      const comun = {
        tenant_id: tenantId,
        alias,
        agent_enabled: target.enabled === true,
        exists: lectura.exists,
        revision: lectura.revision,
        applied_revision: lectura.applied_revision,
        runtime_state: runtimeState,
        runtime_verification: prepared?.verification
          ?? (motivoDelTope === undefined ? null : verificacionSinProyeccion(motivoDelTope)),
        runtime_adoption: validAdoption ?? null,
        ...(runtimeReason === undefined ? {} : { runtime_reason: runtimeReason }),
        self_role: selfRole,
        harness,
        perfil: contexto.perfil,
        hechos: contexto.hechos,
        limites: AGENT_PROFILE_LIMITS,
        medida: { unidades: agentProfileUnits(contexto.perfil), tope: AGENT_PROFILE_LIMITS.total },
        base: prepared === undefined && preflight?.existentes === undefined
          ? 'fichero-vacio' as const
          : 'runtime-medido' as const,
        contaminacion,
      };

      if (nombres.length === 0) {
        const respuesta: RespuestaDelPerfil = {
          ...comun,
          ficheros: [],
          aviso: `Cauce no sabe qué fichero de contexto lee el arnés «${harness}». Los que sabe escribir son claude, codex y openclaw.`
        };
        return respuesta;
      }

      const respuesta: RespuestaDelPerfil = {
        ...comun,
        ficheros,
        ...(motivoDelTope === undefined
          ? {}
          : { aviso: `${motivoDelTope}. Recorta el perfil y vuelve a guardarlo.` }),
      };
      return respuesta;
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

  async function responderPut(
    request: FastifyRequest<{ Params: CanonicalParams; Body: unknown }>, reply: FastifyReply,
  ) {
    const aliasResult = AliasSchema.safeParse(request.params.alias);
    const tenantResult = TenantSchema.safeParse(request.params.tenantId);
    if (!aliasResult.success || !tenantResult.success) {
      return reply.code(400).send({ error: 'invalid_input', message: 'tenantId or alias is invalid' });
    }
    const tenantId = tenantResult.data;
    const alias = aliasResult.data;
    const actor = await deps.authorize(request, 'control');
    const escritura: ProfileWriteContext = {
      actor,
      target: { tenant_id: tenantId, alias },
      operador: deps.resolveOperator === undefined
        ? SIN_PERSONA : await deps.resolveOperator(request),
      reason: null,
    };
    const denegar = async (
      status: number,
      cuerpo: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, unknown>> = {},
    ): Promise<FastifyReply> => {
      await fila(escritura, 'deny', { reason: cuerpo.error, ...extra });
      return reply.code(status).send(cuerpo);
    };

    const target = await deps.authorizeTarget(actor, tenantId, alias, 'control', false);
    if (target?.tenant_id !== tenantId || target.alias !== alias) {
      const visible = await deps.authorizeTarget(actor, tenantId, alias, 'read', false);
      if (visible?.tenant_id === tenantId && visible.alias === alias) {
        return denegar(403, {
          error: 'forbidden',
          message: `el actor puede leer ${tenantId}/${alias} pero no tiene permiso de control sobre él`,
        });
      }
      return denegar(404, { error: 'not_found', message: 'agent not found or not visible' });
    }
    // Same act of authority as writing into the alias' HOME, so the same gate: no person, no write.
    if (!escritura.operador.attributed) return denegar(403, PERFIL_SIN_PERSONA);
    if (target.enabled !== true) {
      return denegar(409, {
        error: 'agent_disabled',
        message: 'el alias está apagado; su perfil desired no se cambia sin un runtime habilitado',
      });
    }
    if (deps.replaceProfile === undefined || deps.prepareRuntime === undefined) {
      return denegar(503, {
        error: 'profile_write_unavailable',
        message: 'este gateway no tiene montada la saga durable de perfil y runtime',
      });
    }

    const admitido = admitProfileWrite(request.body, tenantId, alias);
    if (isRejectedProfileWrite(admitido)) return denegar(admitido.status, admitido.body);
    const { expected_revision: expectedRevision, profile } = admitido;
    escritura.reason = admitido.reason;

    const current = await deps.readContext(tenantId, alias);
    if (current.contexto.perfil.tenant_id !== tenantId || current.contexto.perfil.alias !== alias) {
      throw new Error('agent profile repository returned a non-canonical identity');
    }
    if ((expectedRevision === null && current.exists)
      || (expectedRevision !== null && current.revision !== expectedRevision)) {
      return denegar(409, {
        error: 'profile_revision_conflict',
        message: 'el perfil cambió desde que se abrió',
        revision: current.revision,
        applied_revision: current.applied_revision,
      });
    }

    /* QUARANTINE BEFORE THE PROJECTION: a file holding the managed block of ANOTHER alias is not
     * this one's, and measuring first is what names the owner the bare preflight conflict hides. */
    const contaminacion = await contaminacionDe(tenantId, alias);
    if (contaminacion.contaminated) {
      telemetry.recordVerdict(contaminacion);
      return denegar(409, {
        error: 'context_contaminated',
        message: 'los ficheros de gobierno de este alias contienen algo que no es suyo; guardar '
          + 'aquí sería escribir en la casa de otro. Queda en cuarentena hasta que alguien mire '
          + 'ese contenedor.',
        revision: current.revision,
        contaminacion,
      }, { findings: contaminacion.findings.map((finding) => finding.reason) });
    }

    let preflight: ProfileRuntimePreflight;
    try {
      preflight = await deps.prepareRuntime(tenantId, alias, {
        perfil: profile, hechos: current.contexto.hechos,
      });
    } catch (error) {
      const tope = topeSuperadoDe(error);
      if (tope !== undefined) {
        return denegar(422, {
          error: 'tope_del_arnes',
          fichero: tope.fichero,
          medido: tope.medido,
          tope: tope.tope,
          message: mensajeDeError(error, tope.message),
        });
      }
      return denegar(statusDeRuntime(error), {
        error: codigoDeError(error) ?? 'runtime_preflight_failed',
        message: mensajeDeError(error, 'no se pudo preparar el runtime sin modificarlo'),
        revision: current.revision,
        applied_revision: current.applied_revision,
      });
    }

    let desired: Awaited<ReturnType<NonNullable<AgentProfileDeps['replaceProfile']>>>;
    try {
      desired = await deps.replaceProfile(profile, expectedRevision, actor);
    } catch (error) {
      const code = codigoDeError(error);
      const status = code === 'not_found' ? 404 : code === 'disabled' || code === 'conflict' ? 409 : 500;
      return denegar(status, {
        error: code ?? 'profile_write_failed',
        message: mensajeDeError(error, 'no se pudo persistir el perfil desired'),
      });
    }
    /* The row goes here and only here: past this point the desired revision EXISTS, so every later
     * outcome reports how far the runtime got instead of denying a write that did happen. */
    await fila(escritura, 'allow', {
      revision: desired.revision,
      bytes: Buffer.byteLength(JSON.stringify(profile), 'utf8'),
    });

    let prepared: PreparedProfileRuntime;
    try {
      prepared = preflight.materialize(desired.revision);
    } catch (error) {
      return reply.code(statusDeRuntime(error)).send({
        error: codigoDeError(error) ?? 'runtime_revision_materialization_failed',
        state: 'pending',
        message: mensajeDeError(
          error, 'el perfil desired quedó guardado, pero no se pudo materializar su revisión',
        ),
        revision: desired.revision,
        applied_revision: desired.applied_revision,
      });
    }
    if (prepared.revision !== desired.revision) {
      return reply.code(502).send({
        error: 'runtime_revision_mismatch',
        state: 'pending',
        message: 'el lote preparado no contiene la revisión durable devuelta por el store',
        revision: desired.revision,
        applied_revision: desired.applied_revision,
      });
    }

    let acknowledgements: readonly ProfileRuntimeAck[];
    try {
      acknowledgements = await prepared.apply();
    } catch (error) {
      return reply.code(statusDeRuntime(error)).send({
        error: codigoDeError(error) ?? 'runtime_apply_failed',
        state: 'pending',
        message: mensajeDeError(error, 'el runtime no acreditó el lote'),
        revision: desired.revision,
        applied_revision: desired.applied_revision,
      });
    }
    if (!acksCompletos(prepared, acknowledgements)) {
      return reply.code(502).send({
        error: 'runtime_ack_incomplete', state: 'pending',
        message: 'el runtime no acreditó exactamente todos los documentos del perfil',
        revision: desired.revision, applied_revision: desired.applied_revision,
      });
    }

    const ackByName = new Map(acknowledgements.map((ack) => [ack.name, ack]));
    const verificationAfterApply: ProfileRuntimeVerification = {
      ...prepared.verification,
      state: 'current',
      observed_at: new Date().toISOString(),
      documents: prepared.verification.documents.map((document) => ({
        ...document,
        observed_sha: ackByName.get(document.name)?.sha ?? null,
        observed_bytes: ackByName.get(document.name)?.bytes ?? null,
        current: ackByName.get(document.name)?.sha === document.expected_sha
          && ackByName.get(document.name)?.bytes === document.expected_bytes,
      })),
    };
    if (deps.recordRuntimeExpectation !== undefined) {
      try {
        await deps.recordRuntimeExpectation(
          tenantId, alias, desired.revision, verificationAfterApply,
        );
      } catch (error) {
        return reply.code(codigoDeError(error) === 'conflict' ? 409 : 503).send({
          error: codigoDeError(error) ?? 'runtime_expectation_not_recorded', state: 'pending',
          message: mensajeDeError(error, 'el runtime se escribió pero no se pudo registrar su expectativa'),
          revision: desired.revision,
          applied_revision: desired.applied_revision,
          acknowledgements,
          runtime_verification: verificationAfterApply,
        });
      }
    }
    let adoption: ProfileRuntimeAdoptionAck | undefined;
    let adoptionReason = 'el perfil está en disco, pero la TUI compartida todavía no acreditó recibirlo';
    if (deps.readRuntimeAdoption !== undefined) {
      try {
        adoption = await deps.readRuntimeAdoption(
          tenantId, alias, desired.revision, verificationAfterApply,
        );
      } catch (error) {
        adoptionReason = mensajeDeError(error, 'no se pudo leer el ACK de adopción del adaptador');
      }
    }
    if (!adoptionMatches(adoption, desired.revision, verificationAfterApply)
      || deps.markProfileApplied === undefined) {
      return reply.code(202).send({
        ok: true,
        state: 'pending_session_refresh',
        tenant_id: tenantId,
        alias,
        message: deps.markProfileApplied === undefined
          ? 'el ACK de sesión no se puede acreditar de forma durable en este gateway'
          : adoptionReason,
        revision: desired.revision,
        applied_revision: desired.applied_revision,
        acknowledgements,
        runtime_verification: verificationAfterApply,
        runtime_adoption: null,
      });
    }

    let applied: Awaited<ReturnType<NonNullable<AgentProfileDeps['markProfileApplied']>>>;
    try {
      applied = await deps.markProfileApplied(tenantId, alias, desired.revision, actor);
    } catch (error) {
      return reply.code(codigoDeError(error) === 'conflict' ? 409 : 503).send({
        error: codigoDeError(error) ?? 'applied_revision_not_recorded', state: 'pending',
        message: mensajeDeError(error, 'el runtime respondió pero no se pudo registrar su revisión'),
        revision: desired.revision, applied_revision: desired.applied_revision,
      });
    }
    if (applied.revision !== desired.revision || applied.applied_revision !== desired.revision) {
      return reply.code(409).send({
        error: 'profile_superseded_after_runtime_ack', state: 'pending',
        message: 'el runtime aplicó esta revisión, pero ya existe otra desired más nueva',
        revision: applied.revision, applied_revision: applied.applied_revision,
      });
    }

    const response: PerfilAplicado = {
      ok: true,
      state: 'applied',
      tenant_id: tenantId,
      alias,
      revision: desired.revision,
      applied_revision: desired.revision,
      acknowledgements,
      runtime_adoption: adoption,
    };
    return reply.send(response);
  }

  app.get<{ Params: CanonicalParams }>(
    '/v3/console/tenants/:tenantId/agents/:alias/perfil',
    (request, reply) => responder(request, reply, false),
  );

  app.put<{ Params: CanonicalParams; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/perfil',
    responderPut,
  );

  // Scoped backward compatibility: no tenant in the URL can only mean the actor's tenant.
  app.get<{ Params: LegacyParams }>(
    '/v3/console/agents/:alias/perfil',
    (request, reply) => responder(request, reply, true),
  );
}
