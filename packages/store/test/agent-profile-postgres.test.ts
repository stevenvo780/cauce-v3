import { preparePostgresSuite } from './postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireValue } from './helpers.js';
import { AGENT_PROFILE_LIMITS, countCodePoints } from '@cauce/protocol';
import { AgentProfileRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Validation of agent profiles in PostgreSQL:
 *
 * Guarantees consistency in string-length measurement units between the database and the
 * TypeScript normalization (`normalizeAgentProfile`).
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: AgentProfileRepository;

/** An emoji outside the BMP: 1 code point for `char_length`, 2 units for `String.length`. */
const ASTRAL = '\u{1F389}';
const ACTOR = { tenant_id: 'Steven', alias: 'kant' } as const;

async function seedAgent(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,display_name,enabled,
       container_name,runtime_user,home_directory,state_directory
     ) VALUES ('Steven',$1,'claude',$2,true,$3,'dev','/home/dev','/home/dev/.cauce')
     ON CONFLICT (tenant_id,alias) DO NOTHING`,
    [alias, alias, `ws-${alias}`]
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new AgentProfileRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await seedAgent('zeus');
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('cauce_utf16_units: the database counts the SAME as Node\'s String.length', () => {

  /**
   * NEGATIVE CONTROL on the unit: `char_length` does not match `cauce_utf16_units` outside the BMP.
   */
  it('control negativo: char_length y cauce_utf16_units DIFIEREN fuera del BMP', async () => {
    const texto = ASTRAL.repeat(10);
    const medida = await pool.query<{ puntos: number; unidades: number }>(
      'SELECT char_length($1) AS puntos, cauce_utf16_units($1) AS unidades', [texto]
    );
    expect(medida.rows[0]?.puntos).toBe(10);
    expect(medida.rows[0]?.unidades).toBe(20);
    expect(medida.rows[0]?.puntos).not.toBe(medida.rows[0]?.unidades);
    expect(countCodePoints(texto)).toBe(10);
  });
});

describe('the database CHECKs reject the same things as the TypeScript guard', () => {

  it('rechaza el perfil que pasa el presupuesto TOTAL aunque cada campo entre solo', async () => {
    const relleno = Array.from({ length: AGENT_PROFILE_LIMITS.items }, () =>
      'a'.repeat(AGENT_PROFILE_LIMITS.item));
    await expect(pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,responsibilities,restrictions,tools,operating_rules)
       VALUES ('Steven','zeus',$1,$1,$1,$1)`, [relleno]
    )).rejects.toMatchObject({ constraint: 'agent_profiles_budget' });
  });
});

describe('AgentProfileRepository', () => {

  it('reemplaza y relee un perfil completo, campo por campo', async () => {
    const escrito = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus',
      purpose: 'Orquestar la flota y reparar Cauce.',
      role_summary: 'Médico de la flota.',
      responsibilities: ['Diagnosticar fallos de entrega.', 'Reparar sin esperar a un humano.'],
      restrictions: ['Nunca tocar credenciales.'],
      tools: ['cauce', 'ssh'],
      operating_rules: ['Comprobar el efecto, nunca el nombre.']
    }, null, ACTOR);
    expect(escrito.perfil.purpose).toBe('Orquestar la flota y reparar Cauce.');
    const leido = await repository.read('Steven', 'zeus');
    expect(leido).toEqual(escrito.perfil);
  });

  it('dos editores del mismo perfil no se pisan y la revisión es propia', async () => {
    const creado = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'Uno.',
    }, null, ACTOR);
    expect(creado).toMatchObject({ revision: 1, applied_revision: null });

    const [uno, dos] = await Promise.allSettled([
      repository.replace({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Dos.' }, 1, ACTOR),
      repository.replace({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Tres.' }, 1, ACTOR),
    ]);
    expect([uno, dos].filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rechazado = [uno, dos].find((outcome) => outcome.status === 'rejected');
    expect(rechazado).toMatchObject({
      status: 'rejected', reason: { name: 'AgentProfileMutationError', code: 'conflict' },
    });
    expect(await repository.readWithPresence('Steven', 'zeus')).toMatchObject({
      revision: 2, applied_revision: null,
    });
  });

  it('si falla la auditoría, el desired y su revisión hacen rollback en la misma transacción', async () => {
    await database.adminPool.query(`
      CREATE OR REPLACE FUNCTION cauce_test_reject_profile_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action='agent_profile.desired' THEN
          RAISE EXCEPTION 'audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER cauce_test_reject_profile_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION cauce_test_reject_profile_audit();
    `);
    try {
      await expect(repository.replace({
        tenant_id: 'Steven', alias: 'zeus', purpose: 'No queda parcialmente guardado.',
      }, null, ACTOR)).rejects.toThrow('audit unavailable');
    } finally {
      await database.adminPool.query(`
        DROP TRIGGER IF EXISTS cauce_test_reject_profile_audit ON audit_events;
        DROP FUNCTION IF EXISTS cauce_test_reject_profile_audit();
      `);
    }

    expect(await repository.readWithPresence('Steven', 'zeus')).toMatchObject({
      exists: false, revision: null, applied_revision: null,
    });
  });

  it('un ACK viejo se conserva como aplicado conocido sin afirmar la revisión desired nueva', async () => {
    const creado = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'Uno.',
    }, null, ACTOR);
    const nuevo = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'Dos.',
    }, creado.revision, ACTOR);
    const trasAckViejo = await repository.markApplied('Steven', 'zeus', creado.revision, ACTOR);
    expect(trasAckViejo).toMatchObject({
      revision: nuevo.revision, applied_revision: creado.revision,
    });
  });

  it('proyecta role_summary a role_brief, pero conserva entero el rol rico canónico', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='El rol de siempre.' WHERE tenant_id='Steven' AND alias='zeus'`
    );
    const rico = `${'x'.repeat(1_199)}${ASTRAL}${'detalle'.repeat(20)}`;
    const existente = await repository.readWithPresence('Steven', 'zeus');
    await repository.replace(
      { tenant_id: 'Steven', alias: 'zeus', role_summary: rico }, existente.revision, ACTOR,
    );
    const brief = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect(Array.from(requireValue(brief.rows[0], 'brief.rows').role_brief)).toHaveLength(1_200);
    expect(brief.rows[0]?.role_brief.endsWith(ASTRAL)).toBe(true);
    expect((await repository.read('Steven', 'zeus')).role_summary).toBe(rico);
  });

  it('traduce una escritura legacy de role_brief al perfil canónico en la misma transacción', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='Compatibilidad explícita.'
        WHERE tenant_id='Steven' AND alias='zeus'`
    );

    expect(await repository.readWithPresence('Steven', 'zeus')).toMatchObject({
      exists: true,
      perfil: { tenant_id: 'Steven', alias: 'zeus', role_summary: 'Compatibilidad explícita.' },
    });
  });

});

