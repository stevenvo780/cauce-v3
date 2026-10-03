import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConsolePublishIntentPrepareResultSchema, PublishResultSchema,
  type PublishResult,
} from '@cauce/protocol';
import { CauceRepository } from '@cauce/store';
import type { Delivery } from '../../packages/adapter-sdk/src/sdk/types.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

interface Session { cookie: string; csrf: string }
interface HttpResult { status: number; cookie?: string; body: unknown }
export interface HumanPublication {
  userId: string;
  author: unknown;
  delivery: Delivery;
}
export interface HumanContextFixture {
  containerId: string;
  directory: string;
  publications: readonly [HumanPublication, HumanPublication, HumanPublication];
  absent: Delivery;
  ambiguous: Delivery;
  forged: Delivery;
  legacy: Delivery;
  deniedCsrfStatus: number;
  close: () => Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function send(base: string, ca: Buffer, path: string, payload: unknown, session?: Session): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(new URL(path, base), {
      method: 'POST', ca, rejectUnauthorized: true,
      headers: {
        origin: base, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        ...(session === undefined ? {} : { cookie: session.cookie, 'x-csrf-token': session.csrf }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) req.destroy(new Error('HTTP fixture response exceeds bound'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        clearTimeout(timer);
        try {
          const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
          resolve({ status: response.statusCode ?? 0, ...(cookie === undefined ? {} : { cookie }),
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        } catch (error) { reject(error instanceof Error ? error : new Error('Invalid fixture response')); }
      });
    });
    const timer = setTimeout(() => { req.destroy(new Error('HTTPS fixture request timed out')); }, 10_000);
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.end(data);
  });
}

export async function startHumanContextFixture(): Promise<HumanContextFixture> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) throw new Error('This fixture requires its own disposable database');
  let database: TestDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let directory: string | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    if (app !== undefined) {
      try { await app.close(); } catch (error) { failures.push(error); }
      app = undefined;
    }
    if (database !== undefined) {
      try { await database.pool.end(); } catch (error) { failures.push(error); }
      try { await database.container.stop(); } catch (error) { failures.push(error); }
      database = undefined;
    }
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      directory = undefined;
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Human context fixture cleanup failed');
  };
  try {
    database = await startTestDatabase();
    const pool = database.pool;
    const repository = new CauceRepository(pool);
    const suffix = randomBytes(6).toString('hex');
    const tenant = 'Isa';
    const actor = `human-${suffix}`;
    const target = `agent-${suffix}`;
    const room = `human-isolation-${suffix}`;
    await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
      container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'openclaw',true,10,$4,'claw','/home/claw','/home/claw/.cauce'),
      ($1,$3,'openclaw',true,10,$5,'claw','/home/claw','/home/claw/.cauce')`,
    [tenant, actor, target, `cauce-human-actor-${suffix}`, `cauce-human-agent-${suffix}`]);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')`, [tenant, room, actor, target]);
    const users = await Promise.all(['a', 'b'].map(async (label) => {
      const email = `${label}-${suffix}@fixture.invalid`;
      const password = randomBytes(24).toString('base64url');
      const user = await maintainConsoleUser(pool, {
        email, name: `Human ${label}`, role: 'operator', tenant, alias: actor,
        updateOnly: false, activate: false,
      }, await hashPassword(password));
      return { ...user, email, password };
    }));
    const a = users[0];
    const b = users[1];
    if (a === undefined || b === undefined) throw new Error('Missing fixture users');
    directory = await mkdtemp(join(tmpdir(), 'cauce-human-context-'));
    const tls = createSelfSignedCert({ directory });
    await chmod(tls.key_path, 0o600);
    const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) });
    await authProvider.ready();
    app = await buildGateway({ pool, authProvider, https: { key: tls.key, cert: tls.cert } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = async (user: typeof a): Promise<Session> => {
      const result = await send(base, tls.cert, '/v3/auth/login', { email: user.email, password: user.password });
      const csrf = object(result.body).csrf_token;
      if (result.status !== 200 || result.cookie === undefined || typeof csrf !== 'string') throw new Error(`Real password login failed (${String(result.status)})`);
      return { cookie: result.cookie, csrf };
    };
    const semantic = { room_id: room, recipients: [{ tenant_id: tenant, alias: target }],
      body: { text: 'own human context isolation fixture' }, lane: 'interactive', priority: 10 };
    const firstSession = await login(a);
    const denied = await send(base, tls.cert, '/v3/console/publish-intents', { ...semantic, intent_nonce: randomUUID() }, { ...firstSession, csrf: 'invalid-fixture-csrf' });
    const publish = async (session: Session, extraBody: Record<string, unknown> = {}): Promise<PublishResult> => {
      const command = { ...semantic, body: { ...semantic.body, ...extraBody } };
      const prepared = await send(base, tls.cert, '/v3/console/publish-intents', { ...command, intent_nonce: randomUUID() }, session);
      if (prepared.status !== 200) throw new Error(`Prepare failed (${String(prepared.status)}): ${JSON.stringify(prepared.body)}`);
      const intent = ConsolePublishIntentPrepareResultSchema.parse(prepared.body);
      if (intent.state !== 'prepared') throw new Error('Expected new prepared intent');
      const published = await send(base, tls.cert, '/v3/console/messages', { ...command, idempotency_key: intent.idempotency_key }, session);
      if (published.status !== 202) throw new Error(`Publish failed (${String(published.status)}): ${JSON.stringify(published.body)}`);
      const receipt = PublishResultSchema.parse(published.body);
      const confirmed = await send(base, tls.cert, '/v3/console/publish-intents/confirm', {
        idempotency_key: receipt.idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash,
      }, session);
      if (confirmed.status !== 200 || object(confirmed.body).confirmed !== true) throw new Error('Durable intent confirmation failed');
      return receipt;
    };
    const receipts = [await publish(firstSession), await publish(await login(a)), await publish(await login(b))];
    const absent = await publish(firstSession);
    await pool.query(`UPDATE audit_events SET metadata=metadata-'console_author'
      WHERE message_id=$1 AND action='message.publish'`, [absent.message_id]);
    const ambiguous = await publish(firstSession);
    await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata)
      SELECT tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata FROM audit_events
      WHERE message_id=$1 AND action='message.publish'`, [ambiguous.message_id]);
    const forged = await publish(firstSession, { console_human_subject: `human:${'f'.repeat(64)}`, session_key: 'shared-client-label' });
    const instance = randomUUID();
    const lease = await repository.acquireLease(tenant, target, instance, ['console_human_scope_v1'], 60_000);
    if (lease.epoch === undefined) throw new Error('Missing lease epoch');
    const deliveries = await repository.claimDeliveries(tenant, target, instance, lease.epoch, 6, 30_000);
    const sdkClaim = (receipt: PublishResult, claims = deliveries): Delivery => {
      const delivery = claims.find((item) => item.message_id === receipt.message_id);
      if (delivery === undefined) throw new Error('Canonical claim missing publication');
      const context = delivery.authenticated_context;
      if (context === undefined) throw new Error('Canonical claim missing authenticated context');
      return { ...delivery, authenticated_context: {
        session_id: context.session_id, channel: context.channel,
        ...(context.origin === undefined ? {} : { origin: context.origin }),
      } };
    };
    const publications = await Promise.all(receipts.map(async (receipt, index): Promise<HumanPublication> => {
      const detail = await repository.getMessage(receipt.message_id, tenant, actor, 'operator');
      return { userId: index === 2 ? b.id : a.id, author: detail.author, delivery: sdkClaim(receipt) };
    }));
    const legacyReceipt = await publish(firstSession);
    const legacyLease = await repository.acquireLease(tenant, target, instance, [], 60_000, { resume: true });
    if (legacyLease.epoch === undefined) throw new Error('Missing legacy epoch');
    const legacyClaims = await repository.claimDeliveries(tenant, target, instance, legacyLease.epoch, 1, 30_000);
    const one = publications[0]; const two = publications[1]; const three = publications[2];
    if (one === undefined || two === undefined || three === undefined) throw new Error('Expected three publications');
    return { publications: [one, two, three], deniedCsrfStatus: denied.status,
      absent: sdkClaim(absent), ambiguous: sdkClaim(ambiguous), forged: sdkClaim(forged), legacy: sdkClaim(legacyReceipt, legacyClaims),
      containerId: database.container.getId(), directory, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed'); }
    throw error;
  }
}
