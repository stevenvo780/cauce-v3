import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessConsumptionEvidenceSchema, VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { CauceRepository, ContextRuntimeUnsupportedError, type ContextApplicationRuntime, type ContextRuntimeReadiness,
  type ContextTarget, type ContextVersion, type DatabasePool } from '@cauce/store';

/** A lease names its harness as `harness.<id>`; only these harnesses emit the consumption witness that proves adoption. */
const WITNESS_HARNESSES = new Set<unknown>(HarnessConsumptionEvidenceSchema.shape.harness_id.options.map(id => `harness.${id}`));
function requestUuid(hash: string): string {
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
/** Publishes at most one outstanding dedicated turn per version; the outbox worker bounds and schedules those turns. */
export class DeliveryContextRuntimeSink implements ContextApplicationRuntime {
  private readonly repository: CauceRepository;
  constructor(private readonly pool: DatabasePool, private readonly timeoutMs = 55_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid context application deadline');
    this.repository = new CauceRepository(pool);
  }
  async readiness(target: ContextTarget): Promise<ContextRuntimeReadiness> {
    const lease = (await this.pool.query<{ capabilities: unknown }>(`SELECT capabilities FROM connection_leases
      WHERE tenant_id=$1 AND alias=$2 AND lease_until>clock_timestamp()`, [target.tenant_id, target.alias])).rows[0];
    if (!lease) return 'offline';
    const capabilities: readonly unknown[] = Array.isArray(lease.capabilities) ? lease.capabilities : [];
    return capabilities.includes(VERSIONED_CONTEXT_CAPABILITY) && capabilities.some(capability => WITNESS_HARNESSES.has(capability))
      ? 'ready' : 'unsupported';
  }
  async apply(version: ContextVersion, waiting?: () => void, stop?: AbortSignal): Promise<{ version: number; digest: string }> {
    const evidence = () => this.pool.query<{ applied_at: Date | null }>(`SELECT applied_at FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [version.company_id, version.tenant_id, version.alias, version.version]);
    if ((await evidence()).rows[0]?.applied_at) return { version: version.version, digest: version.digest };
    if (await this.readiness(version) === 'unsupported') throw new ContextRuntimeUnsupportedError();
    const sourceOnly = (await this.pool.query(`SELECT 1 FROM company_system_principals
      WHERE company_id=$1 AND kind='director' AND delivery_source_only`, [version.company_id])).rowCount !== 0;
    const principal = (await this.pool.query<{ tenant_id: string; alias: string; room_id: string }>(sourceOnly
      ? 'SELECT * FROM cauce_ensure_context_director_anchor($1,$2,$3,$4,$5)'
      : `SELECT principal.tenant_id,
      principal.principal_alias AS alias,membership.room_id FROM company_system_principals principal
      JOIN tenants source ON source.id=principal.tenant_id AND source.company_id=principal.company_id
      JOIN tenants target ON target.id=$2 AND target.company_id=principal.company_id
      JOIN agents actor ON actor.tenant_id=principal.tenant_id AND actor.alias=principal.principal_alias
      JOIN memberships membership ON membership.tenant_id=actor.tenant_id AND membership.alias=actor.alias
      JOIN role_policies policy ON policy.role=membership.role
      JOIN rooms room ON room.tenant_id=membership.tenant_id AND room.id=membership.room_id
      WHERE principal.company_id=$1 AND principal.kind='director' AND NOT principal.delivery_source_only AND actor.enabled AND actor.retired_at IS NULL
        AND actor.purged_at IS NULL AND source.enabled AND target.enabled AND membership.enabled AND room.enabled AND policy.allow_route
      ORDER BY membership.room_id LIMIT 1`, sourceOnly
      ? [version.company_id, version.tenant_id, version.alias, version.version, version.digest]
      : [version.company_id, version.tenant_id]).catch((error: unknown) => {
        if (sourceOnly && error instanceof Error && 'code' in error && error.code === '22023') {
          throw new Error('context application director is unavailable', { cause: error });
        }
        throw error;
      })).rows[0];
    if (!principal) throw new Error('context application director is unavailable');
    const hash = createHash('sha256').update(JSON.stringify([version.company_id, version.tenant_id, version.alias, version.version, version.digest])).digest('hex');
    const baseKey = `context-apply:${hash}`;
    const previous = (await this.pool.query<{ idempotency_key: string; status: string }>(`SELECT key.idempotency_key,delivery.status
      FROM idempotency_keys key JOIN messages message ON message.id=key.message_id JOIN deliveries delivery ON delivery.message_id=message.id
      WHERE key.tenant_id=$1 AND key.actor_alias=$2 AND (key.idempotency_key=$3 OR key.idempotency_key LIKE $3||':%')
        AND delivery.recipient_tenant=$4 AND delivery.recipient_alias=$5 AND message.auth_channel='context-broker'
      ORDER BY message.created_at DESC,message.id DESC LIMIT 1`,
    [principal.tenant_id, principal.alias, baseKey, version.tenant_id, version.alias])).rows[0];
    const terminal = previous !== undefined && ['done','failed','dead','cancelled'].includes(previous.status);
    if (!previous || terminal) {
      if ((await evidence()).rows[0]?.applied_at) return { version: version.version, digest: version.digest };
      const attempt = terminal ? Number(previous.idempotency_key.split(':').at(-1)) + 1 : 0;
      const retry = terminal ? Number.isSafeInteger(attempt) ? attempt : 1 : 0;
      const key = retry === 0 ? baseKey : `${baseKey}:${String(retry)}`;
      const requestHash = createHash('sha256').update(key).digest('hex');
      await this.repository.publish({ version: '3.0', request_id: requestUuid(requestHash), trace_id: key,
        tenant_id: principal.tenant_id, room_id: principal.room_id, actor_alias: principal.alias,
        recipients: [{ tenant_id: version.tenant_id, alias: version.alias }], idempotency_key: key, lane: 'interactive', priority: 0,
        body: { type: 'command', text: `Cauce context broker: consume desired context version ${String(version.version)} with digest ${version.digest}. Return a brief acknowledgement after this native turn reads the attached context.` },
        authenticated_context: { session_id: `context-broker:${version.company_id}`, channel: 'context-broker' },
        origin: { adapter: 'context-broker', channel: 'context', conversation_id: hash, relay: [],
          metadata: { company_id: version.company_id, context_version: version.version, digest: version.digest } },
      });
    }
    waiting?.();
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline && stop?.aborted !== true) {
      const row = (await this.pool.query<{ applied_at: Date | null; digest: string; desired_version: string }>(`SELECT outbox.applied_at,version.digest,current.desired_version
        FROM agent_context_outbox outbox JOIN agent_context_versions version USING(company_id,tenant_id,alias,version)
        JOIN agent_context_state current USING(company_id,tenant_id,alias)
        WHERE outbox.company_id=$1 AND outbox.tenant_id=$2 AND outbox.alias=$3 AND outbox.version=$4`,
      [version.company_id, version.tenant_id, version.alias, version.version])).rows[0];
      if (row?.digest !== version.digest) throw new Error('context application scope changed');
      if (row.applied_at !== null) return { version: version.version, digest: version.digest };
      if (Number(row.desired_version) !== version.version) throw new Error('context application was replaced');
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())), undefined, stop ? { signal: stop } : {}).catch(() => undefined);
    }
    throw new Error('context application consumed-turn evidence is unavailable');
  }
}
