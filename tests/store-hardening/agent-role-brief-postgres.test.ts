import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_LIMITS, AgentConfigMutationSchema, ConfigMutationSchema,
  ROLE_BRIEF_MAX_CODE_POINTS, WsOutboundSchema, clampToRoleBriefLimit, countCodePoints,
  type ConfigMutation,
} from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, StoreError, type DatabasePool,
} from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let profiles: AgentProfileRepository;

const actor = { tenant_id: 'Steven', alias: 'kant' } as const;
const edgeRole = `${'a'.repeat(1_100)}${'🎉'.repeat(100)}`;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
  profiles = new AgentProfileRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    TRUNCATE config_revisions RESTART IDENTITY;
    DELETE FROM agents WHERE tenant_id='Isa' AND alias='salva';
    UPDATE memberships SET role='agent',enabled=true WHERE tenant_id='Isa' AND alias='salva';
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
  `);
  await repository.applyConfigurationChange('Steven', 'kant', {
    resource: 'agent', action: 'create', tenant_id: 'Isa', alias: 'salva',
    value: {
      harness_id: 'codex', display_name: 'Salva', enabled: true,
      container_name: 'ws-salva', runtime_user: 'dev',
      home_directory: '/home/dev', state_directory: '/var/lib/salva',
    },
  }, false, 0);
});

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

async function deliveryEnvelope(): Promise<Record<string, unknown>> {
  await repository.publish({
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }], body: { text: 'perfil canónico' },
    idempotency_key: randomUUID(), lane: 'interactive', priority: 0,
  });
  const lease = await repository.acquireLease(
    'Isa', 'salva', 'salva-profile-test', ['agent_identity_v1', 'agent_profile_v1'], 30_000,
  );
  const claimed = await repository.claimDeliveries(
    'Isa', 'salva', 'salva-profile-test', lease.epoch!, 5,
  );
  expect(claimed).toHaveLength(1);
  return claimed[0] as unknown as Record<string, unknown>;
}

describe('role_brief es una proyección, no una segunda fuente de verdad', () => {
  it('el protocolo y el store rechazan ambas vías genéricas sin consumir revisión', async () => {
    expect(AgentConfigMutationSchema.safeParse({
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { role_brief: 'duplicado' },
    }).success).toBe(false);
    expect(ConfigMutationSchema.safeParse({
      resource: 'agent_profile', action: 'create', tenant_id: 'Isa', alias: 'salva',
      value: { purpose: 'duplicado' },
    }).success).toBe(false);

    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM config_revisions',
    );
    const directRole = {
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { role_brief: 'duplicado' },
    } as unknown as ConfigMutation;
    const directProfile = {
      resource: 'agent_profile', action: 'create', tenant_id: 'Isa', alias: 'salva',
      value: { purpose: 'duplicado' },
    } as unknown as ConfigMutation;
    for (const mutation of [directRole, directProfile]) {
      await expect(repository.applyConfigurationChange(
        'Steven', 'kant', mutation, false, before.rows[0]!.count,
      )).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const after = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM config_revisions',
    );
    expect(after.rows).toEqual([{ count: before.rows[0]!.count }]);
  });

  it('la escritura canónica proyecta el rol y el mismo valor llega al sobre', async () => {
    expect(countCodePoints(edgeRole)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(edgeRole.length).toBe(1_300);
    const desired = await profiles.replace({
      tenant_id: 'Isa', alias: 'salva', role_summary: edgeRole,
    }, null, actor);
    await profiles.markApplied('Isa', 'salva', desired.revision, actor);

    const state = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Isa' AND alias='salva'`,
    );
    expect(countCodePoints(state.rows[0]!.role_brief)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(state.rows[0]?.role_brief).toBe(edgeRole);

    const envelope = await deliveryEnvelope();
    expect(envelope.self_role).toBe(edgeRole);
    expect(WsOutboundSchema.parse(envelope)).toMatchObject({ self_role: edgeRole });
  });

  it('el tope canónico nombra el campo y no deja una fila parcial', async () => {
    await expect(profiles.replace({
      tenant_id: 'Isa', alias: 'salva',
      role_summary: 'x'.repeat(AGENT_PROFILE_LIMITS.role_summary + 1),
    }, null, actor)).rejects.toMatchObject({
      name: 'AgentProfileError', field: 'role_summary',
    });
    expect(await profiles.readWithPresence('Isa', 'salva')).toMatchObject({
      exists: false, revision: null, applied_revision: null,
    });
  });

  it('el snapshot muestra la proyección, pero borrar el agente no puede hacer cascade del perfil', async () => {
    const desired = await profiles.replace({
      tenant_id: 'Isa', alias: 'salva', role_summary: 'Operación de Isa.',
    }, null, actor);
    await profiles.markApplied('Isa', 'salva', desired.revision, actor);
    const snapshot = await repository.getConfiguration('Steven', 'kant');
    expect(snapshot.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 'Isa', alias: 'salva', role_brief: 'Operación de Isa.' }),
    ]));

    const revision = Number(snapshot.revision);
    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'agent', action: 'delete', tenant_id: 'Isa', alias: 'salva',
    }, false, revision)).rejects.toMatchObject({ code: 'conflict' });
    expect(await profiles.readWithPresence('Isa', 'salva')).toMatchObject({ exists: true });
  });

  it('una escritura SQL legacy se traduce al perfil desired, sin fingir applied_revision', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='Compatibilidad de rollback.'
        WHERE tenant_id='Isa' AND alias='salva'`,
    );
    expect(await profiles.readWithPresence('Isa', 'salva')).toMatchObject({
      exists: true,
      perfil: { role_summary: 'Compatibilidad de rollback.' },
      applied_revision: null,
    });
  });

  it('el recorte de compatibilidad no parte un par suplente', () => {
    const clamped = clampToRoleBriefLimit(`${'x'.repeat(1_199)}🎉detalle`);
    expect(countCodePoints(clamped)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(clamped.endsWith('🎉')).toBe(true);
    expect(() => Buffer.from(clamped, 'utf8').toString('utf8')).not.toThrow();
  });

  it('los rechazos genéricos se traducen a StoreError estable', async () => {
    const mutation = {
      resource: 'agent_profile', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { purpose: 'duplicado' },
    } as unknown as ConfigMutation;
    const error = await repository.applyConfigurationChange(
      'Steven', 'kant', mutation, true, 1,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ code: 'invalid_input' });
  });
});
