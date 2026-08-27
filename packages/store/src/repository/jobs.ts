import type { Tenant } from '@cauce/protocol';
import { withTransaction } from '../db.js';
import { StoreError } from './errors.js';
import { ObservabilityRepository } from './observability.js';

export interface JobClaim extends Record<string, unknown> {
  id: string;
  tenant_id: Tenant;
  lane: 'interactive' | 'batch';
  status: 'running';
  attempts: number;
  claimed_by: string;
  claim_token: string;
  lease_until: Date;
}

export abstract class JobsRepository extends ObservabilityRepository {
  async enqueueJob(tenantId: Tenant, lane: 'interactive' | 'batch', priority: number, kind: string, payload: Record<string, unknown>): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO jobs(tenant_id,lane,priority,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [tenantId, lane, priority, kind, JSON.stringify(payload)]
    );
    return result.rows[0]!.id;
  }

  async claimJobs(lane: 'interactive' | 'batch', worker: string, limit = 1, leaseMs = 30_000): Promise<JobClaim[]> {
    if (limit < 1 || leaseMs <= 0) throw new StoreError('conflict', 'job lease and limit must be positive');
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<JobClaim>(
        `WITH picked AS (
           SELECT id FROM jobs WHERE lane=$1 AND status='queued' AND available_at<=now()
            ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT $3
          ) UPDATE jobs j SET status='running',attempts=j.attempts+1,claimed_by=$2,claimed_at=now(),
              claim_token=gen_random_uuid(),lease_until=now()+$4*interval '1 millisecond',updated_at=now()
            FROM picked p WHERE j.id=p.id RETURNING j.*`, [lane, worker, limit, leaseMs]
      );
      return result.rows;
    });
  }

  async claimFairJobs(
    worker: string,
    limit = 1,
    leaseMs = 30_000,
    interactiveBurst = 3,
    scope = 'global'
  ): Promise<JobClaim[]> {
    if (limit < 1 || leaseMs <= 0 || interactiveBurst < 1) {
      throw new StoreError('conflict', 'fair job claim limits must be positive');
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO job_lane_fairness(scope) VALUES($1) ON CONFLICT(scope) DO NOTHING`, [scope]
      );
      const fairness = await client.query<{ interactive_streak: number }>(
        `SELECT interactive_streak FROM job_lane_fairness WHERE scope=$1 FOR UPDATE`, [scope]
      );
      let interactiveStreak = fairness.rows[0]?.interactive_streak ?? 0;
      const jobs: JobClaim[] = [];
      for (let index = 0; index < Math.min(limit, 100); index += 1) {
        const availability = await client.query<{ interactive: boolean; batch: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM jobs WHERE lane='interactive' AND status='queued' AND available_at<=now()) AS interactive,
             EXISTS(SELECT 1 FROM jobs WHERE lane='batch' AND status='queued' AND available_at<=now()) AS batch`
        );
        const available = availability.rows[0];
        if (!available || (!available.interactive && !available.batch)) break;
        const lane: 'interactive' | 'batch' = available.batch
          && (!available.interactive || interactiveStreak >= interactiveBurst) ? 'batch' : 'interactive';
        const claimed = await client.query<JobClaim>(
          `WITH picked AS (
             SELECT id FROM jobs WHERE lane=$1 AND status='queued' AND available_at<=now()
             ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT 1
           ) UPDATE jobs j SET status='running',attempts=j.attempts+1,claimed_by=$2,
               claimed_at=now(),claim_token=gen_random_uuid(),
               lease_until=now()+$3*interval '1 millisecond',updated_at=now()
             FROM picked p WHERE j.id=p.id RETURNING j.*`, [lane, worker, leaseMs]
        );
        const job = claimed.rows[0];
        if (!job) continue;
        jobs.push(job);
        interactiveStreak = lane === 'interactive' ? interactiveStreak + 1 : 0;
      }
      await client.query(
        `UPDATE job_lane_fairness SET interactive_streak=$2,updated_at=now() WHERE scope=$1`,
        [scope, interactiveStreak]
      );
      return jobs;
    });
  }

  async completeJob(id: string, worker: string, claimToken?: string): Promise<boolean> {
    if (!claimToken) return false;
    const result = await this.pool.query(
      `UPDATE jobs SET status='done',lease_until=NULL,updated_at=now()
       WHERE id=$1 AND claimed_by=$2 AND claim_token=$3 AND status='running' AND lease_until>now()`,
      [id, worker, claimToken]
    );
    return result.rowCount === 1;
  }

  async failJob(id: string, worker: string, error: string, claimToken?: string): Promise<'retry' | 'dead' | 'fenced'> {
    if (!claimToken) return 'fenced';
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{
        id: string; tenant_id: Tenant; payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,payload,attempts,max_attempts FROM jobs
         WHERE id=$1 AND claimed_by=$2 AND claim_token=$3 AND status='running'
           AND lease_until>now() FOR UPDATE`, [id, worker, claimToken]
      );
      const job = result.rows[0];
      if (!job) return 'fenced';
      if (job.attempts >= job.max_attempts) {
        await client.query(
          `UPDATE jobs SET status='dead',lease_until=NULL,claim_token=NULL,last_error=$2,updated_at=now()
           WHERE id=$1`,
          [id, error.slice(0, 2_000)]
        );
        await client.query(
          `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
           VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(job_id) DO NOTHING`,
          [id, job.tenant_id, error.slice(0, 2_000), JSON.stringify(job.payload), job.attempts]
        );
        return 'dead';
      }
      const backoffSeconds = Math.min(300, 2 ** Math.max(0, job.attempts - 1));
      await client.query(
         `UPDATE jobs SET status='queued',available_at=now()+$2*interval '1 second',last_error=$3,
            claimed_by=NULL,claimed_at=NULL,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [id, backoffSeconds, error.slice(0, 2_000)]
      );
      return 'retry';
    });
  }

  async retryExpiredJobs(limit = 100): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; attempts: number; max_attempts: number; tenant_id: Tenant; payload: Record<string, unknown> }>(
        `SELECT id,attempts,max_attempts,tenant_id,payload FROM jobs
         WHERE status='running' AND lease_until<now()
         ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      for (const job of result.rows) {
        if (job.attempts >= job.max_attempts) {
          await client.query(
            `UPDATE jobs SET status='dead',lease_until=NULL,claim_token=NULL,
             last_error='job lease expired: max attempts exhausted',
             updated_at=now() WHERE id=$1`, [job.id]
          );
          await client.query(
            `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,'job lease expired: max attempts exhausted',$3::jsonb,$4)
             ON CONFLICT(job_id) DO NOTHING`, [job.id, job.tenant_id, JSON.stringify(job.payload), job.attempts]
          );
        } else {
          const delay = Math.min(300, 2 ** Math.max(0, job.attempts - 1));
          await client.query(
            `UPDATE jobs SET status='queued',available_at=now()+$2*interval '1 second',
              last_error='job lease expired',claimed_by=NULL,claim_token=NULL,
             claimed_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, delay]
          );
        }
      }
      return result.rows.length;
    });
  }

  async listJobs(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS job_id,tenant_id,lane,kind,status,priority,attempts,claimed_by,claimed_at,created_at,updated_at
       FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [actorTenant, limit]
    );
    return { items: result.rows };
  }
}
