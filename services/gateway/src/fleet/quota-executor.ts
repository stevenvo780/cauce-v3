import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { QuotaOperationClaim, QuotaOperationExecution } from '@cauce/store';
import { assertQuotaEffect, QuotaEffectSchema, QuotaExecutionSchema, type QuotaEffect } from './quota-host-command.js';
import { readQuotaStepReason, type QuotaStepReason } from './provider-login.js';

export interface QuotaExecutionRepository {
  claim(worker: string, host: string, leaseMs?: number): Promise<QuotaOperationClaim | null>;
  renew(claim: QuotaOperationClaim, leaseMs?: number): Promise<boolean>;
  execution(claim: QuotaOperationClaim): Promise<QuotaOperationExecution>;
  resumeAuthentication(claim: QuotaOperationClaim): Promise<boolean>;
  finish(claim: QuotaOperationClaim, value: unknown, awaitingAuth?: boolean): Promise<unknown>;
  fail(claim: QuotaOperationClaim, code: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED' | 'AUTH_CANCELLED', detail?: QuotaStepReason): Promise<unknown>;
}
export interface QuotaAuthenticationHandle {
  public_result: { expires_at: string; output?: string; login_url?: string; user_code?: string };
  close(): Promise<void>;
}
export interface QuotaExecutorOptions {
  worker: string; host: string; leaseMs?: number; signal?: AbortSignal;
  perform(execution: QuotaOperationExecution, signal: AbortSignal, claim: QuotaOperationClaim): Promise<QuotaEffect>;
  beginAuthentication?(execution: QuotaOperationExecution, plan: NonNullable<QuotaEffect['login_plan']>,
    claim: QuotaOperationClaim, signal: AbortSignal): Promise<QuotaAuthenticationHandle>;
}
export class QuotaExecutor {
  constructor(private readonly repository: QuotaExecutionRepository, private readonly options: QuotaExecutorOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(options.host)
        || !Number.isSafeInteger(options.leaseMs ?? 30_000) || (options.leaseMs ?? 30_000) < 1000 || (options.leaseMs ?? 30_000) > 300_000) {
      throw new Error('Quota worker identity or lease is invalid');
    }
  }
  async runOnce(): Promise<boolean> {
    if (this.options.signal?.aborted) return false;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const claim = await this.repository.claim(this.options.worker, this.options.host, leaseMs);
    if (!claim) return false;
    const abort = new AbortController();
    const shutdown = () => { abort.abort(); };
    this.options.signal?.addEventListener('abort', shutdown, { once: true });
    if (this.options.signal?.aborted) abort.abort();
    let renewing: Promise<void> | undefined; let stopping = false;
    const heartbeat = setInterval(() => {
      if (renewing || stopping) return;
      renewing = this.repository.renew(claim, leaseMs).then(valid => { if (!valid) abort.abort(); })
        .catch(() => { abort.abort(); }).finally(() => { renewing = undefined; });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    const drainRenewal = async () => {
      stopping = true; clearInterval(heartbeat);
      await renewing;
    };
    let authentication: QuotaAuthenticationHandle | undefined; let handedOff = false;
    let failure: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED' = 'STEP_FAILED';
    try {
      abort.signal.throwIfAborted();
      const execution = QuotaExecutionSchema.parse(await this.repository.execution(claim));
      abort.signal.throwIfAborted();
      if (execution.operation_id !== claim.id || execution.environment.id !== claim.environment_id || execution.environment.host_id !== this.options.host) {
        throw new Error('Quota claim identity differs from its execution');
      }
      const result = QuotaEffectSchema.parse(await this.options.perform(execution, abort.signal, claim));
      assertQuotaEffect(execution, result);
      abort.signal.throwIfAborted();
      const current = await this.repository.execution(claim);
      abort.signal.throwIfAborted();
      if (!isDeepStrictEqual(current, execution)) throw new Error('Quota execution changed while its effect ran');
      if (execution.action === 'authenticate') {
        if (!this.options.beginAuthentication || result.awaiting_auth !== true || !result.login_plan) {
          failure = 'PROVIDER_UNAVAILABLE'; throw new Error('Quota authentication broker is unavailable');
        }
        authentication = await this.options.beginAuthentication(execution, result.login_plan, claim, abort.signal);
        await drainRenewal();
        abort.signal.throwIfAborted();
        await this.repository.finish(claim, authentication.public_result, true);
        handedOff = true;
      } else {
        if (result.awaiting_auth !== undefined || result.login_plan !== undefined) throw new Error('Unexpected quota authentication effect');
        await drainRenewal();
        abort.signal.throwIfAborted();
        await this.repository.finish(claim, result);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const reason = readQuotaStepReason(error);
        if (reason) process.stderr.write(`quota step failed reason=${reason}\n`);
        try { await (reason ? this.repository.fail(claim, failure, reason) : this.repository.fail(claim, failure)); } catch { /* A replaced lease cannot accept a receipt. */ }
      }
    } finally {
      stopping = true; clearInterval(heartbeat); abort.abort();
      this.options.signal?.removeEventListener('abort', shutdown);
      await renewing;
      if (authentication && !handedOff) await authentication.close();
    }
    return true;
  }
}

export interface QuotaHostChannel { request(method: 'POST', path: string, payload: Record<string, unknown>): Promise<unknown> }
export class QuotaHostTransportError extends Error {
  constructor() { super('Signed host channel transport is unavailable'); this.name = 'QuotaHostTransportError'; }
}
const ClaimSchema = z.object({ id: z.uuid(), environment_id: z.uuid(), claim_token: z.uuid(), claim_epoch: z.number().int().nonnegative(),
  worker_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).strict();
export class HostChannelQuotaRepository implements QuotaExecutionRepository {
  constructor(private readonly channel: QuotaHostChannel, private readonly host: string) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(host)) throw new Error('Quota channel host is invalid');
  }
  private invoke(action: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.channel.request('POST', `/v3/fleet/hosts/${this.host}/channel`, { resource: 'quota_environment', action, ...payload });
  }
  private async terminal(action: 'finish' | 'fail', payload: Record<string, unknown>): Promise<unknown> {
    try { return await this.invoke(action, payload); } catch (error) {
      if (!(error instanceof QuotaHostTransportError)) throw error;
      return this.invoke(action, payload);
    }
  }
  async claim(_worker: string, host: string, leaseMs = 30_000) {
    if (host !== this.host) throw new Error('Quota claim host differs from its channel');
    return z.object({ claim: ClaimSchema.nullable() }).strict().parse(await this.invoke('claim', { lease_ms: leaseMs })).claim;
  }
  async renew(claim: QuotaOperationClaim, leaseMs = 30_000) {
    return z.object({ renewed: z.boolean() }).strict().parse(await this.invoke('renew', { claim, lease_ms: leaseMs })).renewed;
  }
  async execution(claim: QuotaOperationClaim) {
    return QuotaExecutionSchema.parse(await this.invoke('execution', { claim }));
  }
  async resumeAuthentication(claim: QuotaOperationClaim) {
    return z.object({ resumed: z.boolean() }).strict().parse(await this.invoke('resume_auth', { claim })).resumed;
  }
  finish(claim: QuotaOperationClaim, value: unknown, awaitingAuth = false) { return this.terminal('finish', { claim, result: value, awaiting_auth: awaitingAuth }); }
  fail(claim: QuotaOperationClaim, code: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED' | 'AUTH_CANCELLED', detail?: QuotaStepReason) {
    return this.terminal('fail', { claim, code, ...(detail ? { detail } : {}) });
  }
}
