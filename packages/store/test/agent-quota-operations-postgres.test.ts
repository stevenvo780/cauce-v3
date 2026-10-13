import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQuotaInvalidatedError, AgentQuotaOperationsRepository, lockCompanyAuthority, withTransaction,
  type DatabaseClient, type DatabasePool, type AgentQuotaSnapshot } from '../src/index.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import type { AgentQuotaClaim } from '@cauce/protocol';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let identities: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let repository: AgentQuotaOperationsRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.pool;
  identities = await seedSyntheticCompanyContexts(current.adminUrl); repository = new AgentQuotaOperationsRepository(pool);
  await admin().query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES
    ('zz-canary-alpha','Alpha','context_alpha'),('zz-canary-beta','Beta','context_beta');
    UPDATE agents SET harness_id='codex',runtime_mode='container',host_id=CASE company_id
      WHEN 'context_alpha' THEN 'zz-canary-alpha' ELSE 'zz-canary-beta' END,
      container_name='zz-canary-'||lower(tenant_id)||'-'||alias,runtime_user='dev',home_directory='/home/dev',
      state_directory='/home/dev/.cauce/dev',systemd_user='stev',runtime_key=COALESCE(runtime_key,'zz-canary-'||lower(tenant_id)||'-'||alias)
      WHERE company_id IN ('context_alpha','context_beta');`);
  for (const [index, host] of ['zz-canary-alpha', 'zz-canary-beta'].entries()) {
    const owner = requireValue(identities[index], 'owner');
    await liveHost(host, owner.company_id, owner.human_id);
  }
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function admin() { return requireValue(current, 'case database').adminPool; }
async function liveHost(host: string, company: string, human: string) {
  const enrollment = requireValue((await admin().query<{ id: string }>(`INSERT INTO fleet_host_enrollments
    (company_id,host_id,display_name,invited_by,token_hash,nonce,expires_at,state)
    VALUES($1,$2,$2,$3,$4,$4,now()+interval '1 hour','enrolled') RETURNING id`,
  [company, host, human, createHash('sha256').update(host).digest('hex')])).rows[0], 'enrollment');
  await admin().query(`INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint,capabilities,capabilities_seen_at)
    VALUES($1,$2,$3,$4,$5,'{"fleet_executor":true}',now())`,
  [host, company, enrollment.id, 'x'.repeat(64), createHash('sha256').update(`identity-${host}`).digest('hex')]);
}
function authority(index = 0) {
  const person = requireValue(identities[index], 'company');
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: person.tenant_id, alias: 'owner', humanId: person.human_id });
}
const target = { tenant_id: 'ContextAlpha', alias: 'director' };
async function enqueue(key: string = randomUUID(), alias = 'director') {
  const card = await repository.snapshot(authority(), { ...target, alias });
  return repository.enqueue(authority(), { ...target, alias, expected_revision: card.revision, idempotency_key: key });
}
async function claim(): Promise<AgentQuotaClaim> {
  return requireValue(await repository.claim('zz_canary_worker', 'zz-canary-alpha', 30_000, 'context_alpha'), 'quota claim');
}
function measured(agent: AgentQuotaSnapshot, captured = new Date().toISOString()) {
  return { status: 'measured', operation_id: agent.operation_id, tenant: agent.tenant_id, alias: agent.alias,
    host_id: agent.host_id, container_name: agent.container_name, harness: agent.harness_id, captured_at: captured,
    provider: 'codex', identity_hash: createHash('sha256').update('zz-canary-identity').digest('hex'), observation_status: 'ok',
    provider_report: { provider: 'codex', ok: true, available: true, windows: [{ group_key: 'default', window_key: 'week', remaining_percent: 88 }] } };
}
async function collections() { return (await admin().query<{ count: number }>('SELECT count(*)::int AS count FROM quota_collections')).rows[0]?.count; }

describe('durable agent quota operations with real PostgreSQL', () => {
  it('enqueues, claims, executes, binds and reads a durable observation without duplicating effects', async () => {
    const request = await enqueue('zz-canary-idempotency'); const worker = await claim();
    expect(await repository.renew(worker)).toBe(true);
    const execution = await repository.execution(worker); const receipt = measured(execution.agent);
    expect(await repository.finish(worker, receipt)).toMatchObject({ operation_id: request.id, status: 'done', result: { status: 'measured' } });
    const card = await repository.snapshot(authority(), target);
    expect(card).toMatchObject({ status: 'ok', reader_available: true, can_query: true, captured_at: receipt.captured_at,
      binding: { enabled: false }, sample: { provider: 'codex', windows: [{ remaining_percent: 88 }] },
      operation: { id: request.id, status: 'done' } });
    expect(card.sample?.account_id).toBe(card.binding?.account_id);
    expect(typeof card.binding?.account_id).toBe('string');
    expect(await enqueue('zz-canary-idempotency')).toMatchObject({ id: request.id, duplicate: true, status: 'done' });
    expect(await repository.finish(worker, receipt)).toMatchObject({ status: 'done' }); expect(await collections()).toBe(1);
    expect((await admin().query('SELECT receipt,result FROM agent_quota_operations WHERE id=$1', [worker.id])).rows[0])
      .toMatchObject({ receipt: { status: 'measured' }, result: { account_id: card.binding?.account_id } });
  });
  it('isolates other company targets, worker claims and host acknowledgements', async () => {
    await enqueue();
    await expect(repository.snapshot(authority(1), target)).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.enqueue(authority(1), { ...target, expected_revision: 0, idempotency_key: 'zz-canary-cross-company' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await repository.claim('zz_beta', 'zz-canary-alpha', 30_000, 'context_beta')).toBeNull();
    const worker = await claim();
    await expect(withTransaction(pool, client => repository.assertHostScopeInTransaction(client, worker, { host_id: 'zz-canary-beta', company_id: 'context_alpha' })))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(withTransaction(pool, client => repository.assertHostScopeInTransaction(client, worker, { host_id: 'zz-canary-alpha', company_id: 'context_beta' })))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
  it('requires the revision and rejects changed idempotent requests or another active query', async () => {
    const card = await repository.snapshot(authority(), target);
    await expect(repository.enqueue(authority(), { ...target, expected_revision: card.revision + 1, idempotency_key: 'zz-canary-stale' }))
      .rejects.toMatchObject({ code: 'conflict' });
    await enqueue('zz-canary-reused');
    await expect(enqueue('zz-canary-reused', 'owner')).rejects.toMatchObject({ code: 'conflict' });
    await expect(enqueue('zz-canary-second')).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['pending', 'running'])('allows a new query after relocating a %s operation', async phase => {
    const first = await enqueue(); const worker = phase === 'running' ? await claim() : null;
    await admin().query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('zz-canary-destination','Destination','context_alpha')");
    await liveHost('zz-canary-destination', 'context_alpha', requireValue(identities[0], 'owner').human_id);
    await admin().query("UPDATE agents SET host_id='zz-canary-destination' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    const second = await enqueue();
    expect(second).toMatchObject({ status: 'pending', duplicate: false }); expect(second.id).not.toBe(first.id);
    expect((await admin().query('SELECT status,error_code,lease_until FROM agent_quota_operations WHERE id=$1', [first.id])).rows)
      .toEqual([{ status: 'failed', error_code: 'SCOPE_CHANGED', lease_until: null }]);
    expect(await repository.claim('zz_old', 'zz-canary-alpha', 30_000, 'context_alpha')).toBeNull();
    const next = requireValue(await repository.claim('zz_next', 'zz-canary-destination', 30_000, 'context_alpha'), 'relocated claim');
    expect(next.id).toBe(second.id);
    if (worker) expect(await repository.renew(worker)).toBe(false);
  });
  it.each(['pending', 'running'])('enqueues a fresh query after a %s operation expires in the same placement', async phase => {
    const key = randomUUID(); const first = await enqueue(key); const worker = phase === 'running' ? await claim() : null;
    await admin().query("UPDATE agent_quota_operations SET expires_at=now()-interval '1 second' WHERE id=$1", [first.id]);
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'failed', can_query: true,
      operation: { id: first.id, status: 'failed', error_code: 'EXPIRED' } });
    expect((await admin().query('SELECT status,error_code FROM agent_quota_operations WHERE id=$1', [first.id])).rows)
      .toEqual([{ status: phase, error_code: null }]);
    const second = await enqueue();
    expect(second).toMatchObject({ status: 'pending', duplicate: false }); expect(second.id).not.toBe(first.id);
    expect((await admin().query('SELECT status,error_code,lease_until FROM agent_quota_operations WHERE id=$1', [first.id])).rows)
      .toEqual([{ status: 'failed', error_code: 'EXPIRED', lease_until: null }]);
    expect((await admin().query('SELECT expires_at>now() AS live FROM agent_quota_operations WHERE id=$1', [second.id])).rows)
      .toEqual([{ live: true }]);
    expect(await enqueue(key)).toMatchObject({ id: first.id, status: 'failed', duplicate: true });
    expect((await admin().query('SELECT status,error_code FROM agent_quota_operations WHERE id=$1', [first.id])).rows)
      .toEqual([{ status: 'failed', error_code: 'EXPIRED' }]);
    const next = await claim(); expect(next.id).toBe(second.id);
    if (worker) expect(await repository.renew(worker)).toBe(false);
  });
  it.each(['pending', 'running'])('does not claim an expired %s operation or wait for the configuration lock', async phase => {
    const request = await enqueue(); if (phase === 'running') await claim();
    await admin().query(`UPDATE agent_quota_operations SET expires_at=now()-interval '1 second',
      lease_until=CASE WHEN status='running' THEN now()-interval '1 second' ELSE NULL END WHERE id=$1`, [request.id]);
    const before = (await admin().query('SELECT status,claim_token,claim_epoch,worker_id,lease_until FROM agent_quota_operations WHERE id=$1', [request.id])).rows;
    const holder = await admin().connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_004)');
      const next = withTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout='200ms'");
        return repository.forTransaction(client).claim('zz_expired', 'zz-canary-alpha', 30_000, 'context_alpha');
      });
      await expect(next).resolves.toBeNull();
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect((await admin().query('SELECT status,claim_token,claim_epoch,worker_id,lease_until FROM agent_quota_operations WHERE id=$1', [request.id])).rows).toEqual(before);
    expect(await collections()).toBe(0);
  });
  it('rejects a running claim after its deadline even while its lease is live', async () => {
    await enqueue(); const worker = await claim(); const receipt = measured((await repository.execution(worker)).agent);
    await admin().query("UPDATE agent_quota_operations SET expires_at=now()-interval '1 second' WHERE id=$1", [worker.id]);
    expect((await admin().query('SELECT lease_until>now() AS live FROM agent_quota_operations WHERE id=$1', [worker.id])).rows)
      .toEqual([{ live: true }]);
    expect(await repository.renew(worker)).toBe(false);
    await expect(repository.execution(worker)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.finish(worker, receipt)).rejects.toMatchObject({ code: 'conflict' });
    await expect(withTransaction(pool, client => repository.assertHostScopeInTransaction(client, worker,
      { host_id: 'zz-canary-alpha', company_id: 'context_alpha' }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await collections()).toBe(0);
  });
  it('does not claim a pending operation that expires while waiting for the configuration lock', async () => {
    const request = await enqueue(); const holder = await admin().connect(); const claimant = await pool.connect();
    let next: Promise<AgentQuotaClaim | null> | undefined;
    try {
      const holderPid = requireValue((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'holder').pid;
      const claimantPid = requireValue((await claimant.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'claimant').pid;
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_004)');
      await admin().query("UPDATE agent_quota_operations SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1", [request.id]);
      const before = (await admin().query('SELECT * FROM agent_quota_operations WHERE id=$1', [request.id])).rows;
      await claimant.query('BEGIN');
      next = repository.forTransaction(claimant).claim('zz_waiting', 'zz-canary-alpha', 30_000, 'context_alpha');
      await expect.poll(async () => (await admin().query<{ waiting: boolean }>(
        'SELECT $1=ANY(pg_blocking_pids($2)) AS waiting', [holderPid, claimantPid])).rows[0]?.waiting,
      { timeout: 2_000, interval: 10 }).toBe(true);
      await expect.poll(async () => (await admin().query<{ expired: boolean }>(
        'SELECT expires_at<=clock_timestamp() AS expired FROM agent_quota_operations WHERE id=$1', [request.id])).rows[0]?.expired,
      { timeout: 5_000, interval: 25 }).toBe(true);
      await holder.query('ROLLBACK'); expect(await next).toBeNull(); await claimant.query('COMMIT');
      expect((await admin().query('SELECT * FROM agent_quota_operations WHERE id=$1', [request.id])).rows).toEqual(before);
    } finally {
      await holder.query('ROLLBACK'); await next?.catch(() => undefined); await claimant.query('ROLLBACK');
      holder.release(); claimant.release();
    }
  });
  it.each(['missing', 'stale', 'disabled', 'without-executor'])('rejects a query when the host identity is %s', async state => {
    if (state === 'missing') await admin().query("DELETE FROM fleet_host_identities WHERE host_id='zz-canary-alpha'");
    else if (state === 'stale') await admin().query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id='zz-canary-alpha'");
    else if (state === 'disabled') await admin().query("UPDATE fleet_host_identities SET enabled=false WHERE host_id='zz-canary-alpha'");
    else await admin().query("UPDATE fleet_host_identities SET capabilities='{}' WHERE host_id='zz-canary-alpha'");
    await expect(enqueue()).rejects.toMatchObject({ code: 'conflict' });
    expect((await admin().query('SELECT 1 FROM agent_quota_operations')).rowCount).toBe(0);
  });
  it('does not wait for the configuration lock while the host queue is empty', async () => {
    const holder = await admin().connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_004)');
      const next = withTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout='200ms'");
        return repository.forTransaction(client).claim('zz_idle', 'zz-canary-alpha', 30_000, 'context_alpha');
      });
      await expect(next).resolves.toBeNull();
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it('does not invert the signed host identity lock while enqueuing a query', async () => {
    const card = await repository.snapshot(authority(), target); const holder = await admin().connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM fleet_host_identities WHERE host_id='zz-canary-alpha' FOR NO KEY UPDATE");
      const next = withTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout='200ms'");
        return repository.forTransaction(client).enqueue(authority(), { ...target, expected_revision: card.revision, idempotency_key: 'zz-canary-lock-order' });
      });
      await expect(next).resolves.toMatchObject({ status: 'pending' });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it('fences old tokens, epochs, workers and expired leases after recovery', async () => {
    await enqueue(); const first = await claim(); const receipt = measured((await repository.execution(first)).agent);
    for (const changed of [{ claim_token: randomUUID() }, { claim_epoch: first.claim_epoch + 1 }, { worker_id: 'zz_other' }, { alias: 'owner' }]) {
      await expect(repository.finish({ ...first, ...changed }, receipt)).rejects.toMatchObject({ code: 'conflict' });
    }
    await admin().query("UPDATE agent_quota_operations SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    expect(await repository.renew(first)).toBe(false);
    await expect(repository.finish(first, receipt)).rejects.toMatchObject({ code: 'conflict' });
    const second = await claim(); expect(second.claim_epoch).toBe(first.claim_epoch + 1); expect(second.claim_token).not.toBe(first.claim_token);
    await expect(repository.finish(first, receipt)).rejects.toMatchObject({ code: 'conflict' });
    await repository.finish(second, receipt); expect(await collections()).toBe(1);
  });
  it.each(['claim', 'finish'])('revalidates revoked human authority at %s', async phase => {
    await enqueue(); const worker = phase === 'finish' ? await claim() : null;
    const receipt = worker ? measured((await repository.execution(worker)).agent) : null;
    await admin().query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1',
      [requireValue(identities[0], 'owner').human_id]);
    if (worker) await expect(repository.finish(worker, receipt)).rejects.toMatchObject({ code: 'conflict' });
    else expect(await repository.claim('zz_worker', 'zz-canary-alpha', 30_000, 'context_alpha')).toBeNull();
    expect((await admin().query('SELECT status,error_code FROM agent_quota_operations')).rows)
      .toEqual([{ status: 'failed', error_code: 'AUTHORITY_REVOKED' }]); expect(await collections()).toBe(0);
  });
  it.each(['claim', 'finish'])('revalidates placement changes at %s without a sample', async phase => {
    await enqueue(); const worker = phase === 'finish' ? await claim() : null;
    const receipt = worker ? measured((await repository.execution(worker)).agent) : null;
    await admin().query("UPDATE agents SET container_name='zz-canary-replaced' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    if (worker) await expect(repository.finish(worker, receipt)).rejects.toMatchObject({ code: 'conflict' });
    else expect(await repository.claim('zz_worker', 'zz-canary-alpha', 30_000, 'context_alpha')).toBeNull();
    expect((await admin().query('SELECT status,error_code FROM agent_quota_operations')).rows)
      .toEqual([{ status: 'failed', error_code: 'SCOPE_CHANGED' }]); expect(await collections()).toBe(0);
  });
  it('accepts the exact terminal receipt beyond the lease and deadline but rejects changed reports or lost authority', async () => {
    await enqueue(); const worker = await claim(); const receipt = measured((await repository.execution(worker)).agent);
    await repository.finish(worker, receipt);
    await admin().query(`UPDATE agent_quota_operations SET lease_until=now()-interval '1 hour',
      expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [worker.id]);
    await repository.finish(worker, receipt);
    await expect(repository.finish(worker, { ...receipt, identity_hash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    await admin().query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1',
      [requireValue(identities[0], 'owner').human_id]);
    await expect(repository.finish(worker, receipt)).rejects.toMatchObject({ code: 'forbidden' }); expect(await collections()).toBe(1);
  });
  it('persists unsupported runtime observations without a binding or fake percentage', async () => {
    await enqueue(); const worker = await claim(); const agent = (await repository.execution(worker)).agent;
    await repository.finish(worker, { operation_id: agent.operation_id, tenant: agent.tenant_id, alias: agent.alias,
      host_id: agent.host_id, container_name: agent.container_name, harness: agent.harness_id, captured_at: new Date().toISOString(),
      status: 'unsupported', reason: 'quota_reader_unavailable' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority(), target)).toMatchObject({ status: 'unsupported',
      reader_available: true, can_query: true, reason: null, binding: null, sample: null, operation: { status: 'done' } });
    expect(await enqueue()).toMatchObject({ status: 'pending' });
    expect(await collections()).toBe(0);
    expect((await admin().query('SELECT reader_available,status FROM agent_quota_observations')).rows)
      .toEqual([{ reader_available: false, status: 'unsupported' }]);
  });
  it('persists an explicit missing reader for unsupported harnesses before any query', async () => {
    await admin().query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'unsupported', reader_available: false, sample: null });
    expect((await admin().query('SELECT status FROM agent_quota_observations')).rows).toEqual([{ status: 'unsupported' }]);
    expect(await enqueue()).toMatchObject({ status: 'unsupported', operation_id: null });
  });
  it('does not rewrite an unchanged unsupported observation during repeated reads', async () => {
    await admin().query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    await repository.snapshot(authority(), target);
    const before = (await admin().query('SELECT xmin::text AS transaction,updated_at FROM agent_quota_observations')).rows;
    await repository.snapshot(authority(), target); await repository.snapshot(authority(), target);
    expect((await admin().query('SELECT xmin::text AS transaction,updated_at FROM agent_quota_observations')).rows).toEqual(before);
  });
  it('recovers the query capability when an unavailable harness is re-enabled', async () => {
    await admin().query("UPDATE harness_definitions SET enabled=false WHERE id='codex'");
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'unsupported', reader_available: false });
    await admin().query("UPDATE harness_definitions SET enabled=true WHERE id='codex'");
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'unknown', reader_available: true, can_query: true });
    expect(await enqueue()).toMatchObject({ status: 'pending' });
  });
  it('allows an authorized company administrator to query an agent runtime', async () => {
    const person = randomUUID();
    await admin().query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'zz-canary-admin@dev.example','zz-canary-admin@dev.example',$2,'Canary admin','operator','ContextAlpha','director')`,
    [person, `$scrypt$${'x'.repeat(48)}`]);
    await admin().query("UPDATE memberships SET role='operator' WHERE tenant_id='ContextAlpha' AND alias='director'");
    await admin().query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'ContextAlpha','director','operator',ARRAY['read','control'])`, [person]);
    await admin().query("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('context_alpha',$1,'admin','import',$1)", [person]);
    const source = (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'ContextAlpha', alias: 'director', humanId: person });
    const card = await repository.snapshot(source, target); expect(card).toMatchObject({ reader_available: true, can_query: true });
    expect(await repository.enqueue(source, { ...target, expected_revision: card.revision, idempotency_key: 'zz-canary-admin' }))
      .toMatchObject({ status: 'pending' });
  });
  it('records bounded terminal failures idempotently and rejects a changed error', async () => {
    await enqueue(); const worker = await claim();
    await repository.fail(worker, 'RUNTIME_UNAVAILABLE');
    await admin().query("UPDATE agent_quota_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [worker.id]);
    const before = (await admin().query('SELECT * FROM agent_quota_operations WHERE id=$1', [worker.id])).rows;
    await repository.fail(worker, 'RUNTIME_UNAVAILABLE');
    expect((await admin().query('SELECT * FROM agent_quota_operations WHERE id=$1', [worker.id])).rows).toEqual(before);
    await expect(repository.fail(worker, 'STEP_FAILED')).rejects.toMatchObject({ code: 'conflict' });
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'failed', operation: { status: 'failed', error_code: 'RUNTIME_UNAVAILABLE' } });
  });
  it('commits invalidation in an enclosing signed transaction before reporting its conflict', async () => {
    await enqueue(); const worker = await claim(); const receipt = measured((await repository.execution(worker)).agent);
    await admin().query("UPDATE agents SET container_name='zz-canary-replaced' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    const invalidated = await withTransaction(pool, async client => {
      try { await repository.forTransaction(client).finish(worker, receipt); return false; }
      catch (error) { if (error instanceof AgentQuotaInvalidatedError) return true; throw error; }
    });
    expect(invalidated).toBe(true);
    expect((await admin().query('SELECT status,error_code FROM agent_quota_operations')).rows)
      .toEqual([{ status: 'failed', error_code: 'SCOPE_CHANGED' }]); expect(await collections()).toBe(0);
  });
  it.each([true, false])('only invalidates a revision from its own company: %s', async ownCompany => {
    await enqueue();
    await admin().query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,scope,company_id)
      VALUES($1,'owner','{}','{}','canary revision','company',$2)`,
    [ownCompany ? 'ContextAlpha' : 'ContextBeta', ownCompany ? 'context_alpha' : 'context_beta']);
    const worker = await repository.claim('zz_worker', 'zz-canary-alpha', 30_000, 'context_alpha');
    if (ownCompany) {
      expect(worker).toBeNull(); expect((await admin().query('SELECT status,error_code FROM agent_quota_operations')).rows)
        .toEqual([{ status: 'failed', error_code: 'SCOPE_CHANGED' }]);
    } else {
      const active = requireValue(worker, 'worker'); await repository.finish(active, measured((await repository.execution(active)).agent));
      expect(await collections()).toBe(1);
    }
  });
  it('hides a previous observation after changing the durable placement', async () => {
    await enqueue(); const worker = await claim(); await repository.finish(worker, measured((await repository.execution(worker)).agent));
    await admin().query("UPDATE agents SET container_name='zz-canary-replaced' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    expect(await repository.snapshot(authority(), target)).toMatchObject({ status: 'unknown', captured_at: null, sample: null, binding: null, operation: null });
  });
  it('binds two agents to one shared subscription and preserves the operator-selected binding state', async () => {
    await enqueue(); const first = await claim(); await repository.finish(first, measured((await repository.execution(first)).agent));
    await enqueue(randomUUID(), 'owner'); const second = await claim(); await repository.finish(second, measured((await repository.execution(second)).agent));
    const card = await repository.snapshot(authority(), target); const other = await repository.snapshot(authority(), { ...target, alias: 'owner' });
    expect(card.binding?.account_id).toBe(other.binding?.account_id); expect(card.binding).toMatchObject({ enabled: false, shared: true, agent_count: 2 });
  });
});
