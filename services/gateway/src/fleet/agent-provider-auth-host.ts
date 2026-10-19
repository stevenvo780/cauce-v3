import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { FleetOperationRequestSchema, FleetOperationSchema } from '@cauce/protocol';
import type { ProviderAuthLogin } from '../console/provider-auth.types.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { AgentAuthExchangeSchema, AgentAuthPhysicalSchema, RuntimeDriftFenceSchema, type AgentAuthCommand, type AgentAuthEvent, type AgentAuthResult } from './agent-provider-auth-contracts.js';
import { FleetProviderAccountsSchema } from './accounts.js';
import type { FleetExecution } from './executor.js';
import { performHostCommand, performHostLoginStop } from './host-command.js';
import { hostProviderLoginConfiguration, readHostProviderAuthPolicy, type HostProviderAuthOptions } from './host-provider-auth.js';
import { cleanupProviderLogin, createProviderLogin, providerAuthFailureReason, queryProviderLoginBinding, type ProviderLoginConfig } from './provider-login.js';
import type { QuotaHostChannel } from './quota-executor.js';
import type { RuntimeDriftReceipt } from './agent-runtime-reconcile.js';

const Records = z.array(z.record(z.string(), z.unknown())).max(1000);
const Target = z.object({ resource: z.literal('agent'), tenant_id: z.string(), alias: z.string() }).strict();
const Membership = z.object({ tenant_id: z.string(), alias: z.string(), room_id: z.string(), role: z.string(), enabled: z.boolean() }).strict();
const Execution = z.object({ operation: FleetOperationSchema, request: FleetOperationRequestSchema,
  fenced_targets: z.array(Target).max(1000), previous_agents: Records.exactOptional(),
  desired_memberships: z.array(Membership).max(1000).exactOptional(), global_desired_memberships: z.array(Membership).max(1000).exactOptional(),
  snapshot: z.object({ agents: Records, memberships: Records, rolePolicies: Records }).strict(), trusted_accounts: FleetProviderAccountsSchema,
}).strict();
const Context = z.object({ physical: AgentAuthPhysicalSchema, execution: Execution.optional() }).strict();
const Reconciliation = z.object({ cursor: z.uuid().nullable(),
  inspections: z.array(z.object({ fence: RuntimeDriftFenceSchema, execution: Execution }).strict()).max(8) }).strict();
