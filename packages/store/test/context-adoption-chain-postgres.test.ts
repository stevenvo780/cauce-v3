import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { CauceRepository, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { ContextVersionStore } from '../src/context-version.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { contextRepositoryPrefix } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { HarnessAdapter, codexDefinition } from '../../adapter-sdk/src/harnesses/index.js';
import { DurableStore } from '../../adapter-sdk/src/sdk/durable-store.js';
import { AdapterEngine } from '../../adapter-sdk/src/sdk/engine.js';
import type { CommandRunner, Delivery, DeliveryEvent } from '../../adapter-sdk/src/sdk/types.js';
import { consumptionWitness } from '../../adapter-sdk/src/shared-session/consumption.js';

const execute = promisify(execFile);
const environment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'zz-canary-fixture', GIT_AUTHOR_EMAIL: 'zz-canary-fixture@cauce.invalid',
  GIT_COMMITTER_NAME: 'zz-canary-fixture', GIT_COMMITTER_EMAIL: 'zz-canary-fixture@cauce.invalid',
};
async function git(directory: string, args: string[]): Promise<string> {
  return (await execute('git', ['-C', directory, ...args], { env: environment, encoding: 'utf8', timeout: 20_000 })).stdout.trim();
}
const SESSION = '00000000-0000-4000-8000-0000000000c1';
const REPLY = JSON.stringify({ reply: 'Context consumed by the natural turn.', messages: [], status: 'done', retryable: false, artifacts: [] });

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
let directory: string; let remote: string; let broker: ContextGitBroker; let previousSpace: string | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  await current.adminPool.query("UPDATE agents SET harness_id='codex' WHERE alias='director' AND tenant_id='ContextAlpha'");
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-adoption-chain-')); await chmod(directory, 0o700);
  remote = join(directory, 'origin.git'); const repository = join(directory, 'broker');
  await git(directory, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  await git(directory, ['init', '--quiet', '--initial-branch=main', repository]); await chmod(repository, 0o700);
  await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'Initialize adoption chain fixture']);
  await git(repository, ['remote', 'add', 'origin', remote]);
  await git(repository, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main']);
  broker = new ContextGitBroker(repository); previousSpace = process.env.CAUCE_SPACE_ROOT;
});
afterEach(async () => {
  if (previousSpace === undefined) Reflect.deleteProperty(process.env, 'CAUCE_SPACE_ROOT'); else process.env.CAUCE_SPACE_ROOT = previousSpace;
  await current?.close(); current = undefined; await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const write = (expected: number, content: string) => store.write(source, target().tenant_id, target().alias,
  { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content }] });
async function synced(version: number) {
  await processContextOutbox(pool, { git: broker }, target());
  const row = (await pool.query<{ state: string; git_commit: string | null }>(
    'SELECT state,git_commit FROM agent_context_outbox WHERE tenant_id=$1 AND alias=$2 AND version=$3', [target().tenant_id, target().alias, version])).rows[0];
  if (row?.state !== 'synced' || !row.git_commit) throw new Error(`version ${String(version)} did not sync`);
  return row.git_commit;
}

