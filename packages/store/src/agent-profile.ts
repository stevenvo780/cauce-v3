import {
  emptyAgentProfile, normalizeAgentProfile,
  type AgentProfile, type ArnesDelAlias, type ContextoDeAlias, type CuotaDelAlias,
  type HechosDelAlias, type PermisosDelAlias
} from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';

/**
 * EL PERFIL POR ALIAS: leer y escribir la fuente de verdad de lo que va al fichero del arnés.
 *
 * La tabla es `agent_profiles` (migración 026) y la forma y los topes son los de
 * `packages/protocol/src/agent-profile.ts`. Este módulo no decide nada sobre el contenido: valida
 * con `normalizeAgentProfile` —la MISMA guarda que usa cualquier otra capa— y persiste.
 *
 * POR QUÉ ES UNA CLASE Y NO UNA FUNCIÓN SUELTA: es la misma forma que `ConfigurationRepository`,
 * porque es la misma clase de objeto —una superficie coherente de lectura y escritura sobre una
 * tabla de configuración— y porque la pantalla que lo va a usar ya sostiene un repositorio así.
 *
 * POR QUÉ TIENE REVISIÓN PROPIA: el perfil es un recurso independiente. Usar la revisión global
 * de configuración hace que una cuota o un destino cambiados por otro operador vuelvan obsoleto
 * este borrador, y aun así no evita que dos editores del MISMO perfil se pisen. La migración 028
 * mantiene `revision` y `applied_revision`; este repositorio hace CAS contra la primera y sólo
 * avanza la segunda después de un ACK completo del runtime.
 *
 * POR QUÉ NO LEE PERMISOS NI CUOTAS: no son de esta tabla. Los permisos viven en `memberships` +
 * `role_policies`, las cuotas en `provider_accounts`, y la configuración del arnés en `agents` +
 * `harness_definitions`. El compilador los recibe como HECHOS y los une; duplicarlos acá sería
 * fabricar una segunda fuente de verdad que se desincroniza en silencio.
 */

/** Las columnas, en el orden de la tabla. Una sola copia para el SELECT y para el RETURNING. */
const profileColumns =
  'tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules,revision,applied_revision';

interface ProfileRow {
  tenant_id: string;
  alias: string;
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[] | null;
  restrictions: string[] | null;
  tools: string[] | null;
  operating_rules: string[] | null;
  revision: string;
  applied_revision: string | null;
}

/**
 * La fila y su presencia son dos hechos distintos.
 *
 * Un perfil persistido puede estar completamente vacío (todos los textos en NULL y todas las
 * listas vacías). Por eso la presencia nunca se deduce del contenido: sale del mismo SELECT que
 * leyó la fila y viaja junto con el perfil normalizado.
 */
export interface StoredAgentProfile {
  readonly perfil: AgentProfile;
  readonly exists: boolean;
  /** NULL sólo cuando no existe la fila. */
  readonly revision: number | null;
  /** Última revisión cuyo runtime quedó acreditado; NULL = nunca acreditado. */
  readonly applied_revision: number | null;
}

/** Resultado de una fila que Postgres acaba de devolver; conserva los literales útiles al CAS. */
export interface PersistedAgentProfile extends StoredAgentProfile {
  readonly exists: true;
  readonly revision: number;
}

export interface StoredAgentContext {
  readonly contexto: ContextoDeAlias;
  readonly exists: boolean;
  /** Estado durable del alias; false también cuando la identidad canónica no existe. */
  readonly agent_enabled: boolean;
  readonly revision: number | null;
  readonly applied_revision: number | null;
}

export type AgentProfileMutationErrorCode = 'not_found' | 'disabled' | 'conflict';

export interface AgentProfileAuditActor {
  readonly tenant_id: string;
  readonly alias: string;
}

/** Fallo de dominio estable para que el gateway no traduzca concurrencia a un 500. */
export class AgentProfileMutationError extends Error {
  constructor(
    readonly code: AgentProfileMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentProfileMutationError';
  }
}

function revisionOf(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`agent profile returned an invalid ${field}`);
  }
  return parsed;
}

function stored(row: ProfileRow): PersistedAgentProfile {
  return {
    perfil: toProfile(row),
    exists: true,
    revision: revisionOf(row.revision, 'revision'),
    applied_revision: row.applied_revision === null
      ? null
      : revisionOf(row.applied_revision, 'applied_revision'),
  };
}

