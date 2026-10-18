import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { preparedState, publicFleetOperation, withTransaction,
  type DatabaseClient, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { createProviderAuthDependencies, loadProviderAuthRoutingScope, resolveProviderAuthRequest,
  type ProviderAuthPhysicalScope, type ProviderAuthPolicyResolver } from '../console/provider-auth-binding.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthLogin, ProviderAuthService } from '../console/provider-auth.types.js';
import { AgentAuthBindingSchema, type AgentAuthBinding, type AgentAuthCommand, type AgentAuthEvent, type AgentAuthResult } from './agent-provider-auth-contracts.js';
import { readFleetProviderAccounts } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';
import { fleetHostInputs } from './coordinator.js';
import type { FleetExecution } from './executor.js';
import { recoverAgentAuthSession } from './agent-provider-auth-recovery.js';
import { recoverableAgentAuthStart } from './agent-provider-auth-start.js';

interface Pending { packet: AgentAuthCommand; binding: AgentAuthBinding; timer: ReturnType<typeof setTimeout>; resolve(value: AgentAuthResult): void }
interface Output { binding: AgentAuthBinding; sequence: number; listeners: Set<(bytes: Uint8Array) => void> }
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');
const unavailable = () => new ProviderAuthError('HOST_UNAVAILABLE');

export class AgentProviderAuthBroker {
  readonly service: ProviderAuthService;
  private readonly pending = new Map<string, Pending>();
  private readonly outputs = new Map<string, Output>();
  private readonly resolvePolicy: ProviderAuthPolicyResolver = async (client, value) => {
    const scope = await loadProviderAuthRoutingScope(client, value.actor, value.operation.id);
    if (value.actor.requestedCompany !== undefined && value.actor.requestedCompany !== scope.agent.company_id) throw denied();
    await this.enrollment(client, scope.sealed.host_id, scope.agent.company_id);
    return { provider_id: scope.account.provider as AgentAuthBinding['request']['provider_id'], account_id: scope.account.id,
      profile_id: scope.account.id, harness_id: scope.agent.harness_id, host_id: scope.sealed.host_id, runtime_user: scope.agent.runtime_user };
  };
  constructor(private readonly pool: DatabasePool, options: { ttlMs?: number } = {}) {
    const dependencies = createProviderAuthDependencies(pool, this.resolvePolicy, {
      stopAdapter: async (physical, signal) => {
        const binding = await this.binding(physical); signal.throwIfAborted();
        return { stopped: (await this.command(binding, { id: randomUUID(), type: 'stop' })).stopped === true };
      },
      openLogin: async (physical, signal) => {
        const binding = await this.binding(physical); signal.throwIfAborted();
        const response = await this.command(binding, { id: randomUUID(), type: 'open' });
        if (!response.ok || response.method === undefined) throw unavailable();
        await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
          SELECT id,version,'step_started',$2::jsonb FROM fleet_operations WHERE id=$1`, [physical.operation_id,
        JSON.stringify({ step: 'authenticate', agent_provider_auth_method: { session_id: binding.fence.session_id, method: response.method } })]);
        return this.login(binding, response.method);
      },
      verify: async (physical, signal) => {
        const binding = await this.binding(physical); signal.throwIfAborted();
        const response = await this.command(binding, { id: randomUUID(), type: 'verify' });
        return { identity_matches: response.ok && response.identity_matches === true,
          functional_call_verified: response.ok && response.functional_call_verified === true,
          ...(response.account_identity === undefined ? {} : { account_identity: response.account_identity }) };
      },
      cleanup: async (physical, sessionId, _signal, client) => {
        const binding = await this.binding(physical, sessionId, client);
        const response = await this.command(binding, { id: randomUUID(), type: 'cleanup' });
        if (response.stopped === true) this.outputs.delete(sessionId);
        return { stopped: response.ok && response.stopped === true };
      },
    });
    const manager = new ProviderAuthManager(dependencies, options);
    for (const action of ['get','verify','cancel'] as const) {
      const original = manager[action].bind(manager);
      manager[action] = async (actor, id) => {
        try { return await original(actor, id); }
        catch (error) {
          if (!(error instanceof ProviderAuthError) || error.code !== 'AUTHORITY_REVOKED' || this.outputs.has(id)) throw error;
          return recoverAgentAuthSession(pool, actor, id, async binding => {
            const result = await this.command(binding, { id: randomUUID(), type: 'cleanup' });
            return result.ok && result.stopped === true;
          }, action === 'cancel');
        }
      };
    }
    const resolve = (actor: ProviderAuthActor, id: string) => resolveProviderAuthRequest(pool, actor, id, this.resolvePolicy);
    manager.start = recoverableAgentAuthStart(pool, manager, (actor, request) => dependencies.authorize(actor, request), resolve);
    this.service = Object.assign(manager, { resolve });
  }
  private async enrollment(client: DatabaseClient, host: string, company: string) {
    if ((await client.query(`SELECT 1 FROM fleet_hosts host JOIN fleet_host_identities identity
      ON identity.host_id=host.host_id AND identity.company_id=host.company_id
      WHERE host.host_id=$1 AND host.company_id=$2 AND host.enabled AND identity.enabled`, [host, company])).rowCount !== 1) throw denied();
  }
  private async binding(physical: ProviderAuthPhysicalScope, sessionId?: string, borrowed?: DatabaseClient): Promise<AgentAuthBinding> {
    const run = async (client: DatabaseClient) => {
      const rows = await client.query<{ binding: unknown }>(`SELECT metadata->'agent_provider_auth_scope' AS binding FROM fleet_operation_events
        WHERE operation_id=$1 AND metadata ? 'agent_provider_auth_scope' ORDER BY id DESC`, [physical.operation_id]);
      const existing = rows.rows.map(row => AgentAuthBindingSchema.parse(row.binding)).find(value => sessionId === undefined || value.fence.session_id === sessionId);
      const reservation = (await client.query<{ value: { session_id: string; actor_subject: string; expires_at: string; state: string } }>(`SELECT metadata->'provider_auth' AS value
        FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [physical.operation_id])).rows[0]?.value;
      if (existing && (sessionId !== undefined || existing.fence.session_id === reservation?.session_id)) {
        if (!isDeepStrictEqual(existing.physical, physical)) throw denied();
        return existing;
      }
      if (reservation?.state !== 'reserved' || sessionId !== undefined && reservation.session_id !== sessionId) throw denied();
      const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [physical.operation_id])).rows[0];
      if (row?.desired_revision == null) throw denied();
      const actor = { tenant_id: row.actor_tenant, alias: row.actor_alias, subject: reservation.actor_subject,
        requestedCompany: row.company_id };
      const value = await loadProviderAuthRoutingScope(client, actor, row.id);
      await this.enrollment(client, value.sealed.host_id, value.agent.company_id);
      const request = { operation_id: row.id, expected_operation_version: Number(row.version), request_id: reservation.session_id,
        provider_id: physical.provider_id, account_id: physical.account_id, profile_id: physical.profile_id,
        harness_id: physical.harness_id, host_id: physical.host_id, runtime_user: physical.runtime_user };
      const binding = AgentAuthBindingSchema.parse({ physical, actor, request, fence: { operation_id: row.id, session_id: reservation.session_id,
        operation_epoch: Number(row.epoch), prepared_revision: Number(row.desired_revision), scope_sha256: value.sealed.target_sha256,
        expires_at: reservation.expires_at } });
      await client.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
        VALUES($1,$2,'step_started',$3::jsonb)`, [row.id, row.version, JSON.stringify({ step: 'authenticate', agent_provider_auth_scope: binding })]);
      return binding;
    };
    return borrowed === undefined ? withTransaction(this.pool, run) : run(borrowed);
  }
  private async active(client: DatabaseClient, binding: AgentAuthBinding): Promise<FleetExecution> {
    if (Date.parse(binding.fence.expires_at) <= Date.now()) throw new ProviderAuthError('SESSION_EXPIRED');
    const value = await loadProviderAuthRoutingScope(client, binding.actor, binding.fence.operation_id);
    await this.enrollment(client, value.sealed.host_id, value.agent.company_id);
    if (Number(value.operation.epoch) !== binding.fence.operation_epoch || Number(value.operation.desired_revision) !== binding.fence.prepared_revision
        || value.sealed.target_sha256 !== binding.fence.scope_sha256 || value.agent.runtime_key !== binding.physical.runtime_key
        || value.account.id !== binding.physical.account_id || value.account.external_account_id !== binding.physical.expected_external_account_id
        || value.agent.harness_id !== binding.physical.harness_id || value.agent.runtime_user !== binding.physical.runtime_user) throw denied();
    const reservation = (await client.query<{ value: { session_id: string; state: string } }>(`SELECT metadata->'provider_auth' AS value
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [value.operation.id])).rows[0]?.value;
    if (reservation?.session_id !== binding.fence.session_id || reservation.state !== 'reserved') throw denied();
    const prepared = await preparedState(client, value.operation.id);
    const agents = await trustedFleetBaseline(client, value.sealed.agents);
    const previous_agents = await trustedFleetBaseline(client,
      prepared.previous_agents.filter(agent => agent.host_id === value.sealed.host_id));
    return { operation: publicFleetOperation(value.operation), request: value.operation.request,
      ...fleetHostInputs(value.sealed.targets, { ...prepared, previous_agents }),
      snapshot: { agents, memberships: [], rolePolicies: [] }, trusted_accounts: await readFleetProviderAccounts(client, agents) };
  }
  private command(binding: AgentAuthBinding, command: AgentAuthCommand['command']): Promise<AgentAuthResult> {
    if (this.pending.size >= 1000) throw new ProviderAuthError('SESSION_CONFLICT');
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(command.id); resolve({ type: 'result', id: command.id, fence: binding.fence, ok: false }); },
        ['input','resize'].includes(command.type) ? 15_000 : 330_000);
      timer.unref(); this.pending.set(command.id, { binding, packet: { fence: binding.fence, command }, timer, resolve });
    });
  }
  private login(binding: AgentAuthBinding, method: ProviderAuthLogin['method']): ProviderAuthLogin {
    const output: Output = { binding, sequence: 0, listeners: new Set() }; this.outputs.set(binding.fence.session_id, output);
    const invoke = async (command: AgentAuthCommand['command']) => { if (!(await this.command(binding, command)).ok) throw unavailable(); };
    return { method, subscribeOutput: listener => { output.listeners.add(listener); return () => { output.listeners.delete(listener); }; },
      start: () => invoke({ id: randomUUID(), type: 'start' }), write: bytes => invoke({ id: randomUUID(), type: 'input', data: Buffer.from(bytes).toString('base64') }),
      resize: (cols, rows) => invoke({ id: randomUUID(), type: 'resize', cols, rows }),
      close: async () => ({ stopped: (await this.command(binding, { id: randomUUID(), type: 'close' })).stopped === true }) };
  }
  async context(client: DatabaseClient, host: { host_id: string; company_id: string }, id: string, fence: AgentAuthCommand['fence']) {
    const pending = this.pending.get(id);
    if (!pending || !isDeepStrictEqual(pending.packet.fence, fence) || pending.binding.physical.host_id !== host.host_id
        || pending.binding.actor.requestedCompany !== host.company_id) throw denied();
    if (['cleanup','close'].includes(pending.packet.command.type)) return { physical: pending.binding.physical };
    return { physical: pending.binding.physical, execution: await this.active(client, pending.binding) };
  }
  async exchange(client: DatabaseClient, host: { host_id: string; company_id: string }, events: AgentAuthEvent[]) {
    const commands: AgentAuthCommand[] = []; const activeSessions = new Map<string, AgentAuthCommand['fence']>();
    const accepted: (() => void)[] = []; const results = new Set<string>(); const sequences = new Map<string, number>();
    const matching = [...this.pending.values()].filter(value => value.binding.physical.host_id === host.host_id && value.binding.actor.requestedCompany === host.company_id);
    for (const pending of matching) {
      if (!['cleanup','close'].includes(pending.packet.command.type)) {
        try { await this.active(client, pending.binding); } catch { continue; }
      }
      commands.push(pending.packet); activeSessions.set(pending.binding.fence.session_id, pending.binding.fence);
    }
    for (const output of this.outputs.values()) if (output.binding.physical.host_id === host.host_id && output.binding.actor.requestedCompany === host.company_id) {
      if (!matching.some(value => value.binding.fence.session_id === output.binding.fence.session_id && ['cleanup','close'].includes(value.packet.command.type))) {
        try { await this.active(client, output.binding); } catch { continue; }
      }
      activeSessions.set(output.binding.fence.session_id, output.binding.fence);
    }
    for (const event of events) {
      if (event.type === 'result') {
        const pending = this.pending.get(event.id); if (!pending) continue;
        if (!matching.includes(pending) || !isDeepStrictEqual(event.fence, pending.packet.fence)) throw denied();
        results.add(event.id);
        accepted.push(() => { this.pending.delete(event.id); clearTimeout(pending.timer); pending.resolve(event); });
      } else {
        const output = this.outputs.get(event.fence.session_id);
        if (output?.binding.physical.host_id !== host.host_id || !isDeepStrictEqual(event.fence, output.binding.fence)) throw denied();
        if (!activeSessions.has(event.fence.session_id)) continue;
        const sequence = sequences.get(event.fence.session_id) ?? output.sequence;
        if (event.sequence <= sequence) continue;
        if (event.sequence !== sequence + 1) throw denied();
        sequences.set(event.fence.session_id, event.sequence);
        accepted.push(() => { for (const listener of output.listeners) listener(Buffer.from(event.data, 'base64')); output.sequence = event.sequence; });
      }
    }
    return { response: { commands: commands.filter(command => !results.has(command.command.id)).slice(0, 32), active_sessions: [...activeSessions.values()] },
      accept: () => { for (const commit of accepted) commit(); } };
  }
  async shutdown(): Promise<void> {
    await this.service.shutdown();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ type: 'result', id: pending.packet.command.id, fence: pending.packet.fence, ok: false }); }
    this.pending.clear(); this.outputs.clear();
  }
}
