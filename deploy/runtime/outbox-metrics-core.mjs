const kinds = ['wake', 'origin_relay'];
const statuses = ['pending', 'processing', 'sent', 'failed', 'dead'];
const dispositions = [
  'ambiguous', 'safe_retry', 'missing_final', 'auth', 'expected_offline', 'unclassified',
];

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

function exactBoolean(value, source) {
  if (value === true || value === 'true' || value === 't') return true;
  if (value === false || value === 'false' || value === 'f') return false;
  throw new Error(`${source} query returned a malformed actionable flag`);
}

function dlqKey(kind, disposition, actionable) {
  return `${kind}:${disposition}:${String(actionable)}`;
}

/** Exact, label-bounded exporter core kept independent from the runtime-only store bundle. */
export async function collectOutboxMetrics(pool) {
  const [depth, oldest, deadLetters, newDeadLetters, oldestActionable] = await Promise.all([
    pool.query(`SELECT kind, status, count(*)::bigint AS value
      FROM adapter_outbox GROUP BY kind, status`),
    pool.query(`SELECT kind, status,
        extract(epoch FROM greatest(interval '0 seconds', now() - min(
          CASE
            WHEN status IN ('pending','failed') THEN greatest(created_at,available_at)
            WHEN status='processing' THEN greatest(created_at,claim_expires_at)
          END
        )))::float8 AS value
      FROM adapter_outbox
      WHERE (status IN ('pending','failed') AND available_at<=now())
         OR (status='processing' AND claim_expires_at<=now())
      GROUP BY kind, status`),
    pool.query(`SELECT kind, disposition,
        (disposition<>'expected_offline') AS actionable,
        count(*)::bigint AS value
      FROM outbox_dead_letters WHERE resolved_at IS NULL
      GROUP BY kind, disposition, actionable`),
    pool.query(`SELECT kind, disposition,
        (disposition<>'expected_offline') AS actionable,
        count(*)::bigint AS value
      FROM outbox_dead_letters
      WHERE resolved_at IS NULL AND created_at>=now()-interval '10 minutes'
      GROUP BY kind, disposition, actionable`),
    pool.query(`SELECT kind, disposition,
        extract(epoch FROM greatest(interval '0 seconds',
          now()-min(COALESCE(disposition_at,created_at))))::float8 AS value
      FROM outbox_dead_letters
      WHERE resolved_at IS NULL AND disposition<>'expected_offline'
      GROUP BY kind, disposition`),
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
  const deadMap = new Map();
  const deadDispositionMap = new Map(deadLetters.rows.map((candidate) => {
    const row = exactRow(candidate, 'dead-letter');
    if (!kinds.includes(row.kind)) throw new Error('dead-letter query returned an unknown outbox kind');
    if (!dispositions.includes(row.disposition)) {
      throw new Error('dead-letter query returned an unknown disposition');
    }
    const actionable = exactBoolean(row.actionable, 'dead-letter');
    if (actionable !== (row.disposition !== 'expected_offline')) {
      throw new Error('dead-letter query returned an inconsistent actionable flag');
    }
    const value = number(row.value);
    deadMap.set(row.kind, (deadMap.get(row.kind) ?? 0) + value);
    return [dlqKey(row.kind, row.disposition, actionable), value];
  }));
  const newDeadMap = new Map(newDeadLetters.rows.map((candidate) => {
    const row = exactRow(candidate, 'new dead-letter');
    if (!kinds.includes(row.kind)) throw new Error('new dead-letter query returned an unknown outbox kind');
    if (!dispositions.includes(row.disposition)) {
      throw new Error('new dead-letter query returned an unknown disposition');
    }
    const actionable = exactBoolean(row.actionable, 'new dead-letter');
    if (actionable !== (row.disposition !== 'expected_offline')) {
      throw new Error('new dead-letter query returned an inconsistent actionable flag');
    }
    return [dlqKey(row.kind, row.disposition, actionable), number(row.value)];
  }));
  const oldestActionableMap = new Map(oldestActionable.rows.map((candidate) => {
    const row = exactRow(candidate, 'oldest actionable dead-letter');
    if (!kinds.includes(row.kind)) {
      throw new Error('oldest actionable dead-letter query returned an unknown outbox kind');
    }
    if (!dispositions.includes(row.disposition) || row.disposition === 'expected_offline') {
      throw new Error('oldest actionable dead-letter query returned an unknown or inactive disposition');
    }
    return [`${row.kind}:${row.disposition}`, number(row.value)];
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
    '# HELP cauce_outbox_dead_letters_open Unresolved adapter outbox incident inventory, including expected-offline history.',
    '# TYPE cauce_outbox_dead_letters_open gauge',
  );
  for (const kind of kinds) lines.push(`cauce_outbox_dead_letters_open{kind="${kind}"} ${deadMap.get(kind) ?? 0}`);
  lines.push(
    '# HELP cauce_outbox_dead_letters_open_by_disposition Unresolved adapter outbox incidents by durable disposition and actionability.',
    '# TYPE cauce_outbox_dead_letters_open_by_disposition gauge',
  );
  for (const kind of kinds) for (const disposition of dispositions) {
    const actionable = disposition !== 'expected_offline';
    lines.push(`cauce_outbox_dead_letters_open_by_disposition{kind="${kind}",disposition="${disposition}",actionable="${String(actionable)}"} ${deadDispositionMap.get(dlqKey(kind, disposition, actionable)) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_dead_letters_new Unresolved adapter outbox incidents created in the last ten minutes, classified by actionability.',
    '# TYPE cauce_outbox_dead_letters_new gauge',
  );
  for (const kind of kinds) for (const disposition of dispositions) {
    const actionable = disposition !== 'expected_offline';
    lines.push(`cauce_outbox_dead_letters_new{kind="${kind}",disposition="${disposition}",actionable="${String(actionable)}"} ${newDeadMap.get(dlqKey(kind, disposition, actionable)) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_dead_letter_oldest_actionable_seconds Age since creation or classification of the oldest unresolved actionable adapter outbox incident.',
    '# TYPE cauce_outbox_dead_letter_oldest_actionable_seconds gauge',
  );
  for (const kind of kinds) for (const disposition of dispositions) {
    if (disposition === 'expected_offline') continue;
    lines.push(`cauce_outbox_dead_letter_oldest_actionable_seconds{kind="${kind}",disposition="${disposition}"} ${oldestActionableMap.get(`${kind}:${disposition}`) ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
}
