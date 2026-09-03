import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ConsolePublishIntentPrepareResultSchema } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeTestDatabase, dockerTestRequirement, resetTestDatabase, startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';

type Gateway = Awaited<ReturnType<typeof buildGateway>>;

let database: TestDatabase | undefined;
let pool: DatabasePool;
let app: Gateway | undefined;
const databaseRequirement = dockerTestRequirement(
  'console two-phase publish of a body carrying a secret against real PostgreSQL',
);
const testDatabaseNeedsDocker = !process.env.CAUCE_TEST_DATABASE_URL;

const headers = {
  'x-cauce-tenant': 'Steven',
  'x-cauce-alias': 'kant',
  origin: 'http://localhost',
};

const secret = 'sk-ant-api03-0123456789abcdefghij';
const semantic = {
  room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
  body: { text: `usa este token: Bearer ${secret} contra el relay` },
  lane: 'interactive',
  priority: 10,
} as const;

beforeEach(async ({ skip }) => {
  if (testDatabaseNeedsDocker) await databaseRequirement.skipIfUnavailable(skip);
  if (database === undefined) {
    database = await startTestDatabase();
    pool = database.pool;
  }
  await app?.close();
  await resetTestDatabase(pool);
  app = await buildGateway({
    pool,
    repository: new CauceRepository(pool),
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: async () => async () => undefined,
    outboxPollMs: 60_000,
    exposeHealthRoutes: false,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeTestDatabase(database);
});

it('commits a console publish whose text matches a redaction rule and stores it redacted', async () => {
  if (app === undefined) throw new Error('gateway test setup did not complete');
  const prepared = await app.inject({
    method: 'POST',
    url: '/v3/console/publish-intents',
    headers,
    payload: { ...semantic, intent_nonce: randomUUID() },
  });
  expect(prepared.statusCode).toBe(200);
  const intent = ConsolePublishIntentPrepareResultSchema.parse(prepared.json());
  expect(intent.state).toBe('prepared');

  // The regression: prepare hashed the raw body and publish hashed the redacted one, so the store
  // answered 409 and the operator could never send this message at all.
  const published = await app.inject({
    method: 'POST',
    url: '/v3/console/messages',
    headers,
    payload: { ...semantic, idempotency_key: intent.idempotency_key },
  });
  expect(published.statusCode).toBe(202);

  const stored = (await pool.query<{ body: { text?: string } }>(
    'SELECT body FROM messages ORDER BY created_at DESC LIMIT 1',
  )).rows[0]?.body;
  expect(stored?.text).toBe('usa este token: Bearer [secreto-redactado] contra el relay');
  expect(JSON.stringify(stored)).not.toContain(secret);
}, 180_000);

it('keeps the two legs byte-identical when redaction finds nothing to rewrite', async () => {
  if (app === undefined) throw new Error('gateway test setup did not complete');
  const clean = { ...semantic, body: { text: 'sin credenciales' } };
  const prepared = await app.inject({
    method: 'POST',
    url: '/v3/console/publish-intents',
    headers,
    payload: { ...clean, intent_nonce: randomUUID() },
  });
  expect(prepared.statusCode).toBe(200);
  const intent = ConsolePublishIntentPrepareResultSchema.parse(prepared.json());
  const published = await app.inject({
    method: 'POST',
    url: '/v3/console/messages',
    headers,
    payload: { ...clean, idempotency_key: intent.idempotency_key },
  });
  expect(published.statusCode).toBe(202);
  expect((await pool.query<{ body: { text?: string } }>(
    'SELECT body FROM messages ORDER BY created_at DESC LIMIT 1',
  )).rows[0]?.body.text).toBe('sin credenciales');
}, 180_000);
