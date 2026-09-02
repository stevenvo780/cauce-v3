import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import {
  asegurarPlantilla,
  crearBaseEfimera,
  esBaseDePruebas,
  huellaDeMigracionesDelArbol,
  nombreDeBase,
  nombreDePlantilla,
  registrarEjecucion,
  registrarSalto,
  resumenDeSaltos,
} from '../helpers/postgres.js';

const servidor = 'postgresql://cauce@127.0.0.1:5432/cauce_test';

interface Doble {
  pool: DatabasePool;
  sql: string[];
}

function doble(comentario: string | null, fallosDeClon: string[] = []): Doble {
  const sql: string[] = [];
  const pendientes = [...fallosDeClon];
  const responder = async (texto: string): Promise<{ rows: unknown[] }> => {
    sql.push(texto);
    if (texto.includes('TEMPLATE')) {
      const codigo = pendientes.shift();
      if (codigo !== undefined) throw Object.assign(new Error('clonación fallida'), { code: codigo });
    }
    if (texto.includes('shobj_description')) return { rows: [{ huella: comentario }] };
    return { rows: [] };
  };
  const cliente = { query: responder, release: () => undefined } as unknown as DatabaseClient;
  const pool = {
    query: responder,
    connect: async () => cliente,
    end: async () => undefined,
  } as unknown as DatabasePool;
  return { pool, sql };
}

describe('la plantilla de migraciones de las bases efímeras', () => {
  it('recrea la plantilla cuando la huella grabada no es la del árbol', async () => {
    const admin = doble('huella-vieja');
    const sembrar = vi.fn(async () => undefined);

    await asegurarPlantilla(servidor, () => admin.pool, {
      huellaEsperada: async () => 'huella-nueva',
      sembrar,
    });

    expect(admin.sql).toContain(`DROP DATABASE IF EXISTS ${nombreDePlantilla} WITH (FORCE)`);
    expect(admin.sql).toContain(`CREATE DATABASE ${nombreDePlantilla}`);
    expect(sembrar).toHaveBeenCalledOnce();
    expect(admin.sql).toContain(`COMMENT ON DATABASE ${nombreDePlantilla} IS 'huella-nueva'`);
  });

  it('deja la plantilla en pie cuando la huella grabada es la del árbol', async () => {
    const admin = doble('huella-nueva');
    const sembrar = vi.fn(async () => undefined);

    await asegurarPlantilla(servidor, () => admin.pool, {
      huellaEsperada: async () => 'huella-nueva',
      sembrar,
    });

    expect(sembrar).not.toHaveBeenCalled();
    expect(admin.sql.some((texto) => texto.startsWith('DROP DATABASE'))).toBe(false);
    expect(admin.sql.some((texto) => texto.startsWith('CREATE DATABASE'))).toBe(false);
  });

  it('rechaza una huella que no es imprimible en vez de coserla al SQL', async () => {
    const admin = doble(null);

    await expect(asegurarPlantilla(servidor, () => admin.pool, {
      huellaEsperada: async () => "1:a.sql'; DROP DATABASE cauce",
      sembrar: async () => undefined,
    })).rejects.toThrow(/huella de migraciones/);
  });

  it('clona la plantilla, y con plantilla:false no emite TEMPLATE', async () => {
    const huella = await huellaDeMigracionesDelArbol();

    const conPlantilla = doble(huella);
    await crearBaseEfimera(servidor, () => conPlantilla.pool, { plantilla: true });
    expect(conPlantilla.sql.some((t) => t.includes(`TEMPLATE ${nombreDePlantilla}`))).toBe(true);

    const sinPlantilla = doble(huella);
    const { url } = await crearBaseEfimera(servidor, () => sinPlantilla.pool, { plantilla: false });
    expect(sinPlantilla.sql.some((texto) => texto.includes('TEMPLATE'))).toBe(false);
    expect(sinPlantilla.sql).toContain(`CREATE DATABASE ${nombreDeBase(url)}`);
  });

  it('rehace la plantilla y reintenta cuando otra corrida la tira antes de clonar', async () => {
    const admin = doble(await huellaDeMigracionesDelArbol(), ['3D000']);

    await crearBaseEfimera(servidor, () => admin.pool, { plantilla: true });

    expect(admin.sql.filter((t) => t.includes(`TEMPLATE ${nombreDePlantilla}`))).toHaveLength(2);
    expect(admin.sql.filter((t) => t === 'SELECT pg_advisory_lock($1)')).toHaveLength(2);
  });

  it('CONTROL NEGATIVO: un error que no es de carrera ni reintenta ni rehace la plantilla', async () => {
    const admin = doble(await huellaDeMigracionesDelArbol(), ['42P04']);

    await expect(crearBaseEfimera(servidor, () => admin.pool, { plantilla: true }))
      .rejects.toThrow(/clonación fallida/);

    expect(admin.sql.filter((t) => t.includes(`TEMPLATE ${nombreDePlantilla}`))).toHaveLength(1);
    expect(admin.sql.filter((t) => t === 'SELECT pg_advisory_lock($1)')).toHaveLength(1);
  });

  it('el nombre de la plantilla pasa la guarda que impide truncar producción', () => {
    expect(esBaseDePruebas(`postgresql://cauce@127.0.0.1:5432/${nombreDePlantilla}`)).toBe(true);
  });
});

describe('el veredicto por fichero de los saltos por capacidad', () => {
  it('CONTROL NEGATIVO: un fichero con un test ejecutado NO aparece en el resumen', () => {
    registrarSalto('mixto.test.ts', 'Docker server probe failed');
    registrarEjecucion('mixto.test.ts');
    registrarSalto('mudo.test.ts', 'Docker daemon unavailable');
    registrarSalto('mudo.test.ts', 'Docker daemon unavailable');

    const resumen = resumenDeSaltos();

    expect(resumen.map((salto) => salto.fichero)).not.toContain('mixto.test.ts');
    expect(resumen).toContainEqual({
      fichero: 'mudo.test.ts', razon: 'Docker daemon unavailable', saltados: 2,
    });
  });
});
