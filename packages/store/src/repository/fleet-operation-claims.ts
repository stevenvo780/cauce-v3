import { randomUUID } from 'node:crypto';
import { withTransaction, type DatabasePool } from '../db.js';
import { lockFleetRevision, recordFleetEvent } from './fleet-operation-authority.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationClaim, type FleetOperationRow } from './fleet-operation-contracts.js';
import { assertFleetOperationAuthority, loadFleetOrigin } from './fleet-operation-human.js';

function leaseParameters(worker: string, host: string, leaseMs: number): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(host)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
    throw new FleetOperationError('invalid_input', 'fleet worker lease parameters are invalid');
  }
}
export abstract class FleetOperationClaims {
  constructor(protected readonly pool: DatabasePool) {}
  async claim(worker: string, host: string, leaseMs = 30_000): Promise<FleetOperationClaim | null> {
    leaseParameters(worker, host, leaseMs);
    return withTransaction(this.pool, async (client) => {
      await lockFleetRevision(client);
      await client.query(`UPDATE fleet_operations SET worker_id=NULL,claim_token=NULL,lease_expires_at=NULL,
        version=version+1,updated_at=clock_timestamp() WHERE worker_id IS NOT NULL AND lease_expires_at<=clock_timestamp()`);
      const row = (await client.query<FleetOperationRow>(
        `SELECT operation.* FROM fleet_operations operation
          WHERE operation.executor_host=$1 AND operation.status IN ('queued','running','cancelling')
            AND (operation.lease_expires_at IS NULL OR operation.lease_expires_at<=now())
            AND NOT EXISTS (SELECT 1 FROM fleet_operations other WHERE other.id<>operation.id
              AND other.cohort_key=operation.cohort_key AND other.worker_id IS NOT NULL)
          ORDER BY operation.created_at,operation.id LIMIT 1 FOR UPDATE OF operation SKIP LOCKED`, [host])).rows[0];
      if (!row) return null;
      try { await assertFleetOperationAuthority(client, row); }
      catch (error) {
        if (!(error instanceof FleetOperationError) || error.code !== 'forbidden') throw error;
        const failed = (await client.query<FleetOperationRow>(
          `UPDATE fleet_operations SET status='failed',version=version+1,
           error='{"code":"AUTHORITY_REVOKED","retryable":false}',worker_id=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 RETURNING *`, [row.id])).rows[0];
        if (failed) await recordFleetEvent(client, row.id, Number(failed.version), 'failed', { code: 'AUTHORITY_REVOKED' });
        return null;
      }
      const token = randomUUID();
      const next = (await client.query<FleetOperationRow>(
        `UPDATE fleet_operations SET status=CASE WHEN cancel_requested THEN 'cancelling' ELSE 'running' END,
           worker_id=$2,claim_token=$3,epoch=epoch+1,lease_expires_at=now()+$4::integer*interval '1 millisecond',
           version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, worker, token, leaseMs])).rows[0];
      if (!next) throw new Error('fleet operation claim returned no row');
      await recordFleetEvent(client, row.id, Number(next.version), 'claimed', { worker_id: worker, epoch: Number(next.epoch) });
      return { operation: publicFleetOperation(await loadFleetOrigin(client, next)), request: next.request, worker_id: worker, claim_token: token, epoch: Number(next.epoch) };
    });
  }
  async renew(claim: FleetOperationClaim, leaseMs = 30_000): Promise<boolean> {
    leaseParameters(claim.worker_id, 'renew', leaseMs);
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<FleetOperationRow>(
        `SELECT * FROM fleet_operations WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND epoch=$4
          AND lease_expires_at>clock_timestamp() AND status IN ('running','cancelling') FOR UPDATE`,
        [claim.operation.id, claim.worker_id, claim.claim_token, claim.epoch])).rows[0];
      if (!row) return false;
      try { await assertFleetOperationAuthority(client, row); }
      catch (error) { if (error instanceof FleetOperationError && error.code === 'forbidden') return false; throw error; }
      const renewed = await client.query(`UPDATE fleet_operations SET lease_expires_at=clock_timestamp()+$2::integer*interval '1 millisecond'
        WHERE id=$1 AND lease_expires_at>clock_timestamp()`, [row.id, leaseMs]);
      return renewed.rowCount === 1;
    });
  }
}
