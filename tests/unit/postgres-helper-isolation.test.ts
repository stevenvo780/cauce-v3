import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import {
  basesEfimerasCaducadas, creacionDeBaseEfimera, crearBaseEfimera, nombreEfimero,
} from '../helpers/postgres.js';

/*
 * Two vitest runs against the same server overlap by design (the gate fans out). The only thing
 * that keeps run A from destroying run B's database between its CREATE and its first connection
 * is that no run may delete a database it did not create and that is not provably abandoned.
 */

const HORA_MS = 3_600_000;

interface Consulta {
  params: unknown[];
  texto: string;
}

function poolFalso(existentes: string[]): { consultas: Consulta[]; pool: DatabasePool } {
  const consultas: Consulta[] = [];
  const pool = {
    end: async (): Promise<void> => undefined,
    query: async (texto: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
      consultas.push({ params, texto });
      if (texto.includes('FROM pg_database')) {
        return { rows: existentes.map((datname) => ({ datname })) };
      }
      return { rows: [] };
    },
  };
  return { consultas, pool: pool as unknown as DatabasePool };
}

function borradas(consultas: Consulta[]): string[] {
  return consultas
    .map((consulta) => /DROP DATABASE IF EXISTS (\w+)/.exec(consulta.texto)?.[1])
    .filter((nombre): nombre is string => nombre !== undefined);
}

describe('el nombre de la base efímera', () => {
  it('codifica el pid y el instante de creación de forma recuperable', () => {
    const nombre = nombreEfimero(4_242, 1_700_000_000_000);

    expect(creacionDeBaseEfimera(nombre)).toEqual({ creada: 1_700_000_000_000, pid: 4_242 });
  });

  it('es un identificador válido de a lo sumo 63 bytes', () => {
    const nombre = nombreEfimero(4_194_304, 4_102_444_800_000);

    expect(nombre).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(Buffer.byteLength(nombre, 'utf8')).toBeLessThanOrEqual(63);
  });

  it('usa el pid y el reloj del proceso cuando no se le pasan', () => {
    const antes = Date.now();
    const datos = creacionDeBaseEfimera(nombreEfimero());

    expect(datos?.pid).toBe(process.pid);
    expect(datos?.creada).toBeGreaterThanOrEqual(antes - 1_000);
  });

  it('no reconoce un nombre ajeno al formato', () => {
    expect(creacionDeBaseEfimera('cauce_test_e0123456789abcdef')).toBeUndefined();
    expect(creacionDeBaseEfimera('cauce_test')).toBeUndefined();
  });
});

describe('la poda de sobras efímeras', () => {
  const ahora = 1_700_000_000_000;

  it('nunca propone una base más joven que la edad máxima', () => {
    const joven = nombreEfimero(999, ahora - (5 * HORA_MS));

    expect(basesEfimerasCaducadas([joven], ahora)).toEqual([]);
  });

  it('propone la sobra cuya marca supera la edad máxima', () => {
    const vieja = nombreEfimero(999, ahora - (7 * HORA_MS));

    expect(basesEfimerasCaducadas([vieja], ahora)).toEqual([vieja]);
  });

  it('ignora nombres sin marca de tiempo en vez de suponerlos abandonados', () => {
    expect(basesEfimerasCaducadas(['cauce_test_e0123456789abcdef'], ahora)).toEqual([]);
  });
});

describe('crearBaseEfimera contra otra corrida en vuelo', () => {
  const servidor = 'postgresql://cauce@127.0.0.1:5432/cauce_test';

  it('no borra la base recién creada por otro proceso', async () => {
    const ajenaJoven = nombreEfimero(process.pid + 1, Date.now() - 2_000);
    const { consultas, pool } = poolFalso([ajenaJoven]);

    await crearBaseEfimera(servidor, () => pool);

    expect(borradas(consultas)).toEqual([]);
  });

  it('no interroga pg_stat_activity para decidir a quién borrar', async () => {
    const { consultas, pool } = poolFalso([nombreEfimero(process.pid + 1, Date.now() - 2_000)]);

    await crearBaseEfimera(servidor, () => pool);

    const descubrimiento = consultas.filter((consulta) => consulta.texto.includes('pg_database'));
    expect(descubrimiento).toHaveLength(1);
    expect(descubrimiento[0]?.texto).not.toContain('pg_stat_activity');
  });

  it('borra la sobra ajena que ya superó la edad máxima', async () => {
    const ajenaVieja = nombreEfimero(process.pid + 1, Date.now() - (7 * HORA_MS));
    const { consultas, pool } = poolFalso([ajenaVieja]);

    await crearBaseEfimera(servidor, () => pool);

    expect(borradas(consultas)).toEqual([ajenaVieja]);
  });

  it('crea una base propia y la borra sólo en el teardown', async () => {
    const { consultas, pool } = poolFalso([]);

    const { soltar, url } = await crearBaseEfimera(servidor, () => pool);
    const propia = new URL(url).pathname.slice(1);

    expect(creacionDeBaseEfimera(propia)?.pid).toBe(process.pid);
    expect(consultas.some((consulta) => consulta.texto === `CREATE DATABASE ${propia}`)).toBe(true);
    expect(borradas(consultas)).toEqual([]);

    await soltar();

    expect(borradas(consultas)).toEqual([propia]);
  });

  it('termina las conexiones de la base propia sin tocar las ajenas', async () => {
    const { consultas, pool } = poolFalso([]);

    const { tirarConexiones, url } = await crearBaseEfimera(servidor, () => pool);
    const propia = new URL(url).pathname.slice(1);
    await tirarConexiones();

    const terminar = consultas.find((consulta) => consulta.texto.includes('pg_terminate_backend'));
    expect(terminar?.params).toEqual([propia]);
  });
});
