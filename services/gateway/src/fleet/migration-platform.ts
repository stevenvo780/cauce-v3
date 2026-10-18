import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AliasSchema, FleetOperationRequestSchema, FleetTargetSchema, TenantSchema, sha256Hex } from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, ConfigurationRepository, ContextVersionStore, FleetOperationError, StoreError,
  assertPlatformAdmin, canonicalProfileRuntimeContract, companyRevision, createPool, lockCompanyAuthority,
  lockContextTarget, lockFleetRevision, withTransaction, type CompanyAuthoritySource, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { configuredFleetCapability } from '../console/fleet-capability.js';
import { configuredFleetGateway } from './gateway-config.js';
import { HostCapabilityRegistry } from './host-channel.capabilities.js';
import { bindHumanPrincipal } from '../auth.js';
import { prepareConsolePublishOperation, confirmConsolePublishOperation } from '../console-publish-operation.js';
import { ConsolePublishTelemetry } from '../console-publish-telemetry.js';
import { publishOperation } from '../publish-operation.js';
import { BootstrapRecordSchema } from './bootstrap-contracts.js';
import { bootstrapProfileDocuments } from './bootstrap-profile.js';

const Packet = z.object({ human_id: z.uuid(), company: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  tenant: TenantSchema.nullable(), method: z.enum(['GET', 'POST']), path: z.string().max(512), payload: z.unknown() }).strict();
const Fields = ['harness_id', 'display_name', 'enabled', 'runtime_key', 'primary_room_id', 'host_id', 'runtime_mode',
  'container_name', 'runtime_user', 'home_directory', 'state_directory', 'systemd_user', 'primary_account_id',
  'model_id', 'reasoning_effort', 'lifecycle_state', 'retired_at'] as const;
type Row = Record<string, unknown>;

function conflict(message: string): never { throw new StoreError('conflict', message); }
function record(value: unknown): Row { return z.record(z.string(), z.unknown()).parse(value); }
function identity(row: Row, tenant: string | null): { tenant_id: string; alias: string } {
  const result = { tenant_id: TenantSchema.parse(row.tenant_id), alias: AliasSchema.parse(row.alias) };
  if (tenant !== null && result.tenant_id !== tenant) throw new StoreError('forbidden', 'migration target is outside the selected tenant');
  return result;
}
function comparable(row: Row): Row { return Object.fromEntries(Fields.map(field => [field, row[field] ?? null])); }

async function removeCreatedLegacyProfile(client: DatabaseClient, company: string, target: { tenant_id: string; alias: string },
  checkpoint: string, runtimeKey: unknown): Promise<boolean> {
  const deleted = await client.query(`DELETE FROM agent_profiles profile USING fleet_operations operation,
    audit_events marker,fleet_operation_events prepared_event,config_revisions prepared
    WHERE profile.tenant_id=$1 AND profile.alias=$2 AND profile.revision=1
      AND profile.purpose='Agente '||COALESCE(operation.request->'parameters'->>'display_name',operation.target->>'alias')
      AND profile.role_summary IS NULL AND profile.human_brief IS NULL
      AND profile.responsibilities='{}'::text[] AND profile.restrictions='{}'::text[]
      AND profile.tools='{}'::text[] AND profile.operating_rules='{}'::text[]
      AND operation.company_id=$3 AND operation.kind='create' AND operation.target->>'tenant_id'=$1
      AND operation.target->>'alias'=$2 AND operation.request->'parameters'->>'runtime_key'=$5
      AND marker.action='fleet.migration.preserve_legacy' AND marker.decision='allow' AND marker.company_id=$3
      AND marker.tenant_id=operation.actor_tenant AND marker.actor_alias=operation.actor_alias
      AND marker.metadata->>'kind'='create' AND marker.metadata->>'idempotency_key'=operation.idempotency_key
      AND marker.metadata->'target'=operation.target AND marker.metadata->>'checkpoint_revision'=$4
      AND marker.metadata->>'runtime_key'=$5
      AND marker.metadata->>'host_id'=operation.request->'parameters'->'placement'->>'host_id'
      AND EXISTS(SELECT 1 FROM fleet_operation_events queued WHERE queued.operation_id=operation.id AND queued.event='queued'
        AND queued.metadata->>'actor_subject'='console:'||marker.actor_human_id::text)
      AND prepared_event.operation_id=operation.id AND prepared_event.event='step_completed'
      AND prepared_event.metadata->>'step'='prepare' AND prepared.id::text=prepared_event.metadata->>'prepared_revision'
      AND prepared.company_id=$3 AND prepared.operation->>'resource'='fleet_operation'
      AND prepared.operation->>'action'='prepare' AND prepared.operation->>'operation_id'=operation.id::text
      AND profile.created_at=prepared.created_at`, [target.tenant_id, target.alias, company, checkpoint, runtimeKey]);
  return deleted.rowCount === 1;
}

