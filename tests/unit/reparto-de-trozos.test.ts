import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node';
import { afterEach, describe, expect, it } from 'vitest';

interface Trozo { indice: number; total: number }
interface Registro { suite: string; cwd: string; ficheros: string[]; elegidos: Iterable<string> }
interface ModuloDeTrozos {
  leerTrozo: (valor?: string) => Trozo | undefined;
  elegir: (rutas: string[], trozo: Trozo) => string[];
  registrarReparto: (trozo: Trozo, registro: Registro, directorio?: string) => string | undefined;
  verificarReparto: (directorio: string, total: number, suites?: string[]) => { problemas: string[]; resumen: string[] };
}
interface Conteo { ejecutados: number; saltados: number }
interface Corrida { name: string; omitida?: boolean; code?: number; timedOut?: boolean; elapsedMs?: number; conteo?: Conteo }
interface ModuloDeMatriz {
  SUITES: string[];
  ENTERAS: Map<string, { segundos: number; motivo: string }>;
  repartoDeEnteras: (total: number) => Map<string, number>;
  fusionarResultados: (resumenes: { trozo: string; suites: Corrida[] }[], total: number) => {
    results: (Corrida & { code: number })[]; problemas: string[];
  };
}

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const trozos = (await import(new URL('scripts/trozos.mjs', `file://${raiz}`).href)) as ModuloDeTrozos;
const matriz = (await import(new URL('scripts/test-all.mjs', `file://${raiz}`).href)) as ModuloDeMatriz;
const directorios: string[] = [];

function temporal(): string {
  const directorio = mkdtempSync(join(tmpdir(), 'cauce-trozos-'));
  directorios.push(directorio);
  return directorio;
}

function ficheros(cuantos: number): string[] {
  return Array.from({ length: cuantos }, (_, indice) => `tests/zona-${String(indice % 7)}/caso-${String(indice)}.test.ts`);
}

async function repartoDeVitest(rutas: string[], trozo: Trozo): Promise<string[]> {
  const root = '/raiz';
  const ctx = { config: { root, shard: { index: trozo.indice, count: trozo.total } } } as unknown as Vitest;
  const specs = rutas.map(ruta => ({ moduleId: `${root}/${ruta}` }) as unknown as TestSpecification);
  return (await new BaseSequencer(ctx).shard(specs)).map(spec => spec.moduleId.slice(root.length + 1));
}

function registrarTodos(directorio: string, total: number, todos: string[], suite = 'test:unit'): void {
  for (let indice = 1; indice <= total; indice += 1) {
    const trozo = { indice, total };
    trozos.registrarReparto(trozo, { suite, cwd: '', ficheros: todos, elegidos: trozos.elegir(todos, trozo) }, directorio);
  }
}

afterEach(() => {
  for (const directorio of directorios.splice(0)) rmSync(directorio, { recursive: true, force: true });
});

