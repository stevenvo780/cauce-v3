import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentProfileRepository, FleetOperationError, loadFleetHostScope, planFleetHostSlices, preparedState, withTransaction,
  type DatabaseClient, type DatabasePool, type FleetOperationRow, type StoredAgentContext } from '@cauce/store';
import {
  BootstrapAckSchema, BootstrapCreateSchema, BootstrapError, BootstrapRecordSchema, bootstrapPrompt,
  type BootstrapAck, type BootstrapCreate, type BootstrapDescriptor, type BootstrapIdentity,
  type BootstrapPhase, type BootstrapReceipt, type BootstrapRecord,
} from './bootstrap-contracts.js';
import { bootstrapProfileDocuments } from './bootstrap-profile.js';

interface Agent extends Record<string, unknown> {
  tenant_id: string; alias: string; runtime_key: string; harness_id: string; model_id: string | null;
  host_id: string; enabled: boolean; lifecycle_state: string; primary_account_id: string; retired_at: Date | null;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
}
interface Operation extends FleetOperationRow { executor_host: string; worker_live: boolean }
interface Context { operation: Operation; agent: Agent; profile: StoredAgentContext & { revision: number } }
const forbidden = () => new BootstrapError('forbidden');
const conflict = () => new BootstrapError('conflict');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = isDeepStrictEqual;

export class BootstrapRepository {
  private readonly profiles: AgentProfileRepository;
  constructor(private readonly pool: DatabasePool) { this.profiles = new AgentProfileRepository(pool); }

