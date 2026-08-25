const kinds = ['wake', 'origin_relay'];
const statuses = ['pending', 'processing', 'sent', 'failed', 'dead'];

function number(value) {
  if (value === undefined || value === null) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('outbox metric query returned a non-finite or negative value');
  }
  return parsed;
}

function exactRow(row, source) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${source} query returned a malformed row`);
  }
  return row;
}

/** Exact, label-bounded exporter core kept independent from the runtime-only store bundle. */
export async function collectOutboxMetrics(pool) {
  const [depth, oldest, deadLetters] = await Promise.all([
    pool.query(`SELECT kind, status, count(*)::bigint AS value
      FROM adapter_outbox GROUP BY kind, status`),
    pool.query(`SELECT kind, status,
        extract(epoch FROM greatest(interval '0 seconds', now() - min(created_at)))::float8 AS value
      FROM adapter_outbox WHERE status IN ('pending','processing','failed') GROUP BY kind, status`),
    pool.query(`SELECT kind, count(*)::bigint AS value
      FROM outbox_dead_letters WHERE resolved_at IS NULL GROUP BY kind`),
  ]);
  const depthMap = new Map(depth.rows.map((candidate) => {
    const row = exactRow(candidate, 'depth');
    if (!kinds.includes(row.kind) || !statuses.includes(row.status)) {
      throw new Error('depth query returned an unknown outbox kind or status');
    }
    return [`${row.kind}:${row.status}`, number(row.value)];
  }));
  const oldestMap = new Map(oldest.rows.map((candidate) => {
    const row = exactRow(candidate, 'oldest');
    if (!kinds.includes(row.kind) || !['pending', 'processing', 'failed'].includes(row.status)) {
      throw new Error('oldest query returned an unknown outbox kind or status');
    }
    return [`${row.kind}:${row.status}`, number(row.value)];
  }));
  const deadMap = new Map(deadLetters.rows.map((candidate) => {
    const row = exactRow(candidate, 'dead-letter');
    if (!kinds.includes(row.kind)) throw new Error('dead-letter query returned an unknown outbox kind');
    return [row.kind, number(row.value)];
  }));
  const lines = [
    '# HELP cauce_outbox_query_success Whether exact PostgreSQL outbox gauges were collected.',
    '# TYPE cauce_outbox_query_success gauge',
    'cauce_outbox_query_success 1',
    '# HELP cauce_outbox_depth Adapter outbox rows by durable kind and status.',
    '# TYPE cauce_outbox_depth gauge',
  ];
  for (const kind of kinds) for (const status of statuses) {
    lines.push(`cauce_outbox_depth{kind="${kind}",status="${status}"} ${depthMap.get(`${kind}:${status}`) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_oldest_seconds Age of the oldest unfinished adapter outbox row.',
    '# TYPE cauce_outbox_oldest_seconds gauge',
  );
  for (const kind of kinds) for (const status of ['pending', 'processing', 'failed']) {
    lines.push(`cauce_outbox_oldest_seconds{kind="${kind}",status="${status}"} ${oldestMap.get(`${kind}:${status}`) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_dead_letters_open Open adapter outbox dead letters.',
    '# TYPE cauce_outbox_dead_letters_open gauge',
  );
  for (const kind of kinds) lines.push(`cauce_outbox_dead_letters_open{kind="${kind}"} ${deadMap.get(kind) ?? 0}`);
  return `${lines.join('\n')}\n`;
}
