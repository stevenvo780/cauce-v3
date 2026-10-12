import type { FastifyInstance } from 'fastify';
import { FleetErrorSchema, FleetStepNameSchema } from '@cauce/protocol';
import { safeAuditSummary, StoreError, withAbortableTransaction, type CompanyAuthority, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { replyError } from '../shared.js';

const MAX_ITEMS = 500;
const MAX_ROUNDS = 8;
const SYNC_ERRORS = ['context_git_unavailable', 'context_git_commit_failed', 'context_push_failed',
  'context_git_authentication_failed', 'context_git_network_failed', 'context_git_non_fast_forward',
  'context_git_timeout', 'context_git_repository_not_private'];

interface ChainRow {
  node_key: string;
  at: Date;
  refs: string[];
  data: Record<string, unknown> & { type: string; id: string };
  metadata: unknown;
}

// Every node is scoped before its references can extend the frontier. Compound context keys
// include the tenant, alias and version; aliases and versions alone never establish a relation.
const CHAIN_QUERY = `WITH nodes AS (
  SELECT 'audit:'||audit.id AS node_key,audit.created_at AS at,
    array_remove(ARRAY['audit:'||audit.id,'trace:'||audit.trace_id,
      'message:'||audit.message_id,'delivery:'||audit.delivery_id,
      'delivery:'||(audit.metadata->>'delivery_id'),'operation:'||(audit.metadata->>'operation_id'),
      'session:'||(audit.metadata->>'session_id'),'backup:'||(audit.metadata->>'backup_id'),
      CASE WHEN audit.action LIKE 'space.backup.%' THEN 'backup:'||(audit.metadata->>'id') END,
      CASE WHEN audit.action IN ('context.version','context.sync') AND audit.metadata->>'version' ~ '^[1-9][0-9]{0,18}$'
        THEN 'context:'||jsonb_build_array(COALESCE(audit.metadata->>'target_tenant',audit.tenant_id),
          COALESCE(audit.metadata->>'target_alias',audit.actor_alias),audit.metadata->>'version')::text END],NULL) AS refs,
    jsonb_build_object('type','audit','id',audit.id::text,'company_id',COALESCE(audit.company_id,tenant.company_id),
      'tenant_id',audit.tenant_id,'alias',audit.actor_alias,'action',audit.action,'decision',audit.decision,
      'request_id',audit.request_id,'trace_id',audit.trace_id,
      'host_id',(SELECT host.host_id FROM fleet_hosts host WHERE host.company_id=$1 AND host.host_id=audit.metadata->>'host_id'),
      'component',CASE WHEN audit.metadata->>'component' IN ('terminal','context','backup','fleet','gateway','delivery')
        THEN audit.metadata->>'component' END) AS data,audit.metadata
  FROM audit_events audit LEFT JOIN tenants tenant ON tenant.id=audit.tenant_id
  WHERE COALESCE(audit.company_id,tenant.company_id)=$1 AND ($2::text IS NULL OR audit.tenant_id=$2)
  UNION ALL
  SELECT 'message:'||message.id,message.created_at,ARRAY['message:'||message.id,'trace:'||message.trace_id],
    jsonb_build_object('type','message','id',message.id::text,'company_id',tenant.company_id,
      'tenant_id',message.tenant_id,'alias',message.actor_alias,'host_id',NULL,'component','delivery',
      'request_id',message.request_id,'trace_id',message.trace_id),'{}'::jsonb
  FROM messages message JOIN tenants tenant ON tenant.id=message.tenant_id
  WHERE tenant.company_id=$1 AND ($2::text IS NULL OR message.tenant_id=$2)
  UNION ALL
  SELECT 'delivery:'||delivery.id,delivery.created_at,array_remove(ARRAY['delivery:'||delivery.id,
      CASE WHEN source.company_id=$1 AND ($2::text IS NULL OR message.tenant_id=$2) THEN 'message:'||message.id END,
      CASE WHEN source.company_id=$1 AND ($2::text IS NULL OR message.tenant_id=$2) THEN 'trace:'||message.trace_id END,
      CASE WHEN delivery.context_version IS NOT NULL THEN 'context:'||jsonb_build_array(delivery.recipient_tenant,
        delivery.recipient_alias,delivery.context_version::text)::text END],NULL),
    jsonb_build_object('type','delivery','id',delivery.id::text,'company_id',tenant.company_id,
      'tenant_id',delivery.recipient_tenant,'alias',delivery.recipient_alias,'host_id',NULL,'component','delivery',
      'state',delivery.status,'attempt',delivery.attempt,'context_version',delivery.context_version::text,
      'message_id',CASE WHEN source.company_id=$1 AND ($2::text IS NULL OR message.tenant_id=$2) THEN message.id END),
    '{}'::jsonb
  FROM deliveries delivery JOIN tenants tenant ON tenant.id=delivery.recipient_tenant
    JOIN messages message ON message.id=delivery.message_id JOIN tenants source ON source.id=message.tenant_id
  WHERE tenant.company_id=$1 AND ($2::text IS NULL OR delivery.recipient_tenant=$2)
  UNION ALL
  SELECT 'session:'||session.id,session.issued_at,array_remove(ARRAY['session:'||session.id,'trace:'||session.trace_id],NULL),
    jsonb_build_object('type','session','id',session.id::text,'company_id',tenant.company_id,
      'tenant_id',session.tenant_id,'alias',session.alias,'host_id',NULL,'component','terminal',
      'trace_id',session.trace_id,'mode',session.mode,'state',CASE WHEN session.closed_at IS NOT NULL THEN 'closed'
        WHEN session.revoked_at IS NOT NULL THEN 'revoked' WHEN session.expires_at<=now() THEN 'expired'
        WHEN session.consumed_at IS NOT NULL THEN 'consumed' ELSE 'issued' END),'{}'::jsonb
  FROM terminal_sessions session JOIN tenants tenant ON tenant.id=session.tenant_id
  WHERE tenant.company_id=$1 AND ($2::text IS NULL OR session.tenant_id=$2)
  UNION ALL
  SELECT 'operation:'||operation.id,operation.created_at,ARRAY['operation:'||operation.id],
    jsonb_build_object('type','operation','id',operation.id::text,'company_id',operation.company_id,
      'tenant_id',operation.actor_tenant,'alias',operation.actor_alias,'host_id',operation.executor_host,
      'component','fleet','kind',operation.kind,'state',operation.status,
      'error_code',CASE WHEN operation.error->>'code'=ANY($7::text[]) THEN operation.error->>'code' END,
      'step',CASE WHEN operation.error->>'step'=ANY($8::text[]) THEN operation.error->>'step' END),'{}'::jsonb
  FROM fleet_operations operation
  WHERE operation.company_id=$1 AND ($2::text IS NULL OR operation.actor_tenant=$2)
  UNION ALL
  SELECT 'operation_event:'||event.id,event.created_at,ARRAY['operation_event:'||event.id,'operation:'||operation.id],
    jsonb_build_object('type','operation_event','id',event.id::text,'company_id',operation.company_id,
      'tenant_id',operation.actor_tenant,'alias',operation.actor_alias,'host_id',operation.executor_host,
      'component','fleet','operation_id',operation.id::text,'action',event.event,'version',event.version::text,
      'error_code',CASE WHEN event.metadata->>'code'=ANY($7::text[]) THEN event.metadata->>'code' END,
      'step',CASE WHEN event.metadata->>'step'=ANY($8::text[]) THEN event.metadata->>'step' END),'{}'::jsonb
  FROM fleet_operation_events event JOIN fleet_operations operation ON operation.id=event.operation_id
  WHERE operation.company_id=$1 AND ($2::text IS NULL OR operation.actor_tenant=$2)
  UNION ALL
  SELECT 'context:'||jsonb_build_array(outbox.tenant_id,outbox.alias,outbox.version::text)::text,version.created_at,
    ARRAY['context:'||jsonb_build_array(outbox.tenant_id,outbox.alias,outbox.version::text)::text],
    jsonb_build_object('type','context','id',jsonb_build_array(outbox.tenant_id,outbox.alias,outbox.version::text)::text,
      'company_id',outbox.company_id,'tenant_id',outbox.tenant_id,'alias',outbox.alias,'host_id',NULL,
      'component','context','version',outbox.version::text,'state',outbox.state,'git_commit',outbox.git_commit,
      'attempts',outbox.attempts,'applied_at',outbox.applied_at,'pushed_at',outbox.pushed_at,
      'error_code',CASE WHEN outbox.last_error=ANY($6::text[]) THEN outbox.last_error END,
      'application_state',CASE WHEN outbox.applied_at IS NOT NULL THEN 'applied'
        WHEN outbox.apply_token IS NOT NULL AND outbox.apply_lease_until>now() THEN 'applying'
        WHEN outbox.apply_error IS NOT NULL THEN 'error' ELSE 'pending' END,
      'application_error_code',CASE WHEN outbox.apply_error='context_runtime_verification_failed' THEN outbox.apply_error END),'{}'::jsonb
  FROM agent_context_outbox outbox JOIN agent_context_versions version USING(company_id,tenant_id,alias,version)
  WHERE outbox.company_id=$1 AND ($2::text IS NULL OR outbox.tenant_id=$2)
  UNION ALL
  SELECT 'backup:'||backup.id,backup.created_at,ARRAY['backup:'||backup.id],
    jsonb_build_object('type','backup','id',backup.id::text,'company_id',backup.company_id,
      'tenant_id',backup.tenant_id,'alias',backup.alias,'host_id',backup.host_id,'component','backup',
      'state',backup.status,'error_code',backup.error,'bytes',backup.bytes,'expires_at',backup.expires_at),'{}'::jsonb
  FROM space_backups backup
  WHERE backup.company_id=$1 AND ($2::text IS NULL OR backup.tenant_id=$2)
)
SELECT node_key,at,refs,data,metadata FROM nodes WHERE refs && $3::text[] AND NOT node_key=ANY($4::text[])
  AND (data->>'type'<>'delivery' OR EXISTS(SELECT 1 FROM unnest(refs) reference
    WHERE reference NOT LIKE 'context:%' AND reference=ANY($3::text[])))
ORDER BY at,node_key LIMIT $5`;

async function chain(client: DatabaseClient, authority: CompanyAuthority, id: string): Promise<Record<string, unknown>> {
  if (authority.scope !== 'company' && authority.scope !== 'platform' && authority.scope !== 'tenant') {
    throw new AuthorizationError();
  }
  const read = await client.query<{ allowed: boolean }>(`SELECT EXISTS(SELECT 1 FROM memberships member
    JOIN role_policies policy ON policy.role=member.role WHERE member.tenant_id=$1 AND member.alias=$2
      AND member.enabled AND member.retired_at IS NULL AND policy.allow_read) AS allowed`, [authority.homeTenant, authority.alias]);
  if (read.rows[0]?.allowed !== true) throw new AuthorizationError();
  const tenant = authority.scope === 'tenant' ? authority.homeTenant : null;
  let frontier = ['trace', 'operation', 'session', 'delivery', 'backup', 'message'].map(type => `${type}:${id}`);
  const known = new Set(frontier); const nodes = new Map<string, ChainRow>();
  let truncated = false;
  for (let round = 0; round < MAX_ROUNDS && frontier.length > 0; round += 1) {
    const available = MAX_ITEMS - nodes.size;
    const result = await client.query<ChainRow>(CHAIN_QUERY,
      [authority.actingCompany, tenant, frontier, [...nodes.keys()], available + 1, SYNC_ERRORS,
        FleetErrorSchema.shape.code.options, FleetStepNameSchema.options]);
    if (result.rows.length > available) truncated = true;
    const matched = new Set(frontier); frontier = [];
    for (const row of result.rows.slice(0, available)) {
      nodes.set(row.node_key, row);
      if (row.data.type === 'context' || !row.refs.some(reference => !reference.startsWith('context:') && matched.has(reference))) continue;
      for (const reference of row.refs) {
        if (reference.length > 600 || known.has(reference)) continue;
        known.add(reference); frontier.push(reference);
      }
    }
    if (truncated) break;
    if (round === MAX_ROUNDS - 1 && frontier.length > 0) truncated = true;
  }
  if (nodes.size === 0) throw new StoreError('not_found', 'diagnostic chain is unavailable');
  const ordered = [...nodes.values()].sort((left, right) => left.at.getTime() - right.at.getTime()
    || left.data.type.localeCompare(right.data.type) || left.data.id.localeCompare(right.data.id));
  return { id, company_id: authority.actingCompany, items: ordered.map(row => ({ ...row.data, at: row.at.toISOString(),
    ...(row.data.type === 'audit' ? { summary: safeAuditSummary(row.data.action, row.metadata) } : {}) })), truncated };
}

export function registerDiagnoseRoute(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  // A wildcard accepts protocol traces beyond the router's parameter limit; the handler caps their length.
  app.get<{ Params: { '*': string } }>('/v3/console/diagnose/*', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let access: Awaited<ReturnType<typeof consoleHumanAccess>>;
    try {
      access = await consoleHumanAccess(provider, request, reply, 'read');
      if (access === undefined) throw new AuthorizationError('a console session is required');
      const id = request.params['*'];
      if (id.length === 0 || id.length > 256 || id === '.' || id === '..'
        || Array.from(id).some(character => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })
        || Object.keys(request.query as object).length !== 0) {
        throw new StoreError('invalid_input', 'diagnostic identifier is invalid');
      }
      const authorized = access;
      const work = async (client: DatabaseClient) => {
        await authorized.options.humanAuthority(client);
        return chain(client, await authorized.companyAuthority(client), id);
      };
      return await withAbortableTransaction(pool, authorized.options.signal, work);
    } catch (error) { replyError(reply, error); }
    finally { access?.close(); }
  });
}
