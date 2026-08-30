import {
  emptyAgentProfile, normalizeAgentProfile,
  type AgentProfile, type ArnesDelAlias, type ContextoDeAlias, type CuotaDelAlias,
  type HechosDelAlias, type PermisosDelAlias
} from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';

/**
 * Repository for reading, persistence, and context of agent profiles (agent_profiles).
 */

/** The columns, in table order. A single copy for the SELECT and for the RETURNING. */
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
 * Represents the stored profile of an agent together with presence and version metadata.
 */
export interface StoredAgentProfile {
  readonly perfil: AgentProfile;
  readonly exists: boolean;
  /** NULL if the row doesn't exist. */
  readonly revision: number | null;
  /** Last revision acknowledged by runtime; null if never acknowledged. */
  readonly applied_revision: number | null;
}

/** Result of a row Postgres just returned; preserves the literals useful for CAS. */
export interface PersistedAgentProfile extends StoredAgentProfile {
  readonly exists: true;
  readonly revision: number;
}

export interface StoredAgentContext {
  readonly contexto: ContextoDeAlias;
  readonly exists: boolean;
  /** Durable state of the alias; false also when the canonical identity doesn't exist. */
  readonly agent_enabled: boolean;
  readonly revision: number | null;
  readonly applied_revision: number | null;
}

export type AgentProfileMutationErrorCode = 'not_found' | 'disabled' | 'conflict';

export interface AgentProfileAuditActor {
  readonly tenant_id: string;
  readonly alias: string;
}

/** Domain failure for concurrent or invalid profile mutations. */
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
 * Converts a database row to the `AgentProfile` type.
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
   * Gets an alias's profile; returns an empty profile if no row exists.
   */
  async read(tenantId: string, alias: string): Promise<AgentProfile> {
    return (await this.readWithPresence(tenantId, alias)).perfil;
  }

  /** The exact read that preserves whether Postgres returned a row, even if it was empty. */
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

  /**
   * Optimistic profile replacement validating the expected revision.
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
            : `agent profile revision changed from ${String(expectedRevision)}`,
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
   * Records the ACK of a revision even if another desired one was already born.
   *
   * That race is not a success for the first writer, but the data is still true: the runtime
   * reached revision N and the database already desires N+1. Keeping N allows showing "pending"
   * and retrying. A late ACK never rolls back a larger `applied_revision`.
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
          'conflict', `agent profile disappeared before runtime ACK ${String(expectedRevision)}`,
        );
      }
      const state = stored(row);
      if ((state.applied_revision ?? 0) < expectedRevision) {
        throw new AgentProfileMutationError(
          'conflict', `agent profile cannot record runtime ACK ${String(expectedRevision)}`,
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
    if (row.enabled !== true) { // eslint-disable-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- Fail closed when a PostgreSQL row violates its declared boolean shape.
      throw new AgentProfileMutationError('disabled', 'agent is disabled');
    }
  }

  /** Sanitized and atomic audit with the change: never includes the authored profile body. */
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

  /**
   * Gets the consolidated context of an alias: authored profile and derived facts.
   */
  async readContext(tenantId: string, alias: string): Promise<ContextoDeAlias> {
    return (await this.readContextWithPresence(tenantId, alias)).contexto;
  }

  /** The compilable context plus the REAL presence of the authored row. */
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
 * Query for an alias's effective permissions consolidating all its memberships in enabled rooms.
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
 * Query for accounts and limits associated with an alias through bindings and routing ceilings.
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
 * Query for recipient aliases reachable by permissions and network topology.
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

/** The readable limit of a quota window. `undefined` when there is no fresh observation. */
function limiteLegible(
  restante: string | number | null, ventana: string | null
): string | undefined {
  if (restante === null || ventana === null) return undefined;
  return `${String(Number(restante))}% disponible en la ventana ${ventana}`;
}
