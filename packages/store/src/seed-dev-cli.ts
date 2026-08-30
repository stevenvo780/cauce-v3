/**
 * Seeds the local development database with a fleet small enough to reason about and real enough
 * to reproduce production problems: two groups, three agents, and traffic in every state the
 * console has to paint.
 *
 * The migrations already create the five real tenants and their rooms, so this only adds what a
 * fresh schema leaves empty: agents, memberships, profiles, cross-tenant edges and deliveries.
 * Everything goes through `CauceRepository`, never raw INSERTs for traffic: a hand-built row can
 * satisfy the schema and still be something the code would never have produced.
 */
import { randomUUID } from 'node:crypto';
import { CauceRepository, createPool } from './index.js';
import type { PublishMessage } from '@cauce/protocol';

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error('DATABASE_URL is required');
if (!/\/cauce_dev(\?|$)/.test(url)) {
  throw new Error(`refusing to seed "${url}": only a database named cauce_dev is accepted`);
}

interface AgenteSembrado {
  readonly tenant: string;
  readonly room: string;
  readonly alias: string;
  readonly harness: string;
  readonly rol: string;
}

/** Taken from `grupos.json`: the roles are the ones the real fleet carries. */
const FLOTA: readonly [AgenteSembrado, AgenteSembrado, AgenteSembrado] = [
  {
    tenant: 'Steven', room: 'grp.steven', alias: 'zeus', harness: 'claude',
    rol: 'Encargado de la gestion de Cauce y de la infraestructura de los agentes.',
  },
  {
    tenant: 'Steven', room: 'grp.steven', alias: 'kant', harness: 'claude',
    rol: 'Devops encargado de la infraestructura de todos los servidores.',
  },
  {
    tenant: 'Miguel', room: 'grp.miguel', alias: 'kratos', harness: 'codex',
    rol: 'Desarrollador para lo que necesite Miguel.',
  },
];

const pool = createPool(url);
const repository = new CauceRepository(pool);

async function sembrarAgentes(): Promise<void> {
  for (const agente of FLOTA) {
    await pool.query(
      `INSERT INTO agents(
         tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
         home_directory,state_directory,max_concurrent_deliveries
       ) VALUES($1,$2,$3,$2,true,$4,'dev','/home/dev','/home/dev/.cauce/dev',3)
       ON CONFLICT (tenant_id,alias) DO UPDATE SET harness_id=EXCLUDED.harness_id,enabled=true`,
      [agente.tenant, agente.alias, agente.harness, `ws-${agente.alias}`],
    );
    await pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
       VALUES($1,$2,$3,'agent',true) ON CONFLICT DO NOTHING`,
      [agente.tenant, agente.room, agente.alias],
    );
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,role_summary,revision,updated_at)
       VALUES($1,$2,$3,1,now())
       ON CONFLICT (tenant_id,alias) DO UPDATE SET role_summary=EXCLUDED.role_summary`,
      [agente.tenant, agente.alias, agente.rol],
    );
  }
}

/** Miguel's agents reach Steven's and back: that is the only cross-tenant edge production has. */
async function sembrarAristas(): Promise<void> {
  for (const [origen, destino] of [['Miguel', 'Steven'], ['Steven', 'Miguel']]) {
    await pool.query(
      `INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
       VALUES($1,$2,true,true,true,false) ON CONFLICT DO NOTHING`,
      [origen, destino],
    );
  }
}

function mensaje(de: AgenteSembrado, a: AgenteSembrado, texto: string): PublishMessage {
  // A stable idempotency key is what makes re-seeding cheap: publish dedupes instead of piling up.
  const clave = `dev-seed:${de.alias}:${a.alias}:${texto.slice(0, 24)}`;
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-dev-${de.alias}-${a.alias}`,
    tenant_id: de.tenant,
    room_id: de.room,
    actor_alias: de.alias,
    recipients: [{ tenant_id: a.tenant, alias: a.alias }],
    body: { type: 'command', text: texto },
    idempotency_key: clave,
    lane: 'interactive',
    priority: 0,
  };
}

/**
 * Traffic in three states, because a console showing only `pending` proves nothing: a delivery
 * that was answered, one still waiting, and one that exhausted its attempts and reached the DLQ.
 */
async function sembrarTrafico(): Promise<void> {
  const [zeus, kant, kratos] = FLOTA;
  await repository.publish(mensaje(kant, zeus, 'Revisa el estado del despliegue de la consola.'));
  await repository.publish(mensaje(zeus, kratos, 'Necesito el diagnostico del adaptador de Miguel.'));
  await repository.publish(mensaje(kratos, zeus, 'El adaptador quedo sin sesion compartida.'));

  /*
   * The instance is STABLE on purpose. An alias holds one consumer lease: with a fresh id on every
   * run the second seeding collides with the live lease from the first, `acquired` comes back false
   * without an epoch, and the claim is then rejected by fencing.
   */
  const instancia = 'dev-seed-consumer';
  const lease = await repository.acquireLease(zeus.tenant, zeus.alias, instancia, [], 120_000);
  if (!lease.acquired || lease.epoch === undefined) {
    console.log(`lease en manos de ${lease.active_instance_id ?? 'otra instancia'}: no se reclama`);
    return;
  }
  const entregas = await repository.claimDeliveries(
    zeus.tenant, zeus.alias, instancia, lease.epoch, 1,
  );
  console.log(`entregas reclamadas por ${zeus.alias}: ${String(entregas.length)}`);
}

try {
  await sembrarAgentes();
  await sembrarAristas();
  await sembrarTrafico();
  const resumen = await pool.query<{ tabla: string; filas: string }>(
    `SELECT 'agents' AS tabla, count(*)::text AS filas FROM agents
     UNION ALL SELECT 'memberships', count(*)::text FROM memberships
     UNION ALL SELECT 'agent_profiles', count(*)::text FROM agent_profiles
     UNION ALL SELECT 'acl_edges', count(*)::text FROM acl_edges
     UNION ALL SELECT 'messages', count(*)::text FROM messages
     UNION ALL SELECT 'deliveries', count(*)::text FROM deliveries ORDER BY 1`,
  );
  for (const fila of resumen.rows) console.log(`${fila.tabla.padEnd(16)} ${fila.filas}`);
} finally {
  await pool.end();
}