describe('reparto de ficheros de prueba entre trozos', () => {
  it('lee CAUCE_TEST_SHARD y rechaza lo que no es i/N', () => {
    expect(trozos.leerTrozo('')).toBeUndefined();
    expect(trozos.leerTrozo('2/4')).toEqual({ indice: 2, total: 4 });
    for (const malo of ['0/4', '5/4', '1', 'a/b', '1/0', '-1/2', '1/2/3']) {
      expect(() => trozos.leerTrozo(malo), malo).toThrow('CAUCE_TEST_SHARD debe ser i/N');
    }
  });

  it('parte exactamente como vitest --shard y entre todos los trozos cubre cada fichero una sola vez', async () => {
    for (const [cuantos, total] of [[1, 1], [1, 4], [3, 4], [28, 3], [202, 4], [485, 6]] as const) {
      const todos = ficheros(cuantos);
      const vistos: string[] = [];
      for (let indice = 1; indice <= total; indice += 1) {
        const propio = trozos.elegir(todos, { indice, total });
        expect(propio).toEqual(await repartoDeVitest(todos, { indice, total }));
        vistos.push(...propio);
      }
      expect(vistos.sort()).toEqual([...todos].sort());
    }
  });

  it('acredita un reparto completo y detecta trozos ausentes, ficheros repetidos u olvidados y conjuntos distintos', () => {
    const todos = ficheros(40);
    const sano = temporal();
    registrarTodos(sano, 3, todos);
    registrarTodos(sano, 3, todos.slice(0, 5), 'test:e2e');
    registrarTodos(sano, 3, todos.slice(0, 5), 'test:e2e');
    const bueno = trozos.verificarReparto(sano, 3, ['test:unit', 'test:e2e']);
    expect(bueno.problemas).toEqual([]);
    expect(bueno.resumen).toEqual([
      'test:e2e #1 (.): 5 ficheros = 2+2+1', 'test:e2e #2 (.): 5 ficheros = 2+2+1', 'test:unit #1 (.): 40 ficheros = 14+14+12']);

    const sinTrozo = temporal();
    for (const indice of [1, 3]) {
      trozos.registrarReparto({ indice, total: 3 }, { suite: 'test:unit', cwd: '', ficheros: todos, elegidos: trozos.elegir(todos, { indice, total: 3 }) }, sinTrozo);
    }
    expect(trozos.verificarReparto(sinTrozo, 3).problemas.join('\n')).toContain('la vieron los trozos [1,3] y debian verla los 3');

    const repetido = temporal();
    for (let indice = 1; indice <= 2; indice += 1) {
      const elegidos = trozos.elegir(todos, { indice, total: 2 });
      trozos.registrarReparto({ indice, total: 2 }, { suite: 'test:unit', cwd: '', ficheros: todos, elegidos: indice === 2 ? [...elegidos, todos[0] ?? ''] : elegidos }, repetido);
    }
    expect(trozos.verificarReparto(repetido, 2).problemas.join('\n')).toContain(`ficheros corridos mas de una vez: ${todos[0] ?? ''}`);

    const olvidado = temporal();
    for (let indice = 1; indice <= 2; indice += 1) {
      const elegidos = trozos.elegir(todos, { indice, total: 2 }).filter(fichero => fichero !== todos[1]);
      trozos.registrarReparto({ indice, total: 2 }, { suite: 'test:unit', cwd: '', ficheros: todos, elegidos }, olvidado);
    }
    expect(trozos.verificarReparto(olvidado, 2).problemas.join('\n')).toContain(`ficheros que ningun trozo corrio: ${todos[1] ?? ''}`);

    const distinto = temporal();
    trozos.registrarReparto({ indice: 1, total: 2 }, { suite: 'test:unit', cwd: '', ficheros: todos, elegidos: trozos.elegir(todos, { indice: 1, total: 2 }) }, distinto);
    trozos.registrarReparto({ indice: 2, total: 2 }, { suite: 'test:unit', cwd: '', ficheros: todos.slice(1), elegidos: trozos.elegir(todos.slice(1), { indice: 2, total: 2 }) }, distinto);
    expect(trozos.verificarReparto(distinto, 2).problemas.join('\n')).toContain('no vieron el mismo conjunto de ficheros');

    expect(trozos.verificarReparto(sano, 4).problemas.join('\n')).toContain('es del reparto 1/3 y la fusion es de 4 trozos');
    expect(trozos.verificarReparto(sano, 3, ['test:services']).problemas.join('\n')).toContain('test:services: ningun trozo registro su reparto');
  });

  it('el envoltorio de node --test corre solo los ficheros de su trozo y no esconde una orden sin pruebas', () => {
    const directorio = temporal();
    const registros = join(directorio, 'registros');
    const casos = ['a', 'b', 'c', 'd', 'e'].map(nombre => `${nombre}.test.mjs`);
    for (const caso of casos) {
      writeFileSync(join(directorio, caso), `import { test } from 'node:test';\ntest('${caso}', () => { console.log('CORRIO ${caso}'); });\n`);
    }
    const correr = (trozo: string | undefined, argumentos: string[]) => spawnSync(process.execPath,
      [join(raiz, 'scripts/trozos.mjs'), 'ejecutar', process.execPath, '--test', ...argumentos], {
        cwd: directorio, encoding: 'utf8',
        env: { ...process.env, CAUCE_TEST_SHARD: trozo ?? '', CAUCE_TEST_SHARD_DIR: registros, CAUCE_TEST_SUITE: 'test:unit' },
      });
    const corridos = (salida: string) => [...salida.matchAll(/CORRIO (\S+)/gu)].map(([, caso]) => caso ?? '');
    const entero = correr(undefined, casos);
    expect(entero.status, entero.stderr).toBe(0);
    expect(corridos(entero.stdout).sort()).toEqual(casos);
    const porTrozos: string[] = [];
    for (let indice = 1; indice <= 3; indice += 1) {
      const corrida = correr(`${String(indice)}/3`, casos);
      expect(corrida.status, corrida.stderr).toBe(0);
      expect(corrida.stdout).toContain(`trozo ${String(indice)}/3:`);
      porTrozos.push(...corridos(corrida.stdout));
    }
    expect(porTrozos.sort()).toEqual(casos);
    expect(trozos.verificarReparto(registros, 3, ['test:unit']).problemas).toEqual([]);
    const vacio = correr('4/4', ['a.test.mjs']);
    expect(vacio.status, vacio.stderr).toBe(0);
    expect(vacio.stdout).toContain('trozo 4/4: 0 de 1 ficheros de prueba');
    const sinPruebas = correr('1/2', ['no-existe.test.mjs']);
    expect(sinPruebas.status).toBe(1);
    expect(sinPruebas.stderr).toContain('ninguna prueba en');
  });
});

