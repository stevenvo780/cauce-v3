import { basename } from 'node:path';
import { z } from 'zod';
import { beginMaintenanceGuard, MaintenanceDeferReasonSchema, type MaintenanceGuard } from './host-maintenance-guard.js';
import type { FleetExecution } from './executor.js';
import type { FleetOperationClaim } from '@cauce/store';
import type { SignedHostChannel } from './signed-source.js';
import type { FleetHostConfig } from './main.js';

const maintenance = (execution: FleetExecution) => execution.operation.actor.actor_subject?.startsWith('host:') === true;
export class HostMaintenance {
  private pending = true;
  private retryAt = 0;
  private failures = 0;
  private readonly release: string;
  private held: { operation: string; claimToken: string; epoch: number; guard: MaintenanceGuard } | undefined;
  constructor(private readonly channel: SignedHostChannel, private readonly config: FleetHostConfig) {
    this.release = basename(config.projectRoot);
  }
  requestScan(): void { this.pending = true; }
  private request(action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.channel.request('POST', `/v3/fleet/hosts/${this.config.host}/channel`, { resource: 'host_maintenance', action, ...payload }, signal);
  }
  async runOnce(signal: AbortSignal): Promise<boolean> {
    if (!this.pending || Date.now() < this.retryAt || !/^[a-f0-9]{64}$/u.test(this.release)) return false;
    this.pending = false;
    try {
      const response = z.object({ operations: z.array(z.unknown()) }).strict()
        .parse(await this.request('reconcile', { release_sha256: this.release }, signal));
      this.failures = 0; this.retryAt = 0;
      return response.operations.length > 0;
    } catch {
      this.pending = true;
      this.retryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(this.failures++, 6));
      return false;
    }
  }
  async prepare(execution: FleetExecution, claim: FleetOperationClaim, signal: AbortSignal): Promise<boolean | 'prepared'> {
    if (!maintenance(execution) || execution.operation.steps.some(step => step.name === 'stop' && step.status === 'succeeded')) return true;
    const fence = { operation_id: claim.operation.id, claim_token: claim.claim_token, epoch: claim.epoch };
    if (execution.operation.desired_revision === null && execution.maintenance?.release_sha256 !== this.release) {
      await this.request('skip', { claim: fence, reason: 'release_changed' }, signal);
      this.requestScan();
      return false;
    }
    let guard: MaintenanceGuard;
    try { guard = await beginMaintenanceGuard(this.config.command, execution, claim, signal); }
    catch (error) {
      if (execution.operation.desired_revision !== null || signal.aborted) throw error;
      await this.request('defer', { claim: fence, reason: 'preflight_unavailable' }, signal);
      return false;
    }
    let finished = false;
    try {
      const first = guard.first;
      if (first.state === 'deferred' && execution.operation.desired_revision === null) {
        await this.request('defer', { claim: fence, reason: MaintenanceDeferReasonSchema.parse(first.reason) }, signal);
        return false;
      }
      if (first.state === 'runtime_current' && execution.operation.desired_revision === null) {
        await this.request('skip', { claim: fence }, signal); return false;
      }
      if (first.state !== 'ready' && first.state !== 'stopped') throw new Error('Maintenance did not acquire a restart guard');
      const response = z.object({ prepared: z.boolean() }).strict()
        .parse(await this.request('prepare', { claim: fence }, signal));
      if (!response.prepared) return false;
      this.held = { operation: execution.operation.id, claimToken: claim.claim_token, epoch: claim.epoch, guard };
      finished = true;
      return 'prepared';
    } finally {
      if (!finished) await guard.finish(false);
    }
  }
  async stop(execution: FleetExecution, claim: FleetOperationClaim): Promise<void> {
    if (!maintenance(execution)) return;
    const held = this.held;
    const scope = execution.fleet_scope;
    if (execution.operation.status !== 'running' || held?.operation !== execution.operation.id
        || held.claimToken !== claim.claim_token || held.epoch !== claim.epoch
        || execution.operation.id !== claim.operation.id || scope?.operation_id !== execution.operation.id
        || scope.host_id !== this.config.host || scope.claim_token !== claim.claim_token || scope.claim_epoch !== claim.epoch
        || scope.worker_id !== claim.worker_id || scope.prepared_revision !== execution.operation.desired_revision
        || !execution.operation.steps.some(step => step.name === 'stop' && step.status === 'running')) {
      throw new Error('Maintenance stop requires its current durable host claim and running step');
    }
    this.held = undefined;
    await held.guard.finish(true);
  }
  async finish(claim: FleetOperationClaim): Promise<void> {
    const held = this.held;
    if (!held) return;
    if (held.operation !== claim.operation.id || held.claimToken !== claim.claim_token || held.epoch !== claim.epoch) {
      throw new Error('Maintenance cleanup requires its original durable claim');
    }
    this.held = undefined;
    await held.guard.finish(false);
  }
}
