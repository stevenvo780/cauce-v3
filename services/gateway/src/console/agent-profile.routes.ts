import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENT_PROFILE_LIMITS, AgentProfileError, AliasSchema, TenantSchema, agentProfileUnits,
  clampToRoleBriefLimit, ficherosDelArnes, nombresDelArnes, normalizeAgentProfile,
  type AgentProfile, type ContextoDeAlias, type FicheroGenerado
} from '@cauce/protocol';

/**
 * Vista previa y gestión del perfil del agente: genera y proyecta el contenido exacto
 * de los ficheros de gobierno (`CLAUDE.md`, `AGENTS.md`, espacios de trabajo de OpenClaw)
 * correspondientes a cada arnés a partir de `ficherosDelArnes()`.
 */

/** De dónde salen el perfil y los hechos. Inyectable para poder probar la ruta sin base. */
export interface AgentProfileDeps {
  /** Autentica al principal y exige el permiso de rol de la operación. */
  authorize(
    request: unknown, permission: 'read' | 'control'
  ): Promise<{ tenant_id: string; alias: string }>;
  /**
   * Autoriza el par actor→destino usando la identidad CANÓNICA del destino. `undefined` no revela
   * si el alias no existe o si la ACL lo oculta.
   */
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'read' | 'control',
    legacySameTenant: boolean,
  ): Promise<{ tenant_id: string; alias: string; enabled?: boolean } | undefined>;
  /** El perfil autorado más los hechos derivados y la presencia real de su fila. */
  readContext(tenantId: string, alias: string): Promise<{
    contexto: ContextoDeAlias;
    exists: boolean;
    revision: number | null;
    applied_revision: number | null;
  }>;
  /** CAS durable: NULL exige ausencia; número exige esa revisión exacta. */
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
   * Persiste la expectativa exacta que viajará en entregas capability-aware. Sigue siendo
   * evidencia de disco; sólo un ACK posterior del adaptador puede convertirla en adopción.
   */
  recordRuntimeExpectation?(
    tenantId: string,
    alias: string,
    revision: number,
    verification: ProfileRuntimeVerification,
  ): Promise<void>;
  /**
   * ACK emitido por el adaptador DESPUÉS de entregar el perfil a la TUI compartida. Un ACK de
   * escritura del fichero no sustituye esta evidencia: el proceso pudo cargarlo horas antes.
   */
  readRuntimeAdoption?(
    tenantId: string,
    alias: string,
    revision: number,
    verification: ProfileRuntimeVerification,
  ): Promise<ProfileRuntimeAdoptionAck | undefined>;
  /** Registra applied sólo después del ACK conductual del adaptador. */
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
  /** Generación del runtime revalidada DESPUÉS del lote. */
  readonly generation: string;
  /** Contenedor de esa misma presencia medida, cuando lo publicó. */
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

export interface ProfileRuntimeAdoptionAck {
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
  /** Nombres exactos que el lote debe acreditar; no se aceptan ACK parciales ni extras. */
  readonly documents: readonly string[];
  /** Arnés medido, que puede diferir de la columna declarada en la base. */
  readonly harness: string;
  /** Vista previa compuesta contra los bytes vivos, no contra un fichero imaginariamente vacío. */
  readonly preview: readonly FicheroDeLaVistaPrevia[];
  /** Evidencia viva ANTES del lote; `current` es requisito para un GET `applied`. */
  readonly verification: ProfileRuntimeVerification;
  apply(): Promise<readonly ProfileRuntimeAck[]>;
}

export interface ProfileRuntimePreflight {
  readonly harness: string;
  materialize(revision: number): PreparedProfileRuntime;
}

/** De qué está compuesta la vista previa: nunca de una medición que no se hizo. */
export type BaseDeLaVistaPrevia = 'fichero-vacio' | 'runtime-medido';

export interface FicheroDeLaVistaPrevia {
  readonly nombre: string;
  readonly politica: FicheroGenerado['politica'];
  readonly texto: string;
  /**
   * Unidades del texto, en la misma cuenta que usan el CHECK de Postgres y los topes de openclaw.
   * Va medido desde el servidor para garantizar coherencia con la base.
   */
  readonly unidades: number;
}