async function legacyMutation(pool: DatabasePool, source: CompanyAuthoritySource, packet: z.infer<typeof Packet>, restore: boolean) {
  const input = record(packet.payload); const original = record(input.original);
  const target = identity(original, packet.tenant);
  if (original.runtime_mode != null || original.retired_at != null) conflict('migration source is not an active legacy registry row');
  return withTransaction(pool, async client => {
    await lockFleetRevision(client);
    const authority = await source(client); assertPlatformAdmin(authority);
    const revision = await companyRevision(client, authority.actingCompany);
    if (input.expected_revision !== revision) conflict('legacy migration revision changed');
    await lockContextTarget(client, { company_id: packet.company, ...target });
    const current = (await client.query<Row>(`SELECT * FROM agents WHERE tenant_id=$1 AND alias=$2
      AND company_id=$3 AND purged_at IS NULL FOR UPDATE`, [target.tenant_id, target.alias, packet.company])).rows[0];
    if (!current) throw new StoreError('not_found', 'legacy migration target was not found');
    if ((await client.query(`SELECT 1 FROM fleet_operations WHERE target->>'tenant_id'=$1 AND target->>'alias'=$2
      AND company_id=$3 AND status NOT IN ('succeeded','failed','cancelled')`, [target.tenant_id, target.alias, packet.company])).rowCount) {
      conflict('legacy metadata cannot change while a fleet operation is unresolved');
    }
    if (!restore && sha256Hex(comparable(current)) !== sha256Hex(comparable(original))) conflict('legacy migration source changed');
    if (restore && current.runtime_mode != null) {
      const placed = record(input.target); const placement = record(placed.placement);
      if (current.runtime_key !== placed.runtime_key || current.host_id !== placement.host_id
          || current.container_name !== placement.container_name || current.enabled === true
          || !['retired', 'draft', 'failed'].includes(String(current.lifecycle_state))) conflict('legacy rollback destination changed or remains active');
    }
    const profileState = (await client.query<Row>('SELECT revision,applied_revision FROM agent_profiles WHERE tenant_id=$1 AND alias=$2 FOR UPDATE',
      [target.tenant_id, target.alias])).rows[0];
    const expectation = (await client.query<Row>('SELECT revision,generation,documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2',
      [target.tenant_id, target.alias])).rows[0];
    const contextScope = [packet.company, target.tenant_id, target.alias];
    const contextState = (await client.query<Row>(`SELECT desired_version,applied_version,applied_digest,applied_at
      FROM agent_context_state WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 FOR UPDATE`, contextScope)).rows[0];
    const contextOutbox = contextState === undefined ? undefined : (await client.query<Row>(`SELECT applied_at,apply_error
      FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 FOR UPDATE`,
    [...contextScope, contextState.desired_version])).rows[0];
    const legacyContext = { profile_revision: profileState?.revision ?? null, applied_revision: profileState?.applied_revision ?? null,
      expectation: expectation ?? null, context_state: contextState ?? null, context_outbox: contextOutbox ?? null };
    let profileAbsenceRestored = false;
    if (restore) {
      const saved = (await client.query<{ id: string; baseline: Row }>(`SELECT id::text,operation->'legacy_context' AS baseline FROM config_revisions
        WHERE company_id=$1 AND operation->>'resource'='fleet_migration' AND operation->>'action'='prepare_legacy'
          AND operation->'target'=$2::jsonb AND operation->'before'=$3::jsonb ORDER BY id DESC LIMIT 1`,
      [packet.company, JSON.stringify(target), JSON.stringify(comparable(original))])).rows[0];
      if (saved === undefined) conflict('legacy migration checkpoint is unavailable');
      const checkpoint = saved.baseline;
      if (checkpoint.profile_revision === null && profileState !== undefined) {
        await client.query("SELECT set_config('cauce.actor_tenant',$1,true),set_config('cauce.actor_alias',$2,true)",
          [authority.homeTenant, authority.alias]);
        profileAbsenceRestored = await removeCreatedLegacyProfile(client, packet.company, target, saved.id, current.runtime_key);
        if (!profileAbsenceRestored) conflict('legacy profile changed after its migration checkpoint');
      } else if (checkpoint.profile_revision !== (profileState?.revision ?? null)) conflict('legacy profile changed after its migration checkpoint');
      const state = checkpoint.context_state === null ? null : record(checkpoint.context_state);
      if (state === null ? Number(contextState?.desired_version ?? 0) > 0 : state.desired_version !== contextState?.desired_version) {
        conflict('legacy desired context version changed after its migration checkpoint');
      }
      if (contextState) await client.query(`UPDATE agent_context_state SET applied_version=$4,applied_digest=$5,applied_at=$6
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3`,
      [...contextScope, state?.applied_version ?? 0, state?.applied_digest ?? null, state?.applied_at ?? null]);
      if (contextOutbox) {
        const outbox = checkpoint.context_outbox === null ? {} : record(checkpoint.context_outbox);
        await client.query(`UPDATE agent_context_outbox SET applied_at=$5,apply_error=$6
          WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`,
        [...contextScope, contextState?.desired_version, outbox.applied_at ?? null, outbox.apply_error ?? null]);
      }
      if (profileState && !profileAbsenceRestored) await client.query('UPDATE agent_profiles SET applied_revision=$3 WHERE tenant_id=$1 AND alias=$2',
        [target.tenant_id, target.alias, checkpoint.applied_revision]);
      if (checkpoint.expectation === null) {
        await client.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
      } else {
        const previous = record(checkpoint.expectation);
        await client.query(`INSERT INTO agent_profile_runtime_expectations(tenant_id,alias,revision,generation,documents)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,alias) DO UPDATE SET revision=EXCLUDED.revision,
          generation=EXCLUDED.generation,documents=EXCLUDED.documents,updated_at=clock_timestamp()`,
        [target.tenant_id, target.alias, previous.revision, previous.generation, JSON.stringify(previous.documents)]);
      }
    }
    const next: Row = restore ? { ...comparable(original), runtime_key: current.runtime_key ?? original.runtime_key ?? null }
      : { ...comparable(current), enabled: false, lifecycle_state: 'draft' };
    if (!restore && input.target !== null && input.target !== undefined) {
      const effort = record(input.target).reasoning_effort;
      if (effort !== undefined) next.reasoning_effort = BootstrapRecordSchema.shape.probe.shape.reasoning_effort.parse(effort);
    }
    if (!restore && next.primary_room_id === null && input.target !== null && input.target !== undefined) {
      const primaryRoom = z.string().min(1).max(128).parse(record(input.target).primary_room_id);
      if (!(await client.query(`SELECT 1 FROM memberships member JOIN role_policies policy ON policy.role=member.role
        JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
        WHERE member.tenant_id=$1 AND member.alias=$2 AND member.room_id=$3 AND member.retired_at IS NULL
          AND member.enabled AND policy.allow_route AND room.enabled AND room.retired_at IS NULL`,
      [target.tenant_id, target.alias, primaryRoom])).rowCount) conflict('selected legacy primary room is unavailable');
      next.primary_room_id = primaryRoom;
    }
    const keys = Fields.filter(field => field !== 'runtime_key' || next.runtime_key !== null);
    const values = keys.map(field => next[field]);
    await client.query(`UPDATE agents SET ${keys.map((field, index) => `${field}=$${String(index + 4)}`).join(',')},
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2 AND company_id=$3`,
    [target.tenant_id, target.alias, packet.company, ...values]);
    if (restore) {
      const members = z.array(z.record(z.string(), z.unknown())).parse(original.memberships);
      await client.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
      for (const member of members) {
        await client.query(`UPDATE memberships SET role=$4,enabled=$5,retired_at=NULL,retired_enabled=NULL
          WHERE tenant_id=$1 AND alias=$2 AND room_id=$3`, [target.tenant_id, target.alias, member.room_id, member.role, member.enabled]);
      }
    }
    const operation = { resource: 'fleet_migration', action: restore ? 'restore_legacy' : 'prepare_legacy', target,
      before: comparable(current), after: next, legacy_context: legacyContext };
    const revisionRow = (await client.query<{ id: string }>(`INSERT INTO config_revisions
      (actor_tenant,actor_alias,operation,inverse_operation,summary,company_id,actor_human_id,platform_override)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8) RETURNING id::text`,
    [authority.homeTenant, authority.alias, JSON.stringify(operation), JSON.stringify({ ...operation, before: next, after: comparable(current) }),
      `fleet migration ${operation.action}`, packet.company, packet.human_id, authority.platformOverride])).rows[0];
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,actor_human_id,company_id,action,decision,metadata)
      VALUES($1,$2,$3,$4,$5,'allow',$6::jsonb)`, [authority.homeTenant, authority.alias, packet.human_id, packet.company,
      `fleet.migration.${operation.action}`, JSON.stringify({ target, revision: Number(revisionRow?.id),
        permanent_runtime_key: next.runtime_key, profile_absence_restored: profileAbsenceRestored,
        before_sha256: sha256Hex(comparable(current)), after_sha256: sha256Hex(next) })]);
    return { ...target, revision: Number(revisionRow?.id), original, row: { ...original, ...next },
      permanent_runtime_key: next.runtime_key, profile_absence_restored: profileAbsenceRestored, restored: restore };
  });
}

async function preserveLegacyAuthority(pool: DatabasePool, source: CompanyAuthoritySource, input: ReturnType<typeof FleetOperationRequestSchema.parse>) {
  if (input.target.resource !== 'agent' || !['create', 'start', 'stop', 'retire'].includes(input.kind)) return;
  const target = input.target;
  await withTransaction(pool, async client => {
    await lockFleetRevision(client); const authority = await source(client); assertPlatformAdmin(authority);
    const agent = (await client.query<Row>('SELECT * FROM agents WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 FOR SHARE',
      [target.tenant_id, target.alias, authority.actingCompany])).rows[0];
    if (!agent) return;
    let previous: { id: string | null; checkpoint: string; runtime_key: string; host_id: string } | undefined;
    if (input.kind === 'create' && agent.runtime_mode === null && agent.enabled === false && agent.lifecycle_state === 'draft') {
      const checkpoint = (await client.query<{ id: string }>(`SELECT id::text FROM config_revisions
        WHERE company_id=$1 AND id<=$2 AND operation->>'resource'='fleet_migration' AND operation->>'action'='prepare_legacy'
          AND operation->'target'->>'tenant_id'=$3 AND operation->'target'->>'alias'=$4 AND operation->'after'=$5::jsonb
          AND operation->'before'->'runtime_mode'='null'::jsonb ORDER BY id DESC LIMIT 1`,
      [authority.actingCompany, input.expected_revision, target.tenant_id, target.alias, JSON.stringify(comparable(agent))])).rows[0];
      if (checkpoint) previous = { id: null, checkpoint: checkpoint.id,
        runtime_key: input.parameters.runtime_key, host_id: input.parameters.placement.host_id };
    } else if (input.kind !== 'create') {
      previous = (await client.query<{ id: string; checkpoint: string; runtime_key: string; host_id: string }>(`SELECT operation.id,
        marker.metadata->>'checkpoint_revision' AS checkpoint,operation.request->'parameters'->>'runtime_key' AS runtime_key,
        operation.request->'parameters'->'placement'->>'host_id' AS host_id FROM fleet_operations operation
        JOIN audit_events marker ON marker.action='fleet.migration.preserve_legacy' AND marker.company_id=operation.company_id
          AND marker.metadata->>'kind'='create' AND marker.metadata->>'idempotency_key'=operation.idempotency_key
          AND marker.metadata->'target'=operation.target AND marker.tenant_id=operation.actor_tenant AND marker.actor_alias=operation.actor_alias
        JOIN fleet_operation_events queued ON queued.operation_id=operation.id AND queued.event='queued'
          AND queued.metadata->>'actor_subject'='console:'||marker.actor_human_id::text
        WHERE operation.company_id=$1 AND operation.target=$2::jsonb AND operation.kind='create'
          AND operation.request->'parameters'->>'runtime_key'=$3 AND operation.request->'parameters'->'placement'->>'host_id'=$4
        ORDER BY operation.created_at DESC LIMIT 1`,
      [authority.actingCompany, JSON.stringify(input.target), agent.runtime_key, agent.host_id])).rows[0];
    }
    if (!previous) return;
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,actor_human_id,company_id,action,decision,metadata)
      VALUES($1,$2,$3,$4,'fleet.migration.preserve_legacy','allow',$5::jsonb)`,
    [authority.homeTenant, authority.alias, authority.humanId, authority.actingCompany,
      JSON.stringify({ idempotency_key: input.idempotency_key, kind: input.kind, target: input.target, create_operation_id: previous.id,
        checkpoint_revision: previous.checkpoint, runtime_key: previous.runtime_key, host_id: previous.host_id })]);
  });
}

