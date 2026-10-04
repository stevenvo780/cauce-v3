import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildPublishReceipt } from '@cauce/protocol';
import {
  StoreError, type DatabaseClient, type HumanIdentityKey, type HumanIdentitySnapshot,
} from '@cauce/store';
import {
  GatewayOperationError, type McpSubmitCommand,
} from '@cauce/mcp-fleet-monitor/gateway-http';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import type { GatewayRepository } from './app.js';
import type { ConsoleUser } from './console-users.js';
import type { ExternalSubjectResolver, HumanIdentityStore } from './human-mcp-authority.js';
import { createHumanMcpOperationsFactory } from './mcp-operations.js';
import { fakeRepository } from './test-support/gateway-doubles.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT_A = 'owned-boundary-subject-a';
const SUBJECT_B = 'owned-boundary-subject-b';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERY_ID = '55555555-5555-4555-8555-555555555555';

function user(id: string, role: ConsoleUser['role'] = 'operator'): ConsoleUser {
  return { id, email: `${id}@example.test`, display_name: 'Human fixture', role, tenant_id: 'Steven',
    alias: 'kant', active: true, password_hash: 'unused-test-hash', password_changed_at: 0 };
}

function identity(
  subject = SUBJECT_A,
  scopes: readonly string[] = ['cauce.read', 'cauce.publish'],
  expiresAt = Date.now() / 1000 + 30,
): VerifiedOAuthIdentity {
  return { kind: 'oauth', issuer: 'https://issuer.example.test', subject,
    audience: 'https://mcp.example.test/mcp', expiresAt, scopes };
}

function submitCommand(): McpSubmitCommand {
  return { request_key: randomUUID(), room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'boundary test' } };
}

function makeSnapshot(
  key: HumanIdentityKey,
  account: ConsoleUser,
): HumanIdentitySnapshot {
  return {
    humanId: account.id, bindingId: `binding-${account.id}`, provider: key.provider,
    namespace: key.namespace, subject: key.subject, bindingRevision: '1',
    account: { active: account.active, role: account.role, defaultTenant: account.tenant_id,
      displayName: account.display_name },
    membership: { tenantId: account.tenant_id, actorAlias: account.alias, role: account.role,
      permissions: account.role === 'reader' ? ['read'] : ['read', 'route'], enabled: true, revision: '1' },
  };
}

function setup(repository: GatewayRepository = fakeRepository()) {
  const users = new Map([[USER_A, user(USER_A)], [USER_B, user(USER_B)]]);
  const bindings = new Map([[SUBJECT_A, USER_A], [SUBJECT_B, USER_B]]);
  const seenSubjects: string[] = [];
  const identityStore: HumanIdentityStore = {
    async resolve(key, signal) {
      signal.throwIfAborted();
      seenSubjects.push(key.subject);
      const id = bindings.get(key.subject);
      const account = id === undefined ? undefined : users.get(id);
      return account?.active ? makeSnapshot(key, account) : undefined;
    },
    async lock(_client, key, expectedHumanId) {
      const snapshot = await identityStore.resolve(key, new AbortController().signal);
      if (snapshot?.humanId !== expectedHumanId) throw new StoreError('forbidden', 'fixture identity is unavailable');
      return snapshot;
    },
  };
  const resolver: ExternalSubjectResolver = {
    async resolve(current, signal) {
      signal.throwIfAborted();
      const id = bindings.get(current.subject);
      return id === undefined ? undefined : { userId: id, status: 'active' as const };
    },
  };
  const factory = createHumanMcpOperationsFactory({
    repository, users: { findById: async (id) => users.get(id) }, resolver, identityStore,
    priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined,
  });
  return { repository, users, bindings, identityStore, seenSubjects, resolver, factory };
}

function client(): DatabaseClient {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as DatabaseClient;
}

async function failureOf(operation: Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayOperationError);
  return (caught as GatewayOperationError).failure;
}

