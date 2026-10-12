#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HELP = `Uso: cauce platform <grupo> <operación> [opciones]
  admin semilla --email CORREO [--company ID --role owner|admin]
  admin otorgar|revocar --empresa ID --id UUID [--email CORREO --rol owner|admin]
  empresa estado --empresa ID --estado enabled|disabled|retired [--si]
  enlace crear|borrar --empresa ID --otra-empresa ID

semilla es idempotente: sin --company hace platform_admin a la persona; con --company le da el rol
(owner por defecto) usando como actor --admin, CAUCE_PLATFORM_ADMIN_ID o el platform_admin más antiguo.
Actor: --admin UUID o CAUCE_PLATFORM_ADMIN_ID (SA activo).
Conexión: DATABASE_URL_FILE o DATABASE_URL; nunca se imprime. Un servidor remoto exige
sslmode require, verify-ca o verify-full; las variables PG* que alteran la sesión se descartan.
En producción se ejecuta dentro de la imagen de runtime: cauce platform contenedor <grupo> ...
Para la siembra atómica, repetir --id y --email en admin otorgar.
Deshabilitar o retirar una empresa pide confirmación; --si la da por escrito.
Bloqueadas: empresa crear (054 exige un dueño en la misma transacción), y roles, principales,
hosts, catálogo y contraseña (sus funciones SQL aún no existen en 054).
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COMPANY = /^[a-z][a-z0-9_-]{0,63}$/u;
const MISSING_FUNCTION = 'falta su función SQL cauce_platform_* en 053/054';
const UNSUPPORTED = new Map([
  ['empresa crear', 'cauce_platform_create_company no puede confirmar sin un dueño en la misma transacción (054)'],
  ...['empresa roles', 'empresa principales', 'host registrar', 'host asignar', 'catalogo aplicar',
    'persona contraseña'].map(operation => [operation, MISSING_FUNCTION]),
]);
const OPERATIONS = {
  'admin otorgar': { function: 'grant_admin', fields: ['empresa', 'id', 'email', 'rol'], repeated: ['id', 'email'] },
  'admin revocar': { function: 'revoke_admin', fields: ['empresa', 'id'], repeated: ['id'] },
  'empresa estado': { function: 'set_company_state', fields: ['empresa', 'estado'], flags: ['si'] },
  'enlace crear': { function: 'link', fields: ['empresa', 'otra-empresa'] },
  'enlace borrar': { function: 'unlink', fields: ['empresa', 'otra-empresa'] },
};
const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);
const STRONG_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const KEPT_PG_VARIABLES = new Set(['PGSSLMODE', 'PGSSLROOTCERT']);
const SQLSTATE = /^[0-9A-Z]{5}$/u;

class UsageError extends Error {}
class LocalError extends Error {}
class SeedError extends Error {}

const SEED_OPERATION = 'admin semilla';

export function parseSeedArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    const value = argv[index + 1];
    if (!['email', 'company', 'role', 'admin'].includes(name) || !value || value.startsWith('--')) {
      throw new UsageError('Opción desconocida o sin valor; consultar --help.');
    }
    if (values.has(name)) throw new UsageError(`--${name} no se puede repetir.`);
    if (value !== value.trim() || /\p{Cc}/u.test(value)) throw new UsageError(`--${name} contiene caracteres inválidos.`);
    values.set(name, value);
  }
  const email = values.get('email')?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+$/u.test(email)) throw new UsageError('Falta --email o no es un correo válido.');
  const company = values.get('company') ?? null;
  if (company !== null && !COMPANY.test(company)) throw new UsageError('--company no es un id de empresa válido.');
  if (company === null && values.has('role')) throw new UsageError('--role exige --company.');
  const role = values.get('role') ?? 'owner';
  if (!['owner', 'admin'].includes(role)) throw new UsageError('--role debe ser owner o admin.');
  const actor = (values.get('admin') ?? environment.CAUCE_PLATFORM_ADMIN_ID ?? null)?.toLowerCase() ?? null;
  if (actor !== null && !UUID.test(actor)) throw new UsageError('--admin o CAUCE_PLATFORM_ADMIN_ID debe ser un UUID.');
  return { email, company, role, actor };
}

// Idempotent: it reads the current state first, so a repeated run writes nothing and audits nothing.
export async function seedAuthority(client, { email, company, role, actor }) {
  const person = (await client.query(
    `SELECT id::text AS id,active,role,company_id FROM console_users WHERE email_normalized=lower(btrim($1)) FOR SHARE`,
    [email])).rows[0];
  if (!person) throw new SeedError(`no existe ninguna persona con el correo ${email}; crea su cuenta de consola primero`);
  if (!person.active || person.role !== 'operator') {
    throw new SeedError(`la cuenta de ${email} debe estar activa y ser operator`);
  }
  if (company === null) {
    const inserted = await client.query(
      'INSERT INTO platform_admins(human_id) VALUES($1) ON CONFLICT (human_id) DO NOTHING RETURNING human_id', [person.id]);
    return inserted.rowCount === 1
      ? `${email} ahora es platform_admin.` : `${email} ya era platform_admin; sin cambios.`;
  }
  const current = (await client.query('SELECT role FROM company_admins WHERE company_id=$1 AND human_id=$2 FOR SHARE',
    [company, person.id])).rows[0];
  if (current?.role === role) return `${email} ya era ${role} de ${company}; sin cambios.`;
  const acting = actor ?? (await client.query(`SELECT a.human_id::text AS id FROM platform_admins a
    JOIN console_users u ON u.id=a.human_id WHERE u.active AND u.role='operator' ORDER BY a.created_at,a.human_id LIMIT 1`)).rows[0]?.id;
  if (!acting) throw new SeedError('no hay ningún platform_admin activo que actúe; siembra primero sin --company');
  await client.query('SELECT public.cauce_platform_grant_admin($1,$2,$3,$4,$5)', [company, person.id, email, role, acting]);
  return `${email} ahora es ${role} de ${company}.`;
}

