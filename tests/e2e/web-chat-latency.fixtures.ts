import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConsolePublishIntentPrepareResultSchema, PublishResultSchema, type PublishResult } from '@cauce/protocol';
import { CauceRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { StoreTelegramIngress } from '../../services/telegram-bridge/src/ingress.js';
import { AdapterEngine } from '../../packages/adapter-sdk/src/sdk/engine.js';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { HarnessAdapter } from '../../packages/adapter-sdk/src/harnesses/shared/adapter.js';
import { openClawDefinition } from '../../packages/adapter-sdk/src/harnesses/openclaw.js';
import type { CommandRunner, CommandRunRequest, CommandRunResult, Delivery, DeliveryEvent } from '../../packages/adapter-sdk/src/sdk/types.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected fixture JSON object');
  return value as Record<string, unknown>;
}

export interface PhaseMark { phase: string; at: number }
interface HttpResult { status: number; body: unknown; cookie?: string }
interface Session { cookie: string; csrf: string }

export class HeldDeterministicRunner implements CommandRunner {
  readonly witnessesHarnessStart = true;
  readonly requests: CommandRunRequest[] = [];
  readonly entered: Promise<void>;
  private enter: () => void = () => undefined;
  private release: () => void = () => undefined;
  private readonly completion: Promise<void>;
  constructor(private readonly mark: (phase: string) => void, readonly reply: string) {
    this.entered = new Promise((resolve) => { this.enter = resolve; });
    this.completion = new Promise((resolve) => { this.release = resolve; });
  }
  finish(): void { this.release(); }
  async run(command: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(command);
    this.mark('deterministic-runner-entered');
    this.enter();
    command.signal.addEventListener('abort', this.release, { once: true });
    try { await this.completion; } finally { command.signal.removeEventListener('abort', this.release); }
    return {
      stdout: JSON.stringify({ reply: this.reply, messages: [], notify: [], status: 'done', retryable: false, artifacts: [] }),
      stderr: '', exitCode: 0, signal: null, timedOut: false,
      cancelled: command.signal.aborted, harnessStarted: true,
    };
  }
}

