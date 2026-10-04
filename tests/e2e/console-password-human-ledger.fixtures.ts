import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CauceRepository } from '@cauce/store';
import { AckSchema, ConsolePublishIntentPrepareResultSchema, PublishResultSchema } from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/app.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { AdapterEngine } from '../../packages/adapter-sdk/src/sdk/engine.js';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { deliveryHarnesses } from '../../packages/adapter-sdk/src/bin/shared.js';
import { claudeDefinition } from '../../packages/adapter-sdk/src/harnesses/claude.js';
import { humanHarnessSelector } from '../../packages/adapter-sdk/src/sdk/engine/delivery-context.js';
import type { CommandRunner, CommandRunRequest, Delivery } from '../../packages/adapter-sdk/src/sdk/types.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

export interface Session { cookie: string; csrf: string }
export interface HttpResult { status: number; cookie?: string; body: unknown }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
export async function startConsoleLedgerFixture(options: { sessionTtlMs?: number; retainSessionLookup?: boolean } = {}) {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) throw new Error('Disposable PostgreSQL is required');
  let database: TestDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let directory: string | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    if (app) { try { await app.close(); } catch (error) { failures.push(error); } app = undefined; }
    if (database) {
      try { await database.pool.end(); } catch (error) { failures.push(error); }
      try { await database.container.stop(); } catch (error) { failures.push(error); }
      database = undefined;
    }
    if (directory) { try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); } directory = undefined; }
    if (failures.length) throw new AggregateError(failures, 'Console ledger cleanup failed');
  };
  try {
    database = await startTestDatabase();
    console.info(`Owned PostgreSQL container: ${database.container.getId()}`);
    const metadata = await promisify(execFile)('docker', ['inspect', database.container.getId(), '--format',
      '{{json .Mounts}} {{json .NetworkSettings.Ports}}'], { timeout: 5000 });
    console.info(`Owned PostgreSQL mounts/ports: ${metadata.stdout.trim()}`);
    const pool = database.pool;
    const repository = new CauceRepository(pool);
    const suffix = randomBytes(6).toString('hex');
    const tenant = 'Isa';
    const actor = `human-${suffix}`;
    const target = `target-${suffix}`;
    const room = `ledger-${suffix}`;
    await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
      container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'claude',true,10,$4,'dev','/home/dev','/home/dev/.cauce'),
      ($1,$3,'claude',true,10,$5,'dev','/home/dev','/home/dev/.cauce')`,
    [tenant, actor, target, `own-actor-${suffix}`, `own-target-${suffix}`]);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')`, [tenant, room, actor, target]);
    const users = await Promise.all(['a', 'b', 'missing'].map(async (label) => {
      const email = `${label}-${suffix}@fixture.invalid`;
      const password = randomBytes(24).toString('base64url');
      if (label === 'missing') {
        const inserted = await pool.query<{ id: string }>(`INSERT INTO console_users
          (email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
          VALUES($1,$2,$3,$4,'operator',$5,$6,true) RETURNING id`,
        [email, email.toLowerCase(), await hashPassword(password), 'Human missing', tenant, actor]);
        const id = inserted.rows[0]?.id;
        if (id === undefined) throw new Error('Missing-membership console account was not inserted');
        return { id, email, password };
      }
      const user = await maintainConsoleUser(pool, { email, name: `Human ${label}`, role: 'operator',
        tenant, alias: actor, updateOnly: false, activate: false }, await hashPassword(password));
      await pool.query(`UPDATE human_tenant_memberships SET permissions=ARRAY['route','read']
        WHERE human_id=$1 AND tenant_id=$2 AND actor_alias=$3`, [user.id, tenant, actor]);
      return { id: user.id, email, password };
    }));
    directory = await mkdtemp(join(tmpdir(), 'cch-'));
    const tls = createSelfSignedCert({ directory });
    await chmod(tls.key_path, 0o600);
    const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32), ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }) });
    await provider.ready();
    app = await buildGateway({ pool, repository, authProvider: provider, https: { key: tls.key, cert: tls.cert } });
    const completed = new Set<string>();
    const disconnected = new Set<string>();
    if (options.retainSessionLookup) {
      const verified = provider.verifiedConsoleSession.bind(provider);
      provider.verifiedConsoleSession = async (request) => {
        const session = await verified(request);
        if (session) await new PostgresConsoleUserStore(pool).findById(session.humanId);
        return session;
      };
      const prepareIntent = repository.prepareConsolePublishIntent.bind(repository);
      repository.prepareConsolePublishIntent = async (...args) => {
        try { return await prepareIntent(...args); }
        finally { completed.add(args[0].intent_nonce); }
      };
      app.addHook('preHandler', async (request, reply) => {
        const nonce = typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>).intent_nonce : undefined;
        if (typeof nonce === 'string') reply.raw.once('close', () => { disconnected.add(nonce); });
      });
    }
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const send = (path: string, payload: unknown, session?: Session, signal?: AbortSignal): Promise<HttpResult> => new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = request(new URL(path, base), { method: 'POST', ca: tls.cert, rejectUnauthorized: true,
        ...(signal === undefined ? {} : { signal }), headers: { origin: base, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(data), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) } }, (response) => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length;
          if (length > 1024 * 1024) req.destroy(new Error('Response bound exceeded')); else chunks.push(chunk); });
        response.once('error', reject);
        response.once('end', () => { clearTimeout(timer); try {
          const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
          resolve({ status: response.statusCode ?? 0, ...(cookie ? { cookie } : {}),
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        } catch (error) { reject(error instanceof Error ? error : new Error('Invalid response')); } });
      });
      const timer = setTimeout(() => { req.destroy(new Error('HTTP fixture deadline exceeded')); }, 15_000);
      req.once('error', (error) => { clearTimeout(timer); reject(error); }); req.end(data);
    });
    const login = async (index: number): Promise<Session> => {
      const user = users[index]; if (!user) throw new Error('Missing user');
      const response = await send('/v3/auth/login', { email: user.email, password: user.password });
      const csrf = object(response.body).csrf_token;
      if (response.status !== 200 || !response.cookie || typeof csrf !== 'string') throw new Error('Password login failed');
      return { cookie: response.cookie, csrf };
    };
    const command = () => ({ room_id: room, recipients: [{ tenant_id: tenant, alias: target }],
      body: { text: `own-${randomUUID()}` }, lane: 'interactive', priority: 10 });
    const prepare = async (session: Session, body = command()) => {
      const nonce = randomUUID();
      const response = await send('/v3/console/publish-intents', { ...body, intent_nonce: nonce }, session);
      if (response.status !== 200) throw new Error(`Prepare returned ${String(response.status)}`);
      const intent = ConsolePublishIntentPrepareResultSchema.parse(response.body);
      if (intent.state !== 'prepared') throw new Error('Expected prepared intent');
      return { body: { ...body, idempotency_key: intent.idempotency_key }, nonce, intent };
    };
    const publish = async (session: Session) => {
      const prepared = await prepare(session);
      const response = await send('/v3/console/messages', prepared.body, session);
      if (response.status !== 202) throw new Error(`Publish returned ${String(response.status)}`);
      const receipt = PublishResultSchema.parse(response.body);
      const confirmed = await send('/v3/console/publish-intents/confirm', { idempotency_key: receipt.idempotency_key,
        message_id: receipt.message_id, causal_hash: receipt.causal_hash }, session);
      if (confirmed.status !== 200 || object(confirmed.body).confirmed !== true) throw new Error('Confirmation failed');
      return { ...prepared, receipt };
    };
    return { pool, repository, users, tenant, actor, target, room, directory, provider, instance: randomUUID(),
      containerId: database.container.getId(), completed, disconnected, send, login, command, prepare, publish, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Setup cleanup failed'); }
    throw error;
  }
}