async function profile(pool: DatabasePool, tenant: string, alias: string) {
  const repository = new CauceRepository(pool);
  const stored = await new AgentProfileRepository(pool).readContextWithPresence(tenant, alias);
  const row = (await pool.query<Row>('SELECT revision,generation,documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2',
    [tenant, alias])).rows[0];
  const contract = row === undefined ? undefined : canonicalProfileRuntimeContract({ ...row, revision: Number(row.revision) });
  const adoption = contract === undefined ? undefined : await repository.readProfileRuntimeAdoption(tenant, alias, contract);
  const bootstrap = (await pool.query<{ operation_id: string; record: unknown; agent: Row }>(`SELECT operation.id AS operation_id,
    event.metadata->'bootstrap_probe' AS record,to_jsonb(agent) AS agent FROM fleet_operation_events event
    JOIN fleet_operations operation ON operation.id=event.operation_id
    JOIN agents agent ON agent.tenant_id=operation.target->>'tenant_id' AND agent.alias=operation.target->>'alias'
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND operation.status='succeeded'
      AND event.metadata->'bootstrap_probe'->'probe'->>'phase'='normal'
      AND event.metadata->'bootstrap_probe'->>'state'='succeeded' ORDER BY event.id DESC LIMIT 1`, [tenant, alias])).rows[0];
  const parsed = BootstrapRecordSchema.safeParse(bootstrap?.record);
  let bootstrapVerification: Row | null = null;
  if (bootstrap && parsed.success && stored.revision !== null) {
    const { probe, proof } = parsed.data; const agent = bootstrap.agent;
    const valid = probe.operation_id === bootstrap.operation_id && probe.tenant_id === tenant && probe.alias === alias
      && probe.profile_revision === stored.revision && probe.runtime_key === agent.runtime_key && probe.harness_id === agent.harness_id
      && probe.account_id === agent.primary_account_id && probe.model_id === agent.model_id
      && (probe.reasoning_effort ?? null) === (agent.reasoning_effort ?? null)
      && proof?.harness_started === true && proof.reply === `CAUCE_BOOTSTRAP_${probe.nonce}`
      && sha256Hex(proof.documents) === sha256Hex(probe.documents)
      && sha256Hex(probe.documents) === sha256Hex(bootstrapProfileDocuments(stored.contexto, stored.revision));
    if (valid) bootstrapVerification = { verified: true, evidence: 'fleet_bootstrap_normal', operation_id: bootstrap.operation_id,
      profile_revision: probe.profile_revision, documents: probe.documents };
  }
  return { revision: stored.revision, applied_revision: stored.applied_revision,
    bootstrap_verification: bootstrapVerification,
    runtime_state: adoption && stored.revision === stored.applied_revision ? 'applied' : 'pending_session_refresh',
    runtime_adoption: adoption ?? null, runtime_verification: contract === undefined ? null : {
      state: adoption ? 'current' : 'unverified', revision: contract.revision, generation: contract.generation,
      documents: contract.documents.map(document => ({ ...document, current: adoption !== undefined })),
    } };
}

