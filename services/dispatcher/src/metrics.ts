import type { DatabasePool } from '@cauce/store';

type Lane = 'interactive' | 'batch';
type JobResult = 'done' | 'retry' | 'dead' | 'fenced' | 'unknown_kind';

interface CountRow {
  lane: Lane;
  status?: string;
  target?: string;
  count: string;
  oldest_seconds?: number | string;
}

const lanes: readonly Lane[] = ['interactive', 'batch'];
const deliveryStates = ['pending', 'retry', 'leased', 'accepted', 'started', 'done', 'failed', 'dead'] as const;
const relayStates = ['pending', 'processing', 'sent', 'failed', 'dead'] as const;

/** Process counters plus exact, scrape-time PostgreSQL gauges. No tenant or payload labels. */
export class DispatcherMetrics {
  private readonly jobResults = new Map<string, number>();
  private readonly ticks = new Map<'ok' | 'error', number>([['ok', 0], ['error', 0]]);

  constructor(private readonly pool: DatabasePool) {}

  recordTick(result: 'ok' | 'error'): void {
    this.ticks.set(result, (this.ticks.get(result) ?? 0) + 1);
  }

  recordJob(lane: Lane, result: JobResult): void {
    const key = `${lane}:${result}`;
    this.jobResults.set(key, (this.jobResults.get(key) ?? 0) + 1);
  }

