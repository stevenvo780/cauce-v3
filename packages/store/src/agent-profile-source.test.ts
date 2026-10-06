import { schemaBarrierReply, schemaBarrierStatements } from '../../../tests/helpers/schema-barrier.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRepository, type AgentProfileSourceGuard } from './agent-profile.js';
import type { DatabasePool } from './db.js';
import { agentContextReconcileLockKey } from './repository/agent-context-lock.js';
import { CONTEXT_WRITE_QUARANTINE_KIND } from './repository/agent-context-quarantine.js';

const actor = { tenant_id: 'Steven', alias: 'operator' };
const profile = { tenant_id: 'Steven', alias: 'helper', purpose: 'version from Git', role_summary: null,
  human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
const journalGuard: AgentProfileSourceGuard = { application_id: 'a'.repeat(64), expected_journal_id: '42',
  instance_id: 'fixture', commit: 'b'.repeat(40), tree: 'c'.repeat(40), profile_sha256: 'd'.repeat(64),
  source_journal_id: '30', source_revision: 2, operator_id: 'human' };

function database(overrides: { journal?: Record<string, unknown>; receipt?: unknown; current?: boolean;
  enabled?: boolean; failAudit?: boolean; failCommit?: boolean; cas?: boolean } = {}) {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (raw: string, params: readonly unknown[] = []) => {
    const sql = raw.replace(/\s+/gu, ' ').trim(); queries.push({ sql, params });
    const schema = schemaBarrierReply(sql, params);
    if (schema) return schema;
    if ((overrides.failAudit && sql.startsWith('INSERT INTO audit_events')) || (overrides.failCommit && sql === 'COMMIT')) throw new Error('synthetic failure');
    const rows = sql.startsWith('SELECT enabled') ? [{ enabled: overrides.enabled ?? true }]
      : sql.includes('FROM agent_profiles') ? overrides.current === false ? [] : [{ ...profile, purpose: 'current', revision: '4', applied_revision: '3' }]
      : sql.includes('FROM agent_profile_revisions') ? [overrides.journal ?? { id: '42', revision: '4', operation: 'update' }]
      : sql.includes('FROM audit_events') ? overrides.receipt === undefined ? [] : [{ revision: overrides.receipt }]
      : sql.startsWith('UPDATE agent_profiles') ? overrides.cas === false ? [] : [{ ...profile, revision: '5', applied_revision: '3' }]
      : [];
    return { rows, rowCount: rows.length };
  });
  const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
  return { pool: { query, connect: async () => client } as unknown as DatabasePool, queries };
}

const { source_journal_id: _sourceJournal, source_revision: _sourceRevision, ...identity } = journalGuard;
const authoredGuard: AgentProfileSourceGuard = { ...identity, source_kind: 'git_authored' };

