import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, grants, noDeliveryWakes, testPrincipal,
} from '../gateway-hardening/helpers.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    TRUNCATE config_revisions RESTART IDENTITY;
    DELETE FROM memberships WHERE tenant_id='Acme';
    DELETE FROM rooms WHERE tenant_id='Acme';
    DELETE FROM acl_edges WHERE from_tenant='Acme' OR to_tenant='Acme';
    DELETE FROM tenants WHERE id='Acme';
    UPDATE memberships SET role='agent' WHERE alias IN ('midas','salva');
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

/** Steven pays for it; shared_with_pool decides whether anybody else may be routed to it. */
function stevenAccount(sharedWithPool: boolean): ConfigMutation {
  return {
    resource: 'provider_account', action: 'create', id: 'anthropic-max',
    value: {
      provider: 'anthropic', external_account_id: 'acct-steven-001', payer_tenant_id: 'Steven',
      label: 'Claude Max (Steven)', credential_ref_kind: 'env_path',
      credential_ref: 'CAUCE_STEVEN_ANTHROPIC_PATH', shared_with_pool: sharedWithPool, enabled: true
    }
  };
}

const isaAccount: ConfigMutation = {
  resource: 'provider_account', action: 'create', id: 'codex-isa',
  value: {
    provider: 'openai', external_account_id: 'acct-isa-001', payer_tenant_id: 'Isa',
    credential_ref_kind: 'env_path', credential_ref: 'CAUCE_ISA_CODEX_PATH', enabled: true
  }
};

const salvaAgent: ConfigMutation = {
  resource: 'agent', action: 'create', tenant_id: 'Isa', alias: 'salva',
  value: { harness_id: 'codex', display_name: 'Salva', enabled: false }
};

/** Applies mutations as the hub operator, threading the optimistic revision through. */
async function applyAll(mutations: readonly ConfigMutation[], from = 0): Promise<number> {
  let revision = from;
  for (const mutation of mutations) {
    const changed = await repository.applyConfigurationChange('Steven', 'kant', mutation, false, revision);
    expect(changed.applied).toBe(true);
    revision = changed.revision;
  }
  return revision;
}

