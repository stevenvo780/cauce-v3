#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrl, sanitizeEnvironment } from './platform_admin.mjs';

const HELP = `Uso: cauce platform contexto sembrar [--empresa ID] [--nativos DIR] [--simular]

Registra la versión 1 del historial de contextos de cada agente activo que todavía no tiene
ninguna, con su perfil canónico y, con --nativos, sus documentos nativos de
DIR/<tenant>/<alias>/context/ y DIR/<tenant>/<alias>/directives/ (sin enlaces simbólicos; un
context/profile.json en disco se ignora porque manda el perfil de la base). Cada versión queda en
la cola del broker de Git en la misma transacción.
Es idempotente: un agente que ya tiene historial no recibe versiones nuevas.
--simular muestra el plan sin escribir nada.
Conexión: DATABASE_URL_FILE o DATABASE_URL del dueño del esquema; nunca se imprime.
`;
const COMPANY = /^[a-z][a-z0-9_-]{0,63}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;

class UsageError extends Error {}

export function parseContextSeedArguments(argv) {
  if (argv[0] !== 'contexto' || argv[1] !== 'sembrar') throw new UsageError('Operación desconocida; consultar --help.');
  const options = { company: undefined, natives: undefined, dryRun: false };
  const seen = new Set();
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    if (seen.has(name)) throw new UsageError(`--${name} no se puede repetir.`);
    seen.add(name);
    if (name === 'simular') { options.dryRun = true; continue; }
    const value = argv[index + 1];
    if (!['empresa', 'nativos'].includes(name) || !value || value.startsWith('--')) {
      throw new UsageError('Opción desconocida o sin valor; consultar --help.');
    }
    if (value !== value.trim() || /\p{Cc}/u.test(value)) throw new UsageError(`--${name} contiene caracteres inválidos.`);
    if (name === 'empresa' && !COMPANY.test(value)) throw new UsageError('--empresa no es un id de empresa válido.');
    if (name === 'empresa') options.company = value;
    else options.natives = resolve(value);
    index += 1;
  }
  return options;
}

async function loadModule(name) {
  const source = new URL(`../../packages/store/src/${name}.ts`, import.meta.url);
  const compiled = new URL(`../../packages/store/dist/${name}.js`, import.meta.url);
  if (existsSync(source)) {
    let tsImport;
    try { ({ tsImport } = await import('tsx/esm/api')); }
    catch { tsImport = null; }
    if (tsImport) return tsImport(source.href, import.meta.url);
  }
  if (existsSync(compiled)) return import(compiled.href);
  throw new Error('falta tsx y la capa compilada del store');
}

export function summarize(results) {
  const summary = { seeded: 0, planned: 0, existing: 0, empty: 0 };
  for (const result of results) summary[result.state] += 1;
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  let options, url;
  try {
    options = parseContextSeedArguments(argv);
    sanitizeEnvironment(process.env);
    url = await databaseUrl(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Entrada inválida.'}\n`);
    return 2;
  }
  let pool;
  try {
    const [{ createPool }, { nativeContextDirectory, seedAgentContextHistory }] = await Promise.all([loadModule('db'), loadModule('context-seed')]);
    pool = createPool(url, { max: 1, applicationName: 'cauce-context-seed' });
    const results = await seedAgentContextHistory(pool, { ...(options.company ? { company: options.company } : {}),
      ...(options.natives ? { natives: nativeContextDirectory(options.natives) } : {}), dryRun: options.dryRun });
    process.stdout.write(`${JSON.stringify({ simulated: options.dryRun, summary: summarize(results), agents: results }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && SQLSTATE.test(error.code) ? ` (PostgreSQL ${error.code})` : '';
    const reason = code === '' && typeof error?.message === 'string' && /^native context /u.test(error.message) ? `: ${error.message}` : '';
    process.stderr.write(`Siembra interrumpida${code}${reason}; los agentes ya sembrados se conservan y repetirla es seguro.\n`);
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}