export async function startChatLatencyFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) {
    throw new Error('Chat latency fixture requires its own disposable database');
  }
  if (process.env.CAUCE_OPENCLAW_WORKSPACE !== undefined) throw new Error('Fixture must not read an operator workspace');
  let database: TestDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let directory: string | undefined;
  const engines: AdapterEngine[] = [];
  const executions: Promise<void>[] = [];
  const runners: HeldDeterministicRunner[] = [];
  const clients = new Set<ReturnType<typeof request>>();
  const marks: PhaseMark[] = [];
  const mark = (phase: string) => { marks.push({ phase, at: performance.now() }); };
  const close = async () => {
    const failures: unknown[] = [];
    for (const engine of engines) engine.stop();
    for (const runner of runners) runner.finish();
    for (const execution of executions) {
      try { await execution; } catch (error) { failures.push(error); }
    }
    for (const client of clients) client.destroy();
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
    if (failures.length > 0) throw new AggregateError(failures, 'Chat latency fixture cleanup failed');
  };
  try {
    database = await startTestDatabase();
    const pool = database.pool;
    const repository = new CauceRepository(pool);
    const suffix = randomBytes(6).toString('hex');
    const tenant = 'Isa';
    const actor = `chat-human-${suffix}`;
    const target = `chat-agent-${suffix}`;
    const room = `chat-latency-${suffix}`;
    await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
      container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'openclaw',true,10,$4,'claw','/home/claw','/home/claw/.cauce'),
      ($1,$3,'openclaw',true,10,$5,'claw','/home/claw','/home/claw/.cauce')`,
    [tenant, actor, target, `chat-own-actor-${suffix}`, `chat-own-agent-${suffix}`]);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')`, [tenant, room, actor, target]);
    const email = `latency-${suffix}@fixture.invalid`;
    const password = randomBytes(24).toString('base64url');
    await maintainConsoleUser(pool, { email, name: 'Latency fixture', role: 'operator', tenant, alias: actor,
      updateOnly: false, activate: false }, await hashPassword(password));
    directory = await mkdtemp(join(tmpdir(), 'cauce-chat-latency-'));
    await chmod(directory, 0o700);
    const tls = createSelfSignedCert({ directory });
    await chmod(tls.key_path, 0o600);
    const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) });
    await authProvider.ready();
    app = await buildGateway({ pool, authProvider, https: { key: tls.key, cert: tls.cert } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const send = (method: 'GET' | 'POST', path: string, payload?: unknown, session?: Session): Promise<HttpResult> => new Promise((resolve, reject) => {
      const data = payload === undefined ? undefined : JSON.stringify(payload);
      const client = request(new URL(path, base), { method, ca: tls.cert, rejectUnauthorized: true,
        headers: { origin: base,
          ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
          ...(session === undefined ? {} : { cookie: session.cookie, 'x-csrf-token': session.csrf }),
        } }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1024 * 1024) client.destroy(new Error('Fixture response exceeds bound'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          clearTimeout(timer);
          try {
            const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              ...(cookie === undefined ? {} : { cookie }) });
          } catch { reject(new Error('Fixture returned invalid JSON')); }
        });
      });
      clients.add(client);
      client.once('close', () => { clients.delete(client); clearTimeout(timer); });
      const timer = setTimeout(() => { client.destroy(new Error('Fixture HTTPS request timed out')); }, 10_000);
      client.once('error', (error) => { clearTimeout(timer); reject(error); });
      client.end(data);
    });
    const login = await send('POST', '/v3/auth/login', { email, password });
    const csrf = jsonObject(login.body).csrf_token;
    if (login.status !== 200 || login.cookie === undefined || typeof csrf !== 'string') throw new Error('Real password login failed');
    const session = { cookie: login.cookie, csrf };
    const semantic = { room_id: room, recipients: [{ tenant_id: tenant, alias: target }], body: { text: 'ping deterministic QA' }, lane: 'interactive', priority: 10 };
    const publishConsole = async (): Promise<PublishResult> => {
      mark('console-prepare-begin');
      const prepared = await send('POST', '/v3/console/publish-intents', { ...semantic, intent_nonce: randomUUID() }, session);
      if (prepared.status !== 200) throw new Error('Canonical prepare failed');
      const intent = ConsolePublishIntentPrepareResultSchema.parse(prepared.body);
      if (intent.state !== 'prepared') throw new Error('Expected prepared fixture intent');
      mark('console-prepared');
      const published = await send('POST', '/v3/console/messages', { ...semantic, idempotency_key: intent.idempotency_key }, session);
      if (published.status !== 202) throw new Error('Canonical publish failed');
      const receipt = PublishResultSchema.parse(published.body);
      mark('console-receipt-202');
      const confirmed = await send('POST', '/v3/console/publish-intents/confirm', { idempotency_key: receipt.idempotency_key,
        message_id: receipt.message_id, causal_hash: receipt.causal_hash }, session);
      if (confirmed.status !== 200 || jsonObject(confirmed.body).confirmed !== true) throw new Error('Canonical confirmation failed');
      mark('console-confirmed');
      return receipt;
    };
    const publishTelegram = async () => {
      const sessionId = randomUUID();
      mark('telegram-ingress-begin');
      await new StoreTelegramIngress(repository).publish({ bot_id: `own-${suffix}`, update_id: 1,
        tenant_id: tenant, alias: actor, room_id: room, recipients: semantic.recipients, body: semantic.body,
        human: true, session_id: sessionId,
        origin: { adapter: 'telegram', channel: 'dm', conversation_id: sessionId, relay: [], metadata: {} } });
      mark('telegram-ingress-published');
      const rows = await pool.query<{ message_id: string }>('SELECT id AS message_id FROM messages WHERE origin->>\'conversation_id\'=$1', [sessionId]);
      const row = rows.rows[0];
      if (row === undefined) throw new Error('Telegram publication missing');
      return row.message_id;
    };
    const detail = async (messageId: string) => {
      const response = await send('GET', `/v3/console/messages/${messageId}`, undefined, session);
      if (response.status !== 200) throw new Error('Authorized message detail failed');
      mark('http-detail-observed');
      return jsonObject(response.body);
    };
    const instance = randomUUID();
    const lease = await repository.acquireLease(tenant, target, instance, [], 60_000);
    const epoch = lease.epoch;
    if (epoch === undefined) throw new Error('Fixture lease has no epoch');
    const startTurn = async (messageId: string, reply: string) => {
      const claims = await repository.claimDeliveries(tenant, target, instance, epoch, 10, 30_000);
      const claim = claims.find((item) => item.message_id === messageId);
      if (claim === undefined) throw new Error('Canonical claim missing publication');
      mark('claim-applied');
      const context = claim.authenticated_context;
      if (context === undefined) throw new Error('Claim lacks trusted context');
      const delivery: Delivery = { ...claim, authenticated_context: {
        session_id: context.session_id, channel: context.channel, ...(context.origin === undefined ? {} : { origin: context.origin }),
      } };
      const runner = new HeldDeterministicRunner(mark, reply);
      runners.push(runner);
      const store = await DurableStore.open(join(directory ?? '', `adapter-${randomUUID()}`));
      const harness = new HarnessAdapter({ definition: openClawDefinition, runner, store, sessionNamespace: target, environment: {} });
      const events: DeliveryEvent[] = [];
      const engine = new AdapterEngine({ store, harness, ownTenantId: tenant, executionIntentMode: 'local-test-only',
        publish: async (event) => {
          await repository.ackDelivery(event.delivery_id, tenant, target, { version: '3.0', event_id: event.event_id,
            claim_token: event.claim_token, attempt: event.attempt, status: event.phase, instance_id: instance, epoch,
            retryable: event.error?.retryable ?? event.output?.retryable ?? false,
            ...(event.execution_started === true ? { execution_started: true } : {}),
            ...(event.error === undefined ? {} : { error: event.error.message, error_code: event.error.code }),
            ...(event.output === undefined ? {} : { result: { output: event.output } }),
          });
          events.push(event);
          mark(`ack-${event.phase}${event.execution_started === true ? '-execution' : ''}-applied`);
        } });
      engines.push(engine);
      await engine.activateEpoch(epoch);
      const completion = engine.handleDelivery(delivery);
      executions.push(completion);
      return { runner, events, completion, delivery };
    };
    const resource = await promisify(execFile)('docker', ['inspect', '--format', '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}', database.container.getId()], { timeout: 5000 });
    return { pool, repository, publishConsole, publishTelegram, detail, startTurn, marks, resourceMetadata: resource.stdout.trim(), containerId: database.container.getId(), close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Chat latency setup and cleanup failed'); }
    throw error;
  }
}
