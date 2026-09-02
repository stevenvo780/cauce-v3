import type { Ack, ProfileRuntimeAdoptionEvidence, ProfileRuntimeContract, Tenant } from '@cauce/protocol';
import { ProfileRuntimeContractSchema, PROTOCOL_VERSION, SYSTEM_PRINCIPAL_ALIASES } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { withTransaction } from '../db.js';
import { canonicallyEqual } from './config.js';
import { DeliveryAcksRepository, type RoutingTarget } from './deliveries.js';
import { StoreError } from './errors.js';
import { agentDeploymentStatus, type DeliveryRow } from './observability.js';

export type ProfileRuntimeAdoptionAck = ProfileRuntimeAdoptionEvidence & {
  readonly adopted_at: string;
};

function canonicalProfileRuntimeContract(value: unknown): ProfileRuntimeContract | undefined {
  const parsed = ProfileRuntimeContractSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    documents: [...parsed.data.documents].sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
  };
}

export abstract class AgentsRepository extends DeliveryAcksRepository {

  async recordProfileRuntimeExpectation(
    tenantId: Tenant,
    alias: string,
    input: ProfileRuntimeContract,
  ): Promise<void> {
    const contract = canonicalProfileRuntimeContract(input);
    if (contract === undefined) {
      throw new StoreError('invalid_input', 'runtime profile expectation is invalid');
    }
    await withTransaction(this.pool, async (client) => {
      const profile = await client.query<{ revision: string | number }>(
        `SELECT revision FROM agent_profiles
          WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
        [tenantId, alias],
      );
      if (profile.rowCount !== 1 || Number(profile.rows[0]?.revision) !== contract.revision) {
        throw new StoreError('conflict', 'runtime profile expectation is not the desired revision');
      }
      await client.query(
        `INSERT INTO agent_profile_runtime_expectations(
           tenant_id,alias,revision,generation,documents
         ) VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT(tenant_id,alias) DO UPDATE SET
           revision=EXCLUDED.revision,
           generation=EXCLUDED.generation,
           documents=EXCLUDED.documents,
           updated_at=clock_timestamp()`,
        [tenantId, alias, contract.revision, contract.generation, JSON.stringify(contract.documents)],
      );
    });
  }


  async readProfileRuntimeAdoption(
    tenantId: Tenant,
    alias: string,
    input: ProfileRuntimeContract,
  ): Promise<ProfileRuntimeAdoptionAck | undefined> {
    const expected = canonicalProfileRuntimeContract(input);
    if (expected === undefined) return undefined;
    const result = await this.pool.query<{
      revision: string | number;
      generation: string;
      documents: unknown;
      adopted_at: Date;
    }>(
      `SELECT adoption.revision,adoption.generation,adoption.documents,adoption.adopted_at
         FROM agent_profile_runtime_adoptions adoption
         JOIN agent_profile_runtime_expectations expectation
           ON expectation.tenant_id=adoption.tenant_id
          AND expectation.alias=adoption.alias
          AND expectation.revision=adoption.revision
          AND expectation.generation=adoption.generation
          AND expectation.documents=adoption.documents
         JOIN agent_profiles profile
           ON profile.tenant_id=adoption.tenant_id AND profile.alias=adoption.alias
          AND profile.revision=adoption.revision
        WHERE adoption.tenant_id=$1 AND adoption.alias=$2
          AND adoption.revision=$3 AND adoption.generation=$4`,
      [tenantId, alias, expected.revision, expected.generation],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const actual = canonicalProfileRuntimeContract({
      revision: Number(row.revision), generation: row.generation, documents: row.documents,
    });
    if (actual === undefined || !canonicallyEqual(actual, expected)) return undefined;
    return {
      evidence: 'adapter_delivery',
      revision: actual.revision,
      generation: actual.generation,
      documents: actual.documents,
      adopted_at: row.adopted_at.toISOString(),
    };
  }


  protected override async profileRuntimeExpectation(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string,
  ): Promise<ProfileRuntimeContract | undefined> {
    const result = await client.query<{
      revision: string | number;
      generation: string;
      documents: unknown;
    }>(
      `SELECT expectation.revision,expectation.generation,expectation.documents
         FROM agent_profile_runtime_expectations expectation
         JOIN agent_profiles profile
           ON profile.tenant_id=expectation.tenant_id AND profile.alias=expectation.alias
          AND profile.revision=expectation.revision
        WHERE expectation.tenant_id=$1 AND expectation.alias=$2
        FOR SHARE OF expectation,profile`,
      [tenantId, alias],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : canonicalProfileRuntimeContract({
      revision: Number(row.revision), generation: row.generation, documents: row.documents,
    });
  }


  protected override async recordProfileRuntimeAdoption(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string,
    row: DeliveryRow,
    ack: Ack,
    evidence: ProfileRuntimeAdoptionEvidence | undefined,
  ): Promise<boolean> {
    if (ack.status !== 'done' || evidence === undefined) return false;
    const expected = await this.profileRuntimeExpectation(client, tenantId, alias);
    const actual = canonicalProfileRuntimeContract({
      revision: evidence.revision,
      generation: evidence.generation,
      documents: evidence.documents,
    });
    if (expected === undefined || actual === undefined || !canonicallyEqual(actual, expected)) {
      return false;
    }
    const inserted = await client.query(
      `INSERT INTO agent_profile_runtime_adoptions(
         tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT(tenant_id,alias,revision,generation) DO NOTHING
       RETURNING 1`,
      [
        tenantId, alias, actual.revision, actual.generation, JSON.stringify(actual.documents),
        row.id, ack.attempt, ack.instance_id, ack.epoch,
      ],
    );
    await client.query(
      `UPDATE agent_profiles SET applied_revision=$3
        WHERE tenant_id=$1 AND alias=$2 AND revision=$3
          AND (applied_revision IS NULL OR applied_revision<$3)`,
      [tenantId, alias, actual.revision],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'agent_profile.adopted','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          tenantId, alias, row.request_id, row.message_id, row.id, row.trace_id,
          JSON.stringify({
            revision: actual.revision,
            generation: actual.generation,
            document_count: actual.documents.length,
            attempt: ack.attempt,
            epoch: ack.epoch,
          }),
        ],
      );
    }
    return true;
  }





  async listPresence(actorTenant?: Tenant, actorAlias?: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT tenant_id,alias,instance_id,epoch,capabilities,last_heartbeat_at,lease_until,
               (lease_until > now()) AS online
        FROM connection_leases l
        WHERE ($1::text IS NULL OR EXISTS (
          SELECT 1 FROM memberships own JOIN role_policies role ON role.role=own.role
          WHERE own.tenant_id=$1 AND own.alias=$2 AND own.enabled AND role.allow_read
        ) AND (l.tenant_id=$1 OR EXISTS (
          SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=l.tenant_id
            AND a.enabled AND a.allow_read
        )))
       ORDER BY tenant_id,alias`, [actorTenant ?? null, actorAlias ?? null]
    );
    return result.rows.map((row) => ({ ...row, epoch: Number(row.epoch) }));
  }


  /**
   * Short projection of the CANONICAL role of the claiming alias.
   *
   * Returns `undefined` —and not an empty string nor a default text— when the row does not exist or
   * Since migration 028, `agent_profiles.role_summary` is the only authored source. This read
   * derives `self_role` directly from it —trim + 1,200 code points— and does NOT trust the legacy
   * `agents.role_brief` projection. So the greeting, the file and every delivery observe the same
   * revision, even if an old image or a manual query left the cache corrupted.
   */
  protected override async selfRoleFromProfile(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string
  ): Promise<string | undefined> {
    const result = await client.query<{ self_role: string | null }>(
      `SELECT CASE
                WHEN profile.role_summary IS NULL OR btrim(profile.role_summary)='' THEN NULL
                ELSE substring(btrim(profile.role_summary) FROM 1 FOR 1200)
              END AS self_role
         FROM agents agent
         LEFT JOIN agent_profiles profile
           ON profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
        WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.enabled`,
      [tenantId, alias]
    );
    const brief = result.rows[0]?.self_role;
    if (typeof brief !== 'string') return undefined;
    const trimmed = brief.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }


  protected override async routingTargets(
    client: DatabaseClient,
    sourceTenant: Tenant,
    sourceAlias: string
  ): Promise<RoutingTarget[]> {
    const targets = await client.query<RoutingTarget>(
      `SELECT membership.tenant_id,membership.alias,
              COALESCE(bool_or(lease.lease_until > now()),false) AS online
       FROM memberships membership
       JOIN tenants target_tenant ON target_tenant.id=membership.tenant_id
       JOIN rooms target_room
         ON target_room.id=membership.room_id AND target_room.tenant_id=membership.tenant_id
       LEFT JOIN connection_leases lease
         ON lease.tenant_id=membership.tenant_id AND lease.alias=membership.alias
       WHERE membership.enabled AND target_tenant.enabled AND target_room.enabled
         AND NOT (membership.tenant_id=$1 AND membership.alias=$2)
         AND NOT (membership.alias=ANY($3::text[]))
         AND (
           membership.tenant_id=$1
           OR EXISTS (
             SELECT 1
             FROM acl_edges edge
             JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
             WHERE edge.from_tenant=$1 AND edge.to_tenant=membership.tenant_id
               AND edge.enabled AND edge.allow_route
               AND source_tenant.enabled
               AND (source_tenant.is_hub OR target_tenant.is_hub)
           )
         )
       GROUP BY membership.tenant_id,membership.alias
       ORDER BY membership.tenant_id,membership.alias`,
      [sourceTenant, sourceAlias, SYSTEM_PRINCIPAL_ALIASES]
    );
    if (targets.rows.length > 100) {
      throw new StoreError('conflict', 'routing inventory exceeds the protocol limit of 100 targets');
    }
    return targets.rows;
  }


  async listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const [rows, definitions] = await Promise.all([
      this.listPresence(actorTenant, actorAlias),
      this.pool.query<{
        id: string; display_name: string; capabilities: string[]; enabled: boolean; updated_at: Date;
      }>(`SELECT id,display_name,capabilities,enabled,updated_at FROM harness_definitions ORDER BY id`)
    ]);
    const configured = definitions.rows.map((definition) => {
      const observed = rows.find((row) => Array.isArray(row.capabilities) &&
        row.capabilities.includes(`harness.${definition.id}`));
      return {
        id: definition.id,
        label: definition.display_name,
        state: observed?.online === true && definition.enabled ? 'available'
          : observed ? 'unavailable' : 'unknown',
        capabilities: definition.capabilities,
        protocol_version: PROTOCOL_VERSION,
        last_seen_at: observed?.last_heartbeat_at ?? null,
        detail: observed ? (observed.online === true ? 'active lease' : 'expired lease') : 'no matching runtime capability observed'
      };
    });
    const unregistered = rows.filter((row) => !definitions.rows.some((definition) =>
      Array.isArray(row.capabilities) && row.capabilities.includes(`harness.${definition.id}`)
    ));
    return {
      items: [...configured, ...unregistered.map((row) => ({
        id: `${String(row.tenant_id)}:${String(row.alias)}`,
        label: row.alias,
        state: row.online === true ? 'available' : 'unavailable',
        capabilities: row.capabilities,
        protocol_version: PROTOCOL_VERSION,
        last_seen_at: row.last_heartbeat_at,
        detail: row.online === true ? 'active lease' : 'expired lease'
      }))]
    };
  }


  /** Control-plane fleet listing: agents filtered exactly the way every other read endpoint
   *  filters — own tenant plus any tenant the actor has an allow_read ACL edge into (see
   *  topology()). Deployment status is registry+presence only; kratos execution state
   *  (systemd/docker) has no reporter yet, see docs/adr/006-agent-registry-and-deferred-execution.md. */
  async listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT a.tenant_id,a.alias,a.harness_id,h.display_name AS harness_label,a.display_name,
              a.enabled,a.container_name,a.runtime_user,a.home_directory,a.state_directory,
              a.created_at,a.updated_at,
              lease.online,lease.last_heartbeat_at,
              COALESCE(routing.fallback_accounts,0) AS fallback_account_count,
              COALESCE(routing.borrowed_accounts,0) AS borrowed_account_count
       FROM agents a
       LEFT JOIN harness_definitions h ON h.id=a.harness_id
       LEFT JOIN LATERAL (
         SELECT (l.lease_until>now()) AS online, l.last_heartbeat_at
         FROM connection_leases l WHERE l.tenant_id=a.tenant_id AND l.alias=a.alias
       ) lease ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS fallback_accounts,
                count(*) FILTER (WHERE ceiling.account_payer_tenant<>a.tenant_id)::int AS borrowed_accounts
         FROM agent_account_bindings b
         JOIN alias_routing_ceiling ceiling ON ceiling.tenant_id=b.tenant_id
           AND ceiling.alias=b.agent_alias AND ceiling.account_id=b.account_id
         WHERE b.tenant_id=a.tenant_id AND b.agent_alias=a.alias AND b.enabled
       ) routing ON true
       WHERE a.tenant_id=$1 OR EXISTS (
         SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=a.tenant_id
           AND edge.enabled AND edge.allow_read
       )
       ORDER BY a.tenant_id,a.alias`, [actorTenant]
    );
    return { items: result.rows.map((row) => ({ ...row, deployment_status: agentDeploymentStatus(row) })) };
  }


  /**
   * Legacy detail without a tenant in its resource identifier. It means exactly the actor's own
   * tenant; an equally named visible foreign agent must never win by `ORDER BY`.
   */
  async getAgent(alias: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown> | undefined> {
    return this.getAgentByIdentity(actorTenant, alias, actorTenant, actorAlias);
  }


  /** Single-agent detail: same visibility rule as listAgents, plus the ordered fallback accounts
   *  this alias may be routed to. external_account_id is disclosed only for accounts the actor's
   *  own tenant pays for: a borrowed pool account shows who pays, which provider and the label,
   *  never the payer's account identity. Returns undefined rather than throwing so the route can
   *  answer a uniform 404 whether the alias is unknown or simply not visible to this actor. */
  async getAgentByIdentity(
    tenantId: Tenant,
    alias: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown> | undefined> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const agentResult = await this.pool.query<Record<string, unknown>>(
      `SELECT a.tenant_id,a.alias,a.harness_id,h.display_name AS harness_label,a.display_name,
              a.enabled,a.container_name,a.runtime_user,a.home_directory,a.state_directory,
              a.created_at,a.updated_at,
              lease.online,lease.last_heartbeat_at,lease.instance_id
       FROM agents a
       LEFT JOIN harness_definitions h ON h.id=a.harness_id
       LEFT JOIN LATERAL (
         SELECT (l.lease_until>now()) AS online, l.last_heartbeat_at, l.instance_id
         FROM connection_leases l WHERE l.tenant_id=a.tenant_id AND l.alias=a.alias
       ) lease ON true
       WHERE a.tenant_id=$1 AND a.alias=$2 AND (a.tenant_id=$3 OR EXISTS (
         SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$3 AND edge.to_tenant=a.tenant_id
           AND edge.enabled AND edge.allow_read
       ))
       LIMIT 1`, [tenantId, alias, actorTenant]
    );
    const agent = agentResult.rows[0];
    if (!agent) return undefined;
    const routing = await this.pool.query<Record<string, unknown>>(
      `SELECT ceiling.account_id,ceiling.account_payer_tenant,
              (ceiling.account_payer_tenant<>ceiling.tenant_id) AS borrowed,
              b.priority,COALESCE(b.enabled,false) AS enabled,
              p.provider,p.label,p.shared_with_pool,p.enabled AS account_enabled,
              CASE WHEN p.payer_tenant_id=$3 THEN p.external_account_id END AS external_account_id
       FROM alias_routing_ceiling ceiling
       JOIN provider_accounts p ON p.id=ceiling.account_id
       LEFT JOIN agent_account_bindings b ON b.tenant_id=ceiling.tenant_id
         AND b.agent_alias=ceiling.alias AND b.account_id=ceiling.account_id
       WHERE ceiling.tenant_id=$1 AND ceiling.alias=$2
       ORDER BY b.priority NULLS LAST,ceiling.account_id`,
      [tenantId, alias, actorTenant]
    );
    return { ...agent, deployment_status: agentDeploymentStatus(agent), routing_accounts: routing.rows };
  }
}
