import { FleetEvidenceSchema, type FleetError, type FleetEvidence, type FleetOperation, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
import type { FleetProviderAccounts } from './accounts.js';

interface FencedTarget { resource: 'agent'; tenant_id: string; alias: string }
export interface FleetExecution {
  operation: FleetOperation; request: FleetOperationRequest; fenced_targets: FencedTarget[];
  previous_agents?: Record<string, unknown>[];
  desired_memberships?: { tenant_id: string; alias: string; room_id: string; role: string; enabled: boolean }[];
  global_desired_memberships?: { tenant_id: string; alias: string; room_id: string; role: string; enabled: boolean }[];
  snapshot?: Record<string, unknown>;
  trusted_accounts?: FleetProviderAccounts;
  fleet_scope?: {
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
export interface FleetEffectResult { evidence: FleetEvidence; awaiting_auth?: boolean }
export interface FleetExecutorOptions {
  worker: string; host: string; leaseMs?: number;
  signal?: AbortSignal;
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
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.repository.renew(claim, leaseMs).then((valid) => {
        if (!valid) abort.abort();
      }).catch(() => { abort.abort(); }).finally(() => { renewing = false; });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    let step: FleetStepName | undefined;
    try {
      if (isAborted()) return true;
      let execution = await this.repository.execution(claim);
      if (execution.operation.status !== 'cancelling') {
        await this.repository.prepare(claim);
        execution = await this.repository.execution(claim);
      }
      for (;;) {
        if (isAborted()) return true;
        execution = await this.repository.execution(claim);
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
        execution = await this.repository.execution(claim);
        if (execution.operation.status === 'cancelling') continue;
        const result = await this.options.perform(step, execution, abort.signal, claim);
        if (isAborted()) return true;
        const current = await this.repository.execution(claim);
        if (isAborted()) return true;
        if (current.operation.id !== execution.operation.id) throw new Error('fleet operation identity changed');
        if (current.operation.status === 'cancelling') continue;
        if (step === 'admission') result.evidence = { ...result.evidence, authority_verified: true };
        if (result.awaiting_auth === true) {
          await this.repository.awaitAuth(claim);
          return true;
        }
        await this.repository.completeStep(claim, step, FleetEvidenceSchema.parse(result.evidence));
      }
      await this.repository.settle(claim);
    } catch {
      if (!abort.signal.aborted) {
        const error: FleetError = { code: 'STEP_FAILED', retryable: true, ...(step === undefined ? {} : { step }) };
        try { await this.repository.fail(claim, error); } catch { /* A replaced claim cannot settle the operation. */ }
      }
    } finally {
      abort.abort(); clearInterval(heartbeat);
      this.options.signal?.removeEventListener('abort', shutdown);
    }
    return true;
  }
}
