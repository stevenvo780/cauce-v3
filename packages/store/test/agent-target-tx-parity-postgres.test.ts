import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tenant } from '@cauce/protocol';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  CauceRepository, withTransaction, type AgentTargetPermission, type DatabasePool
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * `authorizeAgentTarget` is the ONE authorization for a `(tenant, alias)` target and it must answer
 * the same on the pool as inside a caller's transaction: a second copy that only one of the two
 * paths runs is how `read` on a disabled agent ends up permitted in one and denied in the other.
 * The relaxation is deliberate — `read` sees a disabled agent, `control` never does.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

interface Scenario {
  readonly name: string;
  readonly actorTenant: Tenant;
  readonly actorAlias: string;
  readonly targetTenant: Tenant;
  readonly targetAlias: string;
  readonly permission: AgentTargetPermission;
  readonly authorized: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'mismo tenant, agente habilitado, read',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Steven', targetAlias: 'argos',
    permission: 'read', authorized: true
  },
  {
    name: 'mismo tenant, agente habilitado, control',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Steven', targetAlias: 'argos',
    permission: 'control', authorized: true
  },
  {
    name: 'cross-tenant con arista de control anclada al hub, read',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Miguel', targetAlias: 'kratos',
    permission: 'read', authorized: true
  },
  {
    name: 'cross-tenant con arista de control anclada al hub, control',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Miguel', targetAlias: 'kratos',
    permission: 'control', authorized: true
  },
  {
    name: 'cross-tenant sin arista entre los dos tenants, read',
    actorTenant: 'Miguel', actorAlias: 'kratos', targetTenant: 'Pablo', targetAlias: 'seneca',
    permission: 'read', authorized: false
  },
  {
    name: 'cross-tenant sin arista entre los dos tenants, control',
    actorTenant: 'Miguel', actorAlias: 'kratos', targetTenant: 'Pablo', targetAlias: 'seneca',
    permission: 'control', authorized: false
  },
  {
    name: 'agente destino deshabilitado, read',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Steven', targetAlias: 'socrates',
    permission: 'read', authorized: true
  },
  {
    name: 'agente destino deshabilitado, control',
    actorTenant: 'Steven', actorAlias: 'kant', targetTenant: 'Steven', targetAlias: 'socrates',
    permission: 'control', authorized: false
  }
];

async function seedAgent(tenantId: Tenant, alias: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory
     ) VALUES($1,$2,'codex',$3,'ws-test','dev','/home/dev','/home/dev/.cauce/test')`,
    [tenantId, alias, enabled]
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  // The missing edge, not a missing role, has to be the only reason the Pablo target is denied.
  await pool.query(
    `UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='kratos'`
  );
  await seedAgent('Steven', 'argos', true);
  await seedAgent('Steven', 'socrates', false);
  await seedAgent('Miguel', 'kratos', true);
  await seedAgent('Pablo', 'seneca', true);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('authorizeAgentTarget da el mismo veredicto en el pool y dentro de una transacción', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const pooled = await repository.authorizeAgentTarget(
      scenario.actorTenant, scenario.actorAlias,
      scenario.targetTenant, scenario.targetAlias, scenario.permission
    );
    const transactional = await withTransaction(pool, async (client) =>
      repository.authorizeAgentTarget(
        scenario.actorTenant, scenario.actorAlias,
        scenario.targetTenant, scenario.targetAlias, scenario.permission, client
      ));

    expect(transactional).toEqual(pooled);
    expect(pooled !== undefined).toBe(scenario.authorized);
  }, 120_000);

  it('la llamada transaccional ve el estado no confirmado del llamante', async () => {
    await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='argos'`
      );

      await expect(repository.authorizeAgentTarget(
        'Steven', 'kant', 'Steven', 'argos', 'control', client
      )).resolves.toBeUndefined();
      await expect(repository.authorizeAgentTarget(
        'Steven', 'kant', 'Steven', 'argos', 'control'
      )).resolves.toMatchObject({ alias: 'argos', enabled: true });
    });
  }, 120_000);
});
