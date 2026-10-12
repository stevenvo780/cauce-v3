import type { FastifyInstance } from 'fastify';
import { FleetErrorSchema, FleetStepNameSchema } from '@cauce/protocol';
import { safeAuditSummary, StoreError, withAbortableTransaction, type CompanyAuthority, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { replyError } from '../shared.js';

const MAX_ITEMS = 500;
const MAX_ROUNDS = 8;
const MAX_CONCURRENT_PER_HUMAN = 2;
const UUID_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const UUID_REFERENCE_TYPES = new Set(['message', 'delivery', 'session', 'operation', 'backup']);
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
const CHAIN_QUERY = `WITH context_refs AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS value(tenant text,alias text,version bigint)
), audit_candidates AS MATERIALIZED (
  SELECT audit.id FROM audit_events audit WHERE audit.id=ANY($9::bigint[])
  UNION
  SELECT audit.id FROM audit_events audit WHERE audit.trace_id=ANY($10::text[])
  UNION
  SELECT audit.id FROM audit_events audit WHERE audit.message_id=ANY($11::uuid[])
  UNION
  SELECT audit.id FROM audit_events audit WHERE audit.delivery_id=ANY($12::uuid[])
  UNION
  SELECT audit.id FROM audit_events audit WHERE audit.metadata @> ANY($17::jsonb[])
  UNION
  SELECT audit.id FROM audit_events audit WHERE audit.action LIKE 'space.backup.%'
    AND audit.metadata->>'id'=ANY(($16::uuid[])::text[])
  UNION
  SELECT audit.id FROM context_refs context JOIN LATERAL (SELECT audit.id FROM audit_events audit
    WHERE COALESCE(audit.metadata->>'target_tenant',audit.tenant_id)=context.tenant
      AND COALESCE(audit.metadata->>'target_alias',audit.actor_alias)=context.alias
      AND audit.metadata->>'version'=context.version::text
      AND audit.action IN ('context.version','context.sync') OFFSET 0) audit ON true
), delivery_candidates AS MATERIALIZED (
  SELECT delivery.id FROM deliveries delivery WHERE delivery.id=ANY($12::uuid[])
  UNION
  SELECT delivery.id FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
    JOIN tenants source ON source.id=message.tenant_id
  WHERE delivery.message_id=ANY($11::uuid[]) AND source.company_id=$1
    AND ($2::text IS NULL OR message.tenant_id=$2)
  UNION
  SELECT delivery.id FROM messages message JOIN tenants source ON source.id=message.tenant_id
    JOIN deliveries delivery ON delivery.message_id=message.id
  WHERE message.trace_id=ANY($10::text[]) AND source.company_id=$1
    AND ($2::text IS NULL OR message.tenant_id=$2)
), nodes AS (
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
  FROM audit_candidates candidate JOIN LATERAL (SELECT * FROM audit_events audit WHERE audit.id=candidate.id OFFSET 0) audit ON true
    LEFT JOIN tenants tenant ON tenant.id=audit.tenant_id
  WHERE COALESCE(audit.company_id,tenant.company_id)=$1 AND ($2::text IS NULL OR audit.tenant_id=$2)
  UNION ALL
  SELECT 'message:'||message.id,message.created_at,ARRAY['message:'||message.id,'trace:'||message.trace_id],
    jsonb_build_object('type','message','id',message.id::text,'company_id',tenant.company_id,
      'tenant_id',message.tenant_id,'alias',message.actor_alias,'host_id',NULL,'component','delivery',
      'request_id',message.request_id,'trace_id',message.trace_id),'{}'::jsonb
  FROM messages message JOIN tenants tenant ON tenant.id=message.tenant_id
  WHERE tenant.company_id=$1 AND ($2::text IS NULL OR message.tenant_id=$2)
    AND (message.id=ANY($11::uuid[]) OR message.trace_id=ANY($10::text[]))
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
  FROM delivery_candidates candidate JOIN LATERAL (SELECT * FROM deliveries delivery WHERE delivery.id=candidate.id OFFSET 0) delivery ON true
    JOIN tenants tenant ON tenant.id=delivery.recipient_tenant
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
    AND (session.id=ANY($13::uuid[]) OR session.trace_id=ANY($10::text[]))
  UNION ALL
  SELECT 'operation:'||operation.id,operation.created_at,ARRAY['operation:'||operation.id],
    jsonb_build_object('type','operation','id',operation.id::text,'company_id',operation.company_id,
      'tenant_id',operation.actor_tenant,'alias',operation.actor_alias,'host_id',operation.executor_host,
      'component','fleet','kind',operation.kind,'state',operation.status,
      'error_code',CASE WHEN operation.error->>'code'=ANY($7::text[]) THEN operation.error->>'code' END,
      'step',CASE WHEN operation.error->>'step'=ANY($8::text[]) THEN operation.error->>'step' END),'{}'::jsonb
  FROM fleet_operations operation
  WHERE operation.company_id=$1 AND ($2::text IS NULL OR operation.actor_tenant=$2)
    AND operation.id=ANY($14::uuid[])
  UNION ALL
  SELECT 'operation_event:'||event.id,event.created_at,ARRAY['operation_event:'||event.id,'operation:'||operation.id],
    jsonb_build_object('type','operation_event','id',event.id::text,'company_id',operation.company_id,
      'tenant_id',operation.actor_tenant,'alias',operation.actor_alias,'host_id',operation.executor_host,
      'component','fleet','operation_id',operation.id::text,'action',event.event,'version',event.version::text,
      'error_code',CASE WHEN event.metadata->>'code'=ANY($7::text[]) THEN event.metadata->>'code' END,
      'step',CASE WHEN event.metadata->>'step'=ANY($8::text[]) THEN event.metadata->>'step' END),'{}'::jsonb
  FROM fleet_operation_events event JOIN fleet_operations operation ON operation.id=event.operation_id
  WHERE operation.company_id=$1 AND ($2::text IS NULL OR operation.actor_tenant=$2)
    AND (event.id=ANY($15::bigint[]) OR event.operation_id=ANY($14::uuid[]))
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
      'application_error_code',CASE WHEN outbox.apply_error IN ('context_runtime_verification_failed','native_context_conflict')
        THEN outbox.apply_error END),'{}'::jsonb
  FROM context_refs context JOIN LATERAL (SELECT * FROM agent_context_outbox outbox
    WHERE outbox.company_id=$1 AND outbox.tenant_id=context.tenant AND outbox.alias=context.alias
      AND outbox.version=context.version OFFSET 0) outbox ON true
    JOIN LATERAL (SELECT * FROM agent_context_versions version WHERE version.company_id=outbox.company_id
      AND version.tenant_id=outbox.tenant_id AND version.alias=outbox.alias AND version.version=outbox.version OFFSET 0) version ON true
  WHERE outbox.company_id=$1 AND ($2::text IS NULL OR outbox.tenant_id=$2)
  UNION ALL
  SELECT 'backup:'||backup.id,backup.created_at,ARRAY['backup:'||backup.id],
    jsonb_build_object('type','backup','id',backup.id::text,'company_id',backup.company_id,
      'tenant_id',backup.tenant_id,'alias',backup.alias,'host_id',backup.host_id,'component','backup',
      'state',backup.status,'error_code',backup.error,'bytes',backup.bytes,'expires_at',backup.expires_at),'{}'::jsonb
  FROM space_backups backup
  WHERE backup.company_id=$1 AND ($2::text IS NULL OR backup.tenant_id=$2) AND backup.id=ANY($16::uuid[])
)
SELECT node_key,at,refs,data,metadata FROM nodes WHERE NOT node_key=ANY($4::text[])
ORDER BY at,data->>'type',CASE WHEN data->>'id' ~ '^[0-9]+$' THEN (data->>'id')::numeric END,data->>'id' LIMIT $5`;

function compareIds(left: string, right: string): number {
  if (!/^[0-9]+$/u.test(left) || !/^[0-9]+$/u.test(right)) return left.localeCompare(right);
  const leftId = BigInt(left); const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function bigintId(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function normalizedReference(reference: string): string {
  const separator = reference.indexOf(':'); const kind = reference.slice(0, separator); const value = reference.slice(separator + 1);
  return UUID_REFERENCE_TYPES.has(kind) && UUID_ID.test(value) ? `${kind}:${value.toLowerCase()}` : reference;
}

function queryFrontier(references: readonly string[]) {
  const ids: { audit: string[]; trace: string[]; message: string[]; delivery: string[]; session: string[]; operation: string[];
    operation_event: string[]; backup: string[] } = { audit: [], trace: [], message: [], delivery: [], session: [], operation: [], operation_event: [], backup: [] };
  const buckets: Partial<Record<string, string[]>> = ids;
  const contexts: { tenant: string; alias: string; version: string }[] = [];
  const receipts: Record<string, string>[] = [];
  for (const reference of references) {
    const separator = reference.indexOf(':'); const kind = reference.slice(0, separator); const value = reference.slice(separator + 1);
    if (kind === 'context') {
      try {
        const parts: unknown = JSON.parse(value);
        if (Array.isArray(parts) && parts.length === 3 && typeof parts[0] === 'string' && typeof parts[1] === 'string'
          && typeof parts[2] === 'string' && bigintId(parts[2])) {
          contexts.push({ tenant: parts[0], alias: parts[1], version: parts[2] });
        }
      } catch { /* Context references can originate in legacy metadata. */ }
      continue;
    }
    const values = buckets[kind];
    if (values === undefined || (kind !== 'trace' && !(kind === 'audit' || kind === 'operation_event' ? bigintId(value)
      : UUID_ID.test(value)))) continue;
    values.push(value);
    if (kind === 'delivery' || kind === 'operation' || kind === 'session' || kind === 'backup') receipts.push({ [`${kind}_id`]: value });
  }
  return { audits: ids.audit, traces: ids.trace, messages: ids.message, deliveries: ids.delivery,
    sessions: ids.session, operations: ids.operation, operation_events: ids.operation_event, backups: ids.backup,
    receipts, contexts };
}

async function chain(client: DatabaseClient, authority: CompanyAuthority, id: string): Promise<Record<string, unknown>> {
  if (authority.scope !== 'company' && authority.scope !== 'platform' && authority.scope !== 'tenant') {
    throw new AuthorizationError();
  }
  const read = await client.query<{ allowed: boolean }>(`SELECT EXISTS(SELECT 1 FROM memberships member
    JOIN role_policies policy ON policy.role=member.role WHERE member.tenant_id=$1 AND member.alias=$2
      AND member.enabled AND member.retired_at IS NULL AND policy.allow_read) AS allowed`, [authority.homeTenant, authority.alias]);
  if (read.rows[0]?.allowed !== true) throw new AuthorizationError();
  const tenant = authority.scope === 'tenant' ? authority.homeTenant : null;
  let frontier = ['trace', 'operation', 'session', 'delivery', 'backup', 'message'].map(type => normalizedReference(`${type}:${id}`));
  const known = new Set(frontier); const nodes = new Map<string, ChainRow>();
  let truncated = false;
  for (let round = 0; round < MAX_ROUNDS && frontier.length > 0; round += 1) {
    const available = MAX_ITEMS - nodes.size;
    const currentFrontier = queryFrontier(frontier);
    const result = await client.query<ChainRow>(CHAIN_QUERY,
      [authority.actingCompany, tenant, JSON.stringify(currentFrontier.contexts), [...nodes.keys()], available + 1, SYNC_ERRORS,
        FleetErrorSchema.shape.code.options, FleetStepNameSchema.options, currentFrontier.audits, currentFrontier.traces,
        currentFrontier.messages, currentFrontier.deliveries, currentFrontier.sessions, currentFrontier.operations,
        currentFrontier.operation_events, currentFrontier.backups, currentFrontier.receipts.map(value => JSON.stringify(value))]);
    if (result.rows.length > available) truncated = true;
    const matched = new Set(frontier); frontier = [];
    for (const row of result.rows.slice(0, available)) {
      nodes.set(row.node_key, row);
      const references = row.refs.map(normalizedReference);
      if (row.data.type === 'context' || !references.some(reference => !reference.startsWith('context:') && matched.has(reference))) continue;
      for (const reference of references) {
        if (reference.length > 600 || known.has(reference)) continue;
        known.add(reference); frontier.push(reference);
      }
    }
    if (truncated) break;
    if (round === MAX_ROUNDS - 1 && frontier.length > 0) truncated = true;
  }
  if (nodes.size === 0) throw new StoreError('not_found', 'diagnostic chain is unavailable');
  const ordered = [...nodes.values()].sort((left, right) => left.at.getTime() - right.at.getTime()
    || left.data.type.localeCompare(right.data.type) || compareIds(left.data.id, right.data.id));
  return { id, company_id: authority.actingCompany, items: ordered.map(row => ({ ...row.data, at: row.at.toISOString(),
    ...(row.data.type === 'audit' ? { summary: safeAuditSummary(row.data.action, row.metadata) } : {}) })), truncated };
}

export function registerDiagnoseRoute(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  const activeByHuman = new Map<string, number>();
  // A wildcard accepts protocol traces beyond the router's parameter limit; the handler caps their length.
  app.get<{ Params: { '*': string } }>('/v3/console/diagnose/*', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let access: Awaited<ReturnType<typeof consoleHumanAccess>>;
    let activeHuman: string | undefined;
    try {
      access = await consoleHumanAccess(provider, request, reply, 'read');
      if (access === undefined) throw new AuthorizationError('a console session is required');
      const id = request.params['*'];
      if (id.length === 0 || id.length > 256 || id === '.' || id === '..'
        || Array.from(id).some(character => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })
        || Object.keys(request.query as object).length !== 0) {
        throw new StoreError('invalid_input', 'diagnostic identifier is invalid');
      }
      const humanId = provider instanceof PasswordAuthProvider ? (await provider.verifiedConsoleSession(request))?.humanId : undefined;
      if (humanId === undefined) throw new AuthorizationError('a console session is required');
      const active = activeByHuman.get(humanId) ?? 0;
      if (active >= MAX_CONCURRENT_PER_HUMAN) {
        return await reply.code(429).header('Retry-After', '1').send({ error: 'diagnose_busy', message: 'too many concurrent diagnostic requests' });
      }
      activeByHuman.set(humanId, active + 1); activeHuman = humanId;
      const authorized = access;
      const work = async (client: DatabaseClient) => {
        await authorized.options.humanAuthority(client);
        return chain(client, await authorized.companyAuthority(client), id);
      };
      return await withAbortableTransaction(pool, authorized.options.signal, work);
    } catch (error) { replyError(reply, error); }
    finally {
      if (activeHuman !== undefined) {
        const remaining = (activeByHuman.get(activeHuman) ?? 1) - 1;
        if (remaining === 0) activeByHuman.delete(activeHuman); else activeByHuman.set(activeHuman, remaining);
      }
      access?.close();
    }
  });
}