describe('agent registry CRUD, invariants, and rollback', () => {
  it('previews without side effects and CRUDs every new configuration family', async () => {
    const preview = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', enabled: true }
    }, true, 0);
    expect(preview).toMatchObject({ applied: false, dry_run: true, revision: 0 });

    const revision = await applyAll([
      { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', enabled: true } },
      {
        resource: 'agent', action: 'create', tenant_id: 'Acme', alias: 'acmebot',
        value: {
          harness_id: 'codex', display_name: 'Acme Bot', enabled: true, container_name: 'ws-acme',
          runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/state/acmebot'
        }
      },
      {
        resource: 'provider_account', action: 'create', id: 'codex-acme',
        value: {
          provider: 'openai', external_account_id: 'acct-acme-100', payer_tenant_id: 'Acme',
          credential_ref_kind: 'env_path', credential_ref: 'CAUCE_ACME_CODEX_PATH', enabled: true
        }
      },
      {
        resource: 'alias_routing_ceiling', action: 'create',
        tenant_id: 'Acme', alias: 'acmebot', account_id: 'codex-acme'
      },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Acme', agent_alias: 'acmebot', account_id: 'codex-acme',
        value: { priority: 10, enabled: true }
      }
    ]);

    const snapshot = await repository.getConfiguration('Steven', 'kant');
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 'Acme', alias: 'acmebot', enabled: true, container_name: 'ws-acme' })
    ]));
    expect(snapshot.provider_accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'codex-acme', provider: 'openai', payer_tenant_id: 'Acme', shared_with_pool: false
      })
    ]));
    for (const account of snapshot.provider_accounts as Array<Record<string, unknown>>) {
      expect(account).not.toHaveProperty('credential_ref');
    }
    expect(snapshot.alias_routing_ceiling).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tenant_id: 'Acme', alias: 'acmebot', account_id: 'codex-acme', account_payer_tenant: 'Acme'
      })
    ]));
    expect(snapshot.agent_account_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tenant_id: 'Acme', agent_alias: 'acmebot', account_id: 'codex-acme', priority: 10, enabled: true
      })
    ]));
  });

  it('rejects a binding for an account the alias has no ceiling entry for', async () => {
    await applyAll([salvaAgent, isaAccount]);
    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'agent_account_binding', action: 'create',
      tenant_id: 'Isa', agent_alias: 'salva', account_id: 'codex-isa', value: {}
    }, false, 2)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects provider_account identity and credential rotation through update', async () => {
    await applyAll([isaAccount]);
    for (const value of [
      { credential_ref: 'CAUCE_ISA_CODEX_ROTATED_PATH' },
      { payer_tenant_id: 'Pablo' },
      { external_account_id: 'acct-isa-002' }
    ]) {
      await expect(repository.applyConfigurationChange('Steven', 'kant', {
        resource: 'provider_account', action: 'update', id: 'codex-isa', value
      }, false, 1)).rejects.toMatchObject({ code: 'conflict' });
    }

    const relabelled = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'provider_account', action: 'update', id: 'codex-isa', value: { label: 'Isa Codex' }
    }, false, 1);
    expect(relabelled.applied).toBe(true);
  });

  it('refuses to register the same external subscription under two payers', async () => {
    await applyAll([isaAccount]);
    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'provider_account', action: 'create', id: 'codex-pablo',
      value: {
        provider: 'openai', external_account_id: 'acct-isa-001', payer_tenant_id: 'Pablo',
        credential_ref_kind: 'env_path', credential_ref: 'CAUCE_PABLO_CODEX_PATH'
      }
    }, false, 1)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('blocks provider_account delete while an alias may still be routed to it', async () => {
    await applyAll([
      salvaAgent, isaAccount,
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'codex-isa' }
    ]);

    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'provider_account', action: 'delete', id: 'codex-isa'
    }, false, 3)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(`SELECT 1 FROM provider_accounts WHERE id='codex-isa'`)).rowCount).toBe(1);
  });

  it('blocks agent delete while a delivery is active or a lease is live', async () => {
    await applyAll([salvaAgent]);
    const published = await repository.publish({
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }], body: { text: 'active' },
      idempotency_key: randomUUID(), lane: 'interactive', priority: 0
    });
    expect(published.delivery_ids).toHaveLength(1);

    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'agent', action: 'delete', tenant_id: 'Isa', alias: 'salva'
    }, false, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(`SELECT 1 FROM agents WHERE tenant_id='Isa' AND alias='salva'`)).rowCount).toBe(1);
  });

  it('keeps every registry resource hub-only, even inside the actor tenant', async () => {
    await applyAll([stevenAccount(false)]);
    await pool.query(`UPDATE memberships SET role='operator' WHERE tenant_id='Pablo' AND alias='midas'`);

    const denied: ConfigMutation[] = [
      { resource: 'agent', action: 'create', tenant_id: 'Pablo', alias: 'pablobot', value: { enabled: false } },
      {
        resource: 'provider_account', action: 'update', id: 'anthropic-max',
        value: { shared_with_pool: true }
      },
      {
        resource: 'alias_routing_ceiling', action: 'create',
        tenant_id: 'Pablo', alias: 'midas', account_id: 'anthropic-max'
      },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Pablo', agent_alias: 'midas', account_id: 'anthropic-max', value: {}
      }
    ];
    for (const mutation of denied) {
      await expect(repository.applyConfigurationChange('Pablo', 'midas', mutation, false, 1))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('rolls an agent update back as a new revision', async () => {
    await applyAll([salvaAgent]);
    const updated = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva', value: { display_name: 'Renamed' }
    }, false, 1);
    expect(updated.revision).toBe(2);

    const rolledBack = await repository.rollbackConfiguration('Steven', 'kant', updated.revision, false, 2);
    expect(rolledBack).toMatchObject({ applied: true, revision: 3 });
    expect((await pool.query(`SELECT display_name FROM agents WHERE tenant_id='Isa' AND alias='salva'`)).rows[0])
      .toEqual({ display_name: 'Salva' });
  });

  it('rolls a pool publication and a ceiling grant back as new revisions', async () => {
    await applyAll([salvaAgent, stevenAccount(false)]);
    const shared = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'provider_account', action: 'update', id: 'anthropic-max', value: { shared_with_pool: true }
    }, false, 2);
    const granted = await applyAll([{
      resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max'
    }], shared.revision);

    await repository.rollbackConfiguration('Steven', 'kant', granted, false, granted);
    expect((await pool.query(`SELECT 1 FROM alias_routing_ceiling`)).rowCount).toBe(0);

    await repository.rollbackConfiguration('Steven', 'kant', shared.revision, false, granted + 1);
    expect((await pool.query(`SELECT shared_with_pool FROM provider_accounts WHERE id='anthropic-max'`)).rows[0])
      .toEqual({ shared_with_pool: false });
  });
});

