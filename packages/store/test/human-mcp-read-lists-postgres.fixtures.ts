import type { Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../src/index.js';
import {
  databasePool, getRepository, humanOptions, seededHuman, switchHumanToReader,
  type HumanFixture, type HumanReceiptOptions,
} from './human-owned-receipt-postgres.fixtures.js';
import { createHumanReadAuthority } from '../../../services/gateway/src/human-mcp-authority.js';
import { verifiedIdentity } from './human-owned-receipt-postgres.fixtures.js';

export { databasePool, getRepository, humanOptions };
export type ListKind = 'presence' | 'agents';
export type Account = HumanFixture;
export const listKinds = ['presence', 'agents'] as const;

export const revocations = [
  { name: 'account', sql: 'UPDATE console_users SET active=false WHERE id=$1', parameter: 'humanId' },
  { name: 'binding', sql: 'UPDATE human_external_identities SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1', parameter: 'humanId' },
  { name: 'human membership', sql: "UPDATE human_tenant_memberships SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1 AND tenant_id='Steven'", parameter: 'humanId' },
  { name: 'technical membership', sql: "UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1", parameter: 'alias' },
  { name: 'policy', sql: "UPDATE role_policies SET allow_read=false WHERE role='human-reader'", parameter: undefined },
  { name: 'tenant', sql: "UPDATE tenants SET enabled=false WHERE id='Steven'", parameter: undefined },
  { name: 'room', sql: "UPDATE rooms SET enabled=false WHERE tenant_id='Steven' AND id='grp.steven'", parameter: undefined },
] as const;

export function revokeParameters(revocation: typeof revocations[number], account: Account): unknown[] {
  return revocation.parameter === undefined ? [] : [account[revocation.parameter]];
}

export async function reader(alias?: string): Promise<Account> {
  const account = await seededHuman(alias);
  await switchHumanToReader(account);
  return account;
}

export async function readList(
  kind: ListKind, account: Account, options: HumanReceiptOptions = humanOptions(account, 'read'),
  tenant: Tenant = 'Steven',
): Promise<unknown> {
  return kind === 'presence'
    ? getRepository().listPresence(tenant, account.alias, options)
    : getRepository().listAgents(tenant, account.alias, options);
}

export async function backendPid(client: DatabaseClient): Promise<number> {
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (pid === undefined) throw new Error('missing own PostgreSQL backend PID');
  return pid;
}

export async function waitBlocked(observer: DatabaseClient, waiting: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      'SELECT $2=ANY(pg_blocking_pids($1)) AS blocked', [waiting, blocker],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the expected physical PostgreSQL lock barrier was not reached');
}

export async function blockedReader(observer: DatabaseClient, blocker: number): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const result = await observer.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>$1 LIMIT 1', [blocker],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('own read backend did not block behind the revocation');
}

export function inventoryBarrier(account: Account, kind: ListKind) {
  const originalOptions = humanOptions(account, 'read');
  let enter: ((pid: number) => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<number>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options: HumanReceiptOptions = {
    ...originalOptions,
    humanAuthority: async (client) => {
      const human = await originalOptions.humanAuthority(client);
      const pid = await backendPid(client);
      const query = client.query.bind(client);
      const marker = kind === 'presence' ? 'FROM connection_leases l' : 'FROM agents a';
      client.query = (async (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes(marker)) {
          client.query = query;
          enter?.(pid);
          await gate;
        }
        return Reflect.apply(query, client, args) as unknown;
      }) as typeof client.query;
      return human;
    },
  };
  return { options, entered, release: () => { release?.(); } };
}

export async function waitInventory(barrier: ReturnType<typeof inventoryBarrier>, pending: Promise<unknown>): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      barrier.entered,
      pending.then(() => { throw new Error('inventory escaped the cancellable authority transaction'); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('inventory query barrier was not reached')); }, 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function seedForeignSameAlias(account: Account): Promise<HumanReceiptOptions> {
  const foreign = await seededHuman(account.alias);
  const pool = databasePool();
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Isa',$1) ON CONFLICT DO NOTHING", [account.alias]);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES('Isa','grp.isa',$1,'human-reader',true) ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='human-reader',enabled=true", [account.alias]);
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Isa',$2,'reader',ARRAY['read'])", [foreign.humanId, foreign.alias]);
  await pool.query("UPDATE console_users SET tenant_id='Isa',role='reader' WHERE id=$1", [foreign.humanId]);
  await pool.query("UPDATE acl_edges SET enabled=true,allow_read=true WHERE from_tenant='Steven' AND to_tenant='Isa'");
  await pool.query("INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,last_heartbeat_at,lease_until) VALUES('Steven',$1,'read-lists-own',1,now(),now()+interval '1 minute'),('Isa',$1,'read-lists-foreign',1,now(),now()+interval '1 minute')", [account.alias]);
  const signal = new AbortController().signal;
  return { signal, humanAuthority: createHumanReadAuthority(verifiedIdentity(foreign, ['cauce.read']),
    { humanId: foreign.humanId, tenantId: 'Isa', actorAlias: foreign.alias }, signal) };
}
