import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_STATE_BYTES = 8 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const EXACT_KEYS = [
  'kind',
  'mode',
  'releaseId',
  'schemaVersion',
  'snapshotPath',
  'snapshotSha256',
  'updatedAt',
  'writersExpected',
  'writersObserved',
];

function safeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`release state ${name} is invalid`);
  }
  return value;
}

function canonical(value) {
  return `${JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))}\n`;
}

function parseReleaseState(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('release state is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release state is not an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== EXACT_KEYS.length
      || keys.some((key, index) => key !== [...EXACT_KEYS].sort()[index])) {
    throw new Error('release state fields do not match schema version 1');
  }
  if (canonical(value) !== content) throw new Error('release state is not canonical JSON');
  if (value.kind !== 'cauce-v3-release-state' || value.schemaVersion !== 1) {
    throw new Error('release state kind or schema version is invalid');
  }
  if (value.mode !== 'candidate' && value.mode !== 'rollback_bridge_degraded') {
    throw new Error('release state mode is invalid');
  }
  if (typeof value.releaseId !== 'string' || !RELEASE_ID.test(value.releaseId)) {
    throw new Error('release state release ID is invalid');
  }
  if (typeof value.snapshotPath !== 'string' || !isAbsolute(value.snapshotPath)
      || value.snapshotPath.includes('\u0000')) {
    throw new Error('release state snapshot path is invalid');
  }
  if (typeof value.snapshotSha256 !== 'string' || !SHA256.test(value.snapshotSha256)) {
    throw new Error('release state snapshot hash is invalid');
  }
  if (typeof value.updatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value.updatedAt)
      || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('release state timestamp is invalid');
  }
  const writersExpected = safeCount(value.writersExpected, 'writersExpected');
  const writersObserved = safeCount(value.writersObserved, 'writersObserved');
  if (writersExpected !== writersObserved) {
    throw new Error('release state writer count differs from the observed fleet');
  }
  if (value.mode === 'rollback_bridge_degraded' && writersObserved !== 0) {
    throw new Error('release state rollback bridge declares active external writers');
  }
  return { mode: value.mode, writersExpected, writersObserved };
}


/** Read a single, immutable-at-open marker and expose only aggregate, label-free gauges. */
export async function collectReleaseStateMetrics(path, activeConnectionLeases) {
  const activeLeases = safeCount(activeConnectionLeases, 'activeConnectionLeases');
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) {
    throw new Error('CAUCE_RELEASE_STATE_FILE must be an absolute path');
  }
  const flags = fsConstants.O_RDONLY | fsConstants.O_CLOEXEC
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_STATE_BYTES) {
      throw new Error('release state file metadata is invalid');
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('release state changed while it was read');
    }
    const state = parseReleaseState(content);
    const degraded = state.mode === 'rollback_bridge_degraded' ? 1 : 0;
    return [
      '# HELP cauce_release_state_valid Whether the durable release writer marker passed its exact schema and invariants.',
      '# TYPE cauce_release_state_valid gauge',
      'cauce_release_state_valid 1',
      '# HELP cauce_release_rollback_bridge_degraded Whether Cauce is intentionally running the central-only rollback bridge.',
      '# TYPE cauce_release_rollback_bridge_degraded gauge',
      `cauce_release_rollback_bridge_degraded ${degraded}`,
      '# HELP cauce_release_writers_expected External writer processes expected by the durable release snapshot.',
      '# TYPE cauce_release_writers_expected gauge',
      `cauce_release_writers_expected ${state.writersExpected}`,
      '# HELP cauce_release_writers_declared External writers declared by the durable release transition marker.',
      '# TYPE cauce_release_writers_declared gauge',
      `cauce_release_writers_declared ${state.writersObserved}`,
      '# HELP cauce_release_writer_leases_active Connection leases observed directly in PostgreSQL at scrape time.',
      '# TYPE cauce_release_writer_leases_active gauge',
      `cauce_release_writer_leases_active ${activeLeases}`,
      '',
    ].join('\n');
  } finally {
    await handle.close();
  }
}

export async function activeConnectionLeaseCount(pool) {
  const result = await pool.query(
    'SELECT count(*)::text AS count FROM connection_leases WHERE lease_until > now()',
  );
  if (result.rowCount !== 1 || result.rows.length !== 1 || typeof result.rows[0]?.count !== 'string'
      || !/^\d+$/u.test(result.rows[0].count)) {
    throw new Error('active connection lease count is invalid');
  }
  const count = Number(result.rows[0].count);
  if (!Number.isSafeInteger(count) || count > 10_000) {
    throw new Error('active connection lease count is invalid');
  }
  return count;
}