async function migrationMessageAccess(pool: DatabasePool, source: CompanyAuthoritySource) {
  const resolve = async (client: DatabaseClient) => {
    const authority = await source(client); assertPlatformAdmin(authority);
    const actor = (await client.query<{ tenant_id: string; alias: string; room_id: string }>(`SELECT member.tenant_id,member.alias,member.room_id
      FROM memberships member JOIN role_policies policy ON policy.role=member.role
      JOIN tenants tenant ON tenant.id=member.tenant_id
      JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
      JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
      WHERE tenant.company_id=$1 AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
        AND (($2::boolean AND tenant.id=$3 AND member.alias=$4) OR (NOT $2::boolean AND tenant.is_hub))
        AND member.enabled AND member.retired_at IS NULL AND policy.allow_route AND policy.allow_read
        AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
        AND agent.enabled AND agent.retired_at IS NULL AND agent.purged_at IS NULL
      ORDER BY member.tenant_id,member.alias,member.room_id LIMIT 1 FOR SHARE OF member,policy,tenant,room,agent`,
    [authority.actingCompany, authority.homeCompany === authority.actingCompany, authority.homeTenant, authority.alias])).rows[0];
    if (!actor) conflict('the selected company has no active migration routing actor');
    return actor;
  };
  const routing = await withTransaction(pool, resolve);
  const humanAccess = { signal: AbortSignal.timeout(30_000), humanAuthority: async (client: DatabaseClient) => {
    const current = await resolve(client);
    if (current.tenant_id !== routing.tenant_id || current.alias !== routing.alias || current.room_id !== routing.room_id) {
      conflict('migration routing authority changed');
    }
    const authority = await source(client);
    if (authority.humanId === null) throw new StoreError('forbidden', 'migration human authority is unavailable');
    return { humanId: authority.humanId, tenantId: routing.tenant_id, actorAlias: routing.alias };
  } };
  return { routing, humanAccess };
}

