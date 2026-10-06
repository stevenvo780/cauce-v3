import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Delivery } from '../src/sdk/types.js';
import { humanDelivery, isolatedEngine } from './human-initiator-session-isolation.fixtures.js';

function clientDelivery(): Delivery {
  const root = humanDelivery();
  assert.ok(root.human_initiator);
  const { human_id, root_message_id, tenant_id } = root.human_initiator;
  return { ...root, human_client_provenance: { root_message_id,
    client: { kind: 'oauth_client', verification: 'local_grant', issuer: 'https://cauce.example',
      client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' } },
    human_client_delegation: { root_message_id, owner_human_id: human_id, owner_tenant_id: tenant_id,
      label: 'Cronos', basis: 'owner_declared_grant', instance: 'unknown' } };
}

test('the engine delivers Cronos metadata outside routing context and preserves the human native session', async (t) => {
  const context = await isolatedEngine(t);
  await context.run(humanDelivery());
  const root = clientDelivery();
  await context.run(root);
  await context.run({ ...root, delivery_id: randomUUID(), message_id: randomUUID(),
    tenant_id: 'Jhon', actor_alias: 'hegel', body: { ...root.body, type: 'agent.message' } });
  const requests = context.headless.requests;
  assert.equal(requests.length, 3);
  assert.equal(context.manual.requests.length, 0);
  assert.equal(new Set(requests.map(request => request.args.at(-1))).size, 1);
  for (const request of requests.slice(1)) {
    assert.match(request.stdin, /"label":"Cronos"/u);
    assert.match(request.stdin, /conversation instance are unverified/u);
    const routing = request.stdin.split('--- BEGIN TRUSTED DELIVERY CONTEXT ---')[1]
      ?.split('--- END TRUSTED DELIVERY CONTEXT ---')[0];
    assert.ok(routing);
    assert.equal(routing.includes('Cronos'), false);
    assert.equal(routing.includes('client_provenance'), false);
  }
});

test('foreign client metadata closes before harness selection or starting execution', async (t) => {
  const context = await isolatedEngine(t);
  const original = clientDelivery();
  assert.ok(original.human_initiator); assert.ok(original.human_client_delegation);
  await context.run({ ...original, tenant_id: 'Jhon',
    human_initiator: { ...original.human_initiator, tenant_id: 'Jhon' },
    human_client_delegation: { ...original.human_client_delegation, owner_tenant_id: 'Jhon' } });
  assert.equal(context.selections(), 0);
  assert.equal(context.headless.requests.length + context.manual.requests.length, 0);
  assert.equal(context.events.some(event => event.phase === 'started'), false);
  assert.ok(context.events.some(event => event.phase === 'failed' && event.error?.code === 'INVALID_DELIVERY'));
});
