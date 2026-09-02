#!/usr/bin/env node
/** Runs the whole test matrix to completion; non-zero exit if any suite fails or times out. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const TIMEOUTS = new Map([
  ['test:e2e', 40 * 60_000],
  ['test:integration', 40 * 60_000],
  ['test:store-hardening', 40 * 60_000],
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

function runSuite(name) {
  return new Promise((settle, fail) => {
    const startedAt = Date.now();
    const timeoutMs = TIMEOUTS.get(name) ?? DEFAULT_TIMEOUT_MS;
    process.stdout.write(`\n${'='.repeat(72)}\n=== ${name}\n${'='.repeat(72)}\n`);
    // Own process group so a wedged suite dies with its grandchildren, not just its pnpm wrapper.
    // Piped and re-emitted live instead of inherited: the counter reads each tally on the way out.
    const child = spawn('pnpm', ['run', name], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], detached: true });
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

async function main() {
  await assertMatrixIsComplete();
  const results = [];
  for (const name of SUITES) results.push(await runSuite(name));

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
  if (failed.length > 0) {
    process.stdout.write(`failed suites: ${failed.map((result) => result.name).join(' ')}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
