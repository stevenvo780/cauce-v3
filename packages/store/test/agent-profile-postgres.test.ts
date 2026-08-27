import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_PROFILE_LIMITS, countCodePoints, measureStrictestUnits } from '@cauce/protocol';
import { AgentProfileRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Validación de perfiles de agente en PostgreSQL:
 *
 * Garantiza consistencia en unidades de medición de longitud de cadenas
 * entre la base de datos y la normalización en TypeScript (`normalizeAgentProfile`).
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: AgentProfileRepository;

/** Un emoji fuera del BMP: 1 punto de código para `char_length`, 2 unidades para `String.length`. */
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

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new AgentProfileRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await seedAgent('zeus');
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('la migración 026 está aplicada de verdad', () => {
  it('creó la tabla, la clave primaria y la clave foránea a agents', async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_name='agent_profiles' ORDER BY ordinal_position`
    );
    /*
     * La lista es ORDENADA y EXACTA a propósito: una columna que se añada sin tocar el compilador
     * es un campo editable sin lector, que es el defecto que toda esta tabla vino a cerrar.
     *
     * `human_brief` va en la posición 7 —entre `restrictions` y `tools`— porque ahí la puso la
     * 026: el orden de las columnas cuenta el orden de LECTURA del fichero (quién sos, qué te
     * toca, con quién tratás, con qué contás), y `USER.md` de openclaw se lee después del rol.
     */
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'tenant_id', 'alias', 'purpose', 'role_summary', 'responsibilities',
      'restrictions', 'human_brief', 'tools', 'operating_rules', 'created_at', 'updated_at',
      'revision', 'applied_revision'
    ]);
    const fk = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
       WHERE conrelid='agent_profiles'::regclass AND contype='f'`
    );
    expect(Number(fk.rows[0]?.count)).toBe(1);
  });

  it('quedó anotada en schema_migrations', async () => {
    const applied = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version='026_agent_profile.sql') AS exists`
    );
    expect(applied.rows[0]?.exists).toBe(true);
  });
});

describe('cauce_utf16_units: la base cuenta lo MISMO que String.length de Node', () => {
  it.each([
    'abc', 'ñañ', ASTRAL, `a${ASTRAL}b`, ASTRAL.repeat(37), 'sin nada raro', '👨‍👩‍👧‍👦'
  ])('coincide sobre %j', async (texto) => {
    const medida = await pool.query<{ units: number }>(
      'SELECT cauce_utf16_units($1) AS units', [texto]
    );
    expect(medida.rows[0]?.units).toBe(texto.length);
    expect(medida.rows[0]?.units).toBe(measureStrictestUnits(texto));
  });

  /**
   * CONTROL NEGATIVO de la unidad: `char_length` no coincide con `cauce_utf16_units` fuera del BMP.
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

describe('los CHECK de la base rechazan lo mismo que la guarda de TypeScript', () => {
  async function insertRaw(column: string, value: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,${column}) VALUES ('Steven','zeus',$1)`,
      [value]
    );
  }

  it('rechaza un propósito por encima del tope, contado en unidades UTF-16', async () => {
    await expect(insertRaw('purpose', 'a'.repeat(AGENT_PROFILE_LIMITS.purpose + 1)))
      .rejects.toMatchObject({ constraint: 'agent_profiles_purpose_len' });
  });

  /** CONTROL NEGATIVO: exactamente en el tope, la base lo acepta. */
  it('control negativo: un propósito EXACTAMENTE en el tope entra', async () => {
    await insertRaw('purpose', 'a'.repeat(AGENT_PROFILE_LIMITS.purpose));
    const stored = await pool.query<{ purpose: string }>(
      `SELECT purpose FROM agent_profiles WHERE alias='zeus'`
    );
    expect(stored.rows[0]?.purpose).toHaveLength(AGENT_PROFILE_LIMITS.purpose);
  });

  /**
   * EL CASO QUE DEJÓ SORDO A UN ALIAS, ahora del lado correcto: un texto de 2.000 PUNTOS DE
   * CÓDIGO en emojis mide 4.000 unidades UTF-16. Un CHECK escrito con `char_length` lo aceptaría.
   */
  it('rechaza un propósito que cabe en puntos de código pero NO en unidades UTF-16', async () => {
    const texto = ASTRAL.repeat(AGENT_PROFILE_LIMITS.purpose);
    expect(countCodePoints(texto)).toBe(AGENT_PROFILE_LIMITS.purpose);
    const puntos = await pool.query<{ puntos: number }>('SELECT char_length($1) AS puntos', [texto]);
    expect(puntos.rows[0]?.puntos).toBe(AGENT_PROFILE_LIMITS.purpose);
    await expect(insertRaw('purpose', texto))
      .rejects.toMatchObject({ constraint: 'agent_profiles_purpose_len' });
  });

  it('rechaza un elemento de lista por encima del tope por elemento', async () => {
    await expect(insertRaw('tools', ['ok', 'a'.repeat(AGENT_PROFILE_LIMITS.item + 1)]))
      .rejects.toMatchObject({ constraint: 'agent_profiles_tools_items' });
  });

  /** CONTROL NEGATIVO del tope por elemento. */
  it('control negativo: un elemento EXACTAMENTE en el tope entra', async () => {
    await insertRaw('tools', ['a'.repeat(AGENT_PROFILE_LIMITS.item)]);
    const stored = await pool.query<{ tools: string[] }>(
      `SELECT tools FROM agent_profiles WHERE alias='zeus'`
    );
    expect(stored.rows[0]?.tools[0]).toHaveLength(AGENT_PROFILE_LIMITS.item);
  });

  it('rechaza un elemento en blanco, que en un fichero sería una viñeta vacía', async () => {
    await expect(insertRaw('tools', ['ok', '   ']))
      .rejects.toMatchObject({ constraint: 'agent_profiles_tools_items' });
  });

  it('rechaza una lista con más elementos de los admitidos', async () => {
    const muchos = Array.from({ length: AGENT_PROFILE_LIMITS.items + 1 }, (_, i) => `t${i}`);
    await expect(insertRaw('tools', muchos))
      .rejects.toMatchObject({ constraint: 'agent_profiles_tools_count' });
  });

  /** CONTROL NEGATIVO de la cardinalidad. */
  it('control negativo: EXACTAMENTE el número de elementos admitido entra', async () => {
    const justos = Array.from({ length: AGENT_PROFILE_LIMITS.items }, (_, i) => `t${i}`);
    await insertRaw('tools', justos);
    const stored = await pool.query<{ tools: string[] }>(
      `SELECT tools FROM agent_profiles WHERE alias='zeus'`
    );
    expect(stored.rows[0]?.tools).toHaveLength(AGENT_PROFILE_LIMITS.items);
  });

  it('rechaza el perfil que pasa el presupuesto TOTAL aunque cada campo entre solo', async () => {
    const relleno = Array.from({ length: AGENT_PROFILE_LIMITS.items }, () =>
      'a'.repeat(AGENT_PROFILE_LIMITS.item));
    await expect(pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,responsibilities,restrictions,tools,operating_rules)
       VALUES ('Steven','zeus',$1,$1,$1,$1)`, [relleno]
    )).rejects.toMatchObject({ constraint: 'agent_profiles_budget' });
  });

  /** CONTROL NEGATIVO del presupuesto total: justo en el presupuesto entra. */
  it('control negativo: un perfil EXACTAMENTE en el presupuesto total entra', async () => {
    const cuantos = AGENT_PROFILE_LIMITS.total / AGENT_PROFILE_LIMITS.item;
    const relleno = Array.from({ length: cuantos }, () => 'a'.repeat(AGENT_PROFILE_LIMITS.item));
    await insertRaw('responsibilities', relleno);
    const stored = await pool.query<{ responsibilities: string[] }>(
      `SELECT responsibilities FROM agent_profiles WHERE alias='zeus'`
    );
    expect(stored.rows[0]?.responsibilities).toHaveLength(cuantos);
  });

  it('borrar el alias se lleva su perfil: es configuración, no es prueba', async () => {
    await insertRaw('purpose', 'Orquestar.');
    await pool.query(`DELETE FROM agents WHERE tenant_id='Steven' AND alias='zeus'`);
    const left = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profiles WHERE alias='zeus'`
    );
    expect(Number(left.rows[0]?.count)).toBe(0);
  });

  it('no admite un perfil de un alias que no existe', async () => {
    await expect(pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,purpose) VALUES ('Steven','fantasma','x')`
    )).rejects.toMatchObject({ code: '23503' });
  });
});

describe('AgentProfileRepository', () => {
  it('devuelve un perfil vacío para un alias sin fila, en vez de fallar', async () => {
    const perfil = await repository.read('Steven', 'zeus');
    expect(perfil.alias).toBe('zeus');
    expect(perfil.purpose).toBeNull();
    expect(perfil.responsibilities).toEqual([]);
  });

  it('escribe y relee un perfil completo, campo por campo', async () => {
    const escrito = await repository.write({
      tenant_id: 'Steven', alias: 'zeus',
      purpose: 'Orquestar la flota y reparar Cauce.',
      role_summary: 'Médico de la flota.',
      responsibilities: ['Diagnosticar fallos de entrega.', 'Reparar sin esperar a un humano.'],
      restrictions: ['Nunca tocar credenciales.'],
      tools: ['cauce', 'ssh'],
      operating_rules: ['Comprobar el efecto, nunca el nombre.']
    });
    expect(escrito.purpose).toBe('Orquestar la flota y reparar Cauce.');
    const leido = await repository.read('Steven', 'zeus');
    expect(leido).toEqual(escrito);
  });

  it('escribir dos veces actualiza en vez de duplicar', async () => {
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Uno.' });
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Dos.' });
    const filas = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profiles WHERE alias='zeus'`
    );
    expect(Number(filas.rows[0]?.count)).toBe(1);
    expect((await repository.read('Steven', 'zeus')).purpose).toBe('Dos.');
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

  it('reintentar el mismo desired pendiente es idempotente y luego acredita esa revisión', async () => {
    const creado = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'Pendiente.',
    }, null, ACTOR);
    const repetido = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'Pendiente.',
    }, creado.revision, ACTOR);
    expect(repetido.revision).toBe(creado.revision);
    expect(repetido.applied_revision).toBeNull();

    const aplicado = await repository.markApplied('Steven', 'zeus', repetido.revision, ACTOR);
    expect(aplicado.applied_revision).toBe(repetido.revision);
  });

  it('audita desired y applied sin persistir el cuerpo autorado del perfil', async () => {
    const creado = await repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'CUERPO-QUE-NO-VA-AL-AUDIT.',
      responsibilities: ['OTRO-CUERPO-SENSIBLE.'],
    }, null, ACTOR);
    await repository.markApplied('Steven', 'zeus', creado.revision, ACTOR);

    const auditoria = await pool.query<{
      tenant_id: string;
      actor_alias: string;
      action: string;
      decision: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT tenant_id,actor_alias,action,decision,metadata
         FROM audit_events
        WHERE action IN ('agent_profile.desired','agent_profile.applied')
        ORDER BY id`,
    );
    expect(auditoria.rows).toEqual([
      {
        tenant_id: 'Steven', actor_alias: 'kant', action: 'agent_profile.desired', decision: 'allow',
        metadata: {
          target_tenant: 'Steven', target_alias: 'zeus', expected_revision: null,
          desired_revision: creado.revision, applied_revision: null,
        },
      },
      {
        tenant_id: 'Steven', actor_alias: 'kant', action: 'agent_profile.applied', decision: 'allow',
        metadata: {
          target_tenant: 'Steven', target_alias: 'zeus', applied_revision: creado.revision,
          desired_revision: creado.revision, converged: true,
        },
      },
    ]);
    const serializado = JSON.stringify(auditoria.rows);
    expect(serializado).not.toContain('CUERPO-QUE-NO-VA-AL-AUDIT');
    expect(serializado).not.toContain('OTRO-CUERPO-SENSIBLE');
  });

  it('si falla la auditoría, el desired y su revisión hacen rollback en la misma transacción', async () => {
    await pool.query(`
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
      await pool.query(`
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

  it('replace falla cerrado para un alias apagado', async () => {
    await pool.query(
      `UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='zeus'`,
    );
    await expect(repository.replace({
      tenant_id: 'Steven', alias: 'zeus', purpose: 'No debe entrar.',
    }, null, ACTOR)).rejects.toMatchObject({
      name: 'AgentProfileMutationError', code: 'disabled',
    });
  });

  it('rechaza en TypeScript, antes de tocar la base, lo mismo que rechaza el CHECK', async () => {
    await expect(repository.write({
      tenant_id: 'Steven', alias: 'zeus', purpose: ASTRAL.repeat(AGENT_PROFILE_LIMITS.purpose)
    })).rejects.toMatchObject({ name: 'AgentProfileError', field: 'purpose' });
    const filas = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profiles WHERE alias='zeus'`
    );
    expect(Number(filas.rows[0]?.count)).toBe(0);
  });

  it('proyecta role_summary a role_brief, pero conserva entero el rol rico canónico', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='El rol de siempre.' WHERE tenant_id='Steven' AND alias='zeus'`
    );
    const rico = `${'x'.repeat(1_199)}${ASTRAL}${'detalle'.repeat(20)}`;
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', role_summary: rico });
    const brief = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect([...brief.rows[0]!.role_brief]).toHaveLength(1_200);
    expect(brief.rows[0]?.role_brief.endsWith(ASTRAL)).toBe(true);
    expect((await repository.read('Steven', 'zeus')).role_summary).toBe(rico);
  });

  it('borrar el perfil borra también la proyección legacy para no revivir identidad vieja', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='Sigo acá.' WHERE tenant_id='Steven' AND alias='zeus'`
    );
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Orquestar.' });
    expect(await repository.remove('Steven', 'zeus')).toBe(true);
    expect((await repository.read('Steven', 'zeus')).purpose).toBeNull();
    const brief = await pool.query<{ role_brief: string | null }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect(brief.rows[0]?.role_brief).toBeNull();
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

  /** CONTROL NEGATIVO de `remove`: borrar lo que no existe informa `false`, no miente `true`. */
  it('control negativo: borrar un perfil que no existe devuelve false', async () => {
    expect(await repository.remove('Steven', 'zeus')).toBe(false);
  });
});

