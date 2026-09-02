import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakeRepository, grants, noDeliveryWakes, testPrincipal,
} from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function historyPool(entries: readonly Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: string, params: readonly unknown[] = []) => {
    void params;
    return { rows: [...entries], rowCount: entries.length };
  });
  return { pool: { query } as unknown as DatabasePool, query };
}

async function gateway(
  repository: GatewayRepository,
  pool: DatabasePool,
  principal = testPrincipal({ tenant_id: 'Steven', alias: 'kant', roles: [], permissions: grants('read') }),
) {
  const app = await buildGateway({
    pool,
    repository,
    authProvider: new FixedAuthProvider(principal),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return app;
}

describe('agent read routes', () => {
  it('mounts bounded DB-only role history for a visible reader target', async () => {
    const repository = fakeRepository();
    repository.authorizeAgentTarget = vi.fn(async (
      _actorTenant: string, _actorAlias: string, targetTenant: string, targetAlias: string,
      permission: 'read' | 'control',
    ) => permission === 'read'
      ? {
          tenant_id: targetTenant, alias: targetAlias, enabled: true,
          harness_id: null, home_directory: null,
        }
      : undefined);
    const entries = [{
      id: '9', tenant_id: 'Steven', alias: 'zeus', operation: 'update',
      previous_brief: 'antes', new_brief: 'después', changed_at: new Date().toISOString(),
    }];
    const database = historyPool(entries);
    const app = await gateway(repository, database.pool);

    const response = await app.inject({
      method: 'GET', url: '/v3/console/role-assignments/Steven/zeus/history',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: 'Steven', alias: 'zeus', entries });
    expect(repository.authorizeAgentTarget).toHaveBeenCalledWith(
      'Steven', 'kant', 'Steven', 'zeus', 'read',
    );
    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, params] = database.query.mock.calls[0] ?? [];
    expect(String(sql).replace(/\s+/gu, ' ')).toContain(
      'ORDER BY agent_role_brief_history.id DESC LIMIT 100',
    );
    expect(params).toEqual(['Steven', 'zeus']);
  });

  it('returns the same 404 for absent and invisible history without querying the journal', async () => {
    const repository = fakeRepository();
    repository.authorizeAgentTarget = vi.fn(async () => undefined);
    const database = historyPool();
    const app = await gateway(repository, database.pool);

    const absent = await app.inject({
      method: 'GET', url: '/v3/console/role-assignments/Steven/ghost/history',
    });
    const invisible = await app.inject({
      method: 'GET', url: '/v3/console/role-assignments/Pablo/midas/history',
    });

    expect(absent.statusCode).toBe(404);
    expect(invisible.statusCode).toBe(404);
    expect(absent.body).toBe(invisible.body);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('returns entries empty when the visible alias exists but has no journal rows', async () => {
    const repository = fakeRepository();
    repository.authorizeAgentTarget = vi.fn(async (
      _actorTenant: string, _actorAlias: string, targetTenant: string, targetAlias: string,
    ) => ({
      tenant_id: targetTenant, alias: targetAlias, enabled: true,
      harness_id: null, home_directory: null,
    }));
    const database = historyPool();
    const app = await gateway(repository, database.pool);

    const response = await app.inject({
      method: 'GET', url: '/v3/console/role-assignments/Steven/zeus/history',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: 'Steven', alias: 'zeus', entries: [] });
  });

  it('keeps legacy detail in the actor tenant and makes canonical detail tenant-qualified', async () => {
    const repository = fakeRepository();
    repository.getAgent = vi.fn(async () => ({ tenant_id: 'Isa', alias: 'dupe', marker: 'own' }));
    repository.getAgentByIdentity = vi.fn(async (
      tenantId: string, alias: string, actorTenant: string,
    ) => {
      if (alias !== 'dupe') return undefined;
      if (tenantId === actorTenant || actorTenant === 'Steven') {
        return { tenant_id: tenantId, alias, marker: `${tenantId}-exact` };
      }
      return undefined;
    });
    const database = historyPool();
    const isa = await gateway(repository, database.pool, testPrincipal({
      tenant_id: 'Isa', alias: 'salva', roles: [], permissions: grants('read'),
    }));

    const legacyOwn = await isa.inject({ method: 'GET', url: '/v3/console/agents/dupe' });
    const canonicalOwn = await isa.inject({
      method: 'GET', url: '/v3/console/tenants/Isa/agents/dupe',
    });
    const canonicalHidden = await isa.inject({
      method: 'GET', url: '/v3/console/tenants/Pablo/agents/dupe',
    });
    expect(legacyOwn.statusCode).toBe(200);
    expect(legacyOwn.json()).toMatchObject({ tenant_id: 'Isa', marker: 'own' });
    expect(canonicalOwn.statusCode).toBe(200);
    expect(canonicalOwn.json()).toMatchObject({ tenant_id: 'Isa', marker: 'Isa-exact' });
    expect(canonicalHidden.statusCode).toBe(404);

    // A buggy/legacy double returning a visible foreign duplicate cannot leak it through the
    // tenant-less compatibility route: the handler validates the returned identity as well.
    vi.mocked(repository.getAgent).mockResolvedValueOnce({
      tenant_id: 'Pablo', alias: 'dupe', marker: 'foreign-wrong-winner',
    });
    const legacyForeign = await isa.inject({ method: 'GET', url: '/v3/console/agents/dupe' });
    expect(legacyForeign.statusCode).toBe(404);

    const hubRepository = fakeRepository();
    hubRepository.getAgentByIdentity = repository.getAgentByIdentity;
    const hub = await gateway(hubRepository, historyPool().pool);
    const canonicalVisible = await hub.inject({
      method: 'GET', url: '/v3/console/tenants/Pablo/agents/dupe',
    });
    expect(canonicalVisible.statusCode).toBe(200);
    expect(canonicalVisible.json()).toMatchObject({ tenant_id: 'Pablo', marker: 'Pablo-exact' });
  });
});
