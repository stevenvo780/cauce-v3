#!/usr/bin/env node
/** Runs the whole test matrix to completion; non-zero exit if any suite fails or times out. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leerTrozo, sinTrozo, verificarReparto } from './trozos.mjs';

export const SUITES = [
  'test:unit',
  'test:terminal-pty',
  'test:pty',
  'test:ops',
  'test:container-supervisor',
  'test:container-cutover',
  'test:services',
  'test:gateway-hardening',
  'test:store-hardening',
  'test:integration',
  'test:runtime-role',
  'test:e2e',
];

/* Kept out of the matrix, each for a reason no automated check can see from the script alone. */
export const SEPARATELY_GATED = new Map([
  ['test:core', 'both halves are already in the matrix: it exists as a per-commit step for whatever touches services/**'],
  ['test:coverage', 're-runs this whole matrix under instrumentation, so the matrix cannot contain it'],
  ['coverage:ratchet', 're-runs this whole matrix under instrumentation: nightly and release closure only'],
  ['coverage:seed', 'rewrites the coverage baseline, so it only runs on a green tree: nightly and release closure only'],
  ['qa:real', 'the live fleet: talks to the real bus and real agent adapters'],
  ['qa:contract', 'the live fleet: exercises the harness against the fleet topology, mocked responses only'],
  ['qa:opencode-cli', 'the live fleet: probes whatever opencode CLI binary the host actually has installed'],
  ['qa:testcontainers', 'Docker: provisions real containers via testcontainers'],
  ['qa:runtime-packaging', 'root/packaging: builds and boots the release Docker image, needs a normal-user identity'],
  ['qa:layout', 'Playwright/Chromium: renders the console in a real browser at fixed viewports'],
  ['qa:layout:update', 'Playwright/Chromium: same renderer as qa:layout, writing the baseline instead of checking it'],
  ['qa:audit', 'the npm advisory feed: turns red on a new CVE with no code change, so the nightly runs it as its own step'],
]);

export const ENTERAS = new Map([
  ['test:ops', { segundos: 463, motivo: 'ops/tests/run-all.mjs corre .mjs, .sh y .py sin partirlos' }],
  ['test:container-supervisor', { segundos: 227, motivo: 'un unico guion node' }],
  ['test:pty', { segundos: 14, motivo: 'python unittest no conoce CAUCE_TEST_SHARD' }],
  ['test:container-cutover', { segundos: 1, motivo: 'un unico guion node' }],
]);

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const TIMEOUTS = new Map([
  ['test:e2e', 40 * 60_000],
  ['test:integration', 40 * 60_000],
  ['test:runtime-role', 40 * 60_000],
  ['test:store-hardening', 75 * 60_000],
  ['test:container-supervisor', 10 * 60_000],
  ['test:container-cutover', 10 * 60_000],
]);
const GRACE_KILL_MS = 10_000;