export function parseArguments(argv, environment = process.env) {
  const operation = `${argv[0]} ${argv[1]}`;
  if (UNSUPPORTED.has(operation)) {
    throw new UsageError(`Operación bloqueada: ${UNSUPPORTED.get(operation)} (${operation}).`);
  }
  const spec = OPERATIONS[operation];
  if (!spec) throw new UsageError('Operación desconocida; consultar --help.');
  const options = {};
  const flags = new Set();
  const allowed = new Set([...spec.fields, 'admin']);
  for (let index = 2; index < argv.length;) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    if (spec.flags?.includes(name)) {
      flags.add(name);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!allowed.has(name) || !value || value.startsWith('--')) {
      throw new UsageError('Opción desconocida o sin valor; consultar --help.');
    }
    if (options[name] && !spec.repeated?.includes(name)) throw new UsageError(`--${name} no se puede repetir.`);
    (options[name] ??= []).push(value);
    index += 2;
  }
  const actor = options.admin?.[0] ?? environment.CAUCE_PLATFORM_ADMIN_ID;
  if (!actor || !UUID.test(actor)) throw new UsageError('--admin o CAUCE_PLATFORM_ADMIN_ID debe ser un UUID.');
  for (const field of spec.fields) {
    if (!options[field]) throw new UsageError(`Falta --${field}.`);
    for (const value of options[field]) {
      if (value !== value.trim() || /\p{Cc}/u.test(value)) throw new UsageError(`--${field} contiene caracteres inválidos.`);
    }
  }
  for (const field of ['empresa', 'otra-empresa']) {
    if (options[field] && !COMPANY.test(options[field][0])) {
      throw new UsageError(`--${field} no es un id de empresa válido.`);
    }
  }
  if (options.id) options.id = options.id.map(value => value.toLowerCase());
  if (options.id?.some(value => !UUID.test(value)) || new Set(options.id).size !== (options.id?.length ?? 0)) {
    throw new UsageError('--id debe contener UUID distintos.');
  }
  if (options.rol && !['owner', 'admin'].includes(options.rol[0])) throw new UsageError('--rol debe ser owner o admin.');
  if (options.estado && !['enabled', 'disabled', 'retired'].includes(options.estado[0])) {
    throw new UsageError('--estado debe ser enabled, disabled o retired.');
  }
  if (options.email && (options.email.length !== options.id.length
      || options.email.some(value => !/^[^\s@]+@[^\s@]+$/u.test(value)))) {
    throw new UsageError('Se exige un --email válido por cada --id, en el mismo orden.');
  }
  if ((options.id?.length ?? 1) > 100) throw new UsageError('Máximo 100 personas por transacción.');
  return { spec, options, flags, actor: actor.toLowerCase() };
}

export function planOperation(argv, environment = process.env) {
  const { spec, options, actor } = parseArguments(argv, environment);
  const count = options.id?.length ?? 1;
  const placeholders = spec.fields.map((_, index) => `$${index + 1}`).concat(`$${spec.fields.length + 1}`);
  const text = `SELECT public.cauce_platform_${spec.function}(${placeholders.join(',')})`;
  return Array.from({ length: count }, (_, index) => ({ text,
    values: [...spec.fields.map(field => options[field][spec.repeated?.includes(field) ? index : 0]), actor] }));
}

export function confirmationFor(argv, environment = process.env) {
  const { options, flags } = parseArguments(argv, environment);
  const state = options.estado?.[0];
  if (!state || state === 'enabled' || flags.has('si')) return null;
  return { company: options.empresa[0], state };
}

async function confirm(request, input = process.stdin, output = process.stderr) {
  if (!request) return;
  if (!input.isTTY) {
    throw new UsageError('Deshabilitar o retirar una empresa exige --si o una terminal para confirmar.');
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(
      `La empresa ${request.company} quedará ${request.state}. Escribí su id para confirmar: `);
    if (answer.trim() !== request.company) throw new UsageError('Confirmación rechazada; no se cambió nada.');
  } finally {
    prompt.close();
  }
}

