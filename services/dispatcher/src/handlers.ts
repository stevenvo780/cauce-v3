import type { Lane } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';

interface ClaimedJob extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly kind: string;
  readonly lane: Lane;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claim_token: string;
}

type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Explicit allow-list of executable job kinds. There is deliberately no fallback handler, and a
 *  lookup must test own properties: the inherited members of `Object.prototype` are callable. */
export type JobHandlers = Readonly<Record<string, JobHandler>>;

export function asClaimedJob(value: Readonly<Record<string, unknown>>): ClaimedJob {
  const { id, kind, lane, payload, claim_token: claimToken } = value;
  if (typeof id !== 'string' || !id) throw new Error('claimed job has no string id');
  if (typeof kind !== 'string' || !kind) throw new Error(`claimed job ${id} has no kind`);
  if (lane !== 'interactive' && lane !== 'batch') throw new Error(`claimed job ${id} has an invalid lane`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`claimed job ${id} has an invalid payload`);
  if (typeof claimToken !== 'string' || !claimToken) throw new Error(`claimed job ${id} has no claim token`);
  return value as ClaimedJob;
}

/** Runtime-owned handlers. Agent/model execution is intentionally absent: adapters, not the
 *  dispatcher, own that boundary. The QA handler performs strict fixture validation and exists
 *  only under NODE_ENV=test so a test job can never become a production no-op. */
export function createDefaultJobHandlerRegistry(
  pool: DatabasePool,
  environment = process.env.NODE_ENV,
): JobHandlers {
  return Object.freeze({
    'system.database.probe': async (): Promise<void> => {
      await pool.query('SELECT 1');
    },
    ...(environment === 'test'
      ? { 'qa.fairness': async (job: ClaimedJob): Promise<void> => validateQaFixture(job) }
      : {}),
  });
}

function validateQaFixture(job: ClaimedJob): Promise<void> {
  const index = job.payload.index;
  if (!Number.isSafeInteger(index) || Number(index) < 0) {
    throw new Error('qa.fairness payload.index must be a non-negative integer');
  }
  return Promise.resolve();
}