  async render(databaseAllowed = true): Promise<string> {
    const lines = [
      '# HELP cauce_dispatcher_ticks_total Dispatcher polling ticks by result.',
      '# TYPE cauce_dispatcher_ticks_total counter',
      ...(['ok', 'error'] as const).map((result) => `cauce_dispatcher_ticks_total{result="${result}"} ${this.ticks.get(result) ?? 0}`),
      '# HELP cauce_dispatcher_jobs_processed_total Jobs whose registered handler was selected, by outcome.',
      '# TYPE cauce_dispatcher_jobs_processed_total counter',
    ];
    for (const lane of lanes) {
      for (const result of ['done', 'retry', 'dead', 'fenced', 'unknown_kind'] as const) {
        lines.push(`cauce_dispatcher_jobs_processed_total{lane="${lane}",result="${result}"} ${this.jobResults.get(`${lane}:${result}`) ?? 0}`);
      }
    }

    if (!databaseAllowed) {
      lines.push('# HELP cauce_dispatcher_metrics_query_success Whether exact PostgreSQL gauges were collected.');
      lines.push('# TYPE cauce_dispatcher_metrics_query_success gauge');
      lines.push('cauce_dispatcher_metrics_query_success 0');
      return `${lines.join('\n')}\n`;
    }

    try {
      const [jobs, jobOldest, deliveries, deliveryOldest, dlq, jobLeases, deliveryLeases, consumerLeases, relays, relayOldest] = await Promise.all([
        this.pool.query<CountRow>(`SELECT lane,status,count(*)::text AS count FROM jobs GROUP BY lane,status`),
        this.pool.query<CountRow>(`SELECT lane,count(*)::text AS count,
          COALESCE(extract(epoch FROM now()-min(created_at)),0)::float8 AS oldest_seconds
          FROM jobs WHERE status='queued' GROUP BY lane`),
        this.pool.query<CountRow>(`SELECT m.lane,d.status,count(*)::text AS count
          FROM deliveries d JOIN messages m ON m.id=d.message_id GROUP BY m.lane,d.status`),
        this.pool.query<CountRow>(`SELECT m.lane,d.status,count(*)::text AS count,
          COALESCE(extract(epoch FROM now()-min(d.created_at)),0)::float8 AS oldest_seconds
          FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('pending','retry','leased','accepted','started') GROUP BY m.lane,d.status`),
        this.pool.query<CountRow>(`SELECT COALESCE(j.lane,m.lane)::text AS lane,
          CASE WHEN dl.job_id IS NULL THEN 'delivery' ELSE 'job' END AS target,count(*)::text AS count
          FROM dead_letters dl LEFT JOIN jobs j ON j.id=dl.job_id
          LEFT JOIN deliveries d ON d.id=dl.delivery_id LEFT JOIN messages m ON m.id=d.message_id
          WHERE dl.resolved_at IS NULL GROUP BY COALESCE(j.lane,m.lane),target`),
        this.pool.query<CountRow>(`SELECT lane,count(*)::text AS count FROM jobs
          WHERE status='running' AND lease_until>now() GROUP BY lane`),
        this.pool.query<CountRow>(`SELECT m.lane,count(*)::text AS count FROM deliveries d
          JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('leased','accepted','started') AND d.claim_expires_at>now() GROUP BY m.lane`),
        this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM connection_leases WHERE lease_until>now()`),
        this.pool.query<CountRow>(`SELECT m.lane,o.status,count(*)::text AS count FROM adapter_outbox o
          JOIN messages m ON m.id=o.message_id WHERE o.kind='origin_relay' GROUP BY m.lane,o.status`),
        this.pool.query<CountRow>(`SELECT m.lane,o.status,count(*)::text AS count,
          COALESCE(extract(epoch FROM now()-min(o.created_at)),0)::float8 AS oldest_seconds
          FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
          WHERE o.kind='origin_relay' AND o.status IN ('pending','processing','failed') GROUP BY m.lane,o.status`),
      ]);

      lines.push('# HELP cauce_dispatcher_metrics_query_success Whether exact PostgreSQL gauges were collected.');
      lines.push('# TYPE cauce_dispatcher_metrics_query_success gauge');
      lines.push('cauce_dispatcher_metrics_query_success 1');
      appendMatrix(lines, 'cauce_dispatcher_job_queue_depth', 'Queued jobs currently stored.', lanes, ['queued'], jobs.rows);
      appendOldest(lines, 'cauce_dispatcher_job_oldest_seconds', 'Age of the oldest queued job.', lanes, ['queued'], jobOldest.rows);
      appendMatrix(lines, 'cauce_dispatcher_delivery_queue_depth', 'Deliveries currently stored by durable state.', lanes, deliveryStates, deliveries.rows);
      appendOldest(lines, 'cauce_dispatcher_delivery_oldest_seconds', 'Age of oldest non-terminal delivery by state.', lanes, ['pending', 'retry', 'leased', 'accepted', 'started'], deliveryOldest.rows);
      appendTargetMatrix(lines, dlq.rows);
      appendLaneGauge(lines, 'cauce_dispatcher_job_leases_active', 'Non-expired running job leases.', jobLeases.rows);
      appendLaneGauge(lines, 'cauce_dispatcher_delivery_leases_active', 'Non-expired delivery claim leases.', deliveryLeases.rows);
      lines.push('# HELP cauce_dispatcher_consumer_leases_active Non-expired consumer identity leases.');
      lines.push('# TYPE cauce_dispatcher_consumer_leases_active gauge');
      lines.push(`cauce_dispatcher_consumer_leases_active ${number(consumerLeases.rows[0]?.count)}`);
      appendMatrix(lines, 'cauce_dispatcher_origin_relay_depth', 'Origin relay rows by durable status.', lanes, relayStates, relays.rows);
      appendOldest(lines, 'cauce_dispatcher_origin_relay_oldest_seconds', 'Age of oldest unfinished origin relay.', lanes, ['pending', 'processing', 'failed'], relayOldest.rows);
    } catch {
      lines.push('# HELP cauce_dispatcher_metrics_query_success Whether exact PostgreSQL gauges were collected.');
      lines.push('# TYPE cauce_dispatcher_metrics_query_success gauge');
      lines.push('cauce_dispatcher_metrics_query_success 0');
    }
    return `${lines.join('\n')}\n`;
  }
}

function appendMatrix(
  lines: string[], name: string, help: string, laneValues: readonly Lane[], states: readonly string[], rows: readonly CountRow[],
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const lane of laneValues) for (const status of states) {
    const row = rows.find((candidate) => candidate.lane === lane && candidate.status === status);
    lines.push(`${name}{lane="${lane}",status="${status}"} ${number(row?.count)}`);
  }
}

function appendOldest(
  lines: string[], name: string, help: string, laneValues: readonly Lane[], states: readonly string[], rows: readonly CountRow[],
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const lane of laneValues) for (const status of states) {
    const row = rows.find((candidate) => candidate.lane === lane && candidate.status === status);
    lines.push(`${name}{lane="${lane}",status="${status}"} ${number(row?.oldest_seconds)}`);
  }
}

function appendTargetMatrix(lines: string[], rows: readonly CountRow[]): void {
  const name = 'cauce_dispatcher_dlq_depth';
  lines.push(`# HELP ${name} Unresolved dead letters by target and lane.`);
  lines.push(`# TYPE ${name} gauge`);
  for (const lane of lanes) for (const target of ['delivery', 'job']) {
    const row = rows.find((candidate) => candidate.lane === lane && candidate.target === target);
    lines.push(`${name}{lane="${lane}",target="${target}"} ${number(row?.count)}`);
  }
}

function appendLaneGauge(lines: string[], name: string, help: string, rows: readonly CountRow[]): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const lane of lanes) {
    lines.push(`${name}{lane="${lane}"} ${number(rows.find((row) => row.lane === lane)?.count)}`);
  }
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
