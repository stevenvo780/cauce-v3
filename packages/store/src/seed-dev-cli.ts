import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CauceRepository, createPool, withTransaction, type DatabaseClient } from './index.js';
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

/** Not part of the traffic sample: the director of the legacy company and the second company's fleet. */
const SEED_DIRECTOR: SeedAgent = {
  tenant: 'Steven', room: 'grp.steven', alias: 'argos', harness: 'claude',
  role: 'Director de la flota: coordina el trabajo y responde ante los dueños.',
};
const SECOND_COMPANY = { id: 'praxis', name: 'Praxis', tenant: 'Hospital', room: 'grp.hospital' } as const;
const SECOND_FLEET: readonly SeedAgent[] = [
  {
    tenant: SECOND_COMPANY.tenant, room: SECOND_COMPANY.room, alias: 'operador', harness: 'codex',
    role: 'Líder de la flota: coordina todo el trabajo y atiende a su dueño.',
  },
  {
    tenant: SECOND_COMPANY.tenant, room: SECOND_COMPANY.room, alias: 'praxis-supervisor', harness: 'codex',
    role: 'Supervisa la flota y emite avisos reservados.',
  },
];
const UNUSABLE_PASSWORD_HASH = `$scrypt$${'x'.repeat(48)}`;

type Queryable = Pick<DatabaseClient, 'query'>;