const ACTIVE_POLL_MS = 100;
const IDLE_POLL_MIN_MS = 1000;
const IDLE_POLL_MAX_MS = 5000;
interface Login { fence: AgentAuthCommand['fence']; login: ProviderAuthLogin; config: ProviderLoginConfig; unsubscribe(): void }
export interface AgentProviderAuthHostOptions extends HostProviderAuthOptions {
  createLogin?(config: ProviderLoginConfig, signal: AbortSignal): Promise<ProviderAuthLogin>;
}
export class AgentProviderAuthHost {
  private readonly logins = new Map<string, Login>();
  private readonly completed = new Map<string, AgentAuthResult>();
  private readonly events: AgentAuthEvent[] = [];
  private readonly sequences = new Map<string, number>();
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private reconciliation: Promise<void> | undefined;
  private reconcileAt = 0;
  private reconcileAfter: string | undefined;
  private readonly driftReceipts: RuntimeDriftReceipt[] = [];
  constructor(private readonly channel: QuotaHostChannel, private readonly options: AgentProviderAuthHostOptions) {}
  start(): void { this.loop ??= this.poll(); }
  private async context(packet: AgentAuthCommand) {
    const value = Context.parse(await this.channel.request('POST', `/v3/fleet/hosts/${this.options.hostConfig.host}/agent-auth`,
      { action: 'context', id: packet.command.id, fence: packet.fence }));
    if (value.physical.host_id !== this.options.hostConfig.host || value.physical.operation_id !== packet.fence.operation_id
        || value.physical.host_scope_sha256 !== packet.fence.scope_sha256) throw new Error('Agent authentication context differs');
    if (value.execution && (value.execution.operation.id !== packet.fence.operation_id
        || value.execution.operation.desired_revision !== packet.fence.prepared_revision)) throw new Error('Agent authentication operation differs');
    return { physical: value.physical, execution: value.execution as FleetExecution | undefined };
  }
  private async dispatch(packet: AgentAuthCommand): Promise<AgentAuthResult> {
    const prior = this.completed.get(packet.command.id); if (prior) return prior;
    const result: AgentAuthResult = { type: 'result', fence: packet.fence, id: packet.command.id, ok: false };
    try {
      const { command, fence } = packet; const closing = command.type === 'cleanup' || command.type === 'close';
      if (!closing && Date.parse(fence.expires_at) <= Date.now()) throw new Error('Agent authentication expired');
      const context = await this.context(packet);
      const session = this.logins.get(fence.session_id);
      if (session && !isDeepStrictEqual(session.fence, fence)) throw new Error('Agent authentication fence differs');
      if (command.type === 'cleanup') {
        const stopped = await session?.login.close();
        if (stopped && !stopped.stopped) throw new Error('Agent authentication stop is unconfirmed');
        const policy = await readHostProviderAuthPolicy(this.options);
        result.stopped = (await cleanupProviderLogin({ python: this.options.hostConfig.command.python, helper: policy.helper,
          stateRoot: policy.state_root }, fence.operation_id, this.abort.signal)).stopped;
        if (!result.stopped) throw new Error('Agent authentication cleanup is unconfirmed');
        session?.unsubscribe(); this.logins.delete(fence.session_id); this.sequences.delete(fence.session_id);
      } else if (command.type === 'close') {
        if (session) result.stopped = (await session.login.close()).stopped;
        else {
          const policy = await readHostProviderAuthPolicy(this.options);
          result.stopped = (await cleanupProviderLogin({ python: this.options.hostConfig.command.python, helper: policy.helper,
            stateRoot: policy.state_root }, fence.operation_id, this.abort.signal)).stopped;
        }
        if (!result.stopped) throw new Error('Agent login stop is unconfirmed');
      } else {
        if (!context.execution) throw new Error('Agent authentication execution is unavailable');
        switch (command.type) {
          case 'stop': result.stopped = (await performHostLoginStop(this.options.hostConfig.command, context.execution, this.abort.signal)).stopped; break;
          case 'open': {
            if (session || this.logins.size >= 64) throw new Error('Agent login is already open');
            const config = await hostProviderLoginConfiguration(this.options, context.execution, context.physical, this.abort.signal, true);
            config.packet.ttl_seconds = Math.max(1, Math.min(600, Math.ceil((Date.parse(fence.expires_at) - Date.now()) / 1000)));
            const login = await (this.options.createLogin ?? createProviderLogin)(config, this.abort.signal);
            const unsubscribe = login.subscribeOutput(bytes => {
              for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
                if (this.events.length >= 256 || Date.parse(fence.expires_at) <= Date.now()) { this.abort.abort(); return; }
                const sequence = (this.sequences.get(fence.session_id) ?? 0) + 1; this.sequences.set(fence.session_id, sequence);
                this.events.push({ type: 'output', fence, sequence, data: Buffer.from(bytes.subarray(offset, offset + 4096)).toString('base64') });
              }
            });
            this.logins.set(fence.session_id, { fence, login, config, unsubscribe }); result.method = login.method; break;
          }
          case 'start': case 'input': case 'resize': case 'verify': {
            if (!session) throw new Error('Agent login is unavailable');
            const config = await hostProviderLoginConfiguration(this.options, context.execution, context.physical, this.abort.signal);
            const { ttl_seconds: _prior, ...previous } = session.config.packet;
            const { ttl_seconds: _current, ...current } = config.packet;
            if (!isDeepStrictEqual(previous, current) || !isDeepStrictEqual(session.config.helper, config.helper)) throw new Error('Agent login binding changed');
            if (command.type === 'start') await session.login.start();
            else if (command.type === 'input') await session.login.write(Buffer.from(command.data, 'base64'));
            else if (command.type === 'resize') await session.login.resize(command.cols, command.rows);
            else {
              if (!(await session.login.close()).stopped) throw new Error('Agent login stop is unconfirmed');
              const proof = await performHostCommand(this.options.hostConfig.command, 'authenticate', context.execution, this.abort.signal);
              result.identity_matches = !proof.awaiting_auth && proof.evidence.provider_verified === true;
              result.functional_call_verified = result.identity_matches;
              if (result.identity_matches && proof.account_identity !== undefined) result.account_identity = proof.account_identity;
            }
            break;
          }
        }
        await this.context(packet);
      }
      result.ok = true;
    } catch (error) {
      result.ok = false;
      if (error instanceof ProviderAuthError) {
        if (error.code === 'RUNTIME_DRIFT' || error.code === 'STOP_UNCONFIRMED' || error.code === 'HOST_UNAVAILABLE') result.error = error.code;
        if (error.reason !== undefined) result.reason = error.reason;
      }
      process.stderr.write(`Agent provider authentication command=${packet.command.type} failed: ${providerAuthFailureReason(error)}\n`);
    }
    this.completed.set(packet.command.id, result);
    if (this.completed.size > 4096) this.abort.abort();
    return result;
  }
  private async reconcile(): Promise<void> {
    const response = Reconciliation.parse(await this.channel.request('POST', `/v3/fleet/hosts/${this.options.hostConfig.host}/agent-auth`,
      { action: 'reconcile', receipts: this.driftReceipts, ...(this.reconcileAfter === undefined ? {} : { after: this.reconcileAfter }) }));
    this.reconcileAfter = response.cursor ?? undefined;
    this.driftReceipts.length = 0;
    for (const inspection of response.inspections) {
      if (this.abort.signal.aborted) return;
      const { execution, fence } = inspection;
      if (execution.operation.id !== fence.operation_id || execution.operation.desired_revision !== fence.prepared_revision
          || execution.operation.status !== 'awaiting_auth') continue;
      try {
        await queryProviderLoginBinding({ ...this.options.hostConfig.command, timeoutMs: 5000 }, execution, this.abort.signal);
      } catch (error) {
        if (error instanceof ProviderAuthError && error.code === 'RUNTIME_DRIFT') this.driftReceipts.push({ ...fence, error: error.code });
      }
    }
    if (this.driftReceipts.length && !this.abort.signal.aborted) {
      await this.channel.request('POST', `/v3/fleet/hosts/${this.options.hostConfig.host}/agent-auth`, { action: 'reconcile', receipts: this.driftReceipts });
      this.driftReceipts.length = 0;
    }
  }
  /** Every exchange is a signed write on the gateway: an idle host backs off from 1 s to 5 s and polls fast only during a login. */
  private async poll(): Promise<void> {
    try {
      let idle = 0;
      while (!this.abort.signal.aborted) {
        let busy = false;
        try {
          const sent = this.events.splice(0, 32);
          const response = AgentAuthExchangeSchema.parse(await this.channel.request('POST', `/v3/fleet/hosts/${this.options.hostConfig.host}/agent-auth`,
            { action: 'exchange', events: sent }));
          for (const [id, session] of this.logins) if (!response.active_sessions.some(fence => isDeepStrictEqual(fence, session.fence))) {
            session.unsubscribe(); await session.login.close(); this.logins.delete(id); this.sequences.delete(id);
          }
          for (const packet of response.commands) this.events.push(await this.dispatch(packet));
          if (!this.reconciliation && Date.now() >= this.reconcileAt) {
            this.reconcileAt = Date.now() + 30_000;
            this.reconciliation = this.reconcile().catch(() => {
              if (!this.abort.signal.aborted) process.stderr.write('Agent runtime reconciliation could not be verified\n');
            }).finally(() => { this.reconciliation = undefined; });
          }
          busy = response.commands.length > 0 || response.active_sessions.length > 0 || this.logins.size > 0 || this.events.length > 0;
        } catch {
          await this.stopLocal(); this.events.length = 0; this.completed.clear();
        }
        idle = busy ? 0 : Math.min(idle + 1, 4);
        const delay = busy ? ACTIVE_POLL_MS : Math.min(IDLE_POLL_MAX_MS, IDLE_POLL_MIN_MS * 2 ** (idle - 1));
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, delay); this.abort.signal.addEventListener('abort', done, { once: true });
          if (this.abort.signal.aborted) done();
        });
      }
    } finally { await this.stopLocal(); }
  }
  private async stopLocal(): Promise<void> {
    for (const session of this.logins.values()) { session.unsubscribe(); await session.login.close().catch(() => ({ stopped: false })); }
    this.logins.clear(); this.sequences.clear();
  }
  async shutdown(): Promise<void> { this.abort.abort(); await this.loop; await this.reconciliation; }
}
