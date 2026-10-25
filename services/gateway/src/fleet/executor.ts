import { FleetEvidenceSchema, type FleetError, type FleetEvidence, type FleetOperation, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import { z } from 'zod';
import type { FleetOperationClaim } from '@cauce/store';
import type { FleetProviderAccounts } from './accounts.js';
import { redactExecutorStderr } from './host-stderr.js';
import { FleetExecutionFailure } from './recovery-host-command.js';
import type { ProviderAuthProbeReason } from '../console/provider-auth.types.js';

interface FencedTarget { resource: 'agent'; tenant_id: string; alias: string }
export interface FleetExecution {
  operation: FleetOperation; request: FleetOperationRequest; fenced_targets: FencedTarget[];
  previous_agents?: Record<string, unknown>[];
  desired_memberships?: { tenant_id: string; alias: string; room_id: string; role: string; enabled: boolean }[];
  global_desired_memberships?: { tenant_id: string; alias: string; room_id: string; role: string; enabled: boolean }[];
  snapshot?: Record<string, unknown>;
  trusted_accounts?: FleetProviderAccounts;
  maintenance?: { release_sha256: string };
  fleet_scope?: {
    placement_role?: 'source' | 'destination';
    operation_id: string; host_id: string; scope_sha256: string; prepared_revision: number;
    worker_id: string; claim_token: string; claim_epoch: number;
  };
}
export interface FleetExecutionRepository {
  claim(worker: string, host: string, leaseMs?: number): Promise<FleetOperationClaim | null>;
  renew(claim: FleetOperationClaim, leaseMs?: number): Promise<boolean>;
  prepare(claim: FleetOperationClaim): Promise<{ operation: FleetOperation; fenced_targets: FencedTarget[] }>;
  execution(claim: FleetOperationClaim): Promise<FleetExecution>;
  startStep(claim: FleetOperationClaim, name: FleetStepName): Promise<FleetOperation>;
  completeStep(claim: FleetOperationClaim, name: FleetStepName, evidence: FleetEvidence): Promise<FleetOperation>;
  awaitAuth(claim: FleetOperationClaim): Promise<FleetOperation>;
  fail(claim: FleetOperationClaim, error: FleetError): Promise<FleetOperation>;
  compensate(claim: FleetOperationClaim, evidence?: FleetEvidence): Promise<FleetOperation>;
  settle(claim: FleetOperationClaim): Promise<FleetOperation>;
}
export interface FleetEffectResult {
  evidence: FleetEvidence; awaiting_auth?: boolean; account_identity?: string;
  /** Why the authenticate step's identity probe failed, when the host named an allowlisted reason. */
  probe_failure?: ProviderAuthProbeReason;
}

/** Only the fenced console login may bind a provisional provider identity. */
export function providerIdentityPending(execution: FleetExecution): boolean {
  const target = execution.request.target;
  if (target.resource !== 'agent') return false;
  const agents = z.array(z.record(z.string(), z.unknown())).parse(execution.snapshot?.agents ?? []);
  const agent = agents.find(value => value.tenant_id === target.tenant_id && value.alias === target.alias);
  return execution.trusted_accounts?.some(account => account.id === agent?.primary_account_id
    && account.external_account_id.startsWith('unverified:')) === true;
}
export interface FleetExecutorOptions {
  worker: string; host: string; leaseMs?: number;
  signal?: AbortSignal;
  prepare?(execution: FleetExecution, claim: FleetOperationClaim, signal: AbortSignal): Promise<boolean | 'prepared'>;
  finish?(claim: FleetOperationClaim): Promise<void>;
  perform(step: FleetStepName, execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim): Promise<FleetEffectResult>;
  compensate?(execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim): Promise<FleetEvidence>;
}

export class FleetExecutor {
  constructor(private readonly repository: FleetExecutionRepository, private readonly options: FleetExecutorOptions) {}
  async runOnce(): Promise<boolean> {
    if (this.options.signal?.aborted) return false;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const claim = await this.repository.claim(this.options.worker, this.options.host, leaseMs);
    if (!claim) return false;
    const abort = new AbortController();
    const isAborted = () => abort.signal.aborted;
    const shutdown = () => { abort.abort(); };
    this.options.signal?.addEventListener('abort', shutdown, { once: true });
    if (this.options.signal?.aborted) abort.abort();
    let renewing: Promise<void> | undefined;
    let stopping = false;
    const heartbeat = setInterval(() => {
      if (renewing || stopping) return;
      renewing = this.repository.renew(claim, leaseMs).then((valid) => {
        if (!valid) abort.abort();
      }).catch(() => { abort.abort(); }).finally(() => { renewing = undefined; });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    let step: FleetStepName | undefined;
    try {
      if (isAborted()) return true;
      let execution = await this.repository.execution(claim);
      if (isAborted()) return true;
      if (execution.operation.status !== 'cancelling') {
        const prepared = await this.options.prepare?.(execution, claim, abort.signal);
        if (prepared === false) return true;
        if (prepared !== 'prepared') await this.repository.prepare(claim);
        if (isAborted()) return true;
        execution = await this.repository.execution(claim);
        if (isAborted()) return true;
      }
      for (;;) {
        if (isAborted()) return true;
        execution = await this.repository.execution(claim);
        if (isAborted()) return true;
        if (execution.operation.status === 'cancelling') {
          const evidence = this.options.compensate === undefined ? {} : await this.options.compensate(execution, abort.signal, claim);
          if (isAborted()) return true;
          await this.repository.compensate(claim, FleetEvidenceSchema.parse(evidence));
          return true;
        }
        const next = execution.operation.steps.find((candidate) => candidate.status !== 'succeeded' && candidate.status !== 'compensated');
        if (!next) break;
        step = next.name;
        await this.repository.startStep(claim, step);
        if (isAborted()) return true;
        execution = await this.repository.execution(claim);
        if (isAborted()) return true;
        if (execution.operation.status === 'cancelling') continue;
        const result = await this.options.perform(step, execution, abort.signal, claim);
        if (isAborted()) return true;
        const current = await this.repository.execution(claim);
        if (isAborted()) return true;
        if (current.operation.id !== execution.operation.id) throw new Error('fleet operation identity changed');
        if (current.operation.status === 'cancelling') continue;
        if (step === 'admission') result.evidence = { ...result.evidence, authority_verified: true };
        if (result.awaiting_auth === true || step === 'authenticate' && providerIdentityPending(current)) {
          await this.repository.awaitAuth(claim);
          return true;
        }
        await this.repository.completeStep(claim, step, FleetEvidenceSchema.parse(result.evidence));
      }
      if (isAborted()) return true;
      await this.repository.settle(claim);
    } catch (caught) {
      if (!abort.signal.aborted) {
        const failure = caught instanceof Error ? caught : new Error(String(caught));
        console.error(`fleet step failed step=${step ?? 'prepare'} error=${failure.name}: ${redactExecutorStderr(failure.message)}`);
        const error: FleetError = { code: 'STEP_FAILED', retryable: true, ...(step === undefined ? {} : { step }),
          ...(failure instanceof FleetExecutionFailure ? { reason: failure.reason } : {}) };
        try { await this.repository.fail(claim, error); } catch { /* A replaced claim cannot settle the operation. */ }
      }
    } finally {
      try { await this.options.finish?.(claim); }
      catch (caught) {
        const failure = caught instanceof Error ? caught : new Error(String(caught));
        console.error(`fleet guard cleanup failed error=${failure.name}: ${redactExecutorStderr(failure.message)}`);
        if (!abort.signal.aborted) {
          try { await this.repository.fail(claim, { code: 'STEP_FAILED', retryable: true }); }
          catch { /* A replaced claim cannot settle the operation. */ }
        }
      }
      stopping = true; abort.abort(); clearInterval(heartbeat);
      this.options.signal?.removeEventListener('abort', shutdown);
      await renewing;
    }
    return true;
  }
}
