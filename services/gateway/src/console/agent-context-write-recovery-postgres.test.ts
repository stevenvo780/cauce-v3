import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAgentProfile, type Tenant } from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, assertAgentContextAdmissionAllowed, pendingAgentContextWrites, withTransaction,
  type CompanyAuthority, type DatabasePool,
} from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import type { AgentFactsProbe } from './agent-documents.routes.js';
import { AgentContextWriteCoordinator } from './agent-context-write-coordinator.js';
import {
  contextWriteRecoveryRefusal, legacyProfileWritePlan, persistRecoveredProfileWrite, profileWritePlan,
} from './agent-context-write-recovery.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
let profiles: AgentProfileRepository;
const tenant = 'Steven' as Tenant;
const alias = 'zz-canary-recovery';
const path = '/home/dev/.claude/CLAUDE.md';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const oldText = 'old governed profile';
const targetText = 'new governed profile written by the runtime';
const actor = { tenant_id: tenant, alias: 'owner' };
const profile = { ...emptyAgentProfile(tenant, alias), role_summary: 'Recovery canary' };
const recoverer: CompanyAuthority = { humanId: null, homeTenant: tenant, alias: 'owner', homeCompany: 'humanizar',
  actingCompany: 'humanizar', role: 'company_owner', scope: 'company', platformOverride: false };

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase(); pool = database.pool;
  repository = new CauceRepository(pool); profiles = new AgentProfileRepository(pool);
}, 120_000);
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES($1,$2,'claude','Recovery canary',true,'ws-recovery','dev','/home/dev','/tmp/recovery')`, [tenant, alias]);
  await profiles.replace(profile, null, actor);
  await repository.recordProfileRuntimeExpectation(tenant, alias,
    { revision: 1, generation: 'generation-1', documents: [{ name: 'CLAUDE.md', path, sha: hash(oldText) }] });
});

/** A measured runtime whose writer journal and files are whatever the scenario says: the write landed, or never did. */
function runtime(options: { state?: 'done' | 'unknown'; disk?: string } = {}) {
  const facts = { harness: 'claude' as const, home: '/home/dev', generation: 'generation-1', containerId: 'container-1',
    writerInstanceId: randomUUID(), features: ['write_quiescence_v1'] };
  let operation: { id: string; generation: string } | undefined;
  const disk = () => options.disk ?? targetText;
  const probe = {
    factsFor: vi.fn(async () => ({ source: 'measured' as const, facts })),
    readGovernanceDocument: vi.fn(async () => ({ text: disk(), bytes: Buffer.byteLength(disk()), truncated: false,
      sha: hash(disk()), modified_at: new Date(0).toISOString() })),
    writeStatus: vi.fn(async (_tenant: string, _alias: string, operationId: string, _token: string, generation: string) => {
      operation = { id: operationId, generation };
      return { operation_id: operationId, operation_generation: generation, request_id: operationId,
        runtime_generation: facts.generation, writer_instance_id: facts.writerInstanceId, tenant_id: tenant, alias,
        container_id: facts.containerId, state: options.state ?? 'done',
        files: [{ path, sha: hash(disk()), bytes: Buffer.byteLength(disk()) }] };
    }) as unknown as NonNullable<AgentFactsProbe['writeStatus']>,
    listMemoryDirectory: vi.fn(),
  } as unknown as AgentFactsProbe;
  return { probe, coordinator: new AgentContextWriteCoordinator(pool, probe), seen: () => operation };
}

/** A profile save whose runtime wrote the file but whose answer was lost: the request ends `effect_unknown`. */
async function strandedProfileWrite(coordinator: AgentContextWriteCoordinator, sealPlan: boolean): Promise<string> {
  const documents = [{ name: 'CLAUDE.md', path, beforeSha: hash(oldText), targetSha: hash(targetText) }];
  const plan = profileWritePlan({ actor, operatorId: 'owner@example.test', attributed: true, reason: 'cambio\ncon salto', documents });
  const result = await coordinator.coordinate({
    tenantId: tenant, alias, expectedRevision: 1,
    expectedExpectation: { revision: 1, generation: 'generation-1', documents: [{ name: 'CLAUDE.md', path, sha: hash(oldText) }] },
    documents, ...(sealPlan && plan ? { plan } : {}),
    updateDesired: async (client) => {
      await profiles.replaceInTransaction(client, { ...profile, role_summary: 'Saved from the console' }, 1, actor);
    },
    dispatch: async () => { throw new Error('relay answer lost after the write'); },
    persistTarget: async () => { throw new Error('the request never reaches its own resolution'); },
  });
  if (result.state !== 'effect_unknown') throw new Error(`unexpected ${result.state}`);
  return result.operation_id;
}

const fenced = () => withTransaction(pool, client => assertAgentContextAdmissionAllowed(client, tenant, alias));
async function recover(coordinator: AgentContextWriteCoordinator, operationId: string) {
  return coordinator.recover({ tenantId: tenant, alias, operationId, signal: new AbortController().signal,
    lockHumanAuthority: async () => undefined,
    legacyPlan: descriptor => legacyProfileWritePlan(descriptor, recoverer),
    persistTarget: (client, plan, proof, descriptor) => persistRecoveredProfileWrite(client, plan, proof, descriptor, recoverer) });
}
async function expectation() {
  return (await pool.query<{ revision: string; generation: string; documents: unknown }>(
    'SELECT revision::text,generation,documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0];
}

describe('recovery of a profile write left effect_unknown', () => {
  it('seals a plan, fences the agent and lets a person accredit the landed write once', async () => {
    const lab = runtime();
    const operationId = await strandedProfileWrite(lab.coordinator, true);
    expect(await pendingAgentContextWrites(pool, tenant, alias)).toEqual([expect.objectContaining({
      operationId, dispatch: 'authorized', descriptorVersion: 2, operation: 'profile' })]);
    await expect(fenced()).rejects.toThrow('fences admission');
    await expect(recover(lab.coordinator, operationId)).resolves.toEqual({ operationId, resolution: 'target' });
    expect(lab.seen()?.id).toBe(operationId);
    await expect(fenced()).resolves.toBeUndefined();
    expect(await pendingAgentContextWrites(pool, tenant, alias)).toEqual([]);
    expect(await expectation()).toEqual({ revision: '2', generation: 'generation-1', documents: [{ name: 'CLAUDE.md', path, sha: hash(targetText) }] });
    const journal = await pool.query<{ kind: string; sha256: string; bytes: number; actor_alias: string }>(
      'SELECT kind,sha256,bytes::integer AS bytes,actor_alias FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    expect(journal.rows).toEqual([{ kind: 'directive', sha256: hash(targetText), bytes: Buffer.byteLength(targetText), actor_alias: 'owner' }]);
    const audit = await pool.query<{ metadata: { recovered_operation_id: string; sealed_plan: boolean } }>(
      `SELECT metadata FROM audit_events WHERE action='agent_document.write' AND metadata->>'recovered_operation_id'=$1`, [operationId]);
    expect(audit.rows[0]?.metadata).toMatchObject({ recovered_operation_id: operationId, sealed_plan: true });
    await expect(recover(lab.coordinator, operationId)).resolves.toEqual({ operationId, resolution: 'target' });
    expect((await pool.query('SELECT 1 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(1);
  });

  it('recovers a sealed v1 profile write as production holds it, attributing the result to the person', async () => {
    const lab = runtime();
    const operationId = await strandedProfileWrite(lab.coordinator, false);
    expect((await pendingAgentContextWrites(pool, tenant, alias))[0]).toMatchObject({ descriptorVersion: 1, operation: 'profile' });
    await expect(recover(lab.coordinator, operationId)).resolves.toEqual({ operationId, resolution: 'target' });
    expect((await repository.readContextWrite(tenant, alias, operationId))).toMatchObject({ version: 1, completion: { resolution: 'target' } });
    await expect(fenced()).resolves.toBeUndefined();
    expect((await expectation())?.revision).toBe('2');
  });

  it('resolves a write that never reached the file as old and persists nothing', async () => {
    const lab = runtime({ disk: oldText });
    const operationId = await strandedProfileWrite(lab.coordinator, false);
    await expect(recover(lab.coordinator, operationId)).resolves.toEqual({ operationId, resolution: 'old' });
    await expect(fenced()).resolves.toBeUndefined();
    expect(await expectation()).toMatchObject({ revision: '1', documents: [{ name: 'CLAUDE.md', path, sha: hash(oldText) }] });
    expect((await pool.query('SELECT 1 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(0);
  });

  it('keeps the fence and names the reason when the writer cannot vouch for the operation', async () => {
    const stranded = runtime();
    const operationId = await strandedProfileWrite(stranded.coordinator, true);
    const silent = runtime({ state: 'unknown' });
    const refusal = await recover(silent.coordinator, operationId).catch((error: unknown) => contextWriteRecoveryRefusal(error));
    expect(refusal).toEqual({ status: 409, code: 'context_write_writer_changed' });
    const unproven = await recover(new AgentContextWriteCoordinator(pool, { ...stranded.probe,
      writeStatus: async () => ({ error: 'unknown', reason: 'status desconocido' }) } as unknown as AgentFactsProbe), operationId)
      .catch((error: unknown) => contextWriteRecoveryRefusal(error));
    expect(unproven).toEqual({ status: 409, code: 'context_write_recovery_unproven' });
    await expect(fenced()).rejects.toThrow('fences admission');
    expect(await pendingAgentContextWrites(pool, tenant, alias)).toHaveLength(1);
  });

  it('never accredits a write after the desired profile moved on', async () => {
    const lab = runtime();
    const operationId = await strandedProfileWrite(lab.coordinator, true);
    await pool.query("UPDATE agent_profiles SET role_summary='edited elsewhere' WHERE tenant_id=$1 AND alias=$2", [tenant, alias]);
    const refusal = await recover(lab.coordinator, operationId).catch((error: unknown) => contextWriteRecoveryRefusal(error));
    expect(refusal).toEqual({ status: 409, code: 'context_write_snapshot_changed' });
    await expect(fenced()).rejects.toThrow('fences admission');
  });
});