const PREFIJOS_DE_SUITE = ['test:', 'qa:', 'coverage:'];
/* Runners whose output nobody parses: python unittest and the ops runner print their own tally. */
const SIN_CONTEO = new Set(['test:pty', 'test:ops']);
const ANSI = /\p{Cc}\[[0-9;]*m/gu;
const RESUMEN_DE_VITEST = /^\s*Tests\s+(\S.*)$/u;
const PARTE_DE_VITEST = /(\d+)\s+(passed|failed|skipped|todo)/gu;
const RESUMEN_DE_NODE = /^(?:ℹ|#)\s(pass|fail|skipped)\s(\d+)\s*$/u;
const FILTRO_DE_PNPM = /--filter[= ]\s*(\S+)/gu;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const esSuiteDeclarada = (nombre) => PREFIJOS_DE_SUITE.some((prefijo) => nombre.startsWith(prefijo));

/* A bare token must not match inside a longer one: `console` sits inside `@cauce/console`, so the
   substring test let a rename of that package through with the gate still green. */
function mencionado(invocaciones, token, comoDirectorio) {
  const escapado = token.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
  return new RegExp(`(?:^|\\s|=)${escapado}${comoDirectorio ? '(?:/|\\s|$)' : '(?:\\s|$)'}`, 'u').test(invocaciones);
}

export async function paquetesDelWorkspace() {
  const { execSync } = await import('node:child_process');
  const rutas = execSync('git ls-files "*/package.json"', { encoding: 'utf8' }).split('\n')
    .filter((fichero) => fichero && !fichero.includes('node_modules'));
  const paquetes = [];
  for (const ruta of rutas) {
    const pkg = JSON.parse(await readFile(resolve(root, ruta), 'utf8'));
    if (typeof pkg.name === 'string') paquetes.push({ ruta, nombre: pkg.name, tieneTest: Boolean(pkg.scripts?.test) });
  }
  return paquetes;
}

/* A suite in no list is a suite nobody runs, and a `--filter` that names nothing runs nothing:
   `--fail-if-no-match` misses that, because pnpm exits 0 when one of several filters matches. */
export function comprobarMatriz(manifest, paquetes) {
  const scripts = Object.keys(manifest.scripts ?? {});
  const declared = scripts.filter(esSuiteDeclarada);
  const unclaimed = declared.filter((name) => !SUITES.includes(name) && !SEPARATELY_GATED.has(name));
  if (unclaimed.length > 0) {
    throw new Error(
      `these test/qa scripts are neither in the matrix nor explicitly excluded: ${unclaimed.join(', ')}`,
    );
  }
  const absent = SUITES.filter((name) => !scripts.includes(name));
  if (absent.length > 0) throw new Error(`the matrix names missing scripts: ${absent.join(', ')}`);
  const enterasAjenas = [...ENTERAS.keys()].filter((name) => !SUITES.includes(name));
  if (enterasAjenas.length > 0) throw new Error(`whole-shard suites outside the matrix: ${enterasAjenas.join(', ')}`);

  const comandos = Object.entries(manifest.scripts ?? {}).filter(([name]) => esSuiteDeclarada(name));
  const conocidos = new Set(paquetes.flatMap((paquete) => [paquete.nombre, dirname(paquete.ruta)]));
  const sinDestino = [];
  for (const [name, comando] of comandos) {
    for (const [, filtro] of comando.matchAll(FILTRO_DE_PNPM)) {
      if (!conocidos.has(filtro)) sinDestino.push(`${name}: --filter ${filtro}`);
    }
  }
  if (sinDestino.length > 0) {
    throw new Error(`these scripts filter a workspace package that does not exist: ${sinDestino.join(', ')}`);
  }

  const invocaciones = comandos.filter(([name]) => name.startsWith('test:')).map(([, cmd]) => cmd).join(' ');
  const sinRunner = paquetes
    .filter((paquete) => paquete.tieneTest)
    .filter((paquete) => !mencionado(invocaciones, paquete.nombre, false)
      && !mencionado(invocaciones, dirname(paquete.ruta), true))
    .map((paquete) => paquete.nombre);
  if (sinRunner.length > 0) {
    throw new Error(`workspace packages declare a test script that no root test:* ever invokes: ${sinRunner.join(', ')}`);
  }
}

export async function assertMatrixIsComplete() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  comprobarMatriz(manifest, await paquetesDelWorkspace());
}

function sumarLinea(conteo, linea) {
  const limpia = linea.replaceAll(ANSI, '');
  const vitest = RESUMEN_DE_VITEST.exec(limpia);
  if (vitest) {
    conteo.visto = true;
    for (const [, cantidad, estado] of vitest[1].matchAll(PARTE_DE_VITEST)) {
      if (estado === 'skipped' || estado === 'todo') conteo.saltados += Number(cantidad);
      else conteo.ejecutados += Number(cantidad);
    }
    return;
  }
  const nodo = RESUMEN_DE_NODE.exec(limpia);
  if (!nodo) return;
  conteo.visto = true;
  if (nodo[1] === 'skipped') conteo.saltados += Number(nodo[2]);
  else conteo.ejecutados += Number(nodo[2]);
}

/* Counts as the output streams by: one pnpm invocation prints several tallies, so a tail undercounts. */
export function contadorDeSuite(nombre) {
  const conteo = { ejecutados: 0, saltados: 0, visto: false };
  let resto = '';
  const activo = !SIN_CONTEO.has(nombre);
  return {
    empujar(trozo) {
      if (!activo) return;
      const lineas = (resto + trozo).split('\n');
      resto = lineas.pop() ?? '';
      for (const linea of lineas) sumarLinea(conteo, linea);
    },
    cerrar() {
      if (activo && resto !== '') sumarLinea(conteo, resto);
      return conteo.visto ? { ejecutados: conteo.ejecutados, saltados: conteo.saltados } : undefined;
    },
  };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/** Zero tests executed is not a pass: it is a suite that skipped itself and reported success. */
export function verdictFor(result) {
  if (result.timedOut) return 'TIMEOUT';
  if (result.code !== 0) return 'FAIL';
  if (result.conteo === undefined) return SIN_CONTEO.has(result.name) ? 'PASS' : 'VACIA';
  return result.conteo.ejecutados === 0 ? 'VACIA' : 'PASS';
}

export function cuentaDe(result) {
  return result.conteo === undefined
    ? '(conteo no disponible)'
    : `(${String(result.conteo.ejecutados)} ejecutados, ${String(result.conteo.saltados)} saltados)`;
}

function runSuite(name, env = process.env) {
  return new Promise((settle, fail) => {
    const startedAt = Date.now();
    const timeoutMs = TIMEOUTS.get(name) ?? DEFAULT_TIMEOUT_MS;
    process.stdout.write(`\n${'='.repeat(72)}\n=== ${name}\n${'='.repeat(72)}\n`);
    // Own process group so a wedged suite dies with its grandchildren, not just its pnpm wrapper.
    // Piped and re-emitted live instead of inherited: the counter reads each tally on the way out.
    const child = spawn('pnpm', ['run', name], { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'], detached: true });
    const contador = contadorDeSuite(name);
    for (const flujo of [child.stdout, child.stderr]) {
      flujo.setEncoding('utf8');
      flujo.on('data', (trozo) => {
        process.stdout.write(trozo);
        contador.empujar(trozo);
      });
    }
    let timedOut = false;
    let killTimer = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      process.stdout.write(`\n=== ${name}: exceeded ${(timeoutMs / 60_000).toFixed(0)} min, sending SIGTERM\n`);
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GRACE_KILL_MS);
    }, timeoutMs);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      const result = {
        name, code: code ?? 1, signal, elapsedMs: Date.now() - startedAt, timedOut, timeoutMs,
        conteo: contador.cerrar(),
      };
      process.stdout.write(`\n=== ${name}: ${verdictFor(result)} in ${seconds(result.elapsedMs)} ${cuentaDe(result)}\n`);
      settle(result);
    });
  });
}