export interface RespuestaDelPerfil {
  readonly tenant_id: string;
  readonly alias: string;
  /** Estado durable del registro de agente; editar/controlar uno apagado falla cerrado. */
  readonly agent_enabled: boolean;
  /** Sale de la presencia de la fila, nunca de si los campos tienen contenido. */
  readonly exists: boolean;
  /** Revisión propia del perfil; NULL si la fila no existe. */
  readonly revision: number | null;
  /** Última revisión acreditada por el runtime. */
  readonly applied_revision: number | null;
  readonly runtime_state:
    | 'absent' | 'pending' | 'pending_session_refresh' | 'applied' | 'disabled'
    | 'drifted' | 'runtime_unverified';
  /** Evidencia viva; la igualdad de revisiones sin esto nunca produce `applied`. */
  readonly runtime_verification: ProfileRuntimeVerification | null;
  /** Evidencia de adopción por la sesión, distinta del ACK de disco. */
  readonly runtime_adoption: ProfileRuntimeAdoptionAck | null;
  readonly runtime_reason?: string;
  /** Proyección exacta que una entrega capability-aware recibe como `self_role`. */
  readonly self_role: string | null;
  /** El arnés declarado en los hechos de base. `null` cuando el registro no dice ninguno. */
  readonly harness: string | null;
  readonly perfil: AgentProfile;
  readonly hechos: ContextoDeAlias['hechos'];
  readonly limites: typeof AGENT_PROFILE_LIMITS;
  /** Lo que mide el perfil entero contra su techo. El navegador pinta la barra con esto. */
  readonly medida: { readonly unidades: number; readonly tope: number };
  readonly base: BaseDeLaVistaPrevia;
  readonly ficheros: readonly FicheroDeLaVistaPrevia[];
  /**
   * Por qué no hay ficheros, cuando no los hay. Un array vacío sin explicación se lee como «este
   * alias no tiene contexto», y lo que pasa de verdad es que su arnés no es de los que Cauce sabe
   * escribir — que es una cosa muy distinta y se arregla en otro sitio.
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
  /** ACK conductual exacto que permitió avanzar `applied_revision`. */
  readonly runtime_adoption: ProfileRuntimeAdoptionAck;
}

/**
 * Un tope superado NO es un 500: es una respuesta con el fichero y los dos números.
 *
 * `ficherosDelArnes` lanza `ErrorDeTopeDelArnes` antes de devolver nada cuando un fichero de
 * openclaw —o la suma de los siete— se pasa de lo que ese arnés declara. Lanzar está bien: escribir
 * una persona a medias es peor que no escribirla. Pero el operador necesita saber CUÁL recortar, y
 * un 500 con «internal error» no se lo dice.
 */
export interface TopeSuperado {
  readonly error: 'tope_del_arnes';
  readonly fichero: string;
  readonly medido: number;
  readonly tope: number;
  readonly message: string;
}

function esTopeSuperado(error: unknown): error is Error & { fichero: string; medido: number; tope: number } {
  return error instanceof Error && error.name === 'ErrorDeTopeDelArnes'
    && 'fichero' in error && 'medido' in error && 'tope' in error;
}

/** La misma cuenta que el CHECK de Postgres y que `String.length`. Ver `measureStrictestUnits`. */
function unidades(texto: string): number {
  return Math.max([...texto].length, texto.length);
}