// Every PG* variable except the TLS pair is dropped: libpq-style variables would otherwise
// redirect node-postgres (host, user, options, application name) behind the URL's back.
export function sanitizeEnvironment(environment = process.env) {
  for (const name of Object.keys(environment)) {
    if (name.startsWith('PG') && !KEPT_PG_VARIABLES.has(name)) delete environment[name];
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new UsageError('NODE_TLS_REJECT_UNAUTHORIZED=0 desactiva la verificación TLS; quitala.');
  }
  if (environment.PGSSLMODE !== undefined && !SSL_MODES.has(environment.PGSSLMODE)) {
    throw new UsageError('PGSSLMODE no es un modo TLS válido.');
  }
  if (environment.PGSSLROOTCERT !== undefined && !isAbsolute(environment.PGSSLROOTCERT)) {
    throw new UsageError('PGSSLROOTCERT debe ser una ruta absoluta.');
  }
  return environment;
}

export async function databaseUrl(environment = process.env) {
  let url;
  if (environment.DATABASE_URL_FILE) {
    try { url = (await readFile(environment.DATABASE_URL_FILE, 'utf8')).trim(); }
    catch { throw new UsageError('No se pudo leer DATABASE_URL_FILE.'); }
  } else url = environment.DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) throw new Error();
  } catch { throw new UsageError('Se exige DATABASE_URL_FILE o DATABASE_URL con una conexión PostgreSQL válida.'); }
  for (const name of new Set(parsed.searchParams.keys())) {
    if (name !== 'sslmode') throw new UsageError(`La conexión no puede fijar «${name}».`);
  }
  if (parsed.searchParams.getAll('sslmode').length > 1) throw new UsageError('La conexión repite sslmode.');
  const mode = parsed.searchParams.get('sslmode') ?? environment.PGSSLMODE;
  if (mode !== undefined && !SSL_MODES.has(mode)) throw new UsageError('sslmode no es un modo TLS válido.');
  const loopback = ['localhost', '[::1]'].includes(parsed.hostname) || /^127\.\d+\.\d+\.\d+$/u.test(parsed.hostname);
  if (!loopback && !STRONG_SSL_MODES.has(mode)) {
    throw new UsageError('Una conexión remota exige sslmode require, verify-ca o verify-full.');
  }
  return url;
}

async function loadStore() {
  const source = new URL('../../packages/store/src/db.ts', import.meta.url);
  const compiled = new URL('../../packages/store/dist/db.js', import.meta.url);
  if (existsSync(source)) {
    let tsImport;
    try { ({ tsImport } = await import('tsx/esm/api')); }
    catch { tsImport = null; }
    if (tsImport) return tsImport(source.href, import.meta.url);
  }
  if (existsSync(compiled)) return import(compiled.href);
  throw new LocalError('falta tsx y la capa compilada del store; usá cauce platform contenedor');
}

function isDatabaseError(error) {
  return typeof error?.code === 'string' && SQLSTATE.test(error.code) && typeof error.severity === 'string';
}

function localReason(error) {
  if (error instanceof LocalError) return error.message;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 'ETIMEDOUT' || /timeout/iu.test(message)) return 'tiempo de espera agotado al conectar';
  if (/^production (PostgreSQL|DATABASE_URL)/u.test(message)) {
    return 'la política TLS de producción no se cumple (sslmode=verify-full y PGSSLROOTCERT)';
  }
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_)/u.test(code) || /\b(SSL|TLS|certificate)\b/iu.test(message)) {
    return 'la negociación TLS con PostgreSQL falló';
  }
  if (/^E[A-Z_]+$/u.test(code)) return `la red no llegó al servidor (${code})`;
  return 'error local antes de que PostgreSQL respondiera';
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  let plan, url, seed;
  try {
    if (`${argv[0]} ${argv[1]}` === SEED_OPERATION) seed = parseSeedArguments(argv);
    else plan = planOperation(argv);
    sanitizeEnvironment(process.env);
    url = await databaseUrl(process.env);
    if (!seed) await confirm(confirmationFor(argv));
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : 'Entrada inválida.'}\n`);
    return 2;
  }
  let pool;
  try {
    const { createPool, withTransaction } = await loadStore();
    pool = createPool(url, { max: 1, applicationName: 'cauce-platform-admin' });
    const message = await withTransaction(pool, async client => {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      if (seed) return seedAuthority(client, seed);
      for (const statement of plan) await client.query(statement.text, statement.values);
      return null;
    });
    if (seed) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stdout.write(`${plan.length} operación(es) confirmada(s); auditoría de plataforma registrada.\n`);
    return 0;
  } catch (error) {
    if (error instanceof SeedError) {
      process.stderr.write(`Operación rechazada: ${error.message}.\n`);
      return 1;
    }
    if (!isDatabaseError(error)) {
      process.stderr.write(`Operación no enviada: ${localReason(error)}.\n`);
      return 1;
    }
    const reason = { '23514': 'restricción de integridad o último dueño', '42501': 'autoridad insuficiente',
      '22023': 'persona, correo o rol no confirmados', 'P0002': 'objetivo inexistente', '23505': 'objetivo duplicado',
      '55P03': 'el esquema está bloqueado por una migración' }[error.code];
    process.stderr.write(`Operación rechazada por PostgreSQL (${error.code})${reason ? `: ${reason}` : ''}.\n`);
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
