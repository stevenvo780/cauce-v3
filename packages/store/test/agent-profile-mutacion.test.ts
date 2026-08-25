import { describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { ConfigurationError, ConfigurationRepository } from '../src/configuration.js';
import type { DatabasePool } from '../src/db.js';

/**
 * LAS GUARDAS DEL PERFIL, MEDIDAS POR EL SQL QUE DE VERDAD SE EJECUTA.
 *
 * En este contenedor no hay demonio Docker ni Postgres, así que las pruebas de
 * `configuration-postgres.test.ts` no pueden correr. Eso NO es excusa para dar por buenas las
 * guardas leyendo el código: lo que se comprueba acá es el EFECTO —qué consultas salen, en qué
 * orden y con qué argumentos— contra un cliente falso que las registra. Una guarda que no se
 * ejecuta no aparece en esa lista, y eso es exactamente lo que hay que poder ver.
 *
 * Lo que estas pruebas NO acreditan, y hay que decirlo en vez de dejarlo implícito: que Postgres
 * acepte el SQL. Los CHECK de la migración 026, los tipos de las columnas y el `FOR UPDATE` real
 * sólo se prueban contra una base viva, y eso queda pendiente de un entorno con Docker.
 */

/** Una respuesta preparada para la consulta que la reclame. */
interface Respuesta {
  /** Trozo del SQL que identifica a la consulta. */
  readonly cuando: string;
  readonly filas: Record<string, unknown>[];
}

interface Registro {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function poolFalso(respuestas: readonly Respuesta[]): {
  pool: DatabasePool; ejecutadas: Registro[];
} {
  const ejecutadas: Registro[] = [];
  const cliente = {
    // `withTransaction` engancha y DESengancha un listener de error en el cliente prestado: sin
    // `off` el doble revienta con un TypeError que se parece a un fallo del código bajo prueba.
    on: () => undefined,
    off: () => undefined,
    async query(sql: string, params: readonly unknown[] = []) {
      ejecutadas.push({ sql, params });
      const normalizado = sql.replace(/\s+/g, ' ');
      const encontrada = respuestas.find((r) => normalizado.includes(r.cuando));
      return { rows: encontrada?.filas ?? [], rowCount: encontrada?.filas.length ?? 0 };
    },
    release: () => undefined
  };
  // `get()` consulta por el POOL y `apply()` por un cliente prestado: el doble tiene que servir las
  // dos vías o la lectura del snapshot revienta con un TypeError que no se parece a su causa.
  const pool = {
    connect: async () => cliente,
    query: cliente.query
  } as unknown as DatabasePool;
  return { pool, ejecutadas };
}

/** Las respuestas mínimas para que una mutación llegue hasta el final sin inventar nada. */
function respuestasBase(extra: readonly Respuesta[] = []): Respuesta[] {
  return [
    // assertControl: el actor tiene control y es del hub.
    { cuando: 'SELECT tenant.is_hub FROM memberships', filas: [{ is_hub: true }] },
    // lockRevision: la revisión actual de la configuración.
    { cuando: 'COALESCE(max(id),0)::text AS revision', filas: [{ revision: '7' }] },
    // El asiento de la revisión nueva.
    { cuando: 'INSERT INTO config_revisions', filas: [{ id: '8' }] },
    ...extra
  ];
}

const PERFIL_EXISTENTE = {
  tenant_id: 'Steven', alias: 'zeus',
  purpose: 'lo que habia antes',
  role_summary: 'medico',
  responsibilities: ['diagnosticar'],
  restrictions: ['no tocar credenciales'],
  tools: ['ssh'],
  operating_rules: ['persistir antes de narrar']
};

function sqls(ejecutadas: readonly Registro[]): string[] {
  return ejecutadas.map((r) => r.sql.replace(/\s+/g, ' ').trim());
}

describe('agent_profile como mutación de configuración', () => {
  it('escribe el perfil y deja asiento con su mutación INVERSA', async () => {
    const { pool, ejecutadas } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    const repo = new ConfigurationRepository(pool);
    const mutacion: ConfigMutation = {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'lo nuevo' }
    };

    const resultado = await repo.apply('Steven', 'zeus', mutacion, false, 7);

    expect(resultado.applied).toBe(true);
    expect(resultado.revision).toBe(8);
    // La INVERSA es lo único de lo que sale el botón de deshacer. Tiene que devolver el perfil
    // ENTERO de antes, no sólo el campo que se tocó: si sólo llevara `purpose`, deshacer dejaría
    // el resto del perfil como quedó y el texto anterior sería irrecuperable.
    expect(resultado.inverse_mutation).toEqual({
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: {
        purpose: 'lo que habia antes',
        role_summary: 'medico',
        responsibilities: ['diagnosticar'],
        restrictions: ['no tocar credenciales'],
        tools: ['ssh'],
        operating_rules: ['persistir antes de narrar']
      }
    });
    // Y el asiento en audit_events, que es lo que hace auditable un cambio de identidad.
    expect(sqls(ejecutadas).some((sql) => sql.includes('INSERT INTO audit_events'))).toBe(true);
  });

  /**
   * El SELECT previo tiene que llevar `FOR UPDATE` y TODAS las columnas.
   *
   * Las dos cosas por el mismo motivo, y es el que explica `agent()`: la inversa sale de lo que se
   * leyó, así que una columna que no se lee queda irrecuperable tras un rollback; y sin `FOR
   * UPDATE` dos operadores que guarden a la vez leen el mismo «antes» y el segundo fabrica una
   * inversa que restauraría un estado que ya no existió.
   */
  it('lee el perfil anterior con FOR UPDATE y todas sus columnas', async () => {
    const { pool, ejecutadas } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'lo nuevo' }
    }, false, 7);

    const lectura = sqls(ejecutadas).find((sql) => sql.includes('FROM agent_profiles'));
    expect(lectura).toBeDefined();
    expect(lectura).toContain('FOR UPDATE');
    for (const columna of [
      'purpose', 'role_summary', 'responsibilities', 'restrictions', 'tools', 'operating_rules'
    ]) {
      expect(lectura).toContain(columna);
    }
  });

  /**
   * Un campo AUSENTE se conserva; uno mandado se pisa. Es la misma regla que `agent()`.
   *
   * Sin esto, editar sólo `purpose` desde la pantalla borraría las cuatro listas — y el operador
   * vería «guardado» sobre un perfil que acaba de perder lo que no estaba mirando.
   */
  it('no pisa los campos que el operador no mandó', async () => {
    const { pool, ejecutadas } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'lo nuevo' }
    }, false, 7);

    const escritura = ejecutadas.find((r) => /INSERT INTO agent_profiles/i.test(r.sql));
    expect(escritura).toBeDefined();
    expect(escritura?.params).toContain('lo nuevo');
    // Lo que no se mandó viaja tal cual venía de la base.
    expect(escritura?.params).toContain('medico');
    expect(escritura?.params).toContainEqual(['diagnosticar']);
  });

  /**
   * BORRAR es explícito y su inversa REPONE el perfil entero.
   *
   * Un borrado sin inversa completa no se puede deshacer, y borrar el perfil de un alias es
   * exactamente el cambio que más falta hace poder revertir.
   */
  it('borra el perfil y su inversa lo repone entero', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    const resultado = await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'delete', tenant_id: 'Steven', alias: 'zeus'
    }, false, 7);

    expect(resultado.inverse_mutation).toMatchObject({
      resource: 'agent_profile', action: 'create', tenant_id: 'Steven', alias: 'zeus'
    });
    const inversa = resultado.inverse_mutation;
    if (inversa.resource !== 'agent_profile') throw new Error('la inversa cambió de recurso');
    expect(inversa.value?.role_summary).toBe('medico');
  });

  /**
   * «No hay» NO es «no se pudo mirar»: borrar un perfil que no existe es 404 y no un falso éxito.
   *
   * Es el defecto que la consola ya arregló y que no puede volver por acá. Un `delete` que
   * contesta «hecho» sobre un alias sin perfil le enseña al operador que borró algo.
   */
  it('borrar un perfil que no existe es not_found, no un exito silencioso', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [] }
    ]));
    await expect(new ConfigurationRepository(pool).apply('Steven', 'fantasma', {
      resource: 'agent_profile', action: 'delete', tenant_id: 'Steven', alias: 'fantasma'
    }, false, 7)).rejects.toMatchObject({ code: 'not_found' });
  });

  /** Crear dos veces choca, en vez de pisar en silencio el perfil que ya estaba. */
  it('crear sobre un perfil existente es conflict', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    await expect(new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'create', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'otro' }
    }, false, 7)).rejects.toMatchObject({ code: 'conflict' });
  });

  /**
   * EL BLOQUEO OPTIMISTA. Sin esto, dos operadores editando el mismo perfil se pisan y el segundo
   * gana sin enterarse de que había un primero.
   *
   * El literal del mensaje es CONTRATO: la consola reconoce el choque de revisión con la expresión
   * regular /revision changed: expected (\d+), current (\d+)/i, porque el 409 lo usa el gateway
   * para cualquier conflicto. Cambiar ese texto deja a la pantalla sin su explicación sin romper
   * ningún test de gateway — por eso se comprueba el TEXTO y no sólo el código.
   */
  it('rechaza con conflict cuando otro operador movió la revisión', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    await expect(new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'lo nuevo' }
    }, false, 3)).rejects.toThrow(/revision changed: expected 3, current 7/i);
  });

  /**
   * AISLAMIENTO ENTRE INQUILINOS. El perfil gobierna lo que el agente lee en cada turno: se queda
   * en la caída por defecto de `authorizeMutation`, o sea HUB-ONLY, igual que `agent`.
   *
   * Meterlo en la lista de los recursos «que tienen tenant_id» abriría la escritura del perfil a
   * cualquier operador de cualquier inquilino sobre su propio inquilino. `agent` está fuera de esa
   * lista A PROPÓSITO y el perfil tiene el mismo alcance.
   */
  it('un operador que no es del hub NO puede escribir un perfil, ni el suyo', async () => {
    const { pool } = poolFalso([
      { cuando: 'SELECT tenant.is_hub FROM memberships', filas: [{ is_hub: false }] },
      { cuando: 'COALESCE(max(id),0)::text AS revision', filas: [{ revision: '7' }] },
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]);
    await expect(new ConfigurationRepository(pool).apply('Miguel', 'kratos', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Miguel', alias: 'kratos',
      value: { purpose: 'lo nuevo' }
    }, false, 7)).rejects.toMatchObject({ code: 'forbidden' });
  });

  /**
   * CONTROL NEGATIVO del aislamiento: el mismo caso con el hub SÍ pasa.
   *
   * Sin él, la prueba de arriba daría verde aunque el rechazo viniera de cualquier otra cosa —un
   * SQL mal escrito, una respuesta que falta en el doble— y estaríamos acreditando una guarda que
   * no existe.
   */
  it('el hub SÍ puede escribir el mismo perfil (el rechazo era el permiso, no otra cosa)', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    const resultado = await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Miguel', alias: 'kratos',
      value: { purpose: 'lo nuevo' }
    }, false, 7);
    expect(resultado.applied).toBe(true);
  });

  /**
   * El tope REAL se aplica acá y nombra el CAMPO, que es lo que el borde de zod no puede hacer.
   *
   * Y se lanza como `invalid_input`, que el gateway traduce a 422: una violación de CHECK de
   * Postgres subiría como 500 opaco y la pantalla no podría decir qué corregir.
   */
  it('un campo que pasa el borde pero no el tope se rechaza NOMBRANDO el campo', async () => {
    const { pool } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    const error = await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      // Pasa el borde (24.000) y no el tope de `purpose` (2.000).
      value: { purpose: 'a'.repeat(3_000) }
    }, false, 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).code).toBe('invalid_input');
    expect((error as ConfigurationError).message).toMatch(/purpose/);
  });

  /**
   * EL PERFIL VIAJA EN EL SNAPSHOT DE CONFIGURACIÓN.
   *
   * Es la misma razón por la que `role_brief` viaja en él, escrita en `get()`: lo que la consola
   * EDITA tiene que venir en la lectura, o la pantalla enseña cajas vacías y el primer guardado
   * borra el perfil que el alias ya tenía. Y como la mutación fusiona sobre lo que hay en la base,
   * un formulario que no sabe qué había manda seis campos vacíos y los escribe todos.
   */
  it('el perfil viaja en el snapshot que lee la consola', async () => {
    const { pool, ejecutadas } = poolFalso([
      { cuando: 'SELECT tenant.is_hub FROM memberships', filas: [{ is_hub: true }] },
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]);
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'zeus');

    expect(snapshot['agent_profiles']).toEqual([PERFIL_EXISTENTE]);
    const lectura = sqls(ejecutadas).find(
      (sql) => sql.includes('FROM agent_profiles') && !sql.includes('FOR UPDATE')
    );
    expect(lectura).toBeDefined();
    // Y filtrado por inquilino, como cada SELECT del snapshot: un operador que no es del hub no
    // puede ver el perfil de otro inquilino sólo porque la consola lo pida todo de una vez.
    expect(lectura).toContain('$1::text IS NULL OR tenant_id=$1');
  });

  /**
   * Un ensayo (`dry_run`) NO deja asiento ni escribe.
   *
   * La pantalla previsualiza antes de guardar; si el ensayo dejara fila en `config_revisions`, el
   * historial se llenaría de cambios que nadie hizo y el botón de deshacer apuntaría a ellos.
   */
  it('el ensayo no escribe asiento', async () => {
    const { pool, ejecutadas } = poolFalso(respuestasBase([
      { cuando: 'FROM agent_profiles', filas: [PERFIL_EXISTENTE] }
    ]));
    const resultado = await new ConfigurationRepository(pool).apply('Steven', 'zeus', {
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { purpose: 'lo nuevo' }
    }, true, 7);

    expect(resultado.applied).toBe(false);
    expect(resultado.dry_run).toBe(true);
    expect(sqls(ejecutadas).some((sql) => sql.includes('INSERT INTO config_revisions'))).toBe(false);
    expect(sqls(ejecutadas).some((sql) => sql.includes('ROLLBACK'))).toBe(true);
  });
});