function seconds(ms) {
  return `${(ms / 1_000).toFixed(1)}s`;
}

function informar(results) {
  const vaciaEsRoja = process.env.CAUCE_REQUIRE_TESTCONTAINERS === '1';
  const failed = results.filter(
    (result) => result.timedOut || result.code !== 0 || (vaciaEsRoja && verdictFor(result) === 'VACIA'),
  );
  const vacias = results.filter((result) => verdictFor(result) === 'VACIA');
  const total = results.reduce((sum, result) => sum + result.elapsedMs, 0);
  const width = Math.max(...SUITES.map((name) => name.length));
  process.stdout.write(`\n${'='.repeat(72)}\n=== test matrix summary\n${'='.repeat(72)}\n`);
  for (const result of results) {
    const verdict = verdictFor(result);
    const cause = verdict === 'TIMEOUT'
      ? `  (killed after ${(result.timeoutMs / 60_000).toFixed(0)} min)`
      : verdict === 'FAIL'
        ? `  (${result.signal === null || result.signal === undefined ? `exit ${result.code}` : `signal ${result.signal}`})`
        : '';
    const medida = `${seconds(result.elapsedMs).padStart(8)}  ${cuentaDe(result)}`;
    process.stdout.write(`${verdict.padEnd(7)}  ${result.name.padEnd(width)}  ${medida}${cause}\n`);
  }
  process.stdout.write(
    `\n${results.length - failed.length} passed, ${failed.length} failed of ${results.length} suites in ${seconds(total)}\n`,
  );
  if (vacias.length > 0) {
    process.stdout.write(
      `suites vacías (0 ejecutados): ${vacias.map((result) => result.name).join(' ')}`
        + `${vaciaEsRoja ? '' : ' — rojas sólo con CAUCE_REQUIRE_TESTCONTAINERS=1'}\n`,
    );
  }
  if (failed.length === 0) return 0;
  process.stdout.write(`failed suites: ${failed.map((result) => result.name).join(' ')}\n`);
  return 1;
}

export function repartoDeEnteras(total) {
  const carga = Array.from({ length: total }, () => 0);
  const reparto = new Map();
  for (const [name, { segundos }] of [...ENTERAS].sort((una, otra) => otra[1].segundos - una[1].segundos)) {
    const destino = carga.indexOf(Math.min(...carga));
    carga[destino] += segundos;
    reparto.set(name, destino + 1);
  }
  return reparto;
}

function directorioDeTrozos() {
  const directorio = process.env.CAUCE_TEST_SHARD_DIR;
  if (!directorio) throw new Error('CAUCE_TEST_SHARD_DIR no esta definido: la fusion no sabe donde leer los trozos');
  return directorio;
}

function cerrarTrozo(trozo, results) {
  const corridas = results.filter((result) => !result.omitida);
  const rotas = corridas.filter((result) => result.timedOut || result.code !== 0);
  process.stdout.write(`\n=== trozo ${trozo.indice}/${trozo.total}: ${corridas.length} suites corridas, ${rotas.length} rojas\n`);
  for (const result of corridas) process.stdout.write(`${verdictFor(result).padEnd(7)}  ${result.name}  ${cuentaDe(result)}\n`);
  if (process.env.CAUCE_TEST_SHARD_DIR) {
    const directorio = directorioDeTrozos();
    mkdirSync(directorio, { recursive: true });
    const ruta = join(directorio, `test-trozo-${trozo.indice}.json`);
    const contenido = `${JSON.stringify({ trozo: `${trozo.indice}/${trozo.total}`, suites: results })}\n`;
    writeFileSync(ruta, contenido);
    process.stdout.write(`resumen del trozo: ${ruta} sha256:${createHash('sha256').update(contenido).digest('hex')}\n`);
  }
  return rotas.length === 0 ? 0 : 1;
}

