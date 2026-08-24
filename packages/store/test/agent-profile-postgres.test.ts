import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_PROFILE_LIMITS, countCodePoints, measureStrictestUnits } from '@cauce/protocol';
import { AgentProfileRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * EL PERFIL POR ALIAS, CONTRA POSTGRES DE VERDAD (migración 026).
 *
 * Lo que se comprueba acá no se puede comprobar en TypeScript: que la BASE rechaza lo mismo que
 * rechaza `normalizeAgentProfile`, y en la MISMA unidad. El 16-ago un alias se quedó sordo porque
 * las dos capas medían el mismo número en unidades distintas y nadie tenía una prueba que las
 * enfrentara. Ésta las enfrenta: los mismos textos, contra las dos guardas.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: AgentProfileRepository;

/** Un emoji fuera del BMP: 1 punto de código para `char_length`, 2 unidades para `String.length`. */
const ASTRAL = '\u{1F389}';

async function seedAgent(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled)
     VALUES ('Steven',$1,'claude',$2,false)
     ON CONFLICT (tenant_id,alias) DO NOTHING`,
    [alias, alias]
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
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'tenant_id', 'alias', 'purpose', 'role_summary', 'responsibilities',
      'restrictions', 'tools', 'operating_rules', 'created_at', 'updated_at'
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
   * CONTROL NEGATIVO de la unidad: `char_length` NO coincide con `String.length` fuera del BMP.
   * Si este test se pone verde en las dos columnas, la función está midiendo puntos de código y la
   * grieta del 16-ago volvió a abrirse.
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

  it('rechaza en TypeScript, antes de tocar la base, lo mismo que rechaza el CHECK', async () => {
    await expect(repository.write({
      tenant_id: 'Steven', alias: 'zeus', purpose: ASTRAL.repeat(AGENT_PROFILE_LIMITS.purpose)
    })).rejects.toMatchObject({ name: 'AgentProfileError', field: 'purpose' });
    const filas = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profiles WHERE alias='zeus'`
    );
    expect(Number(filas.rows[0]?.count)).toBe(0);
  });

  it('convive con role_brief: escribir el perfil no lo toca', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='El rol de siempre.' WHERE tenant_id='Steven' AND alias='zeus'`
    );
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', role_summary: 'El rol nuevo.' });
    const brief = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect(brief.rows[0]?.role_brief).toBe('El rol de siempre.');
    expect((await repository.read('Steven', 'zeus')).role_summary).toBe('El rol nuevo.');
  });

  it('borrar el perfil lo deja vacío pero conserva el alias y su role_brief', async () => {
    await pool.query(
      `UPDATE agents SET role_brief='Sigo acá.' WHERE tenant_id='Steven' AND alias='zeus'`
    );
    await repository.write({ tenant_id: 'Steven', alias: 'zeus', purpose: 'Orquestar.' });
    expect(await repository.remove('Steven', 'zeus')).toBe(true);
    expect((await repository.read('Steven', 'zeus')).purpose).toBeNull();
    const brief = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect(brief.rows[0]?.role_brief).toBe('Sigo acá.');
  });

  /** CONTROL NEGATIVO de `remove`: borrar lo que no existe informa `false`, no miente `true`. */
  it('control negativo: borrar un perfil que no existe devuelve false', async () => {
    expect(await repository.remove('Steven', 'zeus')).toBe(false);
  });
});