/**
 * LOS HECHOS DERIVADOS: permisos, cuotas, arnés y destinos.
 *
 * No se guardan en `agent_profiles` a propósito, así que la única forma de comprobarlos es contra
 * las tablas de verdad. Lo que estas pruebas fijan es que se leen FRESCOS: revocar un permiso en
 * `role_policies` tiene que cambiar el fichero que se genere después, sin tocar el perfil.
 */
describe('hechos derivados del alias', () => {
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
   * Se crea un rol PROPIO en vez de usar `operator`. No es ceremonia: `role_policies` es una tabla
   * de catálogo que `resetTestDatabase()` NO trunca, así que sus valores son los que haya dejado la
   * última suite que los tocara — medido: la 003 siembra `operator(route,read,control)` y en la base
   * compartida llega con los tres en falso. Una prueba que dependa de eso mide el residuo de otra.
   */
  it('los permisos son la UNIÓN de todas las salas del alias, no la de una', async () => {
    await pool.query(
      `INSERT INTO rooms(id,tenant_id,enabled) VALUES ('grp.steven2','Steven',true)
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
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

  /** CONTROL NEGATIVO: una membresía DESHABILITADA no puede conceder nada. */
  it('control negativo: una membresía deshabilitada no concede permiso', async () => {
    await darSala('zeus', 'agent');
    await pool.query(`UPDATE memberships SET enabled=false WHERE alias='zeus'`);
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.permisos.control).toBe(false);
    expect(hechos.permisos.ruta).toBe(false);
  });

  it('un registro de agente disabled conserva contexto legible pero todos sus poderes son NO', async () => {
    await darSala('zeus', 'agent');
    await pool.query(
      `UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='zeus'`
    );

    const lectura = await repository.readContextWithPresence('Steven', 'zeus');

    expect(lectura.agent_enabled).toBe(false);
    expect(lectura.contexto.hechos.permisos).toEqual({
      ruta: false, lectura: false, control: false, notificacion: false,
    });
    expect(lectura.contexto.hechos.destinos).toEqual([]);
  });

  it('notificar exige rol Y destino aprobado: con rol pero sin destino es NO', async () => {
    // `agent_notify` NO lo siembra ninguna migración: la 009 sólo lo NOMBRA en un comentario, como
    // el rol que un operador crearía. En la base compartida existía porque lo dejó otra suite, y
    // dar eso por supuesto es medir el residuo ajeno — en una base limpia la FK lo rechaza.
    await pool.query(
      `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
       VALUES ('perfil_notify',true,true,false,true)
       ON CONFLICT (role) DO UPDATE SET allow_notify=true`
    );
    await darSala('zeus', 'perfil_notify');
    const sinDestino = await repository.readContext('Steven', 'zeus');
    expect(sinDestino.hechos.permisos.notificacion).toBe(false);

    await pool.query(
      `INSERT INTO egress_destinations(tenant_id,alias,handle,conversation_id,conversation_kind,allow_kinds,enabled)
       VALUES ('Steven','zeus','steven_dm','12345','dm',ARRAY['alert']::text[],true)`
    );
    const conDestino = await repository.readContext('Steven', 'zeus');
    expect(conDestino.hechos.permisos.notificacion).toBe(true);
  });

  /** CONTROL NEGATIVO simétrico: con destino pero sin el permiso del rol, tambien es NO. */
  it('control negativo: con destino pero sin allow_notify en el rol, es NO', async () => {
    await darSala('zeus', 'agent');
    await pool.query(
      `INSERT INTO egress_destinations(tenant_id,alias,handle,conversation_id,conversation_kind,allow_kinds,enabled)
       VALUES ('Steven','zeus','steven_dm','12345','dm',ARRAY['alert']::text[],true)`
    );
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.permisos.notificacion).toBe(false);
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
   * CONTROL NEGATIVO Y EL QUE MÁS IMPORTA: el perfil se escribe en un fichero DENTRO del
   * contenedor y se le enseña al modelo. Un localizador de credencial que entre acá termina en el
   * contexto de un LLM y en los transcripts. Que no esté no se afirma leyendo el código: se mide
   * sobre el objeto entero, serializado.
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

  it('el arnés sale de agents + harness_definitions, con sus capacidades', async () => {
    await darSala('zeus', 'agent');
    await pool.query(
      `UPDATE agents SET harness_id='claude',container_name='claw-zeus',runtime_user='dev',
         home_directory='/home/dev',state_directory='/var/lib/zeus'
       WHERE tenant_id='Steven' AND alias='zeus'`
    );
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.arnes.harness).toBe('claude');
    expect(hechos.arnes.home).toBe('/home/dev');
    expect(hechos.arnes.contenedor).toBe('claw-zeus');
    expect(hechos.arnes.capacidades).toContain('messages.receive');
  });

  it('los destinos son los alias alcanzables y NUNCA incluyen al propio alias', async () => {
    await darSala('zeus', 'agent');
    await darSala('vecino', 'agent');
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.destinos).toContain('vecino');
    expect(hechos.destinos).not.toContain('zeus');
  });

  it('devuelve el perfil autorado junto a los hechos, en un solo objeto', async () => {
    await darSala('zeus', 'agent');
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Orquestar.' });
    const contexto = await repository.readContext('Steven', 'zeus');
    expect(contexto.perfil.purpose).toBe('Orquestar.');
    expect(contexto.hechos.permisos.ruta).toBe(true);
  });

  it('un alias sin nada configurado devuelve hechos vacíos, no un fallo', async () => {
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.permisos).toEqual({ ruta: false, lectura: false, control: false, notificacion: false });
    expect(hechos.cuotas).toEqual([]);
    expect(hechos.destinos).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO del acoplamiento entre ruta y destinos, que descubrió esta prueba: sin permiso
   * de ruta la lista TIENE que venir vacía. La consulta de ACL responde «quién es alcanzable» sin
   * mirar si el que pregunta puede rutear, así que un alias sin permiso veía la flota entera. Un
   * agente al que se le enseñan doce destinos que no puede usar, los intenta — y gasta el turno en
   * una entrega que la base rechaza.
   */
  it('control negativo: sin permiso de ruta la lista de destinos viene vacía', async () => {
    await pool.query(
      `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
       VALUES ('perfil_sin_ruta',false,true,false,false)
       ON CONFLICT (role) DO UPDATE SET allow_route=false`
    );
    await darSala('zeus', 'perfil_sin_ruta');
    const { hechos } = await repository.readContext('Steven', 'zeus');
    expect(hechos.permisos.ruta).toBe(false);
    expect(hechos.destinos).toEqual([]);

    await darSala('zeus', 'agent');
    const conRuta = await repository.readContext('Steven', 'zeus');
    expect(conRuta.hechos.permisos.ruta).toBe(true);
    expect(conRuta.hechos.destinos.length).toBeGreaterThan(0);
  });
});