describe('human MCP authority boundaries', () => {
  it('uses one bounded durable read signal for status and agents and keeps the projection scoped', async () => {
    const state = setup();
    state.users.set(USER_A, user(USER_A, 'reader'));
    const privateMarker = 'private-inventory-field';
    const presence = vi.spyOn(state.repository, 'listPresence').mockImplementation(async (_tenant, _alias, access) => {
      if (!access) throw new Error('status lost its durable read authority');
      expect(await access.humanAuthority(client())).toMatchObject({ humanId: USER_A, actorAlias: 'kant' });
      return [
        { tenant_id: 'Steven', alias: 'argos', online: true, last_heartbeat_at: null, privateMarker },
        { tenant_id: 'Isa', alias: 'argos', online: true, last_heartbeat_at: null, privateMarker },
      ];
    });
    const agents = vi.spyOn(state.repository, 'listAgents').mockImplementation(async (_tenant, _alias, access) => {
      if (!access) throw new Error('agents lost its durable read authority');
      expect(await access.humanAuthority(client())).toMatchObject({ humanId: USER_A, actorAlias: 'kant' });
      return { items: [
        { tenant_id: 'Steven', alias: 'argos', enabled: true, online: true,
          deployment_status: 'online', last_heartbeat_at: null, privateMarker },
        { tenant_id: 'Isa', alias: 'argos', enabled: true, online: true,
          deployment_status: 'online', last_heartbeat_at: null, privateMarker },
      ] };
    });
    const request = new AbortController();
    const ops = await state.factory.forRequest(identity(SUBJECT_A, ['cauce.read']), request.signal);
    const status = await ops.status();
    const inventory = await ops.agents();
    expect(status).toMatchObject({ presence: { items: [
      { tenant_id: 'Steven', alias: 'argos', online: true, last_heartbeat_at: null },
    ] } });
    expect(inventory).toMatchObject({ items: [
      { tenant_id: 'Steven', alias: 'argos', enabled: true, online: true,
        deployment_status: 'online', last_heartbeat_at: null },
    ] });
    expect(JSON.stringify([status, inventory])).not.toContain(privateMarker);
    const statusAccess = presence.mock.calls[0]?.[2];
    const agentsAccess = agents.mock.calls[0]?.[2];
    expect(statusAccess?.signal).toBe(agentsAccess?.signal);
    expect(statusAccess?.signal).not.toBe(request.signal);
    request.abort(new Error('private request cancellation'));
    expect(statusAccess?.signal.aborted).toBe(true);
    expect(await failureOf(ops.status())).toEqual({ status_code: 503, error: 'operation_unavailable' });
    expect(await failureOf(ops.agents())).toEqual({ status_code: 503, error: 'operation_unavailable' });
    expect(presence).toHaveBeenCalledOnce();
    expect(agents).toHaveBeenCalledOnce();
  });

  it('fails closed for legacy resolver-backed submit and receipt while retaining legacy status reads', async () => {
    const repository = fakeRepository();
    const prepare = vi.spyOn(repository, 'prepareConsolePublishIntent');
    const publish = vi.spyOn(repository, 'publish');
    const getMessage = vi.spyOn(repository, 'getHumanMessage');
    const state = setup(repository);
    const legacyFactory = createHumanMcpOperationsFactory({
      repository,
      users: { findById: async (id) => state.users.get(id) },
      resolver: state.resolver,
      priorityLog: { info: () => undefined, warn: () => undefined },
      logRedaction: () => undefined,
    });
    const ops = await legacyFactory.forRequest(identity(), new AbortController().signal);

    await expect(ops.status()).resolves.toBeDefined();
    expect(await failureOf(ops.submit(submitCommand()))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(await failureOf(ops.receipt(MESSAGE_ID))).toEqual({ status_code: 401, error: 'unauthorized' });
    expect(prepare).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('threads one composed signal and trusted callback through prepare, publish, verify, and confirm', async () => {
    const state = setup();
    const prepare = vi.spyOn(state.repository, 'prepareConsolePublishIntent');
    const publish = vi.spyOn(state.repository, 'publish');
    const verify = vi.spyOn(state.repository, 'verifyPublishReceipt');
    const confirm = vi.spyOn(state.repository, 'confirmConsolePublishIntent');
    const requestSignal = new AbortController().signal;
    const ops = await state.factory.forRequest(identity(), requestSignal);
    await ops.submit(submitCommand());

    const prepareCall = prepare.mock.calls[0];
    const publishCall = publish.mock.calls[0];
    const verifyCall = verify.mock.calls[0];
    const confirmCall = confirm.mock.calls[0];
    if (!prepareCall || !publishCall || !verifyCall || !confirmCall) throw new Error('MCP publish phases were not all called');
    const prepareAccess = prepareCall[2];
    const publishAccess = publishCall[1];
    const verifyAccess = verifyCall[2];
    const confirmAccess = confirmCall[4];
    if (!prepareAccess || !publishAccess?.humanAuthority || !verifyAccess?.humanAuthority || !confirmAccess) {
      throw new Error('a durable phase lost its trusted human authority callback');
    }
    expect(publishAccess.signal).toBe(prepareAccess.signal);
    expect(verifyAccess.signal).toBe(prepareAccess.signal);
    expect(confirmAccess.signal).toBe(prepareAccess.signal);
    expect(prepareAccess.signal).not.toBe(requestSignal);
    expect(publishAccess.humanAuthority).toBe(prepareAccess.humanAuthority);
    expect(verifyAccess.humanAuthority).toBe(prepareAccess.humanAuthority);
    expect(confirmAccess.humanAuthority).toBe(prepareAccess.humanAuthority);
    const trusted = await prepareAccess.humanAuthority(client());
    expect(trusted).toMatchObject({ humanId: USER_A, tenantId: 'Steven', actorAlias: 'kant' });
  });

  it('aborts blocked prepare on absolute expiry and request cancellation without leaking private reasons', async () => {
    const expiredState = setup();
    const expiredPublish = vi.spyOn(expiredState.repository, 'publish');
    const expiredConfirm = vi.spyOn(expiredState.repository, 'confirmConsolePublishIntent');
    let expiredPrepareStarted: (() => void) | undefined;
    const expiredStarted = new Promise<void>((resolve) => { expiredPrepareStarted = resolve; });
    const expiredPrepare = vi.spyOn(expiredState.repository, 'prepareConsolePublishIntent')
      .mockImplementation(async (_command, _scope, access) => {
        const signal = access?.signal;
        if (!signal) throw new Error('prepare did not receive its bounded signal');
        expiredPrepareStarted?.();
        return new Promise((_resolve, reject) => {
          const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('operation expired')); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      });
    const shortLived = identity(SUBJECT_A, ['cauce.read', 'cauce.publish'], Date.now() / 1000 + 0.5);
    const expiredOps = await expiredState.factory.forRequest(shortLived, new AbortController().signal);
    const expiredSubmission = expiredOps.submit(submitCommand());
    await expiredStarted;
    const expired = await failureOf(expiredSubmission);
    expect(expired).toMatchObject({ status_code: 503, error: 'operation_unavailable', safe_to_retry_same_request_key: true });
    expect(JSON.stringify(expired)).not.toContain('TimeoutError');
    expect(expiredPrepare.mock.calls[0]?.[2]?.signal.aborted).toBe(true);
    expect(expiredPublish).not.toHaveBeenCalled();
    expect(expiredConfirm).not.toHaveBeenCalled();

    const cancelledState = setup();
    const cancelledPublish = vi.spyOn(cancelledState.repository, 'publish');
    const cancelledConfirm = vi.spyOn(cancelledState.repository, 'confirmConsolePublishIntent');
    let cancelledPrepareStarted: (() => void) | undefined;
    const cancelledStarted = new Promise<void>((resolve) => { cancelledPrepareStarted = resolve; });
    vi.spyOn(cancelledState.repository, 'prepareConsolePublishIntent').mockImplementation(async (_command, _scope, access) => {
      const signal = access?.signal;
      if (!signal) throw new Error('prepare did not receive its request signal');
      cancelledPrepareStarted?.();
      return new Promise((_resolve, reject) => {
        const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('request cancelled')); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    const request = new AbortController();
    const cancelledOps = await cancelledState.factory.forRequest(identity(), request.signal);
    const cancelledSubmission = cancelledOps.submit(submitCommand());
    await cancelledStarted;
    request.abort(new Error('private HTTP disconnect detail'));
    const cancelled = await failureOf(cancelledSubmission);
    expect(cancelled).toEqual({ status_code: 503, error: 'operation_unavailable', safe_to_retry_same_request_key: true });
    expect(JSON.stringify(cancelled)).not.toContain('private HTTP disconnect detail');
    expect(cancelledPublish).not.toHaveBeenCalled();
    expect(cancelledConfirm).not.toHaveBeenCalled();
  });

  it('recovers a committed publish with publish-only scope through fresh prepare and confirm authority', async () => {
    const state = setup();
    const prepare = vi.spyOn(state.repository, 'prepareConsolePublishIntent');
    const publish = vi.spyOn(state.repository, 'publish');
    const verify = vi.spyOn(state.repository, 'verifyPublishReceipt');
    const confirm = vi.spyOn(state.repository, 'confirmConsolePublishIntent');
    const receipt = buildPublishReceipt({
      version: '3.0', request_id: randomUUID(), trace_id: 'owned-recovery', tenant_id: 'Steven',
      room_id: 'grp.steven', actor_alias: 'kant', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'committed' }, idempotency_key: 'console:committed',
      authenticated_context: { session_id: 'recovery', channel: 'human-mcp' }, lane: 'interactive', priority: 0,
    }, { message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID], duplicate: false,
      request_id: randomUUID(), trace_id: 'owned-recovery' });
    prepare.mockResolvedValue({
      version: 1, state: 'committed', idempotency_key: receipt.idempotency_key, receipt,
    });
    const ops = await state.factory.forRequest(identity(SUBJECT_A, ['cauce.publish']), new AbortController().signal);
    await expect(ops.submit(submitCommand())).resolves.toEqual(receipt);

    expect(prepare).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    const prepareAccess = prepare.mock.calls[0]?.[2];
    const confirmAccess = confirm.mock.calls[0]?.[4];
    expect(prepareAccess?.humanAuthority).toEqual(expect.any(Function));
    expect(confirmAccess?.humanAuthority).toBe(prepareAccess?.humanAuthority);
    const trusted = await confirmAccess?.humanAuthority(client());
    expect(trusted).toMatchObject({ humanId: USER_A, tenantId: 'Steven', actorAlias: 'kant' });
  });

  it('allows a reader with cauce.read to fetch a minimal receipt using the captured identity snapshot', async () => {
    const state = setup();
    state.users.set(USER_A, user(USER_A, 'reader'));
    const privateMarker = 'private-message-detail-must-not-project';
    vi.spyOn(state.repository, 'getHumanMessage').mockImplementation(async (_messageId, access) => {
      const authority = await access.humanAuthority(client());
      expect(authority).toMatchObject({ humanId: USER_A, tenantId: 'Steven', actorAlias: 'kant' });
      return { id: MESSAGE_ID, body: { text: privateMarker }, result: { privateMarker }, human_id: USER_A,
        chain_open: true, deliveries: [{ delivery_id: DELIVERY_ID, tenant_id: 'Steven', alias: 'argos',
          status: 'done', attempt: 1, terminal_at: null, reply: 'canonical reply' }] };
    });
    const candidate = identity(SUBJECT_A, ['cauce.read']);
    const ops = await state.factory.forRequest(candidate, new AbortController().signal);
    Object.assign(candidate, { subject: SUBJECT_B, scopes: ['cauce.publish'], expiresAt: Date.now() / 1000 - 1 });

    expect(await failureOf(ops.submit(submitCommand()))).toEqual({ status_code: 403, error: 'forbidden' });
    const projected = await ops.receipt(MESSAGE_ID);
    expect(projected).toMatchObject({ message_id: MESSAGE_ID, chain_open: true,
      deliveries: [{ delivery_id: DELIVERY_ID, tenant_id: 'Steven', alias: 'argos', reply: 'canonical reply' }] });
    expect(JSON.stringify(projected)).not.toContain(privateMarker);
    expect(JSON.stringify(projected)).not.toContain(USER_A);
    expect(state.seenSubjects.length).toBeGreaterThan(0);
    expect(state.seenSubjects.every((subject) => subject === SUBJECT_A)).toBe(true);
  });
});
