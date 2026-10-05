import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildPublishReceipt, publishRequestHash, type ConsolePublishIntentPrepareResult, type PublishMessage, type PublishResult } from '@cauce/protocol';
import {
  PublishIntentExpiredError, PublishIntentRateLimitedError, PublishIntentReconciliationRequired, StoreError,
  type DatabaseClient, type HumanIdentitySnapshot, type HumanInboxPage, type HumanInboxQuery, type HumanMessageOptions,
} from '@cauce/store';
import { GatewayOperationError, type McpSubmitCommand } from '@cauce/mcp-fleet-monitor/gateway-http';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import type { GatewayRepository } from './app.js';
import type { ConsoleUser } from './console-users.js';
import { consoleMessageAuthor } from './console-message-author.js';
import { createHumanMcpOperationsFactory } from './mcp-operations.js';
import type { ExternalSubjectResolver } from './human-mcp-authority.js';
import { fakeRepository } from './test-support/gateway-doubles.js';
import { OAuthError } from './oauth-authorization-types.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT_A = 'issuer-subject-human-a';
const SUBJECT_B = 'issuer-subject-human-b';
const REQUEST_KEY = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERY_ID = '55555555-5555-4555-8555-555555555555';
const PREPARED_KEY = 'console:prepared-unit-intent';

function account(id: string, email: string, active = true, role: ConsoleUser['role'] = 'operator'): ConsoleUser {
  return { id, email, display_name: 'Human operator', role, tenant_id: 'Steven', alias: 'kant', active,
    password_hash: 'unused-test-hash', password_changed_at: 0 };
}

function identity(subject: string, scopes: readonly string[] = ['cauce.read', 'cauce.publish'], expiresAt = Date.now() / 1000 + 300): VerifiedOAuthIdentity {
  return { kind: 'oauth', issuer: 'https://issuer.test', subject, audience: 'https://mcp.test/mcp', expiresAt, scopes };
}

function command(): McpSubmitCommand {
  return { request_key: REQUEST_KEY, room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
    body: { text: 'unit MCP operation' } };
}

function prepared(): ConsolePublishIntentPrepareResult {
  return { version: 1, state: 'prepared', idempotency_key: PREPARED_KEY, receipt: null };
}

function publishResult(): PublishResult {
  const publish: PublishMessage = {
    version: '3.0', request_id: randomUUID(), trace_id: 'unit-trace', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }], body: { text: 'unit MCP operation' },
    idempotency_key: PREPARED_KEY, authenticated_context: { session_id: 'unit-session', channel: 'human-mcp' },
    lane: 'interactive', priority: 0,
  };
  return buildPublishReceipt(publish, { message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID], duplicate: false,
    request_id: publish.request_id, trace_id: publish.trace_id });
}

function committed(receipt: PublishResult): ConsolePublishIntentPrepareResult {
  return { version: 1, state: 'committed', idempotency_key: PREPARED_KEY, receipt };
}

function setup(repository = fakeRepository()) {
  const users = new Map([[USER_A, account(USER_A, 'a@example.test')], [USER_B, account(USER_B, 'b@example.test')]]);
  const subjects = new Map<string, { userId: string; status: 'active' | 'inactive' | 'revoked' }>([
    [SUBJECT_A, { userId: USER_A, status: 'active' }], [SUBJECT_B, { userId: USER_B, status: 'active' }],
  ]);
  const resolver: ExternalSubjectResolver = { async resolve(current, signal) {
    signal.throwIfAborted();
    const binding = subjects.get(current.subject);
    return binding === undefined ? undefined : { ...binding };
  } };
  const factory = createHumanMcpOperationsFactory({
    repository, users: { findById: async (id) => users.get(id) }, resolver,
    identityStore: {
      async resolve(key, signal) {
        signal.throwIfAborted();
        const binding = subjects.get(key.subject);
        const user = binding?.status === 'active' ? users.get(binding.userId) : undefined;
        if (!user?.active || binding === undefined) return undefined;
        const snapshot: HumanIdentitySnapshot = {
          humanId: user.id, bindingId: `binding-${user.id}`, provider: 'oauth',
          namespace: key.namespace, subject: key.subject, bindingRevision: '1',
          account: { active: user.active, role: user.role, defaultTenant: user.tenant_id, displayName: user.display_name },
          membership: { tenantId: user.tenant_id, actorAlias: user.alias, role: user.role,
            permissions: user.role === 'reader' ? ['read'] : ['read', 'route'], enabled: true, revision: '1' },
        };
        return snapshot;
      },
      async lock(_client, key, humanId) {
        const snapshot = await this.resolve(key, new AbortController().signal);
        if (snapshot?.humanId !== humanId) throw new StoreError('forbidden', 'identity is unavailable');
        return snapshot;
      },
    },
    priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined,
  });
  return { repository, users, subjects, factory };
}