export async function migrationPlatformRequest(pool: DatabasePool, raw: unknown): Promise<unknown> {
  const packet = Packet.parse(raw);
  let selectedIdentity: ReturnType<typeof identity> | undefined;
  const account = (await pool.query<{ tenant_id: string; alias: string }>(
    'SELECT tenant_id,alias FROM console_users WHERE id=$1 AND active', [packet.human_id])).rows[0];
  if (!account) throw new StoreError('forbidden', 'platform administrator is unavailable');
  const source: CompanyAuthoritySource = async (client: DatabaseClient) => {
    if (selectedIdentity) await lockFleetRevision(client);
    const authority = await lockCompanyAuthority(client, { tenant: account.tenant_id, alias: account.alias,
      humanId: packet.human_id, requestedCompany: packet.company });
    assertPlatformAdmin(authority);
    if (authority.actingCompany !== packet.company) throw new StoreError('forbidden', 'migration company authority changed');
    if (packet.tenant !== null && !(await client.query('SELECT 1 FROM tenants WHERE id=$1 AND company_id=$2',
      [packet.tenant, packet.company])).rowCount) throw new StoreError('forbidden', 'migration tenant belongs to another company');
    if (selectedIdentity && !(await client.query(`SELECT 1 FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
      WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.company_id=$3 AND tenant.company_id=$3
        AND agent.purged_at IS NULL AND tenant.purged_at IS NULL FOR SHARE OF agent,tenant`,
    [selectedIdentity.tenant_id, selectedIdentity.alias, packet.company])).rowCount) {
      throw new StoreError('not_found', 'migration target is not registered in the selected company');
    }
    return authority;
  };
  await withTransaction(pool, source);
  const { method, path, payload } = packet;
  if (method === 'GET' && path === '/v3/console/config') return new ConfigurationRepository(pool).get(account.tenant_id, account.alias, source);
  if (method === 'POST' && path === '/internal/migration/prepare-legacy') return legacyMutation(pool, source, packet, false);
  if (method === 'POST' && path === '/internal/migration/restore-legacy') return legacyMutation(pool, source, packet, true);
  const capability = configuredFleetCapability(); const registry = new HostCapabilityRegistry(pool);
  if (method === 'GET' && path === '/v3/console/fleet/capability') return registry.fleet(packet.company, capability);
  const configured = await configuredFleetGateway(pool, capability, process.env, { hostCapabilityRegistry: registry });
  const fleet = configured.fleetOperationsRepository?.forAuthority?.(source);
  const operations = '/v3/console/fleet/operations'; const parsedPath = new URL(path, 'http://internal.invalid');
  const subject = `console:${packet.human_id}`;
  if (parsedPath.pathname.startsWith(operations)) {
    if (!fleet) conflict('fleet executor is unavailable');
    if (method === 'POST' && (path === operations || path === `${operations}/preview`)) {
      const request = FleetOperationRequestSchema.parse(payload); selectedIdentity = identity(request.target, packet.tenant);
      if (path.endsWith('/preview')) return fleet.preview(account.tenant_id, account.alias, request, subject);
      await preserveLegacyAuthority(pool, source, request);
      const operation = record(await fleet.enqueue(account.tenant_id, account.alias, request, subject));
      return { operation_id: operation.id, status: operation.status, operation };
    }
    if (method === 'GET' && parsedPath.pathname === operations) {
      const target = FleetTargetSchema.parse(Object.fromEntries(parsedPath.searchParams)); selectedIdentity = identity(target, packet.tenant);
      if (!fleet.list) conflict('fleet history is unavailable');
      return { operations: await fleet.list(account.tenant_id, account.alias, target, subject) };
    }
    const match = new RegExp(`^${operations}/([a-f0-9-]{36})(/cancel)?$`, 'u').exec(path);
    if (match?.[1]) {
      const operation = record(await fleet.get(account.tenant_id, account.alias, match[1], subject));
      selectedIdentity = identity(record(operation.target), packet.tenant);
      if (method === 'GET' && !match[2]) { await withTransaction(pool, source); return operation; }
      if (method === 'POST' && match[2]) return fleet.cancel(account.tenant_id, account.alias, match[1],
        z.number().int().nonnegative().parse(record(payload).expected_version), subject);
    }
  }
  const agentPath = /^\/v3\/console\/tenants\/([^/]+)\/agents\/([^/]+)\/perfil$/u.exec(path);
  const contextPath = /^\/v3\/console\/context\/agents\/([^/]+)\/([^/]+)$/u.exec(path);
  const selected = agentPath ?? contextPath;
  if (method === 'GET' && selected?.[1] && selected[2]) {
    const target = identity({ tenant_id: decodeURIComponent(selected[1]), alias: decodeURIComponent(selected[2]) }, packet.tenant);
    await new ContextVersionStore(pool).read(source, target.tenant_id, target.alias);
    return agentPath ? profile(pool, target.tenant_id, target.alias) : new ContextVersionStore(pool).read(source, target.tenant_id, target.alias);
  }
  if (method === 'POST' && path === '/internal/migration/nonce') {
    const input = record(payload); const target = identity(input, packet.tenant);
    selectedIdentity = target;
    await new ContextVersionStore(pool).read(source, target.tenant_id, target.alias);
    const nonce = z.string().regex(/^CAUCE_MOVE_[a-f0-9]{32}$/u).parse(input.nonce);
    const { routing, humanAccess } = await migrationMessageAccess(pool, source);
    const actor = bindHumanPrincipal({ tenant_id: routing.tenant_id, alias: routing.alias, session_id: 'platform-migration',
      channel: 'console', roles: ['operator'], permissions: ['route', 'read', 'control'], operator_id: `console:${packet.human_id}`,
      operator_profile: { id: `console:${packet.human_id}`, display_name: account.alias } }, packet.human_id);
    const command = { room_id: routing.room_id, recipients: [target], body: { text: `Reply with exactly this nonce and no other text: ${nonce}` },
      lane: 'interactive', priority: 0 };
    const repository = new CauceRepository(pool); const telemetry = new ConsolePublishTelemetry();
    const common = { actor, humanAccess, priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined };
    const prepared = await prepareConsolePublishOperation(repository,
      { ...common, body: { ...command, intent_nonce: randomUUID() }, interactiveHumanEntry: true }, telemetry);
    const receipt = prepared.state === 'committed' ? prepared.receipt : await publishOperation(repository,
      { ...common, body: { ...command, idempotency_key: prepared.idempotency_key }, entry: 'console', authMechanism: 'internal-platform' });
    await confirmConsolePublishOperation(repository, { actor, humanAccess,
      body: { idempotency_key: receipt.idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash } }, telemetry);
    return receipt;
  }
  const message = /^\/v3\/console\/messages\/([a-f0-9-]{36})$/u.exec(path);
  if (method === 'GET' && message?.[1]) {
    const { humanAccess } = await migrationMessageAccess(pool, source);
    return new CauceRepository(pool).getHumanMessage(message[1], humanAccess);
  }
  throw new StoreError('not_found', 'internal migration command is unavailable');
}

