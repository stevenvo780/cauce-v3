import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, type FleetOperation, type FleetOperationPreview, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationError } from '@cauce/store';
import { FixedAuthProvider, buildTestGateway, testPrincipal } from '../test-support/gateway-doubles.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { hashPassword } from '../password.js';
import { PasswordAuthProvider } from '../password-auth.js';

const apps: FastifyInstance[] = [];
const OPERATION_ID = '71000000-0000-4000-8000-000000000001';
const PATH = '/v3/console/fleet/operations';
const HEADERS = { origin: 'http://localhost', 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' };
const target = { resource: 'agent', tenant_id: 'Steven', alias: 'jarvis' } as const;
const input: FleetOperationRequest = {
  kind: 'stop', target, expected_revision: 7, idempotency_key: 'fleet-stop-jarvis', parameters: {},
};
const operation: FleetOperation = {
  request_sha256: sha256Hex(input),
  id: OPERATION_ID, status: 'queued', version: 0, target, kind: 'stop',
  actor: { tenant_id: 'Steven', alias: 'kant' }, expected_revision: 7,
  desired_revision: null, applied_revision: null, steps: [{ name: 'prepare', status: 'pending' }], error: null,
  created_at: '2026-10-07T20:00:00.000Z', updated_at: '2026-10-07T20:00:00.000Z',
};
const preview: FleetOperationPreview = { request_sha256: sha256Hex(input), expected_revision: 7, target, kind: 'stop', steps: ['prepare', 'stop'], dependencies: [], can_apply: true };

function repositoryDouble() {
  return {
    preview: vi.fn(async (): Promise<unknown> => preview),
    enqueue: vi.fn(async (): Promise<unknown> => operation),
    list: vi.fn(async (): Promise<unknown> => [operation]),
    get: vi.fn(async (): Promise<unknown> => operation),
    cancel: vi.fn(async (): Promise<unknown> => ({ ...operation, version: 1, status: 'cancelled' })),
    resume: vi.fn(async (): Promise<unknown> => ({ ...operation, version: 1 })),
  };
}

async function fixture(authProvider?: FixedAuthProvider | PasswordAuthProvider) {
  const repository = repositoryDouble();
  const app = await buildTestGateway({ fleetOperationsRepository: repository,
    ...(authProvider === undefined ? {} : { authProvider }) });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('durable fleet operation routes', () => {
  it('returns a validated preview for the authenticated actor without enqueueing', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: `${PATH}/preview`, headers: HEADERS, payload: input });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(preview);
    expect(repository.preview).toHaveBeenCalledWith('Steven', 'kant', input, undefined);
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it('forwards retries with the original idempotency key and returns the durable operation receipt', async () => {
    const { app, repository } = await fixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ operation_id: OPERATION_ID, status: 'queued', operation });
    }
    expect(repository.enqueue.mock.calls).toEqual([['Steven', 'kant', input, undefined], ['Steven', 'kant', input, undefined]]);
  });

  it.each(['preview', 'enqueue'] as const)('rejects a %s receipt with a hash for different request parameters', async (action) => {
    const { app, repository } = await fixture();
    const request: FleetOperationRequest = {
      ...input, kind: 'create', parameters: {
        runtime_key: 'jarvis', harness_id: 'codex', primary_room_id: 'group-a',
        memberships: [{ room_id: 'group-a', role: 'agent' }],
        placement: { host_id: 'kratos', mode: 'native', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/state' },
        model_id: 'model-a',
      },
    };
    const incorrectHash = sha256Hex({ ...request, parameters: { ...request.parameters, model_id: 'model-b' } });
    repository[action].mockResolvedValue(action === 'preview'
      ? { ...preview, kind: 'create', request_sha256: incorrectHash }
      : { ...operation, kind: 'create', request_sha256: incorrectHash });
    const response = await app.inject({ method: 'POST', url: action === 'preview' ? `${PATH}/preview` : PATH,
      headers: HEADERS, payload: request });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });

  it('verifies the canonical request hash regardless of JSON property order', async () => {
    const { app } = await fixture();
    const payload = { parameters: {}, idempotency_key: input.idempotency_key, expected_revision: 7,
      target: { alias: 'jarvis', tenant_id: 'Steven', resource: 'agent' }, kind: 'stop' };
    const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ operation: { request_sha256: sha256Hex(input) } });
  });

  it('reads an operation only through the actor-scoped repository', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'GET', url: `${PATH}/${OPERATION_ID}`, headers: HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(operation);
    expect(repository.get).toHaveBeenCalledWith('Steven', 'kant', OPERATION_ID, undefined);
  });

  it.each(['cancel', 'resume'] as const)('forwards the CAS version for %s', async (action) => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: `${PATH}/${OPERATION_ID}/${action}`, headers: HEADERS,
      payload: { expected_version: 0 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: OPERATION_ID, version: 1 });
    expect(repository[action]).toHaveBeenCalledWith('Steven', 'kant', OPERATION_ID, 0, undefined);
  });

  it.each([
    { method: 'POST' as const, url: PATH, payload: input },
    { method: 'POST' as const, url: `${PATH}/preview`, payload: input },
    { method: 'GET' as const, url: `${PATH}/${OPERATION_ID}` },
    { method: 'POST' as const, url: `${PATH}/${OPERATION_ID}/cancel`, payload: { expected_version: 0 } },
  ])('rejects missing authentication before accessing the operation repository', async (request) => {
    const { app, repository } = await fixture();
    const response = await app.inject({ ...request, headers: { origin: HEADERS.origin } });
    expect(response.statusCode).toBe(401);
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    testPrincipal({ roles: ['operator'], permissions: ['read'] }),
    testPrincipal({ roles: ['agent'], permissions: ['read', 'control'] }),
  ])('requires operator role and control permission before reads or mutations', async (actor) => {
    const { app, repository } = await fixture(new FixedAuthProvider(actor));
    for (const request of [
      { method: 'GET' as const, url: `${PATH}/${OPERATION_ID}` },
      { method: 'POST' as const, url: PATH, payload: input },
    ]) {
      const response = await app.inject({ ...request, headers: HEADERS });
      expect(response.statusCode).toBe(403);
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    {}, { origin: 'https://untrusted.example' },
    { origin: HEADERS.origin, 'sec-fetch-site': 'cross-site' },
  ])('rejects unsafe browser origins before enqueue', async (headers) => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: PATH, payload: input,
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant', ...headers } });
    expect(response.statusCode).toBe(403);
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, expected_revision: -1 }, { ...input, idempotency_key: 'tiny' },
    { ...input, actor: { tenant_id: 'Pablo', alias: 'midas' } },
    { ...input, parameters: { command: 'rm -rf /', auth_json: 'SECRET_SENTINEL' } },
    { ...input, target: { ...target, runtime_user: 'root' } },
  ])('rejects malformed and unapproved request parameters before enqueue', async (payload) => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('SECRET_SENTINEL');
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { expected_version: -1 }, { expected_version: 0.1 }, {}, { expected_version: 0, force: true },
  ])('rejects controls without a valid exact version', async (payload) => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: `${PATH}/${OPERATION_ID}/resume`, headers: HEADERS, payload });
    expect(response.statusCode).toBe(400);
    expect(repository.resume).not.toHaveBeenCalled();
  });

  it('rejects malformed operation identifiers without a lookup', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'GET', url: `${PATH}/not-an-id`, headers: HEADERS });
    expect(response.statusCode).toBe(400);
    expect(repository.get).not.toHaveBeenCalled();
  });

  it.each([
    { ...operation, target: { ...target, alias: 'other' } },
    { ...operation, kind: 'start' as const },
    { ...operation, expected_revision: 8 },
    { ...operation, actor: { tenant_id: 'Pablo', alias: 'midas' } },
  ])('does not credit a durable receipt for a different request or actor', async (receipt) => {
    const { app, repository } = await fixture();
    repository.enqueue.mockResolvedValue(receipt);
    const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });

  it('does not expose extra receipt fields or raw backend errors', async () => {
    const { app, repository } = await fixture();
    repository.enqueue.mockResolvedValue({ ...operation, secret: 'SECRET_SENTINEL' });
    const malformed = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
    expect(malformed.statusCode).toBe(409);
    expect(malformed.body).not.toContain('SECRET_SENTINEL');
    repository.enqueue.mockRejectedValue(new Error('postgres password=SECRET_SENTINEL'));
    const failed = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('SECRET_SENTINEL');
  });

  it.each([
    { ...preview, expected_revision: 8 },
    { ...preview, target: { ...target, alias: 'other' } },
    { ...preview, dependencies: [{ type: 'credentials', identity: { credential_ref: 'SECRET_SENTINEL' }, blocking: true }] },
  ])('does not credit or expose a mismatched or unsafe preview', async (receipt) => {
    const { app, repository } = await fixture();
    repository.preview.mockResolvedValue(receipt);
    const response = await app.inject({ method: 'POST', url: `${PATH}/preview`, headers: HEADERS, payload: input });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('SECRET_SENTINEL');
  });

  it('rejects reads for another operation and control receipts below the requested version', async () => {
    const { app, repository } = await fixture();
    repository.get.mockResolvedValue({ ...operation, id: '71000000-0000-4000-8000-000000000002' });
    const read = await app.inject({ method: 'GET', url: `${PATH}/${OPERATION_ID}`, headers: HEADERS });
    expect(read.statusCode).toBe(409);
    const control = await app.inject({ method: 'POST', url: `${PATH}/${OPERATION_ID}/cancel`, headers: HEADERS,
      payload: { expected_version: 2 } });
    expect(control.statusCode).toBe(409);
  });

  it.each(['get', 'cancel'] as const)('requires a valid request hash on %s receipts', async (action) => {
    const { app, repository } = await fixture();
    const receipt = { ...operation } as Partial<FleetOperation>;
    delete receipt.request_sha256;
    repository[action].mockResolvedValue(receipt);
    const response = await app.inject(action === 'get'
      ? { method: 'GET', url: `${PATH}/${OPERATION_ID}`, headers: HEADERS }
      : { method: 'POST', url: `${PATH}/${OPERATION_ID}/cancel`, headers: HEADERS, payload: { expected_version: 0 } });
    expect(response.statusCode).toBe(409);
  });

  it.each([
    ['forbidden', 403], ['conflict', 409], ['not_found', 404], ['invalid_input', 422],
  ] as const)('maps durable %s failures without reporting an acceptance', async (code, status) => {
    const { app, repository } = await fixture();
    repository.enqueue.mockRejectedValue(new FleetOperationError(code, 'operation rejected'));
    const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code, message: 'operation rejected' });
  });

  it('does not register acceptance routes when the fleet repository is absent', async () => {
    const app = await buildTestGateway();
    apps.push(app);
    const response = await app.inject({ method: 'POST', url: PATH, headers: HEADERS, payload: input });
    expect(response.statusCode).toBe(404);
  });

  it('requires the signed human cookie, CSRF and current account authority', async () => {
    const password = 'long-local-test-password';
    const user = {
      id: '11000000-0000-4000-8000-000000000001', email: 'operator@cauce.example', display_name: 'Operator',
      role: 'operator' as const, tenant_id: 'Steven', alias: 'kant', active: true,
      password_hash: await hashPassword(password, { cost: 1_024, blockSize: 8, parallelism: 1 }), password_changed_at: 0,
    };
    const users = new MemoryConsoleUserStore([user]);
    const provider = new PasswordAuthProvider({ users, signingKey: Buffer.alloc(32, 7) });
    const { app, repository } = await fixture(provider);
    const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: HEADERS.origin },
      payload: { email: user.email, password } });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : [raw];
    const cookie = cookies.find((value): value is string => typeof value === 'string' && value.startsWith('__Host-cauce_session='))?.split(';')[0];
    expect(cookie).toBeDefined();
    const session = login.json<{ csrf_token: string }>();
    const headers = { ...HEADERS, cookie: cookie ?? '' };
    const noCsrf = await app.inject({ method: 'POST', url: PATH, headers, payload: input });
    expect(noCsrf.statusCode).toBe(403);
    repository.enqueue.mockResolvedValue({ ...operation, actor: { ...operation.actor, actor_subject: `console:${user.id}` } });
    const accepted = await app.inject({ method: 'POST', url: PATH,
      headers: { ...headers, 'x-csrf-token': session.csrf_token }, payload: input });
    expect(accepted.statusCode).toBe(202);
    expect(repository.enqueue).toHaveBeenCalledOnce();
    expect(repository.enqueue).toHaveBeenCalledWith('Steven', 'kant', input, `console:${user.id}`);
    repository.enqueue.mockResolvedValue(operation);
    const missingOrigin = await app.inject({ method: 'POST', url: PATH,
      headers: { ...headers, 'x-csrf-token': session.csrf_token }, payload: input });
    expect(missingOrigin.statusCode).toBe(409);
    const calls = repository.enqueue.mock.calls.length;
    users.put({ ...user, active: false });
    const revoked = await app.inject({ method: 'POST', url: PATH,
      headers: { ...headers, 'x-csrf-token': session.csrf_token }, payload: input });
    expect(revoked.statusCode).toBe(401);
    expect(repository.enqueue.mock.calls).toHaveLength(calls);
  });
});


describe('fleet inventory endpoints', () => {
  it('reports disabled capability without claiming an executor is configured', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/v3/console/fleet/capability', headers: HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, actions: [], placements: [], reason: 'executor_unconfigured' });
  });
  it('lists only durable receipts for an exact target and rejects a swapped identity', async () => {
    const { app, repository } = await fixture();
    const url = `${PATH}?resource=agent&tenant_id=Steven&alias=jarvis`;
    const response = await app.inject({ method: 'GET', url, headers: HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operations: [operation] });
    repository.list.mockResolvedValue([{ ...operation, target: { ...target, alias: 'other' } }]);
    expect((await app.inject({ method: 'GET', url, headers: HEADERS })).statusCode).toBe(409);
  });
});