describe('matriz de pruebas en trozos', () => {
  it('cada suite entera cae en un solo trozo, la mas larga primero en el menos cargado', () => {
    for (const total of [1, 2, 3, 4, 8]) {
      const reparto = matriz.repartoDeEnteras(total);
      expect([...reparto.keys()].sort()).toEqual([...matriz.ENTERAS.keys()].sort());
      for (const destino of reparto.values()) {
        expect(destino).toBeGreaterThanOrEqual(1);
        expect(destino).toBeLessThanOrEqual(total);
      }
    }
    expect(Object.fromEntries(matriz.repartoDeEnteras(4))).toEqual({
      'test:ops': 1, 'test:container-supervisor': 2, 'test:pty': 3, 'test:container-cutover': 4,
    });
    for (const suite of matriz.ENTERAS.keys()) expect(matriz.SUITES).toContain(suite);
  });

  function resumenes(total: number, ajustar: (corrida: Corrida, indice: number) => Corrida = corrida => corrida) {
    const destino = matriz.repartoDeEnteras(total);
    return Array.from({ length: total }, (_, posicion) => {
      const indice = posicion + 1;
      return {
        trozo: `${String(indice)}/${String(total)}`,
        suites: matriz.SUITES.map(name => ajustar(matriz.ENTERAS.has(name) && destino.get(name) !== indice
          ? { name, omitida: true }
          : { name, code: 0, timedOut: false, elapsedMs: 1000 * indice, conteo: { ejecutados: indice, saltados: 1 } }, indice)),
      };
    });
  }

  it('suma los conteos, toma la duracion del trozo mas lento y acredita la matriz entera', () => {
    const { results, problemas } = matriz.fusionarResultados(resumenes(3), 3);
    expect(problemas).toEqual([]);
    const unidad = results.find(result => result.name === 'test:unit');
    expect(unidad).toMatchObject({ code: 0, elapsedMs: 3000, conteo: { ejecutados: 6, saltados: 3 } });
    const ops = results.find(result => result.name === 'test:ops');
    expect(ops).toMatchObject({ code: 0, conteo: { ejecutados: 1, saltados: 1 } });
  });

  it('no acredita trozos que faltan, suites enteras repetidas ni un trozo rojo', () => {
    expect(matriz.fusionarResultados(resumenes(3).slice(0, 2), 3).problemas.join('\n')).toContain('la fusion espera [1/3 2/3 3/3]');
    const repetida = resumenes(2, corrida => corrida.name === 'test:pty' ? { name: 'test:pty', code: 0, conteo: { ejecutados: 1, saltados: 0 } } : corrida);
    expect(matriz.fusionarResultados(repetida, 2).problemas.join('\n')).toContain('test:pty: corrio en 2 trozo(s) y debia correr en 1');
    const ausente = resumenes(2, (corrida, indice) => corrida.name === 'test:e2e' && indice === 2 ? { name: 'test:e2e', omitida: true } : corrida);
    expect(matriz.fusionarResultados(ausente, 2).problemas.join('\n')).toContain('test:e2e: corrio en 1 trozo(s) y debia correr en 2');
    const roja = resumenes(2, (corrida, indice) => corrida.name === 'test:services' && indice === 2 ? { ...corrida, code: 7 } : corrida);
    expect(matriz.fusionarResultados(roja, 2).results.find(result => result.name === 'test:services')?.code).toBe(7);
  });

  it('la fusion por CLI imprime el reparto y la matriz, y sale roja si un fichero no corrio', () => {
    const directorio = temporal();
    const total = 2;
    for (const resumen of resumenes(total)) {
      writeFileSync(join(directorio, `test-trozo-${resumen.trozo.split('/')[0] ?? ''}.json`), JSON.stringify(resumen));
    }
    for (const suite of matriz.SUITES.filter(name => !matriz.ENTERAS.has(name))) registrarTodos(directorio, total, ficheros(9), suite);
    const fusionar = () => spawnSync(process.execPath, [join(raiz, 'scripts/test-all.mjs')], {
      cwd: raiz, encoding: 'utf8',
      env: { ...process.env, CAUCE_TEST_SHARD_MERGE: String(total), CAUCE_TEST_SHARD_DIR: directorio, CAUCE_REQUIRE_TESTCONTAINERS: '1' },
    });
    const verde = fusionar();
    expect(verde.status, verde.stdout).toBe(0);
    expect(verde.stdout).toContain('test:store-hardening #1 (.): 9 ficheros = 5+4');
    expect(verde.stdout).toContain(`${String(matriz.SUITES.length)} passed, 0 failed of ${String(matriz.SUITES.length)} suites`);
    const registro = readdirSync(directorio).find(nombre => nombre.startsWith('reparto-2-test_e2e-'));
    rmSync(join(directorio, registro ?? 'ninguno'));
    const roja = fusionar();
    expect(roja.status).toBe(1);
    expect(roja.stdout).toContain('FUSION ROJA');
    expect(roja.stdout).toContain('test:e2e #1 (.): la vieron los trozos [1] y debian verla los 2');
  });

  it('un directorio de trozos inexistente no es una fusion verde', () => {
    const directorio = join(temporal(), 'nada');
    mkdirSync(directorio);
    const corrida = spawnSync(process.execPath, [join(raiz, 'scripts/test-all.mjs')], {
      cwd: raiz, encoding: 'utf8', env: { ...process.env, CAUCE_TEST_SHARD_MERGE: '2', CAUCE_TEST_SHARD_DIR: directorio },
    });
    expect(corrida.status).toBe(1);
    expect(corrida.stdout).toContain('falta el resumen del trozo 1/2');
  });
});