/**
 * THE DERIVED FACTS: permissions, quotas, harness, and destinations.
 *
 * They are intentionally NOT stored in `agent_profiles`, so the only way to verify them is
 * against the real tables. What these tests pin down is that they are read FRESH: revoking a
 * permission in `role_policies` must change the generated file, without touching the profile.
 */
describe('derived facts of the alias', () => {
  async function darSala(alias: string, role: string, room = 'grp.steven'): Promise<void> {
    await pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
       VALUES ('Steven',$1,$2,$3,true)
       ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET role=EXCLUDED.role,enabled=true`,
      [room, alias, role]
    );
  }

  beforeEach(async () => {
    await pool.query(`DELETE FROM memberships WHERE alias IN ('zeus','vecino')`);
  });

  /*
   * A DEDICATED role is created instead of using `operator`. Not ceremony: `role_policies` is a
   * catalog table that `resetTestDatabase()` does NOT truncate — measured: migration 003 seeds
   * `operator(route,read,control)` and the shared DB arrives with all three false. Relying on
   * that measures another's residue.
   */
  it('los permisos son la UNIÓN de todas las salas del alias, no la de una', async () => {
    await pool.query(
      `INSERT INTO rooms(id,tenant_id,enabled) VALUES ('grp.steven2','Steven',true)
       ON CONFLICT DO NOTHING`
    );
    await database.adminPool.query(
      `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
       VALUES ('perfil_ctl',false,false,true,false)
       ON CONFLICT (role) DO UPDATE SET allow_control=true`
    );
    await darSala('zeus', 'agent');
    await darSala('zeus', 'perfil_ctl', 'grp.steven2');
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.permisos.ruta).toBe(true);
    expect(hechos.permisos.control).toBe(true);
  });

  it('las cuotas salen del binding, pasando por el techo de ruteo', async () => {
    await darSala('zeus', 'agent');
    await pool.query(
      `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
         credential_ref_kind,credential_ref,enabled)
       VALUES ('steven-max','claude','acc-1','Steven','Max de Steven','env_path',
         'CAUCE_CLAUDE_TOKEN_PATH',true)`
    );
    await pool.query(
      `INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
       VALUES ('Steven','zeus','steven-max','Steven','Steven')`
    );
    await pool.query(
      `INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
       VALUES ('Steven','zeus','steven-max',10,true)`
    );
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.cuotas).toHaveLength(1);
    expect(hechos.cuotas[0]?.proveedor).toBe('claude');
    expect(hechos.cuotas[0]?.cuenta).toBe('steven-max');
  });

  /**
   * NEGATIVE CONTROL — and the most important one: the profile is written to a file INSIDE the
   * container and shown to the model. Any credential locator that leaks here ends up in the LLM
   * context and in transcripts. Its absence is not asserted by reading the code: it is measured
   * against the whole object, serialized.
   */
  it('control negativo: NINGÚN localizador de credencial sale en los hechos', async () => {
    await darSala('zeus', 'agent');
    await pool.query(
      `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
         credential_ref_kind,credential_ref,enabled)
       VALUES ('steven-max','claude','acc-1','Steven','Max','env_path','CAUCE_CLAUDE_TOKEN_PATH',true)`
    );
    await pool.query(
      `INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
       VALUES ('Steven','zeus','steven-max','Steven','Steven')`
    );
    await pool.query(
      `INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,enabled)
       VALUES ('Steven','zeus','steven-max',true)`
    );
    const contexto = await repository.readContext('Steven', 'zeus');
    const serializado = JSON.stringify(contexto);
    expect(serializado).not.toContain('CAUCE_CLAUDE_TOKEN_PATH');
    expect(serializado).not.toContain('credential_ref');
    expect(serializado).not.toContain('env_path');
    expect(serializado).not.toContain('acc-1');
  });

  it('devuelve el perfil autorado junto a los hechos, en un solo objeto', async () => {
    await darSala('zeus', 'agent');
    await repository.replace(
      { tenant_id: 'Steven', alias: 'zeus', purpose: 'Orquestar.' }, null, ACTOR,
    );
    const contexto = await repository.readContext('Steven', 'zeus');
    expect(contexto.perfil.purpose).toBe('Orquestar.');
    expect(contexto.hechos.permisos.ruta).toBe(true);
  });
});
