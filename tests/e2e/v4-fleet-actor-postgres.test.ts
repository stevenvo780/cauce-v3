import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FleetOperationSchema, type FleetOperation } from '@cauce/protocol';
import { displayFleetOperation } from '../../services/gateway/src/console/fleet-operation-display.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const first = randomUUID();
const second = randomUUID();
let database: TestDatabase | undefined;
const base: FleetOperation = { id: randomUUID(), request_sha256: 'a'.repeat(64),
  actor: { tenant_id: 'Steven', alias: 'actor_owner', actor_subject: `console:${first}` },
  target: { resource: 'agent', tenant_id: 'Steven', alias: 'actor_target' }, kind: 'stop',
  status: 'succeeded', version: 1, expected_revision: 0, desired_revision: 1, applied_revision: 1,
  steps: [], error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
const pool = () => { if (!database) throw new Error('actor database absent'); return database.pool; };

beforeAll(async () => {
  database = await startTestDatabase();
  await pool().query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','actor_owner')");
  await pool().query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,'zz-canary-actor-first@example.invalid','zz-canary-actor-first@example.invalid',$3,'Primera persona','operator','Steven','actor_owner'),
      ($2,'zz-canary-actor-second@example.invalid','zz-canary-actor-second@example.invalid',$3,'Segunda persona','operator','Steven','actor_owner')`,
  [first, second, '$scrypt$' + 'x'.repeat(40)]);
}, 120_000);
afterAll(async () => { try { await database?.pool.end(); } finally { await database?.container.stop(); } });

describe('identidad humana de presentación de flota con PostgreSQL', () => {
  it('resuelve el subject exacto cuando dos personas comparten el mismo alias operador', async () => {
    expect((await displayFleetOperation(pool(), base)).actor.display_name).toBe('Primera persona');
    const other = { ...base, actor: { ...base.actor, actor_subject: `console:${second}` } };
    expect((await displayFleetOperation(pool(), other)).actor.display_name).toBe('Segunda persona');
  });
  it.each([{ tenant_id: 'Isa' }, { alias: 'actor_other' }, { actor_subject: `console:${randomUUID()}` }])(
    'omite nombres cuando no corresponde la identidad completa %j', async changed => {
      const receipt = await displayFleetOperation(pool(), { ...base, actor: { ...base.actor, ...changed } });
      expect(receipt.actor).not.toHaveProperty('display_name');
    },
  );
  it('conserva el contrato canónico del worker y los recibos sin procedencia humana', async () => {
    expect(FleetOperationSchema.parse(base)).toEqual(base);
    const legacy = { ...base, actor: { tenant_id: 'Steven', alias: 'actor_owner' } };
    expect(await displayFleetOperation(pool(), legacy)).toEqual(legacy);
    expect(base.actor).not.toHaveProperty('display_name');
  });
});