describe('cross-tenant subscription pool', () => {
  it('routes an alias to an account paid by another tenant, but only once it is pooled', async () => {
    await applyAll([salvaAgent, stevenAccount(false)]);

    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'alias_routing_ceiling', action: 'create',
      tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max'
    }, false, 2)).rejects.toMatchObject({ code: 'conflict' });

    await applyAll([
      { resource: 'provider_account', action: 'update', id: 'anthropic-max', value: { shared_with_pool: true } },
      {
        resource: 'alias_routing_ceiling', action: 'create',
        tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max'
      },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Isa', agent_alias: 'salva', account_id: 'anthropic-max', value: { priority: 20, enabled: true }
      }
    ], 2);

    expect((await pool.query(
      `SELECT tenant_id,account_payer_tenant FROM alias_routing_ceiling`
    )).rows).toEqual([{ tenant_id: 'Isa', account_payer_tenant: 'Steven' }]);
  });

  it('refuses to withdraw from the pool an account another tenant is still routed to', async () => {
    await applyAll([
      salvaAgent, stevenAccount(true),
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max' },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Isa', agent_alias: 'salva', account_id: 'anthropic-max', value: { enabled: true }
      }
    ]);

    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'provider_account', action: 'update', id: 'anthropic-max', value: { shared_with_pool: false }
    }, false, 4)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(`SELECT shared_with_pool FROM provider_accounts WHERE id='anthropic-max'`)).rows[0])
      .toEqual({ shared_with_pool: true });

    // Revoking the ceiling cascades the binding away in one step, and only then may the payer
    // take the account back out of the pool.
    await applyAll([
      { resource: 'alias_routing_ceiling', action: 'delete', tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max' },
      { resource: 'provider_account', action: 'update', id: 'anthropic-max', value: { shared_with_pool: false } }
    ], 4);
    expect((await pool.query(`SELECT 1 FROM agent_account_bindings`)).rowCount).toBe(0);
  });

  it('lets the payer keep routing its own private account', async () => {
    await applyAll([
      {
        resource: 'agent', action: 'create', tenant_id: 'Steven', alias: 'kant',
        value: { harness_id: 'claude', enabled: false }
      },
      stevenAccount(false),
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'kant', account_id: 'anthropic-max' }
    ]);
    expect((await pool.query(`SELECT borrowed_payer_tenant FROM alias_routing_ceiling`)).rows[0])
      .toEqual({ borrowed_payer_tenant: null });
  });

  it('never shows a borrower the payer credential locator or account identity', async () => {
    await pool.query(`UPDATE memberships SET role='operator' WHERE tenant_id='Isa' AND alias='salva'`);
    await applyAll([
      salvaAgent, stevenAccount(true), isaAccount,
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'codex-isa' },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max' },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Isa', agent_alias: 'salva', account_id: 'anthropic-max', value: { priority: 5, enabled: true }
      }
    ]);

    const snapshot = await repository.getConfiguration('Isa', 'salva');
    const accounts = snapshot.provider_accounts as Array<Record<string, unknown>>;
    expect(accounts.find((account) => account.id === 'anthropic-max')).toMatchObject({
      provider: 'anthropic', payer_tenant_id: 'Steven', shared_with_pool: true,
      external_account_id: null, credential_ref_kind: null
    });
    expect(accounts.find((account) => account.id === 'codex-isa')).toMatchObject({
      external_account_id: 'acct-isa-001', credential_ref_kind: 'env_path'
    });
    for (const account of accounts) expect(account).not.toHaveProperty('credential_ref');

    const detail = await repository.getAgent('salva', 'Isa', 'salva');
    expect(detail?.routing_accounts).toEqual([
      expect.objectContaining({
        account_id: 'anthropic-max', account_payer_tenant: 'Steven', borrowed: true,
        priority: 5, enabled: true, provider: 'anthropic', external_account_id: null
      }),
      expect.objectContaining({
        account_id: 'codex-isa', borrowed: false, enabled: false, external_account_id: 'acct-isa-001'
      })
    ]);
  });

  it('keeps a private account invisible to every tenant that does not pay for it', async () => {
    await pool.query(`UPDATE memberships SET role='operator' WHERE tenant_id='Isa' AND alias='salva'`);
    await applyAll([stevenAccount(false)]);

    const snapshot = await repository.getConfiguration('Isa', 'salva');
    expect(snapshot.provider_accounts).toEqual([]);
  });
});

