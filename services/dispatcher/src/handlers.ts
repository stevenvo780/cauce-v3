import type { Lane } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';

export interface ClaimedJob extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly kind: string;
  readonly lane: Lane;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claim_token: string;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Explicit allow-list of executable job kinds. There is deliberately no fallback handler. */
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): this {
    const normalized = kind.trim();
    if (!normalized || normalized !== kind) throw new Error('job kind must be a non-empty normalized string');
    if (this.handlers.has(normalized)) throw new Error(`duplicate job handler: ${normalized}`);
    this.handlers.set(normalized, handler);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }
}

export function asClaimedJob(value: Readonly<Record<string, unknown>>): ClaimedJob {
  const { id, kind, lane, payload, claim_token: claimToken } = value;
  if (typeof id !== 'string' || !id) throw new Error('claimed job has no string id');
  if (typeof kind !== 'string' || !kind) throw new Error(`claimed job ${id} has no kind`);
  if (lane !== 'interactive' && lane !== 'batch') throw new Error(`claimed job ${id} has an invalid lane`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`claimed job ${id} has an invalid payload`);
  if (typeof claimToken !== 'string' || !claimToken) throw new Error(`claimed job ${id} has no claim token`);
  return value as ClaimedJob;
}

/**
 * Runtime-owned handlers. Agent/model execution is intentionally absent: adapters, not the
 * dispatcher, own that boundary. The QA handler performs strict fixture validation and exists
 * only under NODE_ENV=test so a test job can never become a production no-op.
 */
export function createDefaultJobHandlerRegistry(
  pool: DatabasePool,
  environment = process.env.NODE_ENV,
): JobHandlerRegistry {
  const registry = new JobHandlerRegistry();
  registry.register('system.database.probe', async () => {
    await pool.query('SELECT 1');
  });
  if (environment === 'test') {
    registry.register('qa.fairness', async (job) => validateQaFixture(job));
  }
  return registry;
}

function validateQaFixture(job: ClaimedJob): Promise<void> {
  const index = job.payload.index;
  if (!Number.isSafeInteger(index) || Number(index) < 0) {
    throw new Error('qa.fairness payload.index must be a non-negative integer');
  }
  return Promise.resolve();
}