/**
 * Una fila de Postgres se convierte en `AgentProfile` SIN volver a validar.
 *
 * Deliberado: lo que está en la base ya pasó los CHECK de la migración 026, y re-validarlo al
 * leerlo convertiría un tope bajado en el futuro en una lectura que EXPLOTA sobre datos que la
 * base considera legítimos. Un perfil guardado se lee siempre; lo que se valida es lo que ENTRA.
 *
 * `?? []` sobre los arrays no es defensa vacía: las columnas son NOT NULL DEFAULT '{}', pero `pg`
 * devuelve `null` para un array ausente en un RETURNING parcial, y un `null` que llegue como lista
 * rompería el compilador en un `for...of`.
 */
function toProfile(row: ProfileRow): AgentProfile {
  return {
    tenant_id: row.tenant_id,
    alias: row.alias,
    purpose: row.purpose,
    role_summary: row.role_summary,
    human_brief: row.human_brief,
    responsibilities: row.responsibilities ?? [],
    restrictions: row.restrictions ?? [],
    tools: row.tools ?? [],
    operating_rules: row.operating_rules ?? []
  };
}

export class AgentProfileRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * El perfil de un alias. Un alias SIN fila devuelve un perfil vacío, no un error.
   *
   * Es lo que hace que el compilador pueda correr sobre los quince alias desde el primer día: la
   * ausencia de perfil es un estado legítimo —«todavía no se escribió»— y no una avería. El
   * compilador omite las secciones vacías, así que un perfil en blanco produce un bloque sin
   * secciones y nunca un fichero con encabezados huecos.
   */
  async read(tenantId: string, alias: string): Promise<AgentProfile> {
    return (await this.readWithPresence(tenantId, alias)).perfil;
  }

  /** La lectura exacta que conserva si Postgres devolvió una fila, incluso si estaba vacía. */
  async readWithPresence(tenantId: string, alias: string): Promise<StoredAgentProfile> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT ${profileColumns} FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`,
      [tenantId, alias]
    );
    const row = result.rows[0];
    return row === undefined
      ? {
          perfil: emptyAgentProfile(tenantId, alias), exists: false,
          revision: null, applied_revision: null,
        }
      : stored(row);
  }

  /** Los perfiles de varios alias de un tenant, para generar la flota entera de una pasada. */
  async readMany(tenantId: string, aliases: readonly string[]): Promise<Map<string, AgentProfile>> {
    const profiles = new Map<string, AgentProfile>();
    for (const alias of aliases) profiles.set(alias, emptyAgentProfile(tenantId, alias));
    if (aliases.length === 0) return profiles;
    const result = await this.pool.query<ProfileRow>(
      `SELECT ${profileColumns} FROM agent_profiles WHERE tenant_id=$1 AND alias = ANY($2::text[])`,
      [tenantId, [...aliases]]
    );
    for (const row of result.rows) profiles.set(row.alias, toProfile(row));
    return profiles;
  }

  /**
   * Escribe el perfil entero. Es un REEMPLAZO, no un parche.
   *
   * Reemplazo y no parche porque el presupuesto TOTAL sólo se puede comprobar sobre el perfil
   * completo: un parche que sube `tools` sin ver `purpose` no puede saber si la suma entra, y la
   * base lo rechazaría con un error sobre un campo que el que escribe ni mandó.
   *
   * La validación ocurre ANTES de abrir la transacción, a propósito: un perfil inadmisible no
   * merece un `BEGIN`, y así el error que ve la pantalla es el de `AgentProfileError` —que nombra
   * el CAMPO— y no un `23514` de Postgres que sólo nombra el constraint.
   */
  async write(input: Record<string, unknown>): Promise<AgentProfile> {
    const profile = normalizeAgentProfile(input);
    return withTransaction(this.pool, (client) => this.writeWithClient(client, profile));
  }

  /**
   * Reemplazo optimista usado por la consola.
   *
   * `expectedRevision=null` significa «la fila debe estar ausente». Un número significa «debe
   * seguir exactamente en esta revisión». El alias se bloquea y tiene que existir Y estar
   * habilitado; el estado desconocido cae en denegación, nunca en permiso implícito.
   *
   * Persistir aquí sólo cambia lo DESEADO. El llamador todavía debe escribir el runtime y llamar
   * a `markApplied`; hasta entonces `applied_revision` conserva la versión anterior o NULL.
   */
  async replace(
    input: AgentProfile | Record<string, unknown>,
    expectedRevision: number | null,
    actor: AgentProfileAuditActor,
  ): Promise<PersistedAgentProfile> {
    const profile = normalizeAgentProfile(input as Record<string, unknown>);
    if (expectedRevision !== null
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new AgentProfileMutationError('conflict', 'expected profile revision is invalid');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertEnabled(client, profile.tenant_id, profile.alias);
      const values = [
        profile.tenant_id, profile.alias, profile.purpose, profile.role_summary,
        profile.human_brief, [...profile.responsibilities], [...profile.restrictions],
        [...profile.tools], [...profile.operating_rules],
      ];
      const result = expectedRevision === null
        ? await client.query<ProfileRow>(
            `INSERT INTO agent_profiles
               (tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules)
             VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[])
             ON CONFLICT (tenant_id,alias) DO NOTHING
             RETURNING ${profileColumns}`,
            values,
          )
        : await client.query<ProfileRow>(
            `UPDATE agent_profiles SET
               purpose=$3,role_summary=$4,human_brief=$5,responsibilities=$6::text[],
               restrictions=$7::text[],tools=$8::text[],operating_rules=$9::text[],updated_at=now()
             WHERE tenant_id=$1 AND alias=$2 AND revision=$10
             RETURNING ${profileColumns}`,
            [...values, expectedRevision],
          );
      const row = result.rows[0];
      if (row === undefined) {
        throw new AgentProfileMutationError(
          'conflict',
          expectedRevision === null
            ? 'agent profile already exists'
            : `agent profile revision changed from ${expectedRevision}`,
        );
      }
      const state = stored(row);
      await this.audit(client, actor, 'agent_profile.desired', {
        target_tenant: profile.tenant_id,
        target_alias: profile.alias,
        expected_revision: expectedRevision,
        desired_revision: state.revision,
        applied_revision: state.applied_revision,
      });
      return state;
    });
  }

  /**
   * Registra el ACK de una revisión incluso si ya nació otra deseada.
   *
   * Esa carrera no es éxito para el primer escritor, pero el dato sigue siendo verdadero: el
   * runtime llegó a la revisión N y la base ya desea N+1. Conservar N permite mostrar «pendiente»
   * y reintentar. Un ACK tardío nunca hace retroceder un `applied_revision` mayor.
   */
  async markApplied(
    tenantId: string,
    alias: string,
    expectedRevision: number,
    actor: AgentProfileAuditActor,
  ): Promise<PersistedAgentProfile> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new AgentProfileMutationError('conflict', 'applied profile revision is invalid');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertEnabled(client, tenantId, alias);
      let result = await client.query<ProfileRow>(
        `UPDATE agent_profiles
            SET applied_revision=$3
          WHERE tenant_id=$1 AND alias=$2 AND revision >= $3
            AND (applied_revision IS NULL OR applied_revision < $3)
          RETURNING ${profileColumns}`,
        [tenantId, alias, expectedRevision],
      );
      const advanced = result.rows[0] !== undefined;
      if (result.rows[0] === undefined) {
        result = await client.query<ProfileRow>(
          `SELECT ${profileColumns} FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`,
          [tenantId, alias],
        );
      }
      const row = result.rows[0];
      if (row === undefined) {
        throw new AgentProfileMutationError(
          'conflict', `agent profile disappeared before runtime ACK ${expectedRevision}`,
        );
      }
      const state = stored(row);
      if ((state.applied_revision ?? 0) < expectedRevision) {
        throw new AgentProfileMutationError(
          'conflict', `agent profile cannot record runtime ACK ${expectedRevision}`,
        );
      }
      if (advanced) {
        await this.audit(client, actor, 'agent_profile.applied', {
          target_tenant: tenantId,
          target_alias: alias,
          applied_revision: expectedRevision,
          desired_revision: state.revision,
          converged: state.revision === expectedRevision,
        });
      }
      return state;
    });
  }

  private async assertEnabled(
    client: DatabaseClient, tenantId: string, alias: string,
  ): Promise<void> {
    const result = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
      [tenantId, alias],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AgentProfileMutationError('not_found', 'agent not found');
    }
    if (row.enabled !== true) {
      throw new AgentProfileMutationError('disabled', 'agent is disabled');
    }
  }

  /** Auditoría sanitizada y atómica con el cambio: nunca incluye el cuerpo autorado del perfil. */
  private async audit(
    client: DatabaseClient,
    actor: AgentProfileAuditActor,
    action: 'agent_profile.desired' | 'agent_profile.applied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES($1,$2,$3,'allow',$4::jsonb)`,
      [actor.tenant_id, actor.alias, action, JSON.stringify(metadata)],
    );
  }

  private async writeWithClient(
    client: DatabaseClient, profile: AgentProfile
  ): Promise<AgentProfile> {
    const result = await client.query<ProfileRow>(
      `INSERT INTO agent_profiles
         (tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules)
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[])
       ON CONFLICT (tenant_id,alias) DO UPDATE SET
         purpose=EXCLUDED.purpose,
         role_summary=EXCLUDED.role_summary,
         human_brief=EXCLUDED.human_brief,
         responsibilities=EXCLUDED.responsibilities,
         restrictions=EXCLUDED.restrictions,
         tools=EXCLUDED.tools,
         operating_rules=EXCLUDED.operating_rules,
         updated_at=now()
       RETURNING ${profileColumns}`,
      [
        profile.tenant_id, profile.alias, profile.purpose, profile.role_summary, profile.human_brief,
        [...profile.responsibilities], [...profile.restrictions],
        [...profile.tools], [...profile.operating_rules]
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`agent profile write returned no row for ${profile.tenant_id}/${profile.alias}`);
    }
    return toProfile(row);
  }

  /**
   * Borra el perfil. Devuelve si había algo que borrar.
   *
   * Devuelve `false` en vez de fallar cuando no había fila: borrar lo que ya no está es el
   * resultado que se pedía. Lo que NO hace es mentir `true`, porque la pantalla que lo llame
   * necesita poder distinguir «lo borré» de «no había nada», y un `true` incondicional le
   * enseñaría que borró algo que nunca existió.
   *
   * Borrar la fuente canónica borra también su proyección `agents.role_brief` mediante la
   * migración 028. Una imagen anterior ve «sin rol» en vez de seguir usando una identidad vieja.
   */
  async remove(tenantId: string, alias: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenantId, alias]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * El perfil autorado MÁS los hechos derivados: lo único que el compilador necesita.
   *
   * Es una sola llamada y no cinco a propósito: quien genera un fichero no tiene por qué saber que
   * los permisos viven en `role_policies` y las cuotas detrás del techo de ruteo. Esa es
   * exactamente la dispersión que este trabajo vino a cerrar.
   *
   * Un alias sin nada configurado devuelve hechos VACÍOS y no un fallo: no tener permisos, ni
   * cuentas, ni destinos es un estado legítimo —es el de un alias recién dado de alta— y el
   * compilador ya sabe omitir lo que está vacío.
   */
  async readContext(tenantId: string, alias: string): Promise<ContextoDeAlias> {
    return (await this.readContextWithPresence(tenantId, alias)).contexto;
  }

  /** El contexto compilable más la presencia REAL de la fila autorada. */
  async readContextWithPresence(tenantId: string, alias: string): Promise<StoredAgentContext> {
    const [perfilGuardado, permisos, cuotas, arnes, destinos] = await Promise.all([
      this.readWithPresence(tenantId, alias),
      this.pool.query<{ ruta: boolean; lectura: boolean; control: boolean; notify_rol: boolean }>(
        PERMISOS_SQL, [tenantId, alias]
      ),
      this.pool.query<{
        provider: string; account_id: string; label: string | null;
        remaining_percent: string | null; window_key: string | null;
      }>(CUOTAS_SQL, [tenantId, alias]),
      this.pool.query<{
        harness_id: string | null; home_directory: string | null;
        container_name: string | null; capabilities: unknown; enabled: boolean;
      }>(
        `SELECT agent.harness_id, agent.home_directory, agent.container_name, agent.enabled,
                COALESCE(harness.capabilities,'[]'::jsonb) AS capabilities
           FROM agents agent
           LEFT JOIN harness_definitions harness ON harness.id=agent.harness_id
          WHERE agent.tenant_id=$1 AND agent.alias=$2`, [tenantId, alias]
      ),
      this.pool.query<{ alias: string }>(DESTINOS_SQL, [tenantId, alias])
    ]);

    const fila = arnes.rows[0];
    const agentEnabled = fila?.enabled === true;
    const permiso = permisos.rows[0];
    /*
     * `notificacion` es la conjunción de DOS puertas, y las dos son necesarias: el rol tiene que
     * permitirlo Y tiene que existir al menos un destino aprobado. Un rol con `allow_notify` y
     * cero destinos NO puede notificar —`notify` es default-deny por lista— y decirle al agente
     * que sí puede le costaría el turno en un intento que la base rechaza.
     */
    const destinosDeAviso = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM egress_destinations
        WHERE tenant_id=$1 AND alias=$2 AND enabled`, [tenantId, alias]
    );
    const permisosEfectivos: PermisosDelAlias = {
      ruta: agentEnabled && (permiso?.ruta ?? false),
      lectura: agentEnabled && (permiso?.lectura ?? false),
      control: agentEnabled && (permiso?.control ?? false),
      notificacion: agentEnabled && (permiso?.notify_rol ?? false)
        && Number(destinosDeAviso.rows[0]?.total ?? '0') > 0
    };

    const capacidades = Array.isArray(fila?.capabilities)
      ? (fila.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const arnesDelAlias: ArnesDelAlias = {
      harness: fila?.harness_id ?? '',
      home: fila?.home_directory ?? '',
      contenedor: fila?.container_name ?? undefined,
      capacidades
    };

    const cuotasDelAlias: CuotaDelAlias[] = cuotas.rows.map((row) => ({
      proveedor: row.provider,
      cuenta: row.account_id,
      limite: limiteLegible(row.remaining_percent, row.window_key)
    }));

    /*
     * Los destinos se ofrecen SÓLO si el alias puede rutear. La consulta de ACL responde «quién es
     * alcanzable», no «quién puede alcanzarlo»: el permiso del que pregunta se comprueba aparte, en
     * el camino de envío (`assertPermission(...,'route')`). Sin este corte, un alias sin permiso de
     * ruta recibiría en su fichero la lista entera de la flota, y un agente al que se le enseñan
     * doce destinos que no puede usar los intenta y gasta el turno en una entrega que la base
     * rechaza. Es el mismo criterio por el que los permisos denegados se nombran en vez de callarse.
     */
    const hechos: HechosDelAlias = {
      permisos: permisosEfectivos,
      cuotas: cuotasDelAlias,
      arnes: arnesDelAlias,
      destinos: permisosEfectivos.ruta ? destinos.rows.map((row) => row.alias) : []
    };
    return {
      contexto: { perfil: perfilGuardado.perfil, hechos },
      exists: perfilGuardado.exists,
      agent_enabled: agentEnabled,
      revision: perfilGuardado.revision,
      applied_revision: perfilGuardado.applied_revision,
    };
  }
}

/**
 * ── LOS HECHOS DERIVADOS ────────────────────────────────────────────────────────────────────
 *
 * Las tres caras del fichero que NO se escriben a mano. Se leen FRESCAS en cada generación, que es
 * lo único que evita el fallo que esta separación vino a impedir: si se copiaran a `agent_profiles`
 * como texto, revocar un permiso en `role_policies` dejaría el fichero del contenedor diciendo que
 * el alias lo sigue teniendo, y nadie se enteraría hasta que lo intentara.
 */

/**
 * Permisos EFECTIVOS: la UNIÓN de lo que conceden todas las salas del alias.
 *
 * `bool_or` y no `LIMIT 1`, siguiendo el precedente de `principalAccess` en repository.ts: un alias
 * tiene una fila de `memberships` POR SALA, y `LIMIT 1` contestaría con la primera que devolviera
 * el planificador — o sea, con un permiso distinto según el día. La pregunta que responde un perfil
 * es «qué puede hacer este alias», y eso es la unión.
 *
 * Se exige `membership.enabled`, `tenant.enabled` y `room.enabled`: una membresía apagada, o en una
 * sala apagada, no concede nada. Es el mismo criterio que el camino de envío.
 */
const PERMISOS_SQL = `
  SELECT COALESCE(bool_or(policy.allow_route),false)   AS ruta,
         COALESCE(bool_or(policy.allow_read),false)    AS lectura,
         COALESCE(bool_or(policy.allow_control),false) AS control,
         COALESCE(bool_or(policy.allow_notify),false)  AS notify_rol
    FROM memberships membership
    JOIN role_policies policy ON policy.role=membership.role
    JOIN tenants tenant       ON tenant.id=membership.tenant_id
    JOIN rooms room           ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
   WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
     AND tenant.enabled AND room.enabled`;

/**
 * Las cuentas a las que el alias puede ser ruteado, con su límite observado si lo hay.
 *
 * El camino es `agent_account_bindings` -> `alias_routing_ceiling` -> `provider_accounts`, y no un
 * atajo: el techo es la única vía por la que un binding puede existir, y saltárselo aquí daría un
 * inventario que el selector de cuentas no reconocería.
 *
 * NO SE SELECCIONA `credential_ref` NI `credential_ref_kind`, y no es un olvido de columnas: esto
 * termina escrito en un fichero DENTRO del contenedor y enseñado a un modelo. Un localizador de
 * credencial que entre acá acaba en el contexto de un LLM y en los transcripts. El alias no
 * necesita saber dónde está la llave: el adaptador la resuelve por su cuenta.
 *
 * El límite sale de `quota_window_state`, la ventana con MENOS margen: es la que de verdad lo va a
 * frenar, y decirle la más holgada sería tranquilizarlo con el número equivocado.
 */
const CUOTAS_SQL = `
  SELECT account.provider, binding.account_id, account.label,
         quota.remaining_percent, quota.window_key, quota.reset_at
    FROM agent_account_bindings binding
    JOIN alias_routing_ceiling ceiling
      ON ceiling.tenant_id=binding.tenant_id AND ceiling.alias=binding.agent_alias
     AND ceiling.account_id=binding.account_id
    JOIN provider_accounts account ON account.id=binding.account_id
    LEFT JOIN LATERAL (
      SELECT state.remaining_percent, state.window_key, state.reset_at
        FROM quota_window_state state
       WHERE state.account_id=account.id
         AND (state.reset_at IS NULL OR state.reset_at > now())
       ORDER BY state.remaining_percent ASC NULLS LAST, state.window_key
       LIMIT 1
    ) quota ON true
   WHERE binding.tenant_id=$1 AND binding.agent_alias=$2 AND binding.enabled
     AND account.enabled
   ORDER BY binding.priority ASC, binding.account_id ASC`;

/**
 * Los alias alcanzables por ACL. Es la consulta de `routingTargets` SIN la parte de presencia: un
 * fichero se escribe una vez y quién está conectado cambia cada minuto, así que meter `online` acá
 * produciría un fichero desactualizado desde el segundo siguiente. Quién está en línea sigue
 * viajando en el sobre, que es donde ese dato es cierto.
 */
const DESTINOS_SQL = `
  SELECT membership.alias
    FROM memberships membership
    JOIN tenants target_tenant ON target_tenant.id=membership.tenant_id
    JOIN rooms target_room
      ON target_room.id=membership.room_id AND target_room.tenant_id=membership.tenant_id
   WHERE membership.enabled AND target_tenant.enabled AND target_room.enabled
     AND NOT (membership.tenant_id=$1 AND membership.alias=$2)
     AND (
       membership.tenant_id=$1
       OR EXISTS (
         SELECT 1 FROM acl_edges edge
         JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=membership.tenant_id
           AND edge.enabled AND edge.allow_route AND source_tenant.enabled
           AND (source_tenant.is_hub OR target_tenant.is_hub)
       )
     )
   GROUP BY membership.alias
   ORDER BY membership.alias`;

/** El límite legible de una ventana de cuota. `undefined` cuando no hay observación fresca. */
function limiteLegible(
  restante: string | number | null, ventana: string | null
): string | undefined {
  if (restante === null || ventana === null) return undefined;
  return `${Number(restante)}% disponible en la ventana ${ventana}`;
}
