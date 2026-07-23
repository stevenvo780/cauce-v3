import { http, HttpResponse } from 'msw';
import { CauceApi } from './client';
import type { PublishMessageInput } from './types';
import { server } from '../mocks/server';

describe('CauceApi', () => {
  it('uses cookie credentials and strips client identity fields from publish', async () => {
    let observed: Record<string, unknown> = {};
    let credentials: RequestCredentials | undefined;
    let authorization: string | null = null;
    let csrf: string | null = null;
    server.use(http.post('http://localhost/v3/console/messages', async ({ request }) => {
      observed = await request.json() as Record<string, unknown>;
      credentials = request.credentials;
      authorization = request.headers.get('authorization');
      csrf = request.headers.get('x-csrf-token');
      return HttpResponse.json({ message_id: 'msg-1' }, { status: 202 });
    }));
    const api = new CauceApi('http://localhost');
    const hostileInput = {
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'hola' },
      lane: 'interactive', priority: 10, idempotency_key: 'test-key', actor_alias: 'forged', session_id: 'forged', channel: 'forged',
    } as PublishMessageInput & Record<string, unknown>;

    await api.publishMessage(hostileInput);

    expect(credentials).toBe('include');
    expect(authorization).toBeNull();
    expect(csrf).toBe('mock-csrf-token');
    expect(observed).toEqual({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'hola' },
      lane: 'interactive', priority: 10, idempotency_key: 'test-key',
    });
    expect(observed).not.toHaveProperty('actor_alias');
    expect(observed).not.toHaveProperty('session_id');
    expect(observed).not.toHaveProperty('channel');
  });

  it('keeps OIDC session and CSRF state in memory and logs out without bearer credentials', async () => {
    const requests: Array<{ path: string; csrf: string | null; authorization: string | null }> = [];
    server.use(
      http.get('http://localhost/v3/auth/session', () => HttpResponse.json({
        authenticated: true, subject: 'Steven:kant', csrf_token: 'one-time-browser-csrf',
      })),
      http.post('http://localhost/v3/auth/logout', ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          csrf: request.headers.get('x-csrf-token'),
          authorization: request.headers.get('authorization'),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const api = new CauceApi('http://localhost');

    expect(await api.getAuthSession()).toMatchObject({ authenticated: true, subject: 'Steven:kant' });
    await api.logout();

    expect(requests).toEqual([{
      path: '/v3/auth/logout', csrf: 'one-time-browser-csrf', authorization: null,
    }]);
  });

  it('treats a missing PTY backend as disabled', async () => {
    server.use(http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 404 })));
    const capability = await new CauceApi('http://localhost').getTerminalCapability();
    expect(capability).toEqual({ available: false, reason: 'Backend PTY no disponible' });
  });

  it('sends revision-guarded config dry-runs and rollback without client authority', async () => {
    const observed: Array<Record<string, unknown>> = [];
    server.use(
      http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
        observed.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ applied: false, dry_run: true, revision: 7 });
      }),
      http.post('http://localhost/v3/console/config/revisions/:revision/rollback', async ({ request }) => {
        observed.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ applied: true, revision: 8 }, { status: 201 });
      }),
    );
    const api = new CauceApi('http://localhost');
    await api.changeConfiguration({
      resource: 'acl_edge', action: 'create', from_tenant: 'Isa', to_tenant: 'Steven',
      value: { allow_route: false }
    }, { dryRun: true, expectedRevision: 7 });
    await api.rollbackConfiguration('7', { dryRun: false, expectedRevision: 7 });
    expect(observed).toEqual([
      {
        dry_run: true, expected_revision: 7,
        mutation: { resource: 'acl_edge', action: 'create', from_tenant: 'Isa', to_tenant: 'Steven', value: { allow_route: false } }
      },
      { dry_run: false, expected_revision: 7 }
    ]);
  });
});