describe.each([journalGuard, authoredGuard])('Git source guard in the existing profile CAS: %j', (guard) => {
  it('locks identity and profile before journal, then writes provenance atomically without bodies', async () => {
    const { pool, queries } = database();
    const result = await new AgentProfileRepository(pool).replace(profile, 4, actor, guard);
    expect(result.revision).toBe(5);
    const sql = queries.map((row) => row.sql);
    expect(sql.slice(0, 5)).toEqual(['BEGIN', ...schemaBarrierStatements]);
    expect(sql[5]).toContain('pg_advisory_xact_lock_shared');
    expect(queries[5]?.params).toEqual([agentContextReconcileLockKey('Steven', 'helper')]);
    expect(sql[6]).toContain('FROM jobs WHERE tenant_id=$1 AND kind=$2');
    expect(queries[6]?.params).toEqual(['Steven', CONTEXT_WRITE_QUARANTINE_KIND]);
    expect(sql[7]).toContain('FROM agents');
    expect(sql[8]).toMatch(/FROM agent_profiles.*FOR UPDATE/u);
    expect(sql.findIndex((value) => value.includes('FROM agent_profile_revisions')))
      .toBeLessThan(sql.findIndex((value) => value.startsWith('UPDATE agent_profiles')));
    const audit = queries.find((row) => row.sql.startsWith('INSERT INTO audit_events'));
    expect(audit?.params[3]).toContain('"context_source"');
    expect(audit?.params[3]).not.toContain(profile.purpose);
    expect(audit?.params[3]).toContain(guard.application_id);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it.each([
    { id: '43', revision: '4', operation: 'insert' },
    { id: '42', revision: '5', operation: 'update' },
    { id: '42', revision: '4', operation: 'delete' },
  ])('refuses stale/recreated/deleted identity before UPDATE: %j', async (journal) => {
    const { pool, queries } = database({ journal });
    await expect(new AgentProfileRepository(pool).replace(profile, 4, actor, guard)).rejects.toMatchObject({ code: 'conflict' });
    expect(queries.some((row) => row.sql.startsWith('UPDATE') || row.sql.startsWith('INSERT'))).toBe(false);
    expect(queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('replays a durable receipt across repository instances without another profile UPDATE', async () => {
    const { pool, queries } = database({ receipt: 5 });
    expect(await new AgentProfileRepository(pool).readSourceReceipt('Steven', 'helper', actor, guard.application_id))
      .toEqual({ application_id: guard.application_id, revision: 5 });
    const result = await new AgentProfileRepository(pool).replace(profile, 4, actor, guard);
    expect(result.source_receipt?.revision).toBe(5);
    expect(queries.some((row) => row.sql.startsWith('UPDATE') || row.sql.startsWith('INSERT'))).toBe(false);
    const read = queries.find((row) => row.sql.includes('FROM audit_events'));
    expect(read?.params).toEqual(['Steven', 'operator', 'Steven', 'helper', guard.application_id]);
  });

  it.each([{ current: false }, { enabled: false }, { cas: false }])('refuses unavailable targets: %j', async (config) => {
    const { pool, queries } = database(config);
    await expect(new AgentProfileRepository(pool).replace(profile, 4, actor, guard)).rejects.toBeInstanceOf(Error);
    expect(queries.some((row) => row.sql.startsWith('INSERT INTO audit_events'))).toBe(false);
  });

  it.each([{ failAudit: true }, { failCommit: true }])('does not return a successful receipt on transaction failure: %j', async (config) => {
    const { pool, queries } = database(config);
    await expect(new AgentProfileRepository(pool).replace(profile, 4, actor, guard)).rejects.toThrow('synthetic failure');
    expect(queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('retention loss cannot bypass the current journal fence', async () => {
    const { pool, queries } = database({ journal: { id: '43', revision: '5', operation: 'update' } });
    await expect(new AgentProfileRepository(pool).replace(profile, 4, actor, guard)).rejects.toMatchObject({ code: 'conflict' });
    expect(queries.some((row) => row.sql.startsWith('UPDATE'))).toBe(false);
  });

  it.each([null, 0, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid expected revision %j without I/O', async (revision) => {
    const { pool, queries } = database();
    await expect(new AgentProfileRepository(pool).replace(profile, revision, actor, guard)).rejects.toMatchObject({ code: 'conflict' });
    expect(queries).toEqual([]);
  });

  it('keeps the legacy path free of source journal/receipt queries', async () => {
    const { pool, queries } = database();
    expect((await new AgentProfileRepository(pool).replace(profile, 4, actor)).revision).toBe(5);
    expect(queries.some((row) => row.sql.includes('FROM audit_events') || row.sql.includes('FROM agent_profile_revisions'))).toBe(false);
  });
});

it.each([journalGuard, authoredGuard])('serializes concurrent source replacements through the existing row lock: %j', async (guard) => {
  let locked: Promise<void> = Promise.resolve();
  let revision = 4;
  let receipt: number | undefined;
  let updates = 0;
  const pool = { connect: async () => {
    let unlock: (() => void) | undefined;
    return { on: () => undefined, off: () => undefined, release: () => undefined,
      query: async (raw: string, params: readonly unknown[] = []) => {
        const sql = raw.replace(/\s+/gu, ' ');
        const schema = schemaBarrierReply(sql, params);
        if (schema) return schema;
        if (sql.startsWith('SELECT enabled')) {
          const prior = locked; locked = new Promise<void>((resolve) => { unlock = resolve; });
          await prior; return { rows: [{ enabled: true }] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock?.(); return { rows: [] }; }
        if (sql.includes('FROM agent_profiles')) return { rows: [{ ...profile, purpose: 'current', revision: String(revision), applied_revision: '3' }] };
        if (sql.includes('FROM audit_events')) return { rows: receipt === undefined ? [] : [{ revision: receipt }] };
        if (sql.includes('FROM agent_profile_revisions')) return { rows: [{ id: '42', revision: String(revision), operation: 'update' }] };
        if (sql.startsWith('UPDATE agent_profiles')) { updates += 1; revision += 1; return { rows: [{ ...profile, revision: String(revision), applied_revision: '3' }] }; }
        if (sql.startsWith('INSERT INTO audit_events')) receipt = revision;
        return { rows: [] };
      },
    };
  } } as unknown as DatabasePool;
  const repository = new AgentProfileRepository(pool);
  const results = await Promise.all([repository.replace(profile, 4, actor, guard), repository.replace(profile, 4, actor, guard)]);
  expect(updates).toBe(1);
  expect(results.filter((result) => result.source_receipt !== undefined)).toHaveLength(1);
  expect(results.map((result) => result.revision)).toEqual([5, 5]);
});


it.each([
  { ...authoredGuard, source_journal_id: '30' }, { ...authoredGuard, source_revision: 1 },
  { ...journalGuard, source_kind: 'git_authored' }, { ...authoredGuard, source_kind: 'journal_match' },
  { ...identity }, { ...journalGuard, source_journal_id: null },
])('rejects ambiguous or missing source guard provenance without I/O: %j', async (source) => {
  const { pool, queries } = database();
  await expect(new AgentProfileRepository(pool).replace(profile, 4, actor, source as unknown as AgentProfileSourceGuard))
    .rejects.toMatchObject({ code: 'conflict' });
  expect(queries).toEqual([]);
});
