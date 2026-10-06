import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PUBLISH_BODY_BYTES } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import type { Principal } from './auth.js';
import { buildTestGateway, fakeRepository, FixedAuthProvider, ids, testPrincipal } from './test-support/gateway-doubles.js';

const apps: FastifyInstance[] = [];
const paths = [`/v3/deliveries/${ids.delivery}/ack`, '/v3/ack'];
function ack() {
  return { version: '3.0', event_id: ids.event, status: 'done', instance_id: 'media-fixture', epoch: 1,
    claim_token: ids.claim, attempt: 1, retryable: false,
    result: { output: { artifacts: [{ name: 'voice.wav', uri: `data:audio/wav;base64,${Buffer.alloc(800_000).toString('base64')}` }] } } };
}
function payload(path: string, value: ReturnType<typeof ack>) {
  return path === '/v3/ack' ? { delivery_id: ids.delivery, ...value } : value;
}
async function fixture(permissions: Principal['permissions'] = ['route', 'read']) {
  const repository = fakeRepository();
  const app = await buildTestGateway({ repository, authProvider: new FixedAuthProvider(testPrincipal({ permissions })) });
  apps.push(app); return { app, repository, spies: { claim: vi.spyOn(repository, 'claimDeliveries'),
    heartbeat: vi.spyOn(repository, 'heartbeat'), lease: vi.spyOn(repository, 'acquireLease') } };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
describe('bounded HTTP media ACK ingress', () => {
  it.each(paths)('accepts a legal inline artifact above one MiB on %s with the exact claim', async (path) => {
    const { app, repository } = await fixture(); const value = payload(path, ack());
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1024 * 1024);
    const response = await app.inject({ method: 'POST', url: path, payload: value });
    expect(response.statusCode).toBe(200);
    expect(repository.ackDelivery).toHaveBeenCalledExactlyOnceWith(ids.delivery, 'Pablo', 'midas',
      expect.objectContaining({ event_id: ids.event, claim_token: ids.claim, attempt: 1, epoch: 1 }),
      expect.any(Number), expect.objectContaining({}));
    expect(createHash('sha256').update(JSON.stringify(vi.mocked(repository.ackDelivery).mock.calls[0]?.[3].result)).digest('hex'))
      .toBe(createHash('sha256').update(JSON.stringify(value.result)).digest('hex'));
  });
  it.each(paths)('rejects the shared budget plus one byte before repository access on %s', async (path) => {
    const { app, repository } = await fixture();
    const empty = JSON.stringify({ ...payload(path, ack()), result: { padding: '' } });
    const body = empty.replace('"padding":""', `"padding":"${'a'.repeat(MAX_PUBLISH_BODY_BYTES + 1 - Buffer.byteLength(empty))}"`);
    expect(Buffer.byteLength(body)).toBe(MAX_PUBLISH_BODY_BYTES + 1);
    const response = await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json' }, payload: body });
    expect(response.statusCode).toBe(413); expect(repository.ackDelivery).not.toHaveBeenCalled();
  });
  it.each(['/v3/query', '/v3/deliveries/query', '/v3/heartbeat', '/v3/connections/hello'])('retains the default one MiB limit on %s', async (path) => {
    const { app, repository, spies } = await fixture();
    expect((await app.inject({ method: 'POST', url: path, payload: { padding: 'a'.repeat(1024 * 1024) } })).statusCode).toBe(413);
    expect(repository.ackDelivery).not.toHaveBeenCalled(); expect(spies.claim).not.toHaveBeenCalled();
    expect(spies.heartbeat).not.toHaveBeenCalled(); expect(spies.lease).not.toHaveBeenCalled();
  });
  it.each(paths)('keeps route authorization for a large ACK on %s', async (path) => {
    const { app, repository } = await fixture(['read']);
    expect((await app.inject({ method: 'POST', url: path, payload: payload(path, ack()) })).statusCode).toBe(403);
    expect(repository.ackDelivery).not.toHaveBeenCalled();
  });
  it.each(paths)('keeps parser and durable fence rejection on %s', async (path) => {
    const { app, repository } = await fixture(); const value = ack();
    expect((await app.inject({ method: 'POST', url: path, payload: payload(path, { ...value, attempt: 0 }) })).statusCode).toBe(400);
    expect(repository.ackDelivery).not.toHaveBeenCalled();
    vi.mocked(repository.ackDelivery).mockRejectedValue(new StoreError('fenced', 'stale claim'));
    expect((await app.inject({ method: 'POST', url: path, payload: payload(path, value) })).statusCode).toBe(403);
    expect(repository.ackDelivery).toHaveBeenCalledOnce();
  });
});
