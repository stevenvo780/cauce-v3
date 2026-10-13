import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentQuotaClaimSchema, AgentQuotaExecutionSchema, AgentQuotaReceiptSchema,
  type AgentQuotaClaim, type AgentQuotaExecution } from '@cauce/protocol';
import { QuotaHostTransportError, type QuotaHostChannel } from './quota-executor.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';

function logFailureClass(error: unknown): void {
  const name = error instanceof QuotaHostTransportError ? 'QuotaHostTransportError'
    : error instanceof ProviderAuthError ? 'ProviderAuthError' : error instanceof z.ZodError ? 'ZodError'
      : error instanceof Error ? 'Error' : 'UnknownError';
  process.stderr.write(`${name}\n`);
}

export interface AgentQuotaExecutionRepository {
  claim(worker: string, host: string, leaseMs?: number): Promise<AgentQuotaClaim | null>;
  renew(claim: AgentQuotaClaim, leaseMs?: number): Promise<boolean>;
  execution(claim: AgentQuotaClaim): Promise<AgentQuotaExecution>;
  finish(claim: AgentQuotaClaim, receipt: unknown): Promise<unknown>;
  fail(claim: AgentQuotaClaim, code: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED'): Promise<unknown>;
}
interface Options {
  worker: string; host: string; leaseMs?: number; signal?: AbortSignal;
  perform(execution: AgentQuotaExecution, signal: AbortSignal): Promise<unknown>;
}
export class AgentQuotaExecutor {
  constructor(private readonly repository: AgentQuotaExecutionRepository, private readonly options: Options) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(options.host)
      || !Number.isSafeInteger(options.leaseMs ?? 30_000) || (options.leaseMs ?? 30_000) < 1000 || (options.leaseMs ?? 30_000) > 300_000) {
      throw new Error('Agent quota worker identity or lease is invalid');
    }
  }
  async runOnce(): Promise<boolean> {
    if (this.options.signal?.aborted) return false;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const claim = await this.repository.claim(this.options.worker, this.options.host, leaseMs);
    if (!claim) return false;
    const abort = new AbortController(); const shutdown = () => { abort.abort(); };
    this.options.signal?.addEventListener('abort', shutdown, { once: true });
    if (this.options.signal?.aborted) abort.abort();
    let renewing: Promise<void> | undefined; let stopping = false;
    const heartbeat = setInterval(() => {
      if (renewing || stopping) return;
      renewing = this.repository.renew(claim, leaseMs).then(valid => { if (!valid) abort.abort(); })
        .catch((error: unknown) => { logFailureClass(error); abort.abort(); }).finally(() => { renewing = undefined; });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    let failure: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED' = 'STEP_FAILED';
    try {
      abort.signal.throwIfAborted();
      const rawExecution = await this.repository.execution(claim);
      const execution = AgentQuotaExecutionSchema.parse(rawExecution);
      if (execution.operation_id !== claim.id || execution.agent.tenant_id !== claim.tenant_id
        || execution.agent.alias !== claim.alias || execution.agent.host_id !== this.options.host) {
        throw new Error('Agent quota claim differs from its execution');
      }
      abort.signal.throwIfAborted();
      failure = 'PROVIDER_UNAVAILABLE';
      const rawReceipt = await this.options.perform(execution, abort.signal);
      failure = 'STEP_FAILED';
      const receipt = AgentQuotaReceiptSchema.parse(rawReceipt);
      abort.signal.throwIfAborted();
      const current = await this.repository.execution(claim);
      if (!isDeepStrictEqual(current, execution)) {
        throw new Error('Agent quota execution changed while the reader ran');
      }
      await renewing;
      abort.signal.throwIfAborted();
      await this.repository.finish(claim, receipt);
    } catch (error) {
      logFailureClass(error);
      if (!abort.signal.aborted) {
        if (error instanceof z.ZodError) failure = 'STEP_FAILED';
        if (error instanceof QuotaHostTransportError || (error instanceof ProviderAuthError && error.code === 'HOST_UNAVAILABLE')) {
          failure = 'RUNTIME_UNAVAILABLE';
        }
        try { await this.repository.fail(claim, failure); } catch (terminalError) { logFailureClass(terminalError); }
      }
    } finally {
      stopping = true; clearInterval(heartbeat); abort.abort();
      this.options.signal?.removeEventListener('abort', shutdown); await renewing;
    }
    return true;
  }
}
export class HostChannelAgentQuotaRepository implements AgentQuotaExecutionRepository {
  constructor(private readonly channel: QuotaHostChannel, private readonly host: string) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(host)) throw new Error('Agent quota channel host is invalid');
  }
  private invoke(action: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.channel.request('POST', `/v3/fleet/hosts/${this.host}/channel`, { resource: 'agent_quota', action, ...payload });
  }
  private async terminal(action: 'finish' | 'fail', payload: Record<string, unknown>): Promise<unknown> {
    try { return await this.invoke(action, payload); } catch (error) {
      if (!(error instanceof QuotaHostTransportError)) throw error;
      return this.invoke(action, payload);
    }
  }
  async claim(_worker: string, host: string, leaseMs = 30_000) {
    if (host !== this.host) throw new Error('Agent quota claim host differs from its channel');
    return z.object({ claim: AgentQuotaClaimSchema.nullable() }).strict().parse(await this.invoke('claim', { lease_ms: leaseMs })).claim;
  }
  async renew(claim: AgentQuotaClaim, leaseMs = 30_000) {
    return z.object({ renewed: z.boolean() }).strict().parse(await this.invoke('renew', { claim, lease_ms: leaseMs })).renewed;
  }
  async execution(claim: AgentQuotaClaim) { return AgentQuotaExecutionSchema.parse(await this.invoke('execution', { claim })); }
  finish(claim: AgentQuotaClaim, receipt: unknown) { return this.terminal('finish', { claim, receipt: AgentQuotaReceiptSchema.parse(receipt) }); }
  fail(claim: AgentQuotaClaim, code: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED') { return this.terminal('fail', { claim, code }); }
}