function sumar(corridas, campo) {
  return corridas.reduce((suma, corrida) => suma + corrida.conteo[campo], 0);
}

export function fusionarResultados(resumenes, total) {
  const problemas = [];
  const indices = resumenes.map((resumen) => resumen.trozo).sort();
  const esperados = Array.from({ length: total }, (_, posicion) => `${posicion + 1}/${total}`).sort();
  if (indices.join(' ') !== esperados.join(' ')) problemas.push(`los resumenes son de [${indices.join(' ')}] y la fusion espera [${esperados.join(' ')}]`);
  const results = SUITES.map((name) => {
    const vistas = resumenes.map((resumen) => resumen.suites.find((suite) => suite.name === name));
    if (vistas.includes(undefined)) problemas.push(`${name}: algun trozo no la menciona`);
    const hechas = vistas.filter((suite) => suite !== undefined && !suite.omitida);
    const esperadas = ENTERAS.has(name) ? 1 : total;
    if (hechas.length !== esperadas) problemas.push(`${name}: corrio en ${hechas.length} trozo(s) y debia correr en ${esperadas}`);
    const contadas = hechas.filter((suite) => suite.conteo !== undefined);
    return {
      name,
      code: hechas.length === 0 ? 1 : hechas.find((suite) => suite.code !== 0)?.code ?? 0,
      signal: hechas.find((suite) => suite.signal)?.signal ?? null,
      timedOut: hechas.some((suite) => suite.timedOut),
      timeoutMs: Math.max(0, ...hechas.map((suite) => suite.timeoutMs ?? 0)),
      elapsedMs: Math.max(0, ...hechas.map((suite) => suite.elapsedMs ?? 0)),
      conteo: contadas.length === 0 ? undefined : { ejecutados: sumar(contadas, 'ejecutados'), saltados: sumar(contadas, 'saltados') },
    };
  });
  return { results, problemas };
}

function fusionar(total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`CAUCE_TEST_SHARD_MERGE debe ser el numero de trozos (es '${process.env.CAUCE_TEST_SHARD_MERGE}')`);
  const directorio = directorioDeTrozos();
  const resumenes = [];
  const faltan = [];
  process.stdout.write(`=== fusion de ${total} trozos de la matriz desde ${directorio}\n`);
  for (let indice = 1; indice <= total; indice += 1) {
    const ruta = join(directorio, `test-trozo-${indice}.json`);
    if (!existsSync(ruta)) {
      faltan.push(`falta el resumen del trozo ${indice}/${total} (${ruta})`);
      continue;
    }
    const contenido = readFileSync(ruta);
    process.stdout.write(`  ${ruta} sha256:${createHash('sha256').update(contenido).digest('hex')}\n`);
    resumenes.push(JSON.parse(contenido.toString('utf8')));
  }
  const { results, problemas } = fusionarResultados(resumenes, total);
  const reparto = verificarReparto(directorio, total, SUITES.filter((name) => !ENTERAS.has(name)));
  process.stdout.write(`\nreparto de ficheros entre ${total} trozos (cada invocacion, entera y sin repetir):\n`);
  for (const linea of reparto.resumen) process.stdout.write(`  ${linea}\n`);
  const roja = informar(results);
  const todos = [...faltan, ...problemas, ...reparto.problemas];
  if (todos.length === 0) return roja;
  process.stdout.write(`\nFUSION ROJA: los trozos no acreditan la matriz entera\n${todos.map((problema) => `  - ${problema}`).join('\n')}\n`);
  return 1;
}

async function main() {
  const fusion = process.env.CAUCE_TEST_SHARD_MERGE;
  if (fusion !== undefined && fusion !== '') {
    process.exitCode = fusionar(Number(fusion));
    return;
  }
  await assertMatrixIsComplete();
  const trozo = leerTrozo();
  const destino = trozo === undefined ? undefined : repartoDeEnteras(trozo.total);
  const results = [];
  for (const name of SUITES) {
    if (trozo === undefined) {
      results.push(await runSuite(name));
      continue;
    }
    if (ENTERAS.has(name) && destino.get(name) !== trozo.indice) {
      process.stdout.write(`\n=== ${name}: entera en el trozo ${destino.get(name)}/${trozo.total}\n`);
      results.push({ name, omitida: true });
      continue;
    }
    results.push(await runSuite(name, ENTERAS.has(name) ? sinTrozo() : { ...process.env, CAUCE_TEST_SUITE: name }));
  }
  process.exitCode = trozo === undefined ? informar(results) : cerrarTrozo(trozo, results);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