describe('agent fleet read endpoints', () => {
  it('serves at most 100 role-history rows newest-first and distinguishes empty from hidden', async () => {
    await pool.query(`
      INSERT INTO agents(tenant_id,alias,display_name,enabled)
      VALUES ('Steven','zeus','Zeus',false),('Steven','kant','Kant',false)
      ON CONFLICT (tenant_id,alias) DO NOTHING;
      TRUNCATE agent_role_brief_history RESTART IDENTITY;
      DO $body$
      BEGIN
        FOR version IN 1..105 LOOP
          UPDATE agents
             SET role_brief='role history version ' || version,role_template_slug=NULL
           WHERE tenant_id='Steven' AND alias='zeus';
        END LOOP;
      END
      $body$;
    `);
    const hub = await buildGateway({
      pool,
      repository,
      authProvider: new FixedAuthProvider(testPrincipal({
        tenant_id: 'Steven', alias: 'kant', roles: [], permissions: grants('read'),
      })),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    try {
      const history = await hub.inject({
        method: 'GET', url: '/v3/console/role-assignments/Steven/zeus/history',
      });
      expect(history.statusCode).toBe(200);
      const entries = history.json<{ entries: Array<{ id: string }> }>().entries;
      expect(entries).toHaveLength(100);
      const ids = entries.map((entry) => Number(entry.id));
      expect(ids).toEqual([...ids].sort((left, right) => right - left));
      expect(ids[0]).toBe(105);
      expect(ids[ids.length - 1]).toBe(6);

      const empty = await hub.inject({
        method: 'GET', url: '/v3/console/role-assignments/Steven/kant/history',
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({ tenant_id: 'Steven', alias: 'kant', entries: [] });
    } finally {
      await hub.close();
    }

    const clientReader = await buildGateway({
      pool,
      repository,
      authProvider: new FixedAuthProvider(testPrincipal({
        tenant_id: 'Isa', alias: 'salva', roles: [], permissions: grants('read'),
      })),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    try {
      const hidden = await clientReader.inject({
        method: 'GET', url: '/v3/console/role-assignments/Pablo/midas/history',
      });
      const absent = await clientReader.inject({
        method: 'GET', url: '/v3/console/role-assignments/Pablo/ghost/history',
      });
      expect(hidden.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      expect(hidden.body).toBe(absent.body);
    } finally {
      await clientReader.close();
    }
  });

  it('resolves duplicate aliases by exact tenant and never lets legacy pick a foreign row', async () => {
    await pool.query(`
      INSERT INTO agents(tenant_id,alias,display_name,enabled)
      VALUES ('Isa','dupe','Isa duplicate',false),('Pablo','dupe','Pablo duplicate',false)
    `);

    const ownLegacy = await repository.getAgent('dupe', 'Isa', 'salva');
    expect(ownLegacy).toMatchObject({
      tenant_id: 'Isa', alias: 'dupe', display_name: 'Isa duplicate',
    });
    expect(await repository.getAgentByIdentity('Pablo', 'dupe', 'Isa', 'salva')).toBeUndefined();

    const hubForeign = await repository.getAgentByIdentity('Pablo', 'dupe', 'Steven', 'kant');
    expect(hubForeign).toMatchObject({
      tenant_id: 'Pablo', alias: 'dupe', display_name: 'Pablo duplicate',
    });

    await pool.query(`DELETE FROM agents WHERE tenant_id='Isa' AND alias='dupe'`);
    // Even after the local duplicate disappears, the compatibility lookup does not fall through
    // to the still-visible Pablo row.
    expect(await repository.getAgent('dupe', 'Isa', 'salva')).toBeUndefined();
  });

  it('scopes listAgents/getAgent to the actor tenant plus ACL-readable tenants', async () => {
    await applyAll([
      salvaAgent,
      {
        resource: 'agent', action: 'create', tenant_id: 'Pablo', alias: 'midas',
        value: { harness_id: 'openclaw', enabled: false }
      }
    ]);

    const hubAliases = ((await repository.listAgents('Steven', 'kant')).items as Array<{
      tenant_id: string; alias: string;
    }>).map((row) => `${row.tenant_id}/${row.alias}`);
    expect(hubAliases).toEqual(expect.arrayContaining(['Isa/salva', 'Pablo/midas']));

    // Isa has no acl_edge into Pablo (the default seed only wires everyone to/from the hub),
    // so Isa/salva must never see Pablo's agent even though it can see its own tenant's.
    const isaAliases = ((await repository.listAgents('Isa', 'salva')).items as Array<{
      tenant_id: string; alias: string;
    }>).map((row) => `${row.tenant_id}/${row.alias}`);
    expect(isaAliases).toContain('Isa/salva');
    expect(isaAliases).not.toContain('Pablo/midas');

    expect(await repository.getAgent('midas', 'Isa', 'salva')).toBeUndefined();
    expect(await repository.getAgent('salva', 'Isa', 'salva')).toMatchObject({ tenant_id: 'Isa', alias: 'salva' });
  });

  it('derives deployment_status from registry state and live connection presence', async () => {
    await applyAll([salvaAgent]);
    expect(await repository.getAgentByIdentity('Isa', 'salva', 'Steven', 'kant'))
      .toMatchObject({ deployment_status: 'disabled' });

    await applyAll([{
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: {
        enabled: true, container_name: 'ws-isa', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/state/salva'
      }
    }], 1);
    // Enabled, but no connection_leases row has ever existed for this alias: presence is unknown,
    // not "offline" — those are deliberately different states (never connected vs. connected then lost).
    expect(await repository.getAgentByIdentity('Isa', 'salva', 'Steven', 'kant'))
      .toMatchObject({ deployment_status: 'unknown', online: null });

    await repository.acquireLease('Isa', 'salva', 'salva-instance', [], 30_000);
    expect(await repository.getAgentByIdentity('Isa', 'salva', 'Steven', 'kant'))
      .toMatchObject({ deployment_status: 'online', online: true });

    await pool.query(
      `UPDATE connection_leases SET lease_until=now()-interval '1 minute' WHERE tenant_id='Isa' AND alias='salva'`
    );
    expect(await repository.getAgentByIdentity('Isa', 'salva', 'Steven', 'kant'))
      .toMatchObject({ deployment_status: 'offline', online: false });
  });

  it('counts the enabled fallback accounts of an agent and how many are borrowed', async () => {
    await applyAll([
      salvaAgent, isaAccount, stevenAccount(true),
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'codex-isa' },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-max' },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Isa', agent_alias: 'salva', account_id: 'codex-isa', value: { priority: 10, enabled: true }
      },
      {
        resource: 'agent_account_binding', action: 'create',
        tenant_id: 'Isa', agent_alias: 'salva', account_id: 'anthropic-max', value: { priority: 20, enabled: true }
      }
    ]);

    const listed = (await repository.listAgents('Steven', 'kant')).items as Array<Record<string, unknown>>;
    expect(listed.find((row) => row.alias === 'salva')).toMatchObject({
      fallback_account_count: 2, borrowed_account_count: 1
    });
  });
});
