/**
 * Seeds the local development database with a fleet small enough to reason about and real enough
 * to reproduce production problems: two groups, three agents, and a small queue with pending and
 * leased traffic.
 *
 * The migrations already create the five real tenants and their rooms, so this only adds what a
 * fresh schema leaves empty: agents, memberships, profiles, cross-tenant edges and deliveries.
 * Everything goes through `CauceRepository`, never raw INSERTs for traffic: a hand-built row can
 * satisfy the schema and still be something the code would never have produced.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CauceRepository, createPool } from './index.js';
import type { PublishMessage } from '@cauce/protocol';

function databaseName(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const name = path.startsWith('/') ? path.slice(1) : path;
    return name === '' ? undefined : decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

export function assertDevelopmentDatabaseUrl(url: string): void {
  const name = databaseName(url);
  if (name === 'cauce_dev' || name === 'cauce_test' || name?.startsWith('cauce_test_')) return;
  throw new Error(
    `refusing to seed database "${name ?? 'invalid URL'}": only cauce_dev, cauce_test, or cauce_test_* is accepted`,
  );
}

interface SeedAgent {
  readonly tenant: string;
  readonly room: string;
  readonly alias: string;
  readonly harness: string;
  readonly role: string;
}

/** Taken from `grupos.json`: the roles are the ones the real fleet carries. */
const SEED_FLEET: readonly [SeedAgent, SeedAgent, SeedAgent] = [
  {
    tenant: 'Steven', room: 'grp.steven', alias: 'zeus', harness: 'claude',
    role: 'Encargado de la gestion de Cauce y de la infraestructura de los agentes.',
  },
  {
    tenant: 'Steven', room: 'grp.steven', alias: 'kant', harness: 'claude',
    role: 'Devops encargado de la infraestructura de todos los servidores.',
  },
  {
    tenant: 'Miguel', room: 'grp.miguel', alias: 'kratos', harness: 'codex',
    role: 'Desarrollador para lo que necesite Miguel.',
  },
];

async function seedAgents(pool: ReturnType<typeof createPool>): Promise<void> {
  for (const agent of SEED_FLEET) {
    await pool.query(
      `INSERT INTO agents(
         tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
         home_directory,state_directory,max_concurrent_deliveries
       ) VALUES($1,$2,$3,$2,true,$4,'dev','/home/dev','/home/dev/.cauce/dev',3)
       ON CONFLICT (tenant_id,alias) DO UPDATE SET harness_id=EXCLUDED.harness_id,enabled=true`,
      [agent.tenant, agent.alias, agent.harness, `ws-${agent.alias}`],
    );
    await pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
       VALUES($1,$2,$3,'agent',true) ON CONFLICT DO NOTHING`,
      [agent.tenant, agent.room, agent.alias],
    );
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,role_summary,revision,updated_at)
       VALUES($1,$2,$3,1,now())
       ON CONFLICT (tenant_id,alias) DO UPDATE SET role_summary=EXCLUDED.role_summary`,
      [agent.tenant, agent.alias, agent.role],
    );
  }
}

/** Miguel's agents reach Steven's and back: that is the only cross-tenant edge production has. */
async function seedEdges(pool: ReturnType<typeof createPool>): Promise<void> {
  for (const [source, destination] of [['Miguel', 'Steven'], ['Steven', 'Miguel']]) {
    await pool.query(
      `INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
       VALUES($1,$2,true,true,true,false) ON CONFLICT DO NOTHING`,
      [source, destination],
    );
  }
}

function message(from: SeedAgent, to: SeedAgent, text: string): PublishMessage {
  // A stable idempotency key is what makes re-seeding cheap: publish dedupes instead of piling up.
  const key = `dev-seed:${from.alias}:${to.alias}:${text.slice(0, 24)}`;
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-dev-${from.alias}-${to.alias}`,
    tenant_id: from.tenant,
    room_id: from.room,
    actor_alias: from.alias,
    recipients: [{ tenant_id: to.tenant, alias: to.alias }],
    body: { type: 'command', text },
    idempotency_key: key,
    lane: 'interactive',
    priority: 0,
  };
}

/**
 * The sample leaves two honest states: one delivery is leased to the consumer and two remain
 * pending. It does not manufacture terminal acknowledgements or dead letters.
 */
async function seedTraffic(
  pool: ReturnType<typeof createPool>,
  repository: CauceRepository,
  log: (line: string) => void,
): Promise<number> {
  const [zeus, kant, kratos] = SEED_FLEET;
  const receipts = await Promise.all([
    repository.publish(message(kant, zeus, 'Revisa el estado del despliegue de la consola.')),
    repository.publish(message(zeus, kratos, 'Necesito el diagnostico del adaptador de Miguel.')),
    repository.publish(message(kratos, zeus, 'El adaptador quedo sin sesion compartida.')),
  ]);
  const deliveryIds = receipts.flatMap((receipt) => receipt.delivery_ids);
  const trafficState = await pool.query<{ deliveries: number; already_initialized: boolean }>(
    `SELECT count(*)::int AS deliveries,
            COALESCE(bool_or(attempt > 0 OR status <> 'pending'),false) AS already_initialized
       FROM deliveries WHERE id=ANY($1::uuid[])`,
    [deliveryIds],
  );
  const state = trafficState.rows[0];
  if (state?.deliveries !== deliveryIds.length) {
    throw new Error('seed traffic receipts do not resolve to the expected durable deliveries');
  }
  if (state.already_initialized) {
    log('seed traffic already initialized: no deliveries claimed');
    return 0;
  }

  /*
   * A stable instance lets a failed first run resume after its lease expires. Durable delivery
   * attempts above prevent a completed seed from claiming more traffic on every later run.
   */
  const instanceId = 'dev-seed-consumer';
  const lease = await repository.acquireLease(zeus.tenant, zeus.alias, instanceId, [], 120_000);
  if (!lease.acquired || lease.epoch === undefined) {
    log(`lease held by ${lease.active_instance_id ?? 'another instance'}: no deliveries claimed`);
    return 0;
  }
  const deliveries = await repository.claimDeliveries(
    zeus.tenant, zeus.alias, instanceId, lease.epoch, 1,
  );
  log(`deliveries claimed by ${zeus.alias}: ${String(deliveries.length)}`);
  return deliveries.length;
}

export async function seedDevelopmentDatabase(
  url: string,
  log: (line: string) => void = console.log,
): Promise<number> {
  assertDevelopmentDatabaseUrl(url);
  const pool = createPool(url);
  const repository = new CauceRepository(pool);
  try {
    await seedAgents(pool);
    await seedEdges(pool);
    const claimed = await seedTraffic(pool, repository, log);
    const summary = await pool.query<{ table_name: string; rows: string }>(
      `SELECT 'agents' AS table_name, count(*)::text AS rows FROM agents
       UNION ALL SELECT 'memberships', count(*)::text FROM memberships
       UNION ALL SELECT 'agent_profiles', count(*)::text FROM agent_profiles
       UNION ALL SELECT 'acl_edges', count(*)::text FROM acl_edges
       UNION ALL SELECT 'messages', count(*)::text FROM messages
       UNION ALL SELECT 'deliveries', count(*)::text FROM deliveries ORDER BY 1`,
    );
    for (const row of summary.rows) log(`${row.table_name.padEnd(16)} ${row.rows}`);
    return claimed;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is required');
  await seedDevelopmentDatabase(url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
