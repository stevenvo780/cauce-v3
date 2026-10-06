import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach } from 'vitest';
import type { ConsolePublishIntentCommand, PublishMessage, Tenant } from '@cauce/protocol';
import {
  CauceRepository, lockHumanIdentity,
  type DatabaseClient, type DatabasePool, type PublishOptions,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  resetTestDatabase, startTestCaseDatabase, startTestDatabase,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { seedIdentity } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';

const execute = promisify(execFile);
type HumanIdentityFixture = Awaited<ReturnType<typeof seedIdentity>>;
interface HumanPublishProvenance {
  readonly humanId: string;
  readonly tenantId: Tenant;
  readonly actorAlias: string;
}
export const HUMAN_PUBLISH_SCOPE = 'a'.repeat(64);
const LOCK_CLASS = 19742;
const LOCK_OBJECT = 41029;

let database: TestDatabase | undefined;
let currentCase: EmptyTestDatabase | undefined;
let repository: CauceRepository | undefined;

function pool(): DatabasePool {
  if (!currentCase) throw new Error('PostgreSQL test case has not started');
  return currentCase.pool;
}

async function assertOwnedPostgresNetwork(): Promise<void> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('human publication tests require their own Testcontainers database');
  }
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const owner = process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER;
  if ((network === undefined) !== (owner === undefined)) {
    throw new Error('an optional Docker bridge requires both its name and owner UUID');
  }
  if (owner !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)) {
    throw new Error('invalid Docker bridge owner UUID');
  }
  if (process.env.DOCKER_HOST !== undefined && !process.env.DOCKER_HOST.startsWith('unix://')) {
    throw new Error('human publication tests require the local Docker daemon');
  }
  if (process.env.DOCKER_HOST === undefined) {
    const { stdout: context } = await execute('docker', ['context', 'show'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const { stdout: endpoint } = await execute('docker', ['context', 'inspect', context.trim(),
      '--format', '{{.Endpoints.docker.Host}}'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    if (!endpoint.trim().startsWith('unix://')) throw new Error('human publication tests refuse a remote Docker context');
  }
  if (network === undefined || owner === undefined) return;
  const { stdout } = await execute('docker', ['network', 'inspect', '--format', '{{json .}}', '--', network],
    { timeout: 5_000, maxBuffer: 64 * 1024 });
  const value: unknown = JSON.parse(stdout);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Docker network metadata');
  const info = value as Record<string, unknown>;
  const labels = info.Labels;
  if (info.Name !== network || info.Driver !== 'bridge' || info.Scope !== 'local' || info.Internal !== false
      || labels === null || typeof labels !== 'object' || Array.isArray(labels)
      || (labels as Record<string, unknown>)['cauce.test.owner'] !== owner) {
    throw new Error('human publication tests could not verify their exact owned Docker bridge');
  }
}

export function registerHumanPublishSuite(sourceUrl: string): void {
  preparePostgresSuite(sourceUrl, async () => {
    await assertOwnedPostgresNetwork();
    database = await startTestDatabase();
    console.info(`human publication PostgreSQL container ${database.container.getId()} labels ${JSON.stringify(database.container.getLabels())}`);
  }, 180_000);
  beforeEach(async () => {
    if (!database) throw new Error('PostgreSQL fixture has not started');
    currentCase = await startTestCaseDatabase(database);
    await resetTestDatabase(pool());
    repository = new CauceRepository(pool());
  });
  afterEach(async () => {
    const testCase = currentCase;
    await testCase?.close();
    if (currentCase === testCase) currentCase = undefined;
    repository = undefined;
  });
  afterAll(async () => {
    if (!database) return;
    try {
      const testCase = currentCase;
      await testCase?.close();
      if (currentCase === testCase) currentCase = undefined;
      repository = undefined;
    } finally {
      try { await database.pool.end(); } finally { await database.container.stop(); }
    }
  });
}

export function getRepository(): CauceRepository {
  if (!repository) throw new Error('PostgreSQL repository has not started');
  return repository;
}

export async function seedHumanPublishActor(alias?: string): Promise<HumanIdentityFixture> {
  const account = await seedIdentity(pool(), alias);
  await pool().query(
    `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
     VALUES('Steven','grp.steven',$1,'operator',true)
     ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='operator',enabled=true`,
    [account.alias],
  );
  return account;
}

export function consoleIntent(account: HumanIdentityFixture, recipientTenant: 'Steven' | 'Isa' = 'Steven'): ConsolePublishIntentCommand {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `human-publish-intent-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: account.alias,
    recipients: [{ tenant_id: recipientTenant, alias: recipientTenant === 'Steven' ? 'argos' : 'salva' }],
    body: { text: `human publication ${randomUUID()}` }, lane: 'interactive', priority: 40,
    requested_priority: 0, intent_nonce: randomUUID(),
    authenticated_context: { session_id: `intent-session-${randomUUID()}`, channel: 'console' },
  };
}

export async function prepareHumanPublishIntent(
  input: ConsolePublishIntentCommand,
): ReturnType<CauceRepository['prepareConsolePublishIntent']> {
  return getRepository().prepareConsolePublishIntent(input, HUMAN_PUBLISH_SCOPE);
}

export function publishCommand(
  input: ConsolePublishIntentCommand,
  idempotencyKey: string,
  overrides: Partial<PublishMessage> = {},
): PublishMessage {
  const { intent_nonce: _intentNonce, requested_priority: _requestedPriority, ...publishable } = input;
  void _intentNonce;
  void _requestedPriority;
  return {
    ...publishable, request_id: randomUUID(), trace_id: `human-publish-${randomUUID()}`,
    idempotency_key: idempotencyKey,
    authenticated_context: { session_id: `human-mcp-session-${randomUUID()}`, channel: 'human-mcp' },
    ...overrides,
  };
}

export function authorFor(account: HumanIdentityFixture): NonNullable<PublishOptions['consoleAuthor']> {
  const subject = createHash('sha256').update(JSON.stringify([
    'cauce-v3:human-author:v1', 'Steven', `console:${account.humanId}`,
  ])).digest('hex');
  return { kind: 'human', subject_id: `human:${subject}`, display_name: 'Fixture operator' };
}

export function publishOptions(
  account: HumanIdentityFixture,
  overrides: {
    readonly authority?: (client: DatabaseClient) => Promise<Readonly<HumanPublishProvenance>>;
    readonly signal?: AbortSignal;
  } = {},
): PublishOptions {
  return {
    requirePreparedConsoleIntent: true,
    consoleIntentOperatorScope: HUMAN_PUBLISH_SCOPE,
    consoleAuthor: authorFor(account),
    signal: overrides.signal ?? new AbortController().signal,
    humanAuthority: overrides.authority ?? (async (client) => {
      const snapshot = await lockHumanIdentity(client, account.key, account.humanId);
      return { humanId: snapshot.humanId, tenantId: snapshot.membership.tenantId, actorAlias: snapshot.membership.actorAlias };
    }),
  };
}

export async function waitForBlocked(observer: DatabaseClient, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${String(pid)} did not reach the expected lock barrier`);
}

export async function installPublishBarrier(): Promise<{
  blocker: DatabaseClient;
  blockerPid: number;
  functionName: string;
  triggerName: string;
  release: () => Promise<void>;
}> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `human_publish_barrier_${suffix}`;
  const triggerName = `human_publish_barrier_${suffix}`;
  await pool().query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      PERFORM pg_advisory_xact_lock(${String(LOCK_CLASS)},${String(LOCK_OBJECT)});
      RETURN NEW;
    END $body$`);
  await pool().query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON messages
    FOR EACH ROW WHEN (NEW.auth_channel='human-mcp') EXECUTE FUNCTION public.${functionName}()`);
  let blocker: DatabaseClient | undefined;
  try {
    blocker = await pool().connect();
    await blocker.query('SELECT pg_advisory_lock($1,$2)', [LOCK_CLASS, LOCK_OBJECT]);
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (blockerPid === undefined) throw new Error('missing publish barrier PostgreSQL PID');
    const lockedBlocker = blocker;
    return {
      blocker: lockedBlocker, blockerPid, functionName, triggerName,
      release: async () => { await lockedBlocker.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_CLASS, LOCK_OBJECT]); },
    };
  } catch (error) {
    if (blocker !== undefined) {
      await blocker.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_CLASS, LOCK_OBJECT]).catch(() => undefined);
      blocker.release();
    }
    await pool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON messages`);
    await pool().query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    throw error;
  }
}

export async function removePublishBarrier(
  barrier: { blocker: DatabaseClient; blockerPid: number; functionName: string; triggerName: string },
): Promise<void> {
  try {
    await barrier.blocker.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_CLASS, LOCK_OBJECT]);
  } finally {
    barrier.blocker.release();
    await pool().query(`DROP TRIGGER IF EXISTS ${barrier.triggerName} ON messages`);
    await pool().query(`DROP FUNCTION IF EXISTS public.${barrier.functionName}()`);
  }
}

export async function blockingPids(observer: DatabaseClient, pid: number): Promise<number[]> {
  const result = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1) AS pids', [pid]);
  return result.rows[0]?.pids ?? [];
}

export async function countsFor(input: PublishMessage): Promise<Record<string, string>> {
  const result = await pool().query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM messages WHERE request_id=$1) AS messages,
       (SELECT count(*)::text FROM messages m JOIN human_message_initiators h ON h.message_id=m.id WHERE m.request_id=$1) AS initiators,
       (SELECT count(*)::text FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.request_id=$1) AS deliveries,
       (SELECT count(*)::text FROM adapter_outbox WHERE request_id=$1) AS outbox,
       (SELECT count(*)::text FROM audit_events WHERE request_id=$1 AND action='message.publish') AS audit,
       (SELECT count(*)::text FROM idempotency_keys WHERE tenant_id=$2 AND actor_alias=$3 AND idempotency_key=$4) AS idempotency`,
    [input.request_id, input.tenant_id, input.actor_alias, input.idempotency_key],
  );
  return result.rows[0] ?? {};
}

export function databasePool(): DatabasePool { return pool(); }