export async function runMigrationPlatformCommand(): Promise<void> {
  let pool: DatabasePool | undefined;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const raw of process.stdin) { const chunk = Buffer.from(raw as Uint8Array); size += chunk.length;
      if (size > 524_288) throw new Error('migration request is too large'); chunks.push(chunk); }
    if (!process.env.DATABASE_URL) throw new Error('gateway database configuration is unavailable');
    pool = createPool(process.env.DATABASE_URL, { max: 4, applicationName: 'cauce-platform-migration' });
    const body = await migrationPlatformRequest(pool, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    process.stdout.write(JSON.stringify({ status: 200, body }));
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : error instanceof StoreError || error instanceof FleetOperationError
      ? error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 409 : 500;
    const details = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
    const diagnostic = {
      ...(typeof details.code === 'string' && /^[A-Z0-9]{5}$/u.test(details.code) ? { sqlstate: details.code } : {}),
      ...(typeof details.constraint === 'string' && /^[a-zA-Z0-9_]{1,128}$/u.test(details.constraint) ? { constraint: details.constraint } : {}),
      ...(error instanceof Error && /^[a-zA-Z0-9_]{1,64}$/u.test(error.name) ? { type: error.name } : {}),
    };
    process.stdout.write(JSON.stringify({ status, body: { error: 'migration_request_unverified', diagnostic,
      ...(error instanceof StoreError || error instanceof FleetOperationError ? { message: error.message } : {}) } }));
  } finally { await pool?.end(); }
}
