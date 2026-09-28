import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach } from 'vitest';
import { type ConsolePublishIntentCommand, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
export let database: TestDatabase;
export let databaseStarted = false;
export let pool: DatabasePool;
export let repository: CauceRepository;
export const OPERATOR_SCOPE = 'a'.repeat(64);
export const OTHER_OPERATOR_SCOPE = 'b'.repeat(64);
export function intent(
  overrides: Partial<ConsolePublishIntentCommand> = {},
): ConsolePublishIntentCommand {
  const base: ConsolePublishIntentCommand = {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `intent-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'durable intent marker' },
    lane: 'interactive',
    priority: 80,
    requested_priority: 10,
    authenticated_context: {
      session_id: 'console-session-before-refresh',
      channel: 'console',
    },
    intent_nonce: randomUUID(),
  };
  return {
    ...base,
    ...overrides,
    intent_nonce: overrides.intent_nonce ?? base.intent_nonce,
  };
}
export function command(
  prepared: ConsolePublishIntentCommand,
  idempotencyKey: string,
  overrides: Partial<PublishMessage> = {},
): PublishMessage {
  const {
    intent_nonce: _intentNonce,
    requested_priority: _requestedPriority,
    ...publishable
  } = prepared;
  void _intentNonce;
  void _requestedPriority;
  return {
    ...publishable,
    idempotency_key: idempotencyKey,
    request_id: randomUUID(),
    trace_id: `publish-${randomUUID()}`,
    ...overrides,
  };
}
export function prepare(
  input: ConsolePublishIntentCommand,
  scope = OPERATOR_SCOPE,
) {
  return repository.prepareConsolePublishIntent(input, scope);
}

export function publishConsole(
  input: ConsolePublishIntentCommand,
  idempotencyKey: string,
  scope = OPERATOR_SCOPE,
  overrides: Partial<PublishMessage> = {},
) {
  return repository.publish(command(input, idempotencyKey, overrides), {
    requirePreparedConsoleIntent: true,
    consoleIntentOperatorScope: scope,
  });
}

export function confirm(
  tenantId: 'Steven' | 'Miguel' | 'Pablo' | 'Isa' | 'Jhon',
  actorAlias: string,
  input: Parameters<CauceRepository['confirmConsolePublishIntent']>[3],
  scope = OPERATOR_SCOPE,
) {
  return repository.confirmConsolePublishIntent(tenantId, actorAlias, scope, input);
}

export function registerConsolePublishSuite(sourceUrl: string): void {
  preparePostgresSuite(sourceUrl, async () => {
    database = await startTestDatabase();
    databaseStarted = true;
    pool = database.pool;
    repository = new CauceRepository(pool);
  }, 180_000);

  beforeEach(async () => {
    await resetTestDatabase(pool);
    repository = new CauceRepository(pool);
  });

  afterAll(async () => {
    if (!databaseStarted) return;
    await pool.end();
    await database.container.stop();
  });
}