describe('a human edit reaches the agent through Git, the native document and the next natural turn', () => {
  it('versions N+1 with the human as Git author, regenerates AGENTS.md and records adoption with its version and digest', async () => {
    await write(0, 'Mission one: answer briefly.'); await synced(1);
    const edited = await write(1, 'Mission two: answer with the verified outcome first.');
    const commit = await synced(2);
    expect(edited).toMatchObject({ desired_version: 2 });
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(commit);
    expect(await git(remote, ['log', '-1', '--format=%an|%ae|%cn', commit]))
      .toBe('owner|owner@context_alpha.cauce.invalid|Cauce context broker');
    const prefix = contextRepositoryPrefix(target());
    expect(JSON.parse(await git(remote, ['show', `${commit}:${prefix}/.cauce-version.json`]))).toMatchObject({
      version: 2, digest: edited.digest, actor_alias: 'owner', actor_human_id: target().human_id, source: 'ui' });

    const repository = new CauceRepository(pool); const instance = 'zz-canary-natural-turn';
    const lease = await repository.acquireLease(target().tenant_id, target().alias, instance, [VERSIONED_CONTEXT_CAPABILITY, 'harness.codex'], 60_000);
    if (!lease.acquired || !lease.epoch) throw new Error('consumer lease unavailable');
    await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: target().tenant_id,
      room_id: 'context-room', actor_alias: 'owner', recipients: [{ tenant_id: target().tenant_id, alias: target().alias }],
      body: { type: 'command', text: 'Ordinary work after the edit.' }, lane: 'interactive', priority: 0, idempotency_key: randomUUID() });
    const [claimed] = await repository.claimDeliveries(target().tenant_id, target().alias, instance, lease.epoch, 1, 60_000);
    if (!claimed) throw new Error('natural turn was not delivered');
    expect(claimed.versioned_context).toMatchObject({ version: 2, digest: edited.digest });

    const space = join(directory, 'space'); process.env.CAUCE_SPACE_ROOT = space;
    const documents: string[] = []; const events: DeliveryEvent[] = [];
    const runner: CommandRunner = { run: async input => {
      documents.push(await readFile(join(space, 'AGENTS.md'), 'utf8'));
      const stdout = [JSON.stringify({ type: 'thread.started', thread_id: SESSION }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: REPLY } }), JSON.stringify({ type: 'turn.completed' })].join('\n');
      const witness = consumptionWitness('codex', SESSION, 'zz-canary-turn', input.stdin);
      if (!witness) throw new Error('the fixture turn has no consumption witness');
      return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, consumptionWitness: witness };
    } };
    const sdkStore = await DurableStore.open(join(directory, 'adapter-store'));
    const engine = new AdapterEngine({ store: sdkStore, harness: new HarnessAdapter({ definition: codexDefinition, runner, store: sdkStore }),
      ownTenantId: target().tenant_id, executionIntentMode: 'local-test-only', publish: async event => { events.push(event); } });
    await engine.activateEpoch(lease.epoch);
    try { await engine.handleDelivery(claimed as Delivery); } finally { engine.stop(); }

    expect(documents).toHaveLength(1);
    expect(documents[0]).toContain(`Version 2; digest ${edited.digest}`);
    expect(documents[0]).toContain('Mission two: answer with the verified outcome first.');
    expect(documents[0]).not.toContain('Mission one');
    const done = events.find(event => event.phase === 'done');
    if (!done?.harness_consumption_v1 || !done.context_adoption) throw new Error('the turn left no consumption evidence');
    expect(done.context_adoption).toEqual({ version: 2, digest: edited.digest, input_sha256: done.harness_consumption_v1.input_sha256 });
    expect(await store.read(source, target().tenant_id, target().alias)).toMatchObject({ applied_version: 0 });

    await repository.ackDelivery(claimed.delivery_id, target().tenant_id, target().alias, {
      version: '3.0', event_id: done.event_id, status: 'done', instance_id: instance, epoch: lease.epoch, attempt: claimed.attempt,
      claim_token: claimed.claim_token, retryable: false,
      result: { ...(done.output ? { output: done.output } : {}), harness_consumption_v1: done.harness_consumption_v1, context_adoption: done.context_adoption },
    });
    expect(await store.read(source, target().tenant_id, target().alias)).toMatchObject({ desired_version: 2, applied_version: 2 });
    const state = (await pool.query<{ applied_digest: string }>('SELECT applied_digest FROM agent_context_state WHERE tenant_id=$1 AND alias=$2',
      [target().tenant_id, target().alias])).rows[0];
    expect(state?.applied_digest).toBe(edited.digest);
    const adopted = (await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action='context.adopted' AND tenant_id=$1 AND actor_alias=$2", [target().tenant_id, target().alias])).rows;
    expect(adopted).toEqual([{ metadata: { delivery_id: claimed.delivery_id, version: 2, digest: edited.digest, harness: 'codex',
      native_turn_id: done.harness_consumption_v1.native_turn_id } }]);
  });
});