export async function seedSyntheticCompanyContexts(url: string): Promise<readonly {
  company_id: string; tenant_id: string; alias: string; human_id: string;
}[]> {
  assertDevelopmentDatabaseUrl(url);
  const pool = createPool(url);
  try {
    return await withTransaction(pool, async client => {
      const result: { company_id: string; tenant_id: string; alias: string; human_id: string }[] = [];
      for (const [company, tenant] of [['context_alpha', 'ContextAlpha'], ['context_beta', 'ContextBeta']] as const) {
        const room = 'context-room';
        await client.query('INSERT INTO companies(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [company]);
        await client.query('INSERT INTO tenants(id,company_id,is_hub) VALUES($1,$2,true) ON CONFLICT DO NOTHING', [tenant, company]);
        await client.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room, tenant]);
        for (const alias of ['owner', 'director']) await seedAgent(client,
          { tenant, room, alias, harness: 'fake', role: `Synthetic ${alias}` });
        const owner = await seedPerson(client, `${company}@dev.example`, 'Synthetic owner', tenant, 'owner');
        await client.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
          VALUES($1,$2,'owner','import',$2) ON CONFLICT DO NOTHING`, [company, owner]);
        for (const kind of ['director', 'human_receipt']) await client.query(`INSERT INTO company_system_principals
          (company_id,kind,tenant_id,principal_alias) VALUES($1,$2,$3,'director') ON CONFLICT DO NOTHING`, [company, kind, tenant]);
        for (const role of ['coordination', 'infra_escalation']) await client.query(`INSERT INTO company_agent_roles
          (company_id,role,tenant_id,alias) VALUES($1,$2,$3,'director') ON CONFLICT DO NOTHING`, [company, role, tenant]);
        result.push({ company_id: company, tenant_id: tenant, alias: 'director', human_id: owner });
      }
      return result;
    });
  } finally { await pool.end(); }
}

async function seedAgent(db: Queryable, agent: SeedAgent): Promise<void> {
  await db.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
       home_directory,state_directory,max_concurrent_deliveries
     ) VALUES($1,$2,$3,$2,true,$4,'dev','/home/dev','/home/dev/.cauce/dev',3)
     ON CONFLICT (tenant_id,alias) DO UPDATE SET harness_id=EXCLUDED.harness_id,enabled=true`,
    [agent.tenant, agent.alias, agent.harness, `ws-${agent.alias}`],
  );
  await db.query(
    `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
     VALUES($1,$2,$3,'agent',true) ON CONFLICT DO NOTHING`,
    [agent.tenant, agent.room, agent.alias],
  );
  await db.query(
    `INSERT INTO agent_profiles(tenant_id,alias,role_summary,revision,updated_at)
     VALUES($1,$2,$3,1,now())
     ON CONFLICT (tenant_id,alias) DO UPDATE SET role_summary=EXCLUDED.role_summary`,
    [agent.tenant, agent.alias, agent.role],
  );
}

async function seedAgents(pool: ReturnType<typeof createPool>): Promise<void> {
  for (const agent of [...SEED_FLEET, SEED_DIRECTOR]) await seedAgent(pool, agent);
}

async function seedPerson(
  client: DatabaseClient, email: string, name: string, tenant: string, alias: string,
): Promise<string> {
  const person = (await client.query<{ id: string }>(
    `INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
     VALUES($1,$1,$2,$3,'operator',$4,$5)
     ON CONFLICT (email_normalized) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id::text`,
    [email, UNUSABLE_PASSWORD_HASH, name, tenant, alias],
  )).rows[0];
  if (person === undefined) throw new Error('seed person was not written');
  await client.query('UPDATE memberships SET role=\'operator\' WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
  await client.query(
    `INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
     VALUES($1,$2,$3,'operator',ARRAY['read','control']) ON CONFLICT DO NOTHING`,
    [person.id, tenant, alias],
  );
  return person.id;
}

/**
 * Both companies in one transaction: a company must commit with its owner. The first company keeps
 * the legacy shape (a director apart from the infrastructure and coordination agents); the second is
 * led by one agent that is its director, receipt agent and both escalation targets.
 */
async function seedCompanies(pool: ReturnType<typeof createPool>): Promise<void> {
  const [zeus, kant, kratos] = SEED_FLEET;
  const second = SECOND_COMPANY;
  const [leader, supervisor] = SECOND_FLEET;
  if (leader === undefined || supervisor === undefined) throw new Error('second company fleet is incomplete');
  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO companies(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [second.id, second.name],
    );
    await client.query(
      'INSERT INTO tenants(id,company_id,is_hub) VALUES($1,$2,true) ON CONFLICT DO NOTHING', [second.tenant, second.id],
    );
    await client.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [second.room, second.tenant]);
    for (const agent of SECOND_FLEET) await seedAgent(client, agent);
    const owner = await seedPerson(client, 'owner@dev.example', 'Dev owner', kant.tenant, kant.alias);
    const coOwner = await seedPerson(client, 'co-owner@dev.example', 'Dev co-owner', kratos.tenant, kratos.alias);
    const delegate = await seedPerson(client, 'admin@dev.example', 'Dev administrator', zeus.tenant, zeus.alias);
    const secondOwner = await seedPerson(client, 'leader-owner@dev.example', 'Second owner', leader.tenant, leader.alias);
    await client.query('INSERT INTO platform_admins(human_id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
    for (const [company, human, role, source] of [
      ['humanizar', owner, 'owner', 'platform'], ['humanizar', coOwner, 'owner', 'platform'],
      ['humanizar', delegate, 'admin', 'platform'], [second.id, secondOwner, 'owner', 'import'],
    ]) {
      await client.query(
        `INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [company, human, role, source, owner],
      );
    }
    await client.query(
      `INSERT INTO egress_destinations(tenant_id,alias,handle,conversation_id,conversation_kind,allow_kinds)
       VALUES($1,$2,'owner_dm','1000001','dm',ARRAY['alert','decision_request','digest'])
       ON CONFLICT DO NOTHING`, [leader.tenant, leader.alias],
    );
    const principal = (
      company: string, kind: string, agent: SeedAgent, room: string | null, actor: string | null,
      alias: string, recipient: string | null, handle: string | null,
    ): Promise<unknown> => client.query(
      `INSERT INTO company_system_principals(
         company_id,kind,tenant_id,room_id,actor_alias,principal_alias,recipient_alias,notify_handle)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [company, kind, agent.tenant, room, actor, alias, recipient, handle],
    );
    await principal('humanizar', 'gate_probe', kant, kant.room, kant.alias, 'gate-probe', null, null);
    await principal('humanizar', 'director', SEED_DIRECTOR, null, null, SEED_DIRECTOR.alias, null, null);
    await principal(second.id, 'director', leader, null, null, leader.alias, null, null);
    await principal(second.id, 'human_receipt', leader, null, null, leader.alias, null, null);
    await principal(second.id, 'supervision_notice', supervisor, supervisor.room, supervisor.alias,
      supervisor.alias, leader.alias, 'owner_dm');
    for (const [company, role, agent] of [
      ['humanizar', 'infra_escalation', zeus], ['humanizar', 'coordination', kant],
      [second.id, 'infra_escalation', leader], [second.id, 'coordination', leader],
    ] as const) {
      await client.query(
        `INSERT INTO company_agent_roles(company_id,role,tenant_id,alias) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [company, role, agent.tenant, agent.alias],
      );
    }
  });
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
    await seedCompanies(pool);
    await seedEdges(pool);
    const claimed = await seedTraffic(pool, repository, log);
    const summary = await pool.query<{ table_name: string; rows: string }>(
      `SELECT 'agents' AS table_name, count(*)::text AS rows FROM agents
       UNION ALL SELECT 'memberships', count(*)::text FROM memberships
       UNION ALL SELECT 'agent_profiles', count(*)::text FROM agent_profiles
       UNION ALL SELECT 'acl_edges', count(*)::text FROM acl_edges
       UNION ALL SELECT 'companies', count(*)::text FROM companies
       UNION ALL SELECT 'company_admins', count(*)::text FROM company_admins
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