  private async context(client: DatabaseClient, identity: BootstrapIdentity, operationId: string, state = false): Promise<Context> {
    await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
    const operation = (await client.query<Operation>(`SELECT *,lease_expires_at>clock_timestamp() AS worker_live
      FROM fleet_operations WHERE id=$1 FOR UPDATE`, [operationId])).rows[0];
    if (operation?.target.resource !== 'agent' || operation.target.tenant_id !== identity.tenant_id
        || operation.target.alias !== identity.alias || !['create', 'update', 'start', 'restore'].includes(operation.kind)) throw forbidden();
    if (!state && (operation.status !== 'running' || operation.cancel_requested || !operation.worker_live
        || !operation.worker_id || !operation.claim_token)) throw conflict();
    const origin = (await client.query<{ subject: string }>(`SELECT metadata->>'actor_subject' AS subject
      FROM fleet_operation_events WHERE operation_id=$1 AND event='queued' ORDER BY id LIMIT 1`, [operationId])).rows[0];
    const match = /^console:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(origin?.subject ?? '');
    if (!match) throw forbidden();
    const human = await client.query(`SELECT 1 FROM console_users person
      JOIN human_tenant_memberships human ON human.human_id=person.id AND human.tenant_id=person.tenant_id AND human.actor_alias=person.alias
      JOIN memberships member ON member.tenant_id=person.tenant_id AND member.alias=person.alias
      JOIN agents actor ON actor.tenant_id=member.tenant_id AND actor.alias=member.alias
      JOIN tenants tenant ON tenant.id=member.tenant_id JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
      JOIN role_policies policy ON policy.role=member.role
      WHERE person.id=$1 AND person.active AND person.role='operator' AND person.tenant_id=$2 AND person.alias=$3
        AND human.enabled AND human.revoked_at IS NULL AND human.role='operator' AND 'control'=ANY(human.permissions)
        AND member.enabled AND tenant.enabled AND room.enabled AND policy.allow_control AND actor.retired_at IS NULL
        AND member.retired_at IS NULL AND tenant.retired_at IS NULL AND room.retired_at IS NULL
        AND ($4=person.tenant_id OR tenant.is_hub)
      FOR SHARE OF person,human,member,actor,tenant,room,policy`, [match[1], operation.actor_tenant, operation.actor_alias, identity.tenant_id]);
    if (!human.rowCount) throw forbidden();
    if (identity.tenant_id !== operation.actor_tenant && !(await client.query(`SELECT 1 FROM acl_edges
      WHERE from_tenant=$1 AND to_tenant=$2 AND enabled AND allow_control AND to_jsonb(acl_edges)->>'retired_at' IS NULL FOR SHARE`,
    [operation.actor_tenant, identity.tenant_id])).rowCount) throw forbidden();
    const agent = (await client.query<Agent>(`SELECT agent.* FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
      JOIN harness_definitions harness ON harness.id=agent.harness_id
      JOIN provider_accounts account ON account.id=agent.primary_account_id
      WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.retired_at IS NULL AND tenant.enabled AND tenant.retired_at IS NULL
        AND harness.enabled AND account.enabled AND (account.payer_tenant_id=agent.tenant_id OR account.shared_with_pool)
      FOR SHARE OF agent,tenant,harness,account`, [identity.tenant_id, identity.alias])).rows[0];
    if (!agent?.runtime_key || (!state && agent.enabled)) throw forbidden();
    await this.hostScope(client, operation, agent);
    if (operation.kind === 'create' || operation.kind === 'update') {
      const desired = operation.request.parameters;
      if (!('runtime_key' in desired) || desired.runtime_key !== agent.runtime_key || desired.harness_id !== agent.harness_id
          || desired.primary_account_id !== agent.primary_account_id || (desired.model_id ?? null) !== agent.model_id
          || (desired.reasoning_effort ?? null) !== (agent.reasoning_effort ?? null)) throw conflict();
    }
    await client.query('SELECT 1 FROM agent_profiles WHERE tenant_id=$1 AND alias=$2 FOR SHARE', [identity.tenant_id, identity.alias]);
    const profile = await this.profiles.readContextWithPresence(identity.tenant_id, identity.alias, client);
    if (!profile.exists || profile.revision === null || !Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new BootstrapError('unverified');
    return { operation, agent, profile: { ...profile, revision: profile.revision } };
  }

  private async hostScope(client: DatabaseClient, operation: Operation, agent: Agent): Promise<void> {
    const prepared = await client.query(`SELECT 1 FROM fleet_operation_events WHERE operation_id=$1
      AND event='step_completed' AND metadata->>'step' IN ('prepare','fence') LIMIT 1`, [operation.id]);
    if (!prepared.rowCount && operation.desired_revision === null && agent.host_id === operation.executor_host) return;
    try {
      const sealed = await loadFleetHostScope(client, operation, agent.host_id);
      const previous = await preparedState(client, operation.id);
      const exact = planFleetHostSlices(operation, sealed.agents, previous.previous_agents);
      if (exact.length !== 1 || exact[0]?.target_sha256 !== sealed.target_sha256 || sealed.targets.length !== 1
          || sealed.targets[0]?.runtime_key !== agent.runtime_key) throw forbidden();
      const selected = sealed.agents.find(value => value.tenant_id === agent.tenant_id && value.alias === agent.alias);
      if (!selected) throw forbidden();
      for (const field of ['runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name', 'runtime_user',
        'home_directory', 'state_directory', 'systemd_user', 'primary_account_id', 'model_id', 'reasoning_effort'] as const) {
        if (selected[field] !== agent[field]) throw forbidden();
      }
    } catch (error) { if (error instanceof FleetOperationError) throw forbidden(); throw error; }
  }

  private async records(client: DatabaseClient, operationId: string): Promise<BootstrapRecord[]> {
    return (await client.query<{ record: unknown }>(`SELECT DISTINCT ON (metadata->'bootstrap_probe'->'probe'->>'probe_id')
      metadata->'bootstrap_probe' AS record FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'
      ORDER BY metadata->'bootstrap_probe'->'probe'->>'probe_id',id DESC`, [operationId])).rows.map(row => BootstrapRecordSchema.parse(row.record));
  }
  private async event(client: DatabaseClient, context: Context, record: BootstrapRecord): Promise<void> {
    const version = (await client.query<{ version: string }>(`UPDATE fleet_operations SET version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND epoch=$2 AND claim_token=$3 AND lease_expires_at>clock_timestamp() AND status='running'
        AND NOT cancel_requested RETURNING version`, [context.operation.id, context.operation.epoch, context.operation.claim_token])).rows[0];
    if (!version) throw conflict();
    await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
      [context.operation.id, version.version, record.state === 'succeeded' ? 'step_completed' : 'step_started', JSON.stringify({ bootstrap_probe: record })]);
  }
  private assertRecord(record: BootstrapRecord, context: Context, phase: BootstrapPhase, active = true): void {
    const probe = record.probe;
    if (probe.phase !== phase || probe.account_id !== context.agent.primary_account_id || probe.runtime_key !== context.agent.runtime_key
        || probe.harness_id !== context.agent.harness_id || probe.model_id !== context.agent.model_id
        || (probe.reasoning_effort ?? null) !== (context.agent.reasoning_effort ?? null)
        || probe.profile_revision !== context.profile.revision || record.epoch !== context.operation.epoch
        || !same(probe.documents, bootstrapProfileDocuments(context.profile.contexto, probe.profile_revision))) throw conflict();
    if (active && (Date.parse(probe.deadline) <= Date.now() || record.worker_id !== context.operation.worker_id
        || record.worker_claim_hash !== digest(context.operation.claim_token ?? ''))) throw conflict();
  }
  async create(identity: BootstrapIdentity, raw: BootstrapCreate): Promise<BootstrapReceipt> {
    const input = BootstrapCreateSchema.parse(raw);
    return withTransaction(this.pool, async client => {
      const context = await this.context(client, identity, input.operation_id);
      if (context.agent.primary_account_id !== input.account_id || context.profile.revision !== input.profile_revision
          || !context.operation.steps.some(step => step.name === (input.phase === 'normal' ? 'admission' : input.action) && step.status === 'running')) throw conflict();
      const records = await this.records(client, input.operation_id);
      const previous = records.find(record => record.probe.nonce === input.nonce);
      if (previous) {
        this.assertRecord(previous, context, input.phase);
        if (!same({ operation_id: previous.probe.operation_id, phase: previous.probe.phase, action: previous.probe.action,
          nonce: previous.probe.nonce, account_id: previous.probe.account_id, profile_revision: previous.probe.profile_revision }, input)) throw conflict();
        return { probe: previous.probe, state: previous.state, proof: previous.proof };
      }
      if (records.some(record => record.probe.phase === input.phase && record.state !== 'succeeded')) throw conflict();
      if (input.phase === 'normal' && (input.action !== 'verify' || !records.some(record => record.probe.phase === 'bootstrap'
          && record.probe.action === 'verify' && record.state === 'succeeded' && record.epoch === context.operation.epoch
          && record.probe.profile_revision === input.profile_revision))) throw conflict();
      const probe: BootstrapDescriptor = { ...input, probe_id: randomUUID(), tenant_id: identity.tenant_id, alias: identity.alias,
        runtime_key: context.agent.runtime_key, harness_id: context.agent.harness_id, model_id: context.agent.model_id,
        ...(context.agent.reasoning_effort == null ? {} : { reasoning_effort: context.agent.reasoning_effort }),
        deadline: new Date(Date.now() + 120_000).toISOString(), prompt: bootstrapPrompt(input.nonce),
        documents: bootstrapProfileDocuments(context.profile.contexto, input.profile_revision) };
      const record: BootstrapRecord = { probe, state: 'pending', proof: null, epoch: context.operation.epoch,
        worker_id: context.operation.worker_id ?? '', worker_claim_hash: digest(context.operation.claim_token ?? '') };
      await this.event(client, context, record); return { probe, state: record.state, proof: null };
    });
  }
  async read(identity: BootstrapIdentity, phase: BootstrapPhase, probeId: string): Promise<BootstrapReceipt> {
    return withTransaction(this.pool, async client => {
      const source = (await client.query<{ operation_id: string }>(`SELECT operation_id FROM fleet_operation_events
        WHERE metadata->'bootstrap_probe'->'probe'->>'probe_id'=$1 AND metadata->'bootstrap_probe'->'probe'->>'tenant_id'=$2
          AND metadata->'bootstrap_probe'->'probe'->>'alias'=$3 LIMIT 1`, [probeId, identity.tenant_id, identity.alias])).rows[0];
      if (!source) throw new BootstrapError('not_found');
      const operationId = source.operation_id;
      const context = await this.context(client, identity, operationId, true);
      const record = (await this.records(client, operationId)).find(record => record.probe.probe_id === probeId);
      if (!record) throw new BootstrapError('not_found');
      this.assertRecord(record, context, phase, context.operation.status !== 'succeeded');
      return { probe: record.probe, state: record.state, proof: record.proof };
    });
  }
  async claim(identity: BootstrapIdentity, operationId: string, phase: BootstrapPhase, runtimeKey: string): Promise<(BootstrapDescriptor & { claim_token: string }) | null> {
    return withTransaction(this.pool, async client => {
      const context = await this.context(client, identity, operationId, true);
      if (context.operation.status === 'awaiting_auth' && !context.operation.cancel_requested) return null;
      if (context.operation.status !== 'running' || context.operation.cancel_requested || !context.operation.worker_live
          || !context.operation.worker_id || !context.operation.claim_token || context.agent.enabled) throw conflict();
      if (runtimeKey !== context.agent.runtime_key) throw forbidden();
      const record = (await this.records(client, operationId)).find(record => record.probe.phase === phase && record.state !== 'succeeded');
      if (!record) return null;
      this.assertRecord(record, context, phase);
      if (record.state === 'claimed' || !context.operation.steps.some(step => step.name === (phase === 'normal' ? 'admission' : record.probe.action) && step.status === 'running')) throw conflict();
      const token = randomBytes(32).toString('hex');
      record.state = 'claimed'; record.claim_hash = digest(token); record.claim_expires_at = new Date(Date.now() + 50_000).toISOString();
      await this.event(client, context, record); return { ...record.probe, claim_token: token };
    });
  }
  async ack(identity: BootstrapIdentity, probeId: string, raw: BootstrapAck): Promise<BootstrapReceipt> {
    const input = BootstrapAckSchema.parse(raw);
    return withTransaction(this.pool, async client => {
      const context = await this.context(client, identity, input.operation_id);
      const record = (await this.records(client, input.operation_id)).find(record => record.probe.probe_id === probeId);
      if (!record) throw new BootstrapError('not_found');
      this.assertRecord(record, context, input.phase);
      const tokenHash = digest(input.claim_token);
      const { claim_token: _secret, ...proof } = input;
      if (record.state === 'succeeded' && record.claim_hash === tokenHash && same(record.proof, proof)) {
        return { probe: record.probe, state: record.state, proof: record.proof };
      }
      if (!context.operation.steps.some(step => step.name === (input.phase === 'normal' ? 'admission' : record.probe.action) && step.status === 'running')) throw conflict();
      if (record.state !== 'claimed' || record.claim_hash === undefined || !timingSafeEqual(Buffer.from(tokenHash), Buffer.from(record.claim_hash))
          || !Number.isFinite(Date.parse(record.claim_expires_at ?? '')) || Date.parse(record.claim_expires_at ?? '') <= Date.now()) throw conflict();
      const probe = record.probe;
      if (input.nonce !== probe.nonce || input.account_id !== probe.account_id || input.runtime_key !== probe.runtime_key
          || input.profile_revision !== probe.profile_revision || input.harness_id !== probe.harness_id || input.model_id !== probe.model_id
          || (input.reasoning_effort ?? null) !== (probe.reasoning_effort ?? null)
          || !same(input.documents, probe.documents) || (probe.action === 'verify'
            ? !input.harness_started || input.reply !== `CAUCE_BOOTSTRAP_${probe.nonce}`
            : input.harness_started || input.reply !== null)) throw new BootstrapError('unverified');
      record.state = 'succeeded'; record.proof = proof; delete record.claim_expires_at;
      await this.event(client, context, record); return { probe, state: record.state, proof };
    });
  }
  private normalVerified(records: BootstrapRecord[], context: Context): boolean {
    return records.some(record => {
      if (record.probe.phase !== 'normal' || record.probe.action !== 'verify' || record.state !== 'succeeded' || record.proof === null) return false;
      try { this.assertRecord(record, context, 'normal', false); return true; }
      catch (error) { if (error instanceof BootstrapError) return false; throw error; }
    });
  }
  private admitted(context: Context, normalVerified: boolean): boolean {
    return context.operation.status === 'succeeded' && !context.operation.cancel_requested && context.agent.enabled
      && context.agent.lifecycle_state === 'ready' && normalVerified
      && context.operation.steps.some(step => step.name === 'admission' && step.status === 'succeeded');
  }
  async profile(identity: BootstrapIdentity, operationId: string, phase: BootstrapPhase) {
    return withTransaction(this.pool, async client => {
      const context = await this.context(client, identity, operationId, true);
      const active = context.operation.status === 'running' && !context.operation.cancel_requested && context.operation.worker_live
        && context.operation.worker_id !== null && context.operation.claim_token !== null && !context.agent.enabled;
      if (!active && !(phase === 'normal' && this.admitted(context, this.normalVerified(await this.records(client, operationId), context)))) throw conflict();
      return { operation_id: operationId, phase, tenant_id: identity.tenant_id, alias: identity.alias, runtime_key: context.agent.runtime_key,
        harness_id: context.agent.harness_id, model_id: context.agent.model_id, account_id: context.agent.primary_account_id,
        ...(context.agent.reasoning_effort == null ? {} : { reasoning_effort: context.agent.reasoning_effort }),
        profile_revision: context.profile.revision, contexto: context.profile.contexto,
        documents: bootstrapProfileDocuments(context.profile.contexto, context.profile.revision) };
    });
  }
  async state(identity: BootstrapIdentity, operationId: string, phase: BootstrapPhase) {
    return withTransaction(this.pool, async client => {
      const context = await this.context(client, identity, operationId, true);
      const normalVerified = this.normalVerified(await this.records(client, operationId), context);
      return { operation_id: operationId, phase, status: context.operation.status, enabled: context.agent.enabled,
        lifecycle_state: context.agent.lifecycle_state, runtime_key: context.agent.runtime_key,
        profile_revision: context.profile.revision, account_id: context.agent.primary_account_id,
        normal_admitted: phase === 'normal' && this.admitted(context, normalVerified) };
    });
  }
}