function adoptionMatches(
  adoption: ProfileRuntimeAdoptionAck | undefined,
  revision: number | null,
  verification: ProfileRuntimeVerification | undefined,
): adoption is ProfileRuntimeAdoptionAck {
  if (adoption === undefined || revision === null || verification === undefined
    || verification.state !== 'current' || verification.generation === null
    || adoption.evidence !== 'adapter_delivery' || adoption.revision !== revision
    || adoption.generation !== verification.generation
    || !Number.isFinite(Date.parse(adoption.adopted_at))
    || adoption.documents.length !== verification.documents.length) return false;
  const expected = new Map(verification.documents.map((document) => [
    document.name, { path: document.path, sha: document.expected_sha },
  ]));
  for (const document of adoption.documents) {
    const wanted = expected.get(document.name);
    if (wanted === undefined || wanted.path !== document.path || wanted.sha !== document.sha) return false;
    expected.delete(document.name);
  }
  return expected.size === 0;
}

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileDeps): void {
  type CanonicalParams = { tenantId: string; alias: string };
  type LegacyParams = { alias: string };

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
      if (!target || target.tenant_id !== tenantId || target.alias !== alias) {
        return reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      }

      if (legacySameTenant) {
        reply.header('Deprecation', 'true');
        reply.header(
          'Link',
          `</v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil>; rel="successor-version"`,
        );
      }

      const lectura = await deps.readContext(tenantId, alias);
      const contexto = lectura.contexto;
      if (contexto.perfil.tenant_id !== tenantId || contexto.perfil.alias !== alias) {
        throw new Error('agent profile repository returned a non-canonical identity');
      }
      let prepared: PreparedProfileRuntime | undefined;
      let runtimeReason: string | undefined;
      if (target.enabled === true && lectura.exists && deps.prepareRuntime !== undefined) {
        try {
          if (lectura.revision === null) {
            throw new Error('an existing profile must have a durable revision');
          }
          const preflight = await deps.prepareRuntime(tenantId, alias, contexto);
          prepared = preflight.materialize(lectura.revision);
        } catch (error) {
          runtimeReason = mensajeDeError(error, 'no se pudo verificar el runtime vivo');
        }
      }
      const harness = prepared?.harness ?? contexto.hechos.arnes.harness;
      const nombres = nombresDelArnes(harness ?? '');
      const revisionCoincide = lectura.revision !== null
        && lectura.applied_revision === lectura.revision;
      let adoption: ProfileRuntimeAdoptionAck | undefined;
      if (prepared?.verification.state === 'current'
        && lectura.revision !== null) {
        if (deps.recordRuntimeExpectation !== undefined) {
          try {
            await deps.recordRuntimeExpectation(
              tenantId, alias, lectura.revision, prepared.verification,
            );
          } catch (error) {
            runtimeReason = mensajeDeError(error, 'no se pudo registrar la expectativa del runtime');
          }
        }
      }
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

      const comun = {
        tenant_id: tenantId,
        alias,
        agent_enabled: target.enabled === true,
        exists: lectura.exists,
        revision: lectura.revision,
        applied_revision: lectura.applied_revision,
        runtime_state: runtimeState,
        runtime_verification: prepared?.verification ?? null,
        runtime_adoption: validAdoption ?? null,
        ...(runtimeReason === undefined ? {} : { runtime_reason: runtimeReason }),
        self_role: contexto.perfil.role_summary === null
          ? null
          : (() => {
            const normalized = contexto.perfil.role_summary.trim();
            return normalized.length === 0 ? null : clampToRoleBriefLimit(normalized);
          })(),
        harness: harness ?? null,
        perfil: contexto.perfil,
        hechos: contexto.hechos,
        limites: AGENT_PROFILE_LIMITS,
        medida: { unidades: agentProfileUnits(contexto.perfil), tope: AGENT_PROFILE_LIMITS.total },
        base: prepared === undefined ? 'fichero-vacio' as const : 'runtime-medido' as const
      };

      if (nombres.length === 0) {
        const respuesta: RespuestaDelPerfil = {
          ...comun,
          ficheros: [],
          aviso: harness === null || harness === undefined
            ? 'El registro no dice qué arnés corre este alias, así que no se puede saber qué fichero lee.'
            : `Cauce no sabe qué fichero de contexto lee el arnés «${harness}». Los que sabe escribir son claude, codex y openclaw.`
        };
        return respuesta;
      }

      try {
        /*
         * `existentes` va VACÍO a propósito: el gateway no lee el disco del contenedor. Ver el
         * encabezado — la respuesta lo declara en `base` para que la pantalla no pueda enseñar
         * esto como «el fichero entero».
         */
        const generados = prepared?.preview
          ?? ficherosDelArnes(
            harness ?? '', contexto, new Map(),
            lectura.revision === null ? {} : { revision: lectura.revision },
          ).map((fichero) => ({
            nombre: fichero.nombre,
            politica: fichero.politica,
            texto: fichero.texto,
            unidades: unidades(fichero.texto),
          }));
        const respuesta: RespuestaDelPerfil = {
          ...comun,
          ficheros: generados,
        };
        return respuesta;
      } catch (error) {
        if (esTopeSuperado(error)) {
          const cuerpo: TopeSuperado = {
            error: 'tope_del_arnes',
            fichero: error.fichero,
            medido: error.medido,
            tope: error.tope,
            message: error.message
          };
          return reply.code(422).send(cuerpo);
        }
        throw error;
      }
  }

  const PROFILE_FIELDS = new Set([
    'purpose', 'role_summary', 'human_brief', 'responsibilities', 'restrictions', 'tools',
    'operating_rules',
  ]);
  const SHA256 = /^[0-9a-f]{64}$/;

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

  function acksCompletos(
    prepared: PreparedProfileRuntime, acknowledgements: readonly ProfileRuntimeAck[],
  ): boolean {
    if (prepared.documents.length !== acknowledgements.length) return false;
    const expected = new Map(prepared.verification.documents.map((document) => [document.name, document]));
    if (expected.size !== prepared.documents.length) return false;
    const generation = prepared.verification.generation;
    if (generation === null) return false;
    for (const ack of acknowledgements) {
      const document = expected.get(ack.name);
      if (document === undefined || document.path !== ack.path || !expected.delete(ack.name)
        || !ack.path.startsWith('/') || !SHA256.test(ack.sha)
        || ack.sha !== document.expected_sha || ack.bytes !== document.expected_bytes
        || !Number.isSafeInteger(ack.bytes) || ack.bytes < 0
        || ack.generation !== generation
        || (ack.container_id !== null && (typeof ack.container_id !== 'string' || ack.container_id.length === 0))
        || !['written', 'already_current', 'preserved'].includes(ack.state)) return false;
    }
    return expected.size === 0;
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
    const target = await deps.authorizeTarget(actor, tenantId, alias, 'control', false);
    if (!target || target.tenant_id !== tenantId || target.alias !== alias) {
      return reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
    }
    if (target.enabled !== true) {
      return reply.code(409).send({
        error: 'agent_disabled',
        message: 'el alias está apagado; su perfil desired no se cambia sin un runtime habilitado',
      });
    }
    if (deps.replaceProfile === undefined || deps.prepareRuntime === undefined) {
      return reply.code(503).send({
        error: 'profile_write_unavailable',
        message: 'este gateway no tiene montada la saga durable de perfil y runtime',
      });
    }

    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'invalid_input', message: 'el cuerpo tiene que ser un objeto' });
    }
    const source = body as Record<string, unknown>;
    if (Object.keys(source).some((key) => key !== 'expected_revision' && key !== 'profile')
      || !Object.prototype.hasOwnProperty.call(source, 'expected_revision')) {
      return reply.code(400).send({ error: 'invalid_input', message: 'el cuerpo tiene campos desconocidos o incompletos' });
    }
    const expectedRaw = source.expected_revision;
    const expectedRevision = expectedRaw === null
      ? null
      : typeof expectedRaw === 'number' && Number.isSafeInteger(expectedRaw) && expectedRaw > 0
        ? expectedRaw
        : undefined;
    if (expectedRevision === undefined) {
      return reply.code(400).send({
        error: 'invalid_input', message: 'expected_revision tiene que ser null o un entero positivo',
      });
    }
    const rawProfile = source.profile;
    if (rawProfile === null || typeof rawProfile !== 'object' || Array.isArray(rawProfile)
      || Object.keys(rawProfile).some((key) => !PROFILE_FIELDS.has(key))) {
      return reply.code(400).send({ error: 'invalid_input', message: 'profile no tiene la forma esperada' });
    }

    let profile: AgentProfile;
    try {
      profile = normalizeAgentProfile({
        ...(rawProfile as Record<string, unknown>), tenant_id: tenantId, alias,
      });
    } catch (error) {
      if (error instanceof AgentProfileError) {
        return reply.code(422).send({
          error: 'invalid_input', field: error.field, message: error.message,
        });
      }
      throw error;
    }

    const current = await deps.readContext(tenantId, alias);
    if (current.contexto.perfil.tenant_id !== tenantId || current.contexto.perfil.alias !== alias) {
      throw new Error('agent profile repository returned a non-canonical identity');
    }
    if ((expectedRevision === null && current.exists)
      || (expectedRevision !== null && current.revision !== expectedRevision)) {
      return reply.code(409).send({
        error: 'profile_revision_conflict',
        message: 'el perfil cambió desde que se abrió',
        revision: current.revision,
        applied_revision: current.applied_revision,
      });
    }

    let preflight: ProfileRuntimePreflight;
    try {
      preflight = await deps.prepareRuntime(tenantId, alias, {
        perfil: profile, hechos: current.contexto.hechos,
      });
    } catch (error) {
      return reply.code(statusDeRuntime(error)).send({
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
      return reply.code(status).send({
        error: code ?? 'profile_write_failed',
        message: mensajeDeError(error, 'no se pudo persistir el perfil desired'),
      });
    }

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

  // Compatibilidad acotada: sin tenant en la URL sólo puede significar el tenant del actor.
  app.get<{ Params: LegacyParams }>(
    '/v3/console/agents/:alias/perfil',
    (request, reply) => responder(request, reply, true),
  );
}
