import { randomUUID } from 'node:crypto';
import type { FleetError, FleetOperation } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import { lockFleetRevision, recordFleetEvent } from './fleet-operation-authority.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationClaim, type FleetOperationRow } from './fleet-operation-contracts.js';
import { fleetReplacementCommit } from './fleet-operation-retirement.js';
import { assertFleetOperationAuthority, loadFleetOrigin } from './fleet-operation-human.js';
import { cancelStaleMaintenance } from './fleet-operation-maintenance.js';
import { fleetRollbackIntent } from './fleet-operation-rollback-intent.js';

function leaseParameters(worker: string, host: string, leaseMs: number): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(host)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
    throw new FleetOperationError('invalid_input', 'fleet worker lease parameters are invalid');
  }
}
// Backoff applies only to failed compensation attempts (the one path that releases an operation back into the
// claimable set); cancel, resume and any completed step are markers that make the operation claimable at once.
export const FLEET_COMPENSATION_BACKOFF_BASE_MS = 5_000;
export const FLEET_COMPENSATION_BACKOFF_CAP_MS = 300_000;
/** A claim renews its lease at most this long after its last durable progress (claim, step start or step receipt). */
export const FLEET_STEP_MAX_MS = 30 * 60_000;
export abstract class FleetOperationClaims {
  private readonly stepMaxMs: number;
  constructor(protected readonly pool: DatabasePool, private readonly transactionClient?: DatabaseClient, stepMaxMs = FLEET_STEP_MAX_MS) {
    if (!Number.isSafeInteger(stepMaxMs) || stepMaxMs < 1000 || stepMaxMs > 86_400_000) {
      throw new FleetOperationError('invalid_input', 'fleet step duration bound is invalid');
    }
    this.stepMaxMs = stepMaxMs;
  }
  abstract fail(claim: FleetOperationClaim, input: FleetError): Promise<FleetOperation>;
  protected transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return this.transactionClient === undefined ? withTransaction(this.pool, work) : work(this.transactionClient);
  }
  async claim(worker: string, host: string, leaseMs = 30_000, companyId?: string): Promise<FleetOperationClaim | null> {
    leaseParameters(worker, host, leaseMs);
    return this.transaction(async (client) => {
      await lockFleetRevision(client);
      await client.query(`UPDATE fleet_operations SET worker_id=NULL,claim_token=NULL,lease_expires_at=NULL,
        version=version+1,updated_at=clock_timestamp() WHERE worker_id IS NOT NULL AND lease_expires_at<=clock_timestamp()
          AND ($1::text IS NULL OR company_id=$1)`, [companyId ?? null]);
      // One claimed operation per company: prepare and settle advance the company revision its in-flight steps re-check.
      const row = (await client.query<FleetOperationRow>(
        `SELECT operation.* FROM fleet_operations operation
          WHERE operation.executor_host=$1 AND operation.status IN ('queued','running','cancelling')
            AND ($4::text IS NULL OR operation.company_id=$4)
            AND (operation.lease_expires_at IS NULL OR operation.lease_expires_at<=now())
            AND NOT EXISTS (SELECT 1 FROM fleet_operations other WHERE other.id<>operation.id
              AND other.company_id=operation.company_id AND other.worker_id IS NOT NULL)
            AND (operation.cancel_requested OR operation.status='cancelling' OR NOT EXISTS (SELECT 1 FROM (SELECT metadata->'maintenance_deferred'->>'retry_at' AS retry_at
              FROM fleet_operation_events WHERE operation_id=operation.id AND event='renewed'
                AND metadata ? 'maintenance_deferred' ORDER BY id DESC LIMIT 1) deferred
              WHERE deferred.retry_at::timestamptz>clock_timestamp()))
            AND NOT EXISTS (SELECT 1 FROM (
              SELECT count(*) AS failures, max(failure.created_at) AS last_failure FROM fleet_operation_events failure
               WHERE failure.operation_id=operation.id AND failure.event='failed'
                 AND (failure.metadata->>'compensation'='true' OR failure.metadata->>'retirement'='true')
                 AND failure.id>COALESCE((SELECT max(marker.id) FROM fleet_operation_events marker WHERE marker.operation_id=operation.id
                   AND marker.event IN ('cancel_requested','resumed','step_completed','succeeded')),0)) backoff
              WHERE backoff.failures>0 AND backoff.last_failure
                +LEAST($2::double precision*power(2,backoff.failures-1),$3::double precision)*interval '1 millisecond'>clock_timestamp())
          ORDER BY operation.created_at,operation.id LIMIT 1 FOR UPDATE OF operation SKIP LOCKED`,
        [host, FLEET_COMPENSATION_BACKOFF_BASE_MS, FLEET_COMPENSATION_BACKOFF_CAP_MS, companyId ?? null])).rows[0];
      if (!row) return null;
      try {
        await loadFleetOrigin(client, row);
        if (await cancelStaleMaintenance(client, row)) return null;
        await assertFleetOperationAuthority(client, row);
      }
      catch (error) {
        if (!(error instanceof FleetOperationError) || error.code !== 'forbidden') throw error;
        const pendingRollback = row.status === 'cancelling' && await fleetRollbackIntent(client, row.id) !== undefined;
        const pendingRetirement = await fleetReplacementCommit(client, row.id) !== undefined;
        const failed = (await client.query<FleetOperationRow>(
          `UPDATE fleet_operations SET status=CASE WHEN $2 THEN 'cancelling' WHEN $3 THEN 'running' ELSE 'failed' END,version=version+1,
           error='{"code":"AUTHORITY_REVOKED","retryable":false}',worker_id=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 RETURNING *`, [row.id, pendingRollback, pendingRetirement])).rows[0];
        if (failed) await recordFleetEvent(client, row.id, Number(failed.version), 'failed', { code: 'AUTHORITY_REVOKED',
          ...(pendingRollback ? { compensation: true } : {}), ...(pendingRetirement ? { retirement: true } : {}) });
        return null;
      }
      const token = randomUUID();
      const next = (await client.query<FleetOperationRow>(
        `UPDATE fleet_operations SET status=CASE WHEN cancel_requested OR status='cancelling' THEN 'cancelling' ELSE 'running' END,
           worker_id=$2,claim_token=$3,epoch=epoch+1,lease_expires_at=now()+$4::integer*interval '1 millisecond',
           version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, worker, token, leaseMs])).rows[0];
      if (!next) throw new Error('fleet operation claim returned no row');
      await recordFleetEvent(client, row.id, Number(next.version), 'claimed', { worker_id: worker, epoch: Number(next.epoch),
        ...(next.status === 'cancelling' ? { cancelling: true } : {}) });
      return { operation: publicFleetOperation(await loadFleetOrigin(client, next)), request: next.request, worker_id: worker, claim_token: token, epoch: Number(next.epoch) };
    });
  }
  /** A renewal past the step bound fails the operation, so a stalled host releases its company's fleet. */
  async renew(claim: FleetOperationClaim, leaseMs = 30_000): Promise<boolean> {
    leaseParameters(claim.worker_id, 'renew', leaseMs);
    const outcome = await this.transaction(async (client): Promise<{ renewed: boolean; overdue?: FleetError }> => {
      const row = (await client.query<FleetOperationRow>(
        `SELECT * FROM fleet_operations WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND epoch=$4
          AND lease_expires_at>clock_timestamp() AND status IN ('running','cancelling') FOR UPDATE`,
        [claim.operation.id, claim.worker_id, claim.claim_token, claim.epoch])).rows[0];
      if (!row) return { renewed: false };
      try { await assertFleetOperationAuthority(client, row); }
      catch (error) { if (error instanceof FleetOperationError && error.code === 'forbidden') return { renewed: false }; throw error; }
      const overdue = (await client.query<{ overdue: boolean }>(
        `SELECT clock_timestamp()+$2::integer*interval '1 millisecond'>max(created_at)+$3::integer*interval '1 millisecond' AS overdue
          FROM fleet_operation_events WHERE operation_id=$1 AND event IN ('claimed','step_started','step_completed')`,
        [row.id, leaseMs, this.stepMaxMs])).rows[0]?.overdue !== false;
      if (overdue) {
        const step = row.steps.find(candidate => candidate.status === 'running')?.name;
        return { renewed: false, overdue: { code: 'HOST_UNAVAILABLE', retryable: true, ...(step === undefined ? {} : { step }) } };
      }
      const renewed = await client.query(`UPDATE fleet_operations SET lease_expires_at=clock_timestamp()+$2::integer*interval '1 millisecond'
        WHERE id=$1 AND lease_expires_at>clock_timestamp()`, [row.id, leaseMs]);
      return { renewed: renewed.rowCount === 1 };
    });
    if (outcome.overdue !== undefined) {
      try { await this.fail(claim, outcome.overdue); }
      catch (error) { if (!(error instanceof FleetOperationError)) throw error; }
    }
    return outcome.renewed;
  }
}