function callsOf(repository: object, name: string): readonly unknown[][] {
  const mocked = Reflect.get(repository, name) as { mock?: { calls?: unknown } } | undefined;
  if (!Array.isArray(mocked?.mock?.calls)) throw new Error(`repository method ${name} is not a mock`);
  return mocked.mock.calls as unknown[][];
}

async function operations(subject = SUBJECT_A, scopes?: readonly string[], expiresAt?: number) {
  const state = setup();
  const auth = identity(subject, scopes, expiresAt);
  const ops = await state.factory.forRequest(auth, new AbortController().signal);
  return { ...state, ops, auth };
}

async function failureOf(operation: Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GatewayOperationError);
  return (caught as GatewayOperationError).failure;
}

describe('human MCP operations phase boundaries', () => {
  it('keeps the server UUID scope stable across login/email changes and separates same-alias UUIDs', async () => {
    const state = setup();
    const a1 = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    await a1.submit(command());
    state.users.set(USER_A, account(USER_A, 'relabeled@example.test'));
    const a2 = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    await a2.submit(command());
    const b = await state.factory.forRequest(identity(SUBJECT_B), new AbortController().signal);
    await b.submit(command());

    const calls = callsOf(state.repository, 'prepareConsolePublishIntent');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
    expect(calls[2]?.[1]).not.toBe(calls[0]?.[1]);
    const published = callsOf(state.repository, 'publish');
    const authors = published.map(([, value]) => {
      const options = value as { consoleAuthor?: { subject_id?: string } } | undefined;
      return options?.consoleAuthor?.subject_id;
    });
    expect(authors[0]).toBe(authors[1]);
    expect(authors[2]).not.toBe(authors[0]);
    const firstPublish = published[0];
    const secondPublish = published[1];
    if (!firstPublish || !secondPublish) throw new Error('expected two sessions for the same user');
    const firstCommand = firstPublish[0] as PublishMessage;
    const secondCommand = secondPublish[0] as PublishMessage;
    const otherHumanCommand = published[2]?.[0] as PublishMessage;
    expect(firstCommand.authenticated_context?.session_id).toBe(secondCommand.authenticated_context?.session_id);
    expect(firstCommand.authenticated_context?.session_id).not.toBe(otherHumanCommand.authenticated_context?.session_id);
    expect(publishRequestHash(firstCommand)).toBe(publishRequestHash(secondCommand));
    expect(publishRequestHash(firstCommand)).not.toBe(publishRequestHash(otherHumanCommand));
  });

  it('rejects extra authority and malformed request keys before any repository call', async () => {
    const state = await operations();
    const valid = command();
    const forgedTenant = { ...valid, tenant_id: 'Isa' };
    const forgedAlias = { ...valid, actor_alias: 'forged' };
    const malformedKey = { ...valid, request_key: 'not-a-uuid' };
    const invalid: McpSubmitCommand[] = [
      forgedTenant, forgedAlias, malformedKey,
    ];
    for (const candidate of invalid) {
      expect(await failureOf(state.ops.submit(candidate))).toEqual({ status_code: 400, error: 'invalid_request' });
    }
    expect(callsOf(state.repository, 'prepareConsolePublishIntent')).toEqual([]);
    expect(callsOf(state.repository, 'publish')).toEqual([]);
  });

  it('requires both live role authority and the matching OAuth scope', async () => {
    const readOnly = await operations(SUBJECT_A, ['cauce.read']);
    expect(await failureOf(readOnly.ops.submit(command()))).toEqual({ status_code: 403, error: 'forbidden' });
    const publishOnly = await operations(SUBJECT_A, ['cauce.publish']);
    expect(await failureOf(publishOnly.ops.status())).toEqual({ status_code: 403, error: 'forbidden' });
    const reader = setup();
    reader.users.set(USER_A, account(USER_A, 'reader@example.test', true, 'reader'));
    const readerOps = await reader.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    expect(await failureOf(readerOps.submit(command()))).toEqual({ status_code: 403, error: 'forbidden' });
    expect(callsOf(reader.repository, 'prepareConsolePublishIntent')).toEqual([]);
    expect(callsOf(reader.repository, 'publish')).toEqual([]);
  });

  it('rejects expired or aborted request contexts without repository writes or private errors', async () => {
    const state = setup();
    const expired = await failureOf(state.factory.forRequest(identity(SUBJECT_A, undefined, Date.now() / 1000 - 1), new AbortController().signal));
    expect(expired).toEqual({ status_code: 401, error: 'unauthorized' });
    const controller = new AbortController();
    controller.abort(new Error('private cancellation reason'));
    const aborted = await failureOf(state.factory.forRequest(identity(SUBJECT_A), controller.signal));
    expect(aborted).toEqual({ status_code: 503, error: 'operation_unavailable' });
    expect(JSON.stringify(aborted)).not.toContain('private cancellation reason');
    expect(callsOf(state.repository, 'prepareConsolePublishIntent')).toEqual([]);
    expect(callsOf(state.repository, 'publish')).toEqual([]);
  });

  it('revalidates authority after prepare and prevents publish when the user is revoked', async () => {
    const state = setup();
    vi.spyOn(state.repository, 'prepareConsolePublishIntent').mockImplementation(async () => {
      state.subjects.set(SUBJECT_A, { userId: USER_A, status: 'revoked' });
      return prepared();
    });
    const ops = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    expect(await failureOf(ops.submit(command()))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(callsOf(state.repository, 'prepareConsolePublishIntent')).toHaveLength(1);
    expect(callsOf(state.repository, 'publish')).toEqual([]);
    expect(callsOf(state.repository, 'confirmConsolePublishIntent')).toEqual([]);
  });

  it('does not claim rollback when revocation follows commit and blocks confirmation and later calls', async () => {
    const state = setup();
    vi.spyOn(state.repository, 'verifyPublishReceipt').mockResolvedValue(true);
    vi.spyOn(state.repository, 'publish').mockImplementation(async (input) => {
      state.subjects.set(SUBJECT_A, { userId: USER_A, status: 'revoked' });
      return buildPublishReceipt(input, { message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID], duplicate: false,
        request_id: input.request_id, trace_id: input.trace_id });
    });
    const ops = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    expect(await failureOf(ops.submit(command()))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(callsOf(state.repository, 'publish')).toHaveLength(1);
    expect(callsOf(state.repository, 'confirmConsolePublishIntent')).toEqual([]);
    expect(await failureOf(ops.submit(command()))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(callsOf(state.repository, 'prepareConsolePublishIntent')).toHaveLength(1);
  });

  it('recovers a committed receipt after confirmation failure without publishing twice', async () => {
    let durable: PublishResult | undefined;
    const prepare = vi.fn(async () => durable === undefined ? prepared() : committed(durable));
    const publish = vi.fn(async (input: Parameters<GatewayRepository['publish']>[0]) => {
      durable = buildPublishReceipt(input, { message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID], duplicate: false,
        request_id: input.request_id, trace_id: input.trace_id });
      return durable;
    });
    let confirmations = 0;
    const confirm = vi.fn(async (...args: Parameters<GatewayRepository['confirmConsolePublishIntent']>) => {
      confirmations += 1;
      if (confirmations === 1) throw new Error('private confirmation backend detail');
      const input = args[3];
      return { version: 1 as const, confirmed: true as const, ...input };
    });
    const verify = vi.fn(async () => true);
    const state = setup(fakeRepository({ prepareConsolePublishIntent: prepare, publish,
      confirmConsolePublishIntent: confirm, verifyPublishReceipt: verify }));
    const ops = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    expect(await failureOf(ops.submit(command()))).toEqual({ status_code: 503, error: 'operation_unavailable',
      safe_to_retry_same_request_key: true });
    expect(await ops.submit(command())).toEqual(durable);
    expect(publish).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('maps typed store and publish-journal failures to closed structured results', async () => {
    const receipt = publishResult();
    const reconciliation = new PublishIntentReconciliationRequired({ version: 1,
      error: 'publish_intent_reconciliation_required', state: 'committed', idempotency_key: PREPARED_KEY, receipt });
    const cases: readonly [Error, Record<string, unknown>][] = [
      [new StoreError('not_found', 'private'), { status_code: 404, error: 'not_found' }],
      [new StoreError('forbidden', 'private'), { status_code: 403, error: 'forbidden' }],
      [new StoreError('fenced', 'private'), { status_code: 403, error: 'forbidden' }],
      [new StoreError('invalid_input', 'private'), { status_code: 400, error: 'invalid_request' }],
      [new StoreError('no_route', 'private'), { status_code: 400, error: 'invalid_request' }],
      [new StoreError('conflict', 'private'), { status_code: 409, error: 'operation_conflict' }],
      [new StoreError('conflict', 'idempotency request is still in progress'),
        { status_code: 409, error: 'operation_conflict', safe_to_retry_same_request_key: true }],
      [new StoreError('conflict', 'private', 'idempotency_durable_conflict'),
        { status_code: 409, error: 'operation_conflict' }],
      [new Error('private backend detail'), { status_code: 503, error: 'operation_unavailable', safe_to_retry_same_request_key: true }],
      [new OAuthError('invalid_grant'), { status_code: 401, error: 'unauthorized' }],
      [new OAuthError('invalid_scope'), { status_code: 403, error: 'forbidden' }],
      [new PublishIntentExpiredError(PREPARED_KEY), { status_code: 410, version: 1,
        error: 'publish_intent_expired', state: 'expired', idempotency_key: PREPARED_KEY, safe_to_resubmit: true }],
      [new PublishIntentRateLimitedError(30), { status_code: 429, version: 1,
        error: 'publish_intent_rate_limited', retry_after_seconds: 30, safe_to_retry: true }],
      [reconciliation, { status_code: 409, version: 1, error: 'publish_intent_reconciliation_required',
        state: 'committed', idempotency_key: PREPARED_KEY, receipt }],
    ];
    for (const [error, expected] of cases) {
      const state = setup();
      vi.spyOn(state.repository, 'prepareConsolePublishIntent').mockRejectedValue(error);
      const ops = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
      const failure = await failureOf(ops.submit(command()));
      expect(failure).toEqual(expected);
      expect(JSON.stringify(failure)).not.toContain('private backend detail');
    }
  });

  it('projects canonical receipt replies only for the audited owner and fails closed for aliases and incomplete rows', async () => {
    const state = setup();
    const owner = state.users.get(USER_A);
    if (!owner) throw new Error('owner fixture missing');
    const author = consoleMessageAuthor({ tenant_id: owner.tenant_id, alias: owner.alias, session_id: 'unit', channel: 'mcp',
      roles: ['operator'], permissions: ['read', 'route'], operator_id: owner.email,
      operator_profile: { id: `console:${owner.id}`, display_name: owner.display_name } });
    const terminalAt = new Date().toISOString();
    const detail = { id: MESSAGE_ID, tenant_id: 'Steven', actor_alias: 'kant', author,
      body: { text: 'must not leave receipt projection' }, result: { raw: 'private adapter output' }, chain_open: true,
      deliveries: [
        { delivery_id: DELIVERY_ID, tenant_id: 'Steven', alias: 'jarvis', status: 'done', attempt: 1,
          terminal_at: terminalAt, reply: 'canonical answer' },
        { delivery_id: '66666666-6666-4666-8666-666666666666', tenant_id: 'Steven', alias: 'other', status: 'started',
          attempt: 1, terminal_at: null, reply: null },
      ] };
    const owned = async (_messageId: string, access: HumanMessageOptions) => {
      const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DatabaseClient;
      const owner = await access.humanAuthority(client);
      if (owner.humanId !== USER_A) throw new StoreError('not_found', 'message is not owned');
      return detail;
    };
    vi.spyOn(state.repository, 'getHumanMessage').mockImplementation(owned);
    const ownerOps = await state.factory.forRequest(identity(SUBJECT_A), new AbortController().signal);
    const projected = await ownerOps.receipt(MESSAGE_ID);
    expect(projected).toMatchObject({ message_id: MESSAGE_ID, chain_open: true,
      deliveries: [
        { delivery_id: DELIVERY_ID, tenant_id: 'Steven', alias: 'jarvis', status: 'done', attempt: 1,
          terminal_at: terminalAt, reply: 'canonical answer' },
        { delivery_id: '66666666-6666-4666-8666-666666666666', tenant_id: 'Steven', alias: 'other', status: 'started',
          attempt: 1, terminal_at: null, reply: null },
      ] });
    expect(JSON.stringify(projected)).not.toContain('private adapter output');
    expect(JSON.stringify(projected)).not.toContain('must not leave receipt projection');

    const sameAliasOtherUuid = await state.factory.forRequest(identity(SUBJECT_B), new AbortController().signal);
    expect(await failureOf(sameAliasOtherUuid.receipt(MESSAGE_ID))).toEqual({ status_code: 404, error: 'not_found' });
    vi.spyOn(state.repository, 'getHumanMessage').mockRejectedValue(new StoreError('not_found', 'private missing row'));
    expect(await failureOf(ownerOps.receipt('77777777-7777-4777-8777-777777777777')))
      .toEqual({ status_code: 404, error: 'not_found' });
    vi.spyOn(state.repository, 'getHumanMessage').mockResolvedValue({ ...detail, deliveries: [] });
    expect(await failureOf(ownerOps.receipt(MESSAGE_ID))).toEqual({ status_code: 409, error: 'operation_conflict' });
  });

  it('reads only the authorized human inbox through a re-locked read authority and projects it closed', async () => {
    const state = setup();
    const inboxPage: HumanInboxPage = { withheld: 1, next: { at: '2026-10-03T12:00:00.123456Z', id: MESSAGE_ID }, items: [{
      key: { at: '2026-10-03T12:00:00.123456Z', id: MESSAGE_ID }, messageId: MESSAGE_ID,
      createdAt: '2026-10-03T12:00:00.123456Z', lastActivityAt: '2026-10-03T12:00:01.000000Z', roomId: 'grp.steven',
      from: { tenantId: 'Steven', alias: 'kant' }, text: 'own root', chainOpen: false, questions: [], chainMessages: [],
      chainMessagesTruncated: false, deliveries: [{ deliveryId: DELIVERY_ID, tenantId: 'Steven', alias: 'jarvis', status: 'done',
        attempt: 1, terminalAt: '2026-10-03T12:00:01.000000+00:00', reply: 'canonical answer' }],
    }] };
    const queries: HumanInboxQuery[] = [];
    vi.spyOn(state.repository, 'listHumanInbox').mockImplementation(async (query, access) => {
      queries.push(query);
      const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DatabaseClient;
      const owner = await access.humanAuthority(client);
      if (owner.humanId !== USER_A) throw new StoreError('not_found', 'not owned');
      return inboxPage;
    });
    const ops = await state.factory.forRequest(identity(SUBJECT_A, ['cauce.read']), new AbortController().signal);
    const first = await ops.inbox({ limit: 1 });
    expect(first).toMatchObject({ withheld: 1, items: [{ message_id: MESSAGE_ID, chain_open: false,
      deliveries: [{ delivery_id: DELIVERY_ID, reply: 'canonical answer', reply_truncated: false }] }] });
    expect(queries[0]).toEqual({ mode: 'recent', limit: 1, openOnly: false });
    const cursor = first.next_cursor;
    if (cursor === null) throw new Error('expected a next cursor');
    await ops.inbox({ cursor, limit: 1 });
    expect(queries[1]).toEqual({ mode: 'recent', limit: 1, openOnly: false,
      after: { at: '2026-10-03T12:00:00.123456Z', id: MESSAGE_ID } });

    const other = await state.factory.forRequest(identity(SUBJECT_B, ['cauce.read']), new AbortController().signal);
    expect(await failureOf(other.inbox({ cursor }))).toEqual({ status_code: 400, error: 'invalid_request' });
    expect(await failureOf(other.inbox({}))).toEqual({ status_code: 404, error: 'not_found' });
    expect(queries).toHaveLength(3);

    state.subjects.set(SUBJECT_A, { userId: USER_A, status: 'revoked' });
    expect(await failureOf(ops.inbox({}))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(queries).toHaveLength(3);
  });

  it('requires the read scope and maps inbox failures without private detail', async () => {
    const publishOnly = await operations(SUBJECT_A, ['cauce.publish']);
    expect(await failureOf(publishOnly.ops.inbox({}))).toEqual({ status_code: 403, error: 'forbidden' });
    expect(callsOf(publishOnly.repository, 'listHumanInbox')).toEqual([]);
    const bad = await operations(SUBJECT_A, ['cauce.read']);
    expect(await failureOf(bad.ops.inbox({ limit: 0 }))).toEqual({ status_code: 400, error: 'invalid_request' });
    expect(await failureOf(bad.ops.inbox({ cursor: 'abc', since: '2026-10-03T00:00:00Z' })))
      .toEqual({ status_code: 400, error: 'invalid_request' });
    expect(callsOf(bad.repository, 'listHumanInbox')).toEqual([]);
    const cases: readonly [Error, Record<string, unknown>][] = [
      [new StoreError('invalid_input', 'private'), { status_code: 400, error: 'invalid_request' }],
      [new StoreError('forbidden', 'private'), { status_code: 403, error: 'forbidden' }],
      [new StoreError('conflict', 'private'), { status_code: 409, error: 'operation_conflict' }],
      [new Error('private backend detail'), { status_code: 503, error: 'operation_unavailable' }],
    ];
    for (const [error, expected] of cases) {
      const state = setup();
      vi.spyOn(state.repository, 'listHumanInbox').mockRejectedValue(error);
      const ops = await state.factory.forRequest(identity(SUBJECT_A, ['cauce.read']), new AbortController().signal);
      const failure = await failureOf(ops.inbox({ since: new Date().toISOString() }));
      expect(failure).toEqual(expected);
      expect(JSON.stringify(failure)).not.toContain('private');
    }
  });
});

