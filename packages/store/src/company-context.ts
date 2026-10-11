import type { CompanyContext } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';

/** How long a company's principals and roles are served from memory before the next read. */
export const COMPANY_CONTEXT_TTL_MS = 60_000;

export interface SystemGatePrincipal {
  readonly tenant_id: string;
  readonly room_id: string;
  readonly actor_alias: string;
  readonly principal_alias: string;
}

interface PrincipalRow {
  kind: string;
  tenant_id: string;
  room_id: string | null;
  actor_alias: string | null;
  principal_alias: string;
  recipient_alias: string | null;
  notify_handle: string | null;
}

interface RoleRow { role: string; tenant_id: string; alias: string }

interface CompanyFacts {
  readonly company_id: string;
  readonly principals: readonly PrincipalRow[];
  readonly roles: readonly RoleRow[];
}

type Queryable = Pick<DatabaseClient, 'query'>;

/** A tenant that does not exist has no company: the caller sends no context at all. */
async function readFacts(client: Queryable, tenant: string): Promise<CompanyFacts | undefined> {
  const row = (await client.query<{ company_id: string; principals: PrincipalRow[]; roles: RoleRow[] }>(
    `SELECT t.company_id,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',p.kind,'tenant_id',p.tenant_id,'room_id',p.room_id,
         'actor_alias',p.actor_alias,'principal_alias',p.principal_alias,'recipient_alias',p.recipient_alias,
         'notify_handle',p.notify_handle) ORDER BY p.kind,p.tenant_id,p.principal_alias)
         FROM company_system_principals p WHERE p.company_id=t.company_id),'[]'::jsonb) AS principals,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('role',r.role,'tenant_id',r.tenant_id,'alias',r.alias)
         ORDER BY r.role,r.tenant_id,r.alias) FROM company_agent_roles r WHERE r.company_id=t.company_id),'[]'::jsonb) AS roles
     FROM tenants t WHERE t.id=$1`, [tenant],
  )).rows[0];
  return row;
}

function ref(row: RoleRow | undefined): { tenant_id: string; alias: string } | undefined {
  return row === undefined ? undefined : { tenant_id: row.tenant_id, alias: row.alias };
}

/** The wire context of one recipient. Optional keys are omitted, never null, to satisfy the strict schema. */
export function companyContextFor(facts: CompanyFacts, tenant: string, alias: string): CompanyContext {
  const own = (kind: string): boolean => facts.principals.some(
    (row) => row.kind === kind && row.tenant_id === tenant && row.principal_alias === alias,
  );
  const gate = facts.principals.find((row) => row.kind === 'gate_probe');
  const notice = facts.principals.find((row) => row.kind === 'supervision_notice');
  const infra = ref(facts.roles.find((row) => row.role === 'infra_escalation'));
  const coordination = ref(facts.roles.find((row) => row.role === 'coordination'));
  return {
    company_id: facts.company_id,
    ...(own('director') ? { director: true as const } : {}),
    ...(own('human_receipt') ? { human_receipt: true as const } : {}),
    ...(infra === undefined ? {} : { infra_escalation: infra }),
    ...(coordination === undefined ? {} : { coordination }),
    ...(gate?.room_id == null || gate.actor_alias == null ? {} : {
      gate_probe: {
        tenant_id: gate.tenant_id, room_id: gate.room_id, actor_alias: gate.actor_alias,
        principal_alias: gate.principal_alias,
      },
    }),
    ...(notice?.room_id == null || notice.actor_alias == null || notice.recipient_alias == null
      || notice.notify_handle == null ? {} : {
        supervision_notice: {
          tenant_id: notice.tenant_id, room_id: notice.room_id, actor_alias: notice.actor_alias,
          principal_alias: notice.principal_alias, recipient_alias: notice.recipient_alias,
          notify_handle: notice.notify_handle,
        },
      }),
  };
}

/**
 * Serves delivery claims, which are hot and read facts that only the platform changes. Each repository
 * owns one cache, so two databases never share entries. Nothing that authorizes a write reads it:
 * `systemGatePrincipal` always goes to the database.
 */
export class CompanyContextCache {
  private readonly entries = new Map<string, { expires: number; facts: CompanyFacts | undefined }>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = COMPANY_CONTEXT_TTL_MS) {}

  async read(client: Queryable, tenant: string, alias: string): Promise<CompanyContext | undefined> {
    const cached = this.entries.get(tenant);
    let facts: CompanyFacts | undefined;
    if (cached !== undefined && cached.expires > this.now()) facts = cached.facts;
    else {
      facts = await readFacts(client, tenant);
      this.entries.set(tenant, { expires: this.now() + this.ttlMs, facts });
    }
    return facts === undefined ? undefined : companyContextFor(facts, tenant, alias);
  }
}

/** The exact gate-probe principal of the tenant's company, read fresh because it authorizes a publish. */
export async function systemGatePrincipal(client: Queryable, tenant: string): Promise<SystemGatePrincipal | undefined> {
  const facts = await readFacts(client, tenant);
  const gate = facts?.principals.find((row) => row.kind === 'gate_probe');
  if (gate?.room_id == null || gate.actor_alias == null) return undefined;
  return {
    tenant_id: gate.tenant_id, room_id: gate.room_id, actor_alias: gate.actor_alias,
    principal_alias: gate.principal_alias,
  };
}
