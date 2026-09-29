import { describe, expect, it, vi } from 'vitest';
import { type Permission } from '@cauce/protocol';
import { fakeRepository, grants, ids, testPrincipal } from './helpers.js';
import { gateway, registerGatewaySecurityTeardown } from './gateway-security-helpers.js';

registerGatewaySecurityTeardown();

describe('proactive egress endpoint', () => {
  const notifyBody = {
    destination: 'steven.dm',
    kind: 'task_complete',
    body: 'la tarea larga terminó',
    idempotency_key: 'run-4711'
  };

  it('refuses a principal without the notify permission', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'control') }));
    const response = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(response.statusCode).toBe(403);
    expect(repository.enqueueNotification).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted destination and never lets the caller name a chat', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    const accepted = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ notification_id: ids.notification, decision: 'allowed' });
    expect(repository.enqueueNotification).toHaveBeenCalledWith('Pablo', 'midas', {
      ...notifyBody, dry_run: false
    });

    for (const forbiddenField of [
      { conversation_id: '-100123' }, { tenant_id: 'Steven' }, { alias: 'argos' },
      { origin: { adapter: 'telegram' } }, { room_id: 'grp.steven' }
    ]) {
      const rejected = await app.inject({
        method: 'POST', url: '/v3/egress/notifications',
        headers: { host: 'gateway.test', origin: 'http://gateway.test' },
        payload: { ...notifyBody, ...forbiddenField }
      });
      expect(rejected.statusCode).toBe(400);
    }
  });

  it('surfaces a policy denial as 403 with its durable denial code', async () => {
    const repository = fakeRepository();
    repository.enqueueNotification = vi.fn(async () => ({
      notification_id: ids.notification,
      decision: 'denied' as const,
      denial_code: 'cold_contact' as const,
      duplicate: false,
      dry_run: false
    }));
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    const response = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden', denial_code: 'cold_contact' });
  });

  it('advertises message.notify and lists notifications for the reader tenant only', async () => {
    const repository = fakeRepository();
    repository.principalAccess = vi.fn(async () => ({
      roles: ['agent'],
      permissions: ['route', 'read', 'notify'] as Permission[]
    }));
    repository.listNotifications = vi.fn(async () => ({
      items: [
        { id: ids.notification, tenant_id: 'Pablo', alias: 'midas', decision: 'denied' },
        { id: ids.outbox, tenant_id: 'Steven', alias: 'argos', decision: 'allowed' }
      ]
    }));
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    expect((await app.inject({ method: 'GET', url: '/v3/console/access' })).json())
      .toMatchObject({ permissions: ['message.publish', 'message.notify'] });

    const listed = await app.inject({ method: 'GET', url: '/v3/console/egress/notifications' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: ids.notification, tenant_id: 'Pablo', alias: 'midas', decision: 'denied' }]
    });
  });
});