export async function consumeConsoleRoots(fixture: Awaited<ReturnType<typeof startConsoleLedgerFixture>>, ids: string[]) {
  const instance = fixture.instance;
  const lease = await fixture.repository.acquireLease(fixture.tenant, fixture.target, instance,
    ['human_message_initiator_v1', 'console_human_scope_v1'], 60_000);
  if (lease.epoch === undefined) throw new Error('Missing canonical lease epoch');
  const claims = await fixture.repository.claimDeliveries(fixture.tenant, fixture.target, instance, lease.epoch, 100, 30_000);
  const deliveries = ids.map((id): Delivery => {
    const claim = claims.find((item) => item.message_id === id);
    if (!claim?.authenticated_context) throw new Error('Missing canonical claim');
    return { ...claim, authenticated_context: { session_id: claim.authenticated_context.session_id,
      channel: claim.authenticated_context.channel,
      ...(claim.authenticated_context.origin === undefined ? {} : { origin: claim.authenticated_context.origin }) } };
  });
  const requests: CommandRunRequest[] = [];
  const manual: CommandRunner = { run: async () => { throw new Error('Human root entered manual TTY'); } };
  const headless: CommandRunner = { run: async (request) => {
    requests.push(request);
    const human = fixture.users.find((user) => request.stdin.includes(user.id));
    if (human === undefined) throw new Error('Missing trusted human prompt context');
    request.onHarnessStart?.();
    return { stdout: JSON.stringify({ result: JSON.stringify({ reply: `owned output ${human.id}`, messages: [],
      status: 'done', retryable: false, artifacts: [] }) }), stderr: '', exitCode: 0, signal: null,
      cancelled: false, timedOut: false, harnessStarted: true };
  } };
  const store = await DurableStore.open(join(fixture.directory, 'sdk'));
  const adapters = deliveryHarnesses({ definition: claudeDefinition, runner: manual, store,
    sessionNamespace: fixture.target, sharedSession: { alias: fixture.target, harness: 'claude', stateDirectory: fixture.directory } }, headless);
  const engine = new AdapterEngine({ store, harness: adapters.harness, ownTenantId: fixture.tenant,
    harnessForDelivery: humanHarnessSelector(adapters.harness, adapters.humanHarness), executionIntentMode: 'local-test-only',
    publish: async (event) => {
      const result = await fixture.repository.ackDelivery(event.delivery_id, fixture.tenant, fixture.target,
        AckSchema.parse({ event_id: event.event_id, instance_id: instance, epoch: event.epoch,
          attempt: event.attempt, claim_token: event.claim_token, status: event.phase,
          ...(event.execution_started ? { execution_started: true } : {}),
          ...(event.output === undefined ? {} : { result: { output: event.output } }) }));
      if (!result.applied) throw new Error('Canonical ACK was not applied');
    } });
  await engine.activateEpoch(lease.epoch);
  try { for (const delivery of deliveries) await engine.handleDelivery(delivery); }
  finally { engine.stop(); }
  return { deliveries, requests };
}
