import type { ConfigMutation, Tenant } from '@cauce/protocol';
import { selectAccountForAlias, type AccountSelection } from '../accounts.js';
import type { DatabaseClient } from '../db.js';
import {
  ConfigurationError, ConfigurationRepository, type ConfigurationChangeResult
} from '../configuration.js';
import { StoreError } from './errors.js';
import { OutboxRepository } from './outbox.js';

export * from './config/publish-policy.js';

export type AgentTargetPermission = 'read' | 'control';

/** Minimal record of the alias authorized by its canonical identity. */
export interface AuthorizedAgentTarget {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly harness_id: string | null;
  readonly home_directory: string | null;
  readonly enabled: boolean;
}
export abstract class ConfigRepository extends OutboxRepository {
  protected async assertRuntimeRoute(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
    const memberships = await client.query<{ allow_route: boolean }>(
      `SELECT policy.allow_route FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       FOR SHARE OF membership,policy,tenant,room`,
      [tenantId, alias]
    );
    if (memberships.rowCount === 0) {
      throw new StoreError('invalid_actor', 'consumer alias is not an enabled member');
    }
    if (!memberships.rows.some((membership) => membership.allow_route)) {
      throw new StoreError('forbidden', 'consumer route permission has been revoked');
    }
  }

  async assertPrincipal(tenantId: Tenant, alias: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
       JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND t.enabled AND r.enabled LIMIT 1`,
      [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
  }

  override async assertPermission(
    tenantId: Tenant, alias: string, permission: 'route' | 'read' | 'control' | 'notify'
  ): Promise<void> {
    const column = permission === 'route'
      ? 'allow_route'
      : permission === 'read'
        ? 'allow_read'
        : permission === 'control' ? 'allow_control' : 'allow_notify';
    const result = await this.pool.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.${column} LIMIT 1`, [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('forbidden', `principal lacks ${permission} permission`);
  }

  /**
   * Authorizes an actor against ONE canonical target `(tenant, alias)` and returns that same row.
   *
   * It does not accept `alias` alone: the same name may exist in several tenants, and picking the
   * first one by order turns a URL into a cross-tenant leak. First the actor's effective permission
   * is required; then, for another tenant, the ACL edge for the SAME permission. Any absence leaves
   * the result as `undefined`, same for "does not exist" and "you cannot see it".
   */
  async authorizeAgentTarget(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: AgentTargetPermission
  ): Promise<AuthorizedAgentTarget | undefined> {
    const permissionColumn = permission === 'read' ? 'allow_read' : 'allow_control';
    const result = await this.pool.query<AuthorizedAgentTarget>(
      `SELECT agent.tenant_id,agent.alias,agent.harness_id,agent.home_directory,agent.enabled
         FROM agents agent
         JOIN tenants target_tenant ON target_tenant.id=agent.tenant_id
        WHERE agent.tenant_id=$3 AND agent.alias=$4 AND target_tenant.enabled
          AND ($5::text='read' OR agent.enabled)
          AND EXISTS (
            SELECT 1
              FROM memberships actor_membership
              JOIN role_policies actor_role ON actor_role.role=actor_membership.role
              JOIN tenants actor_tenant ON actor_tenant.id=actor_membership.tenant_id
              JOIN rooms actor_room
                ON actor_room.id=actor_membership.room_id
               AND actor_room.tenant_id=actor_membership.tenant_id
             WHERE actor_membership.tenant_id=$1 AND actor_membership.alias=$2
               AND actor_membership.enabled AND actor_role.${permissionColumn}
               AND actor_tenant.enabled AND actor_room.enabled
          )
          AND (
            $1=$3
            OR EXISTS (
              SELECT 1
                FROM acl_edges edge
                JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
               WHERE edge.from_tenant=$1 AND edge.to_tenant=$3
                 AND edge.enabled AND edge.${permissionColumn}
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
        LIMIT 1`,
      [actorTenant, actorAlias, targetTenant, targetAlias, permission]
    );
    return result.rows[0];
  }

  async principalAccess(tenantId: Tenant, alias: string): Promise<{
    roles: string[]; permissions: Array<'route' | 'read' | 'control' | 'notify'>;
  }> {
    const result = await this.pool.query<{
      roles: string[]; allow_route: boolean; allow_read: boolean; allow_control: boolean;
      allow_notify: boolean;
    }>(
      `SELECT array_agg(DISTINCT membership.role ORDER BY membership.role) AS roles,
              bool_or(role.allow_route) AS allow_route,bool_or(role.allow_read) AS allow_read,
              bool_or(role.allow_control) AS allow_control,bool_or(role.allow_notify) AS allow_notify
       FROM memberships membership JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled`, [tenantId, alias]
    );
    const row = result.rows[0];
    if (!row?.roles?.length) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
    return {
      roles: row.roles,
      permissions: [
        ...(row.allow_route ? ['route' as const] : []),
        ...(row.allow_read ? ['read' as const] : []),
        ...(row.allow_control ? ['control' as const] : []),
        ...(row.allow_notify ? ['notify' as const] : [])
      ]
    };
  }

  async getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    try {
      return await new ConfigurationRepository(this.pool).get(actorTenant, actorAlias);
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  async applyConfigurationChange(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).apply(
        actorTenant, actorAlias, mutation, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  async rollbackConfiguration(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).rollback(
        actorTenant, actorAlias, revisionId, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  private rethrowConfigurationError(error: unknown): never {
    if (error instanceof ConfigurationError) {
      throw new StoreError(error.code, error.message);
    }
    throw error;
  }

  async topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const [tenants, edges] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT t.id,COALESCE(t.display_name,t.id) AS label,t.is_hub,t.enabled,COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
              'id',r.id,'label',COALESCE(r.display_name,r.id),'enabled',r.enabled,'members',COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'alias',m.alias,
                  'role',m.role,
                  'enabled',m.enabled,
                  'registered',(agent.tenant_id IS NOT NULL),
                  'agent_enabled',agent.enabled,
                  'harness_id',agent.harness_id,
                  'display_name',agent.display_name,
                  'off_reason',CASE
                    WHEN agent.tenant_id IS NULL THEN 'not_registered'
                    WHEN NOT agent.enabled AND NOT m.enabled THEN 'agent_and_membership_disabled'
                    WHEN NOT agent.enabled THEN 'agent_disabled'
                    WHEN NOT m.enabled THEN 'membership_disabled'
                    ELSE NULL END
                ) ORDER BY m.alias)
               FROM memberships m
               LEFT JOIN agents agent
                 ON agent.tenant_id=m.tenant_id AND agent.alias=m.alias
               WHERE m.tenant_id=t.id AND m.room_id=r.id
             ),'[]'::jsonb)
           ) ORDER BY r.id) FROM rooms r WHERE r.tenant_id=t.id
         ),'[]'::jsonb) AS rooms
          FROM tenants t WHERE t.id=$1 OR EXISTS (
            SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=t.id
              AND a.enabled AND a.allow_read
          ) ORDER BY t.id`, [actorTenant]
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,
                'explicit'::text AS policy FROM acl_edges
         WHERE (from_tenant=$1 OR to_tenant=$1) AND allow_read
         ORDER BY from_tenant,to_tenant`, [actorTenant]
      )
    ]);
    return { observed_at: new Date().toISOString(), tenants: tenants.rows, acl_edges: edges.rows };
  }

  /**
   * Which subscription the alias spends on its next execution (GET /v3/accounts/selection).
   *
   * `actorTenant`/`actorAlias` are the AUTHENTICATED mTLS identity and are ALSO the subject of
   * the query: there is no parameter to ask about another alias. It is deliberate and it is half
   * of this route's security — the response includes the account's `credential_ref`, and even though
   * it is a locator rather than a secret, telling one agent where ANOTHER agent looks up its
   * credential is exactly the kind of data that has no reason to cross over. An alias only resolves
   * its own.
   *
   * Note the difference with `getConfiguration()`, which NEVER returns `credential_ref`, not even
   * to its payer (see configuration.ts): that one feeds a browser; this one feeds the adapter
   * running on the host that already has the material mounted. Migration 010 says so when
   * describing the locator: "the borrower receives a reference it can only dereference on a host
   * that already holds the material".
   */
  async selectAccount(actorTenant: Tenant, actorAlias: string, provider: string): Promise<AccountSelection> {
    // Same character set as the CHECK on `provider_accounts.provider`. Validated here, not just
    // at the route, so no future caller can slip an arbitrary string into the query parameter.
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(provider)) {
      throw new StoreError('invalid_input', `invalid provider name: ${provider}`);
    }
    return selectAccountForAlias(this.pool, {
      tenant_id: actorTenant, alias: actorAlias, provider
    });
  }
}
