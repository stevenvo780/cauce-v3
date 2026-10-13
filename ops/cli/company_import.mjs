import { randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const IMPORT_OPERATION = 'empresa importar';
export const IMPORT_HELP = `Uso: cauce platform empresa importar --inventario RUTA --email CORREO --nombre NOMBRE
       [--perfiles RUTA] [--clave-archivo RUTA] [--admin UUID] --dry-run|--apply

Da de alta la empresa del inventario con su dueño en la misma transacción (cauce_register_company),
le importa salas, agentes en borrador y membresías por la transferencia de configuración de la
plataforma, y verifica en esa transacción que queda aislada de las demás empresas. Con --perfiles
prepara además el perfil (contexto) de cada agente en borrador, sin pisar uno que ya exista.
Es idempotente: repetirla sobre una empresa ya importada no cambia nada.
--dry-run ejecuta todo y lo deshace; --apply lo confirma.
--email (o CAUCE_IMPORT_OWNER_EMAIL): correo del dueño; nunca se guarda en el repositorio.
--clave-archivo: archivo privado (0600) con la contraseña inicial del dueño; solo hace falta con
  --apply cuando hay que crearlo.
--perfiles: archivo privado con la exportación de solo lectura de los perfiles vivos del origen.
Actor: --admin UUID, CAUCE_PLATFORM_ADMIN_ID o el platform_admin activo más antiguo.
Conexión: DATABASE_URL_FILE o DATABASE_URL del dueño del esquema; nunca se imprime.
`;

const COMPANY = /^[a-z][a-z0-9_-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const OPTIONS = new Set(['inventario', 'perfiles', 'clave-archivo', 'email', 'nombre', 'admin']);
const PROFILE_FIELDS = ['tenant_id', 'alias', 'purpose', 'role_summary', 'human_brief', 'responsibilities',
  'restrictions', 'tools', 'operating_rules'];

export class UsageError extends Error {}
export class ImportRejected extends Error {}
class DryRunRollback extends Error { constructor(result) { super('dry run'); this.result = result; } }

export function parseImportArguments(argv, environment = process.env) {
  if (`${argv[0]} ${argv[1]}` !== IMPORT_OPERATION) throw new UsageError('Operación desconocida; consultar --help.');
  const values = new Map(); const flags = new Set();
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run' || argument === '--apply') {
      if (flags.has(argument)) throw new UsageError(`${argument} no se puede repetir.`);
      flags.add(argument);
      continue;
    }
    const name = argument?.startsWith('--') ? argument.slice(2) : '';
    const value = argv[index + 1];
    if (!OPTIONS.has(name) || !value || value.startsWith('--')) throw new UsageError('Opción desconocida o sin valor; consultar --help.');
    if (values.has(name)) throw new UsageError(`--${name} no se puede repetir.`);
    if (value !== value.trim() || /\p{Cc}/u.test(value)) throw new UsageError(`--${name} contiene caracteres inválidos.`);
    values.set(name, value);
    index += 1;
  }
  if (flags.size !== 1) throw new UsageError('Elegí exactamente --dry-run o --apply.');
  const email = (values.get('email') ?? environment.CAUCE_IMPORT_OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new UsageError('Falta --email (o CAUCE_IMPORT_OWNER_EMAIL) o no es un correo válido.');
  const name = values.get('nombre');
  if (!name || name.length > 120) throw new UsageError('Falta --nombre del dueño (de 1 a 120 caracteres).');
  for (const option of ['inventario', 'perfiles', 'clave-archivo']) {
    if (values.has(option) && !isAbsolute(values.get(option))) throw new UsageError(`--${option} debe ser una ruta absoluta.`);
  }
  if (!values.has('inventario')) throw new UsageError('Falta --inventario.');
  const admin = (values.get('admin') ?? environment.CAUCE_PLATFORM_ADMIN_ID ?? null)?.toLowerCase() ?? null;
  if (admin !== null && !UUID.test(admin)) throw new UsageError('--admin o CAUCE_PLATFORM_ADMIN_ID debe ser un UUID.');
  return { inventory: values.get('inventario'), profiles: values.get('perfiles') ?? null,
    passwordFile: values.get('clave-archivo') ?? null, email, name, admin, dryRun: flags.has('--dry-run') };
}

async function readInput(path, label, { limit, secret }) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new UsageError(`No se pudo leer ${label}: debe ser un archivo regular sin enlace simbólico.`); }
  try {
    const state = await file.stat();
    if (!state.isFile() || state.size > limit) throw new UsageError(`${label} no es un archivo regular o supera el límite.`);
    if (secret && ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.())) {
      throw new UsageError(`${label} debe ser un archivo privado (0600) del usuario actual.`);
    }
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

function exact(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new UsageError(`${label} no tiene exactamente los campos ${keys.join(', ')}.`);
  }
  return value;
}
function list(value, label) {
  if (!Array.isArray(value) || value.length > 1000) throw new UsageError(`${label} debe ser una lista.`);
  return value;
}
function json(text, label) {
  try { return JSON.parse(text); } catch { throw new UsageError(`${label} no es JSON válido.`); }
}

/** The envelope is checked here; every record is validated again by the store's transfer bundle schema. */
export function parseInventory(text) {
  const value = exact(json(text, 'El inventario'), ['format', 'version', 'company', 'hub_edges', 'tenants', 'rooms', 'agents', 'memberships'], 'El inventario');
  if (value.format !== 'cauce-company-inventory' || value.version !== 1) throw new UsageError('El inventario no es cauce-company-inventory versión 1.');
  const company = exact(value.company, ['id', 'name'], 'company');
  if (!COMPANY.test(company.id) || typeof company.name !== 'string' || company.name.trim().length === 0 || company.name.length > 80) {
    throw new UsageError('company.id o company.name no son válidos.');
  }
  const edges = exact(value.hub_edges, ['allow_route', 'allow_read', 'allow_control'], 'hub_edges');
  if (Object.values(edges).some(flag => typeof flag !== 'boolean')) throw new UsageError('hub_edges solo admite booleanos.');
  for (const row of list(value.tenants, 'tenants')) exact(row, ['id', 'display_name', 'enabled'], 'Cada tenant');
  for (const row of list(value.rooms, 'rooms')) exact(row, ['tenant_id', 'id', 'display_name', 'enabled'], 'Cada sala');
  for (const row of list(value.agents, 'agents')) exact(row, ['tenant_id', 'alias', 'display_name', 'max_concurrent_deliveries'], 'Cada agente');
  for (const row of list(value.memberships, 'memberships')) exact(row, ['tenant_id', 'room_id', 'alias', 'role', 'enabled'], 'Cada membresía');
  if (value.tenants.length === 0) throw new UsageError('El inventario no declara ningún tenant.');
  return value;
}

/** The live export names every enabled agent of its tenant: one the inventory lacks is drift, not something to drop silently. */
export function parseProfiles(text, inventory) {
  const value = exact(json(text, 'Los perfiles'), ['format', 'version', 'tenant_id', 'agents', 'profiles'], 'Los perfiles');
  if (value.format !== 'cauce-agent-profiles' || value.version !== 1) throw new UsageError('Los perfiles no son cauce-agent-profiles versión 1.');
  const declared = inventory.agents.filter(agent => agent.tenant_id === value.tenant_id).map(agent => agent.alias).sort();
  const live = list(value.agents, 'agents').map(agent => exact(agent, ['alias', 'display_name'], 'Cada agente vivo').alias).sort();
  if (declared.length === 0 || JSON.stringify(declared) !== JSON.stringify(live)) {
    throw new UsageError(`Deriva entre el inventario (${declared.join(', ')}) y los agentes vivos de ${value.tenant_id} (${live.join(', ')}).`);
  }
  const profiles = new Map();
  for (const profile of list(value.profiles, 'profiles')) {
    exact(profile, PROFILE_FIELDS, 'Cada perfil');
    if (profile.tenant_id !== value.tenant_id || !declared.includes(profile.alias) || profiles.has(profile.alias)) {
      throw new UsageError('Cada perfil debe ser de un agente del inventario y aparecer una sola vez.');
    }
    profiles.set(profile.alias, profile);
  }
  return [...profiles.values()];
}

function readPassword(text) {
  const password = text.replace(/\r?\n$/u, '');
  if (password.length < 12 || password.length > 1024) throw new UsageError('La contraseña inicial debe tener de 12 a 1024 caracteres.');
  return password;
}

async function load(source, compiled) {
  const root = new URL('../../', import.meta.url);
  if (existsSync(new URL(source, root))) {
    let tsImport;
    try { ({ tsImport } = await import('tsx/esm/api')); } catch { tsImport = null; }
    if (tsImport) return tsImport(new URL(source, root).href, import.meta.url);
  }
  if (existsSync(new URL(compiled, root))) return import(new URL(compiled, root).href);
  throw new Error('falta tsx y la capa compilada del runtime; usá cauce platform contenedor');
}

/** The company hub comes from the registration: it is copied as it is so the hub edges stay inside the bundle. */
export function buildBundle(sha256Hex, current, inventory) {
  const hub = current.records.tenants.find(tenant => tenant.is_hub);
  if (!hub) throw new ImportRejected(`la empresa ${current.company_id} no tiene hub`);
  if (inventory.tenants.some(tenant => tenant.id === hub.id)) throw new ImportRejected('el inventario no puede redefinir el hub de la empresa');
  const placed = new Map(current.records.agents.map(agent => [`${agent.tenant_id}/${agent.alias}`, agent.runtime]));
  const records = {
    tenants: [hub, ...inventory.tenants.map(tenant => ({ ...tenant, is_hub: false }))],
    rooms: inventory.rooms,
    agents: inventory.agents.map(agent => ({ ...agent, runtime: placed.get(`${agent.tenant_id}/${agent.alias}`) ?? null })),
    memberships: inventory.memberships,
    acl_edges: inventory.tenants.flatMap(tenant => [[hub.id, tenant.id], [tenant.id, hub.id]]
      .map(([from, to]) => ({ from_tenant: from, to_tenant: to, enabled: true, ...inventory.hub_edges }))),
  };
  const payload = { format: 'cauce-company-configuration', version: 1, company_id: current.company_id,
    schema_version: current.schema_version, source_revision: current.source_revision, mode: 'upsert_only', records };
  return { ...payload, bundle_sha256: sha256Hex(payload) };
}

function describe(mutation) {
  const target = { tenant: mutation.id, room: `${mutation.tenant_id}/${mutation.id}`, agent: `${mutation.tenant_id}/${mutation.alias}`,
    membership: `${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}`, acl_edge: `${mutation.from_tenant}->${mutation.to_tenant}` };
  return `${mutation.action} ${mutation.resource} ${target[mutation.resource] ?? ''}`.trim();
}

async function platformAdmin(client, requested) {
  const admin = (await client.query(`SELECT u.id::text AS id,u.tenant_id,u.alias FROM platform_admins a
    JOIN console_users u ON u.id=a.human_id WHERE u.active AND u.role='operator' AND ($1::uuid IS NULL OR u.id=$1::uuid)
    ORDER BY a.created_at,a.human_id LIMIT 1`, [requested])).rows[0];
  if (!admin) throw new ImportRejected('no hay un platform_admin activo que actúe');
  return admin;
}

async function ensureOwner(client, hashPassword, { company, email, name, password, dryRun }) {
  const existing = (await client.query('SELECT enabled AND retired_at IS NULL AS usable FROM companies WHERE id=$1 FOR SHARE', [company.id])).rows[0];
  const person = (await client.query(`SELECT id::text AS id,company_id,tenant_id,alias FROM console_users
    WHERE email_normalized=$1 FOR SHARE`, [email])).rows[0];
  if (existing) {
    if (!existing.usable) throw new ImportRejected(`la empresa ${company.id} existe pero está deshabilitada o retirada`);
    const owner = person?.company_id === company.id && (await client.query(
      "SELECT 1 FROM company_admins WHERE company_id=$1 AND human_id=$2 AND role='owner'", [company.id, person.id])).rowCount === 1;
    if (!owner) throw new ImportRejected(`la empresa ${company.id} ya existe y ${email} no es su dueño`);
    return { ...person, state: 'existing' };
  }
  if (person) throw new ImportRejected(`${email} ya tiene cuenta en la empresa ${person.company_id}; no se crea otra`);
  if (password === null && !dryRun) throw new ImportRejected('crear al dueño exige --clave-archivo con su contraseña inicial');
  const hash = await hashPassword(password ?? randomBytes(24).toString('base64url'));
  const created = (await client.query(`SELECT human_id::text AS id,tenant_id,actor_alias AS alias
    FROM cauce_register_company($1,$2,$3,$4,$5)`, [email, name, hash, company.id, company.name])).rows[0];
  return { ...created, company_id: company.id, state: dryRun ? 'planned' : 'created', password_required: password === null };
}

async function fingerprint(client, store, others, actorFor, pool) {
  const configurations = {};
  for (const other of others) configurations[other] = (await store.exportCompanyConfiguration(pool, actorFor(other), client)).bundle_sha256;
  const people = (await client.query(`SELECT md5(COALESCE((SELECT string_agg(concat_ws(':',u.id,u.company_id,u.tenant_id,u.alias,u.active,u.role),','
      ORDER BY u.id) FROM console_users u WHERE u.company_id=ANY($1::text[])),'')
    || COALESCE((SELECT string_agg(concat_ws(':',a.company_id,a.human_id,a.role),',' ORDER BY a.company_id,a.human_id)
      FROM company_admins a WHERE a.company_id=ANY($1::text[])),'')) AS value`, [others])).rows[0].value;
  return JSON.stringify({ configurations, people });
}

async function verifyIsolation(client, store, { company, inventory, owner, others, before, after }) {
  const checks = [];
  const check = (name, ok) => { checks.push({ check: name, ok }); };
  const tenants = (await client.query('SELECT id,company_id,is_hub FROM tenants WHERE company_id=$1 OR id=ANY($2::text[])',
    [company, inventory.tenants.map(tenant => tenant.id)])).rows;
  check('inventory_tenants_belong_to_company', inventory.tenants.every(wanted =>
    tenants.some(tenant => tenant.id === wanted.id && tenant.company_id === company && !tenant.is_hub)));
  check('company_has_one_hub', tenants.filter(tenant => tenant.company_id === company && tenant.is_hub).length === 1);
  const counts = (await client.query(`SELECT
      (SELECT count(*)::int FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
        WHERE (tenant.company_id=$1) <> (agent.company_id=$1)) AS stray_agents,
      (SELECT count(*)::int FROM acl_edges edge JOIN tenants source ON source.id=edge.from_tenant JOIN tenants target ON target.id=edge.to_tenant
        WHERE (source.company_id=$1) <> (target.company_id=$1)) AS cross_edges,
      (SELECT count(*)::int FROM company_links WHERE company_a=$1 OR company_b=$1) AS links`, [company])).rows[0];
  check('agents_belong_to_their_tenant_company', counts.stray_agents === 0);
  check('no_cross_company_routes', counts.cross_edges === 0);
  check('no_company_links', counts.links === 0);
  const scope = (await client.query(`SELECT u.company_id,
      ARRAY(SELECT DISTINCT tenant.company_id FROM human_tenant_memberships h JOIN tenants tenant ON tenant.id=h.tenant_id
        WHERE h.human_id=u.id AND h.revoked_at IS NULL) AS membership_companies,
      ARRAY(SELECT DISTINCT a.company_id FROM company_admins a WHERE a.human_id=u.id) AS admin_companies,
      EXISTS(SELECT 1 FROM platform_admins p WHERE p.human_id=u.id) AS platform
    FROM console_users u WHERE u.id=$1`, [owner.id])).rows[0];
  check('owner_confined_to_company', scope?.company_id === company && !scope.platform
    && JSON.stringify(scope.membership_companies) === JSON.stringify([company]) && JSON.stringify(scope.admin_companies) === JSON.stringify([company]));
  const own = await store.lockCompanyAuthority(client, { tenant: owner.tenant_id, alias: owner.alias, humanId: owner.id,
    requestedCompany: others[0] ?? company });
  check('owner_acts_only_on_company', own.role === 'company_owner' && own.scope === 'company' && own.actingCompany === company);
  const foreign = (await client.query(`SELECT DISTINCT u.id::text AS id,u.tenant_id,u.alias FROM company_admins a
    JOIN console_users u ON u.id=a.human_id WHERE a.company_id<>$1 AND u.company_id<>$1 AND u.active
      AND NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.human_id=u.id) ORDER BY 1`, [company])).rows;
  let leaked = 0;
  for (const person of foreign) {
    try {
      const authority = await store.lockCompanyAuthority(client, { tenant: person.tenant_id, alias: person.alias, humanId: person.id, requestedCompany: company });
      if (authority.actingCompany === company) leaked += 1;
    } catch (error) { if (!(error instanceof store.StoreError)) throw error; }
  }
  check('foreign_administrators_excluded', leaked === 0);
  check('other_companies_unchanged', before === after);
  return checks;
}

function normalizeProfiles(protocol, profiles) {
  return profiles.map(input => {
    try { return protocol.normalizeAgentProfile(input); }
    catch (error) { throw new ImportRejected(`el perfil de ${input.alias} no es válido (${error instanceof Error ? error.message : 'perfil'})`); }
  });
}

/** Runs after the configuration commits: an existing profile is never overwritten, so a later edit by the owner survives a re-run. */
async function prepareProfiles(context, profiles, { company, admin, dryRun }) {
  const { store, protocol, pool } = context;
  const repository = new store.AgentProfileRepository(pool);
  const actor = { tenant_id: admin.tenant_id, alias: admin.alias, subject: `console:${admin.id}`,
    reason: `Importación de ${company} desde el inventario del origen`,
    humanAuthority: async () => ({ humanId: admin.id, tenantId: admin.tenant_id, actorAlias: admin.alias }),
    companyAuthority: client => store.lockCompanyAuthority(client, { tenant: admin.tenant_id, alias: admin.alias, humanId: admin.id, requestedCompany: company }) };
  const states = [];
  for (const profile of profiles) {
    const current = await repository.readWithPresence(profile.tenant_id, profile.alias);
    let state;
    if (current.exists) state = protocol.sha256Hex(current.perfil) === protocol.sha256Hex(profile) ? 'existing' : 'kept_differs';
    else if (dryRun) state = 'planned';
    else { await repository.prepareDraft(profile, null, actor); state = 'prepared'; }
    states.push({ tenant_id: profile.tenant_id, alias: profile.alias, state });
  }
  return states;
}

export async function runImport(context, input) {
  const { store, protocol, hashPassword, pool } = context;
  const { inventory, profiles, email, name, password, admin: requestedAdmin, dryRun } = input;
  const company = inventory.company.id;
  const desiredProfiles = profiles === null ? null : normalizeProfiles(protocol, profiles);
  let outcome;
  try {
    outcome = await store.withTransaction(pool, async client => {
      await client.query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','120s',true)");
      const admin = await platformAdmin(client, requestedAdmin);
      const actorFor = id => ({ humanId: admin.id, tenant: admin.tenant_id, alias: admin.alias, companyId: id });
      const others = (await client.query('SELECT id FROM companies WHERE id<>$1 AND enabled AND retired_at IS NULL ORDER BY id',
        [company])).rows.map(row => row.id);
      const before = await fingerprint(client, store, others, actorFor, pool);
      const owner = await ensureOwner(client, hashPassword, { company: inventory.company, email, name, password, dryRun });
      const current = await store.exportCompanyConfiguration(pool, actorFor(company), client);
      const bundle = buildBundle(protocol.sha256Hex, current, inventory);
      const plan = await store.planCompanyConfigurationImport(pool, actorFor(company), bundle, current.source_revision,
        { transactionClient: client });
      const changed = plan.mutations.length > 0 || plan.fleet_requests.length > 0;
      const receipt = changed
        ? await store.importCompanyConfiguration(pool, actorFor(company), bundle, plan, false, { transactionClient: client }) : null;
      const after = await fingerprint(client, store, others, actorFor, pool);
      const isolation = await verifyIsolation(client, store, { company, inventory, owner, others, before, after });
      const failed = isolation.filter(item => !item.ok).map(item => item.check);
      if (failed.length > 0) throw new ImportRejected(`el aislamiento no se cumple (${failed.join(', ')}); no se confirmó nada`);
      const result = { admin, owner, isolation, configuration: { source_revision: current.source_revision,
        revision: receipt?.revision ?? current.source_revision, bundle_sha256: bundle.bundle_sha256, plan_sha256: plan.plan_sha256,
        mutations: plan.mutations.map(describe) } };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    outcome = error.result;
  }
  let profileStates = [];
  try {
    if (desiredProfiles !== null) profileStates = await prepareProfiles(context, desiredProfiles, { company, admin: outcome.admin, dryRun });
  } catch (error) {
    if (dryRun) throw error;
    throw new ImportRejected('la empresa y su configuración quedaron confirmadas, pero no se prepararon todos los perfiles '
      + `(${typeof error?.code === 'string' ? error.code : 'error'}); repetir el mismo comando completa lo que falta`);
  }
  const owner = { email, state: outcome.owner.state,
    ...(outcome.owner.password_required === undefined ? {} : { password_required: outcome.owner.password_required }) };
  return { operation: IMPORT_OPERATION, company, dry_run: dryRun, applied: !dryRun, owner,
    configuration: outcome.configuration, profiles: profileStates, isolation: outcome.isolation, physical_effect_verified: false };
}

/**
 * Reached only through platform_admin.mjs, which hands over its connection helpers: importing that
 * module from here would wait on its own top-level await and never settle.
 */
export async function main(argv, { databaseUrl, isDatabaseError, localReason, sanitizeEnvironment, UsageError: SharedUsageError }) {
  if (argv.length === 3 && ['--help', '-h'].includes(argv[2])) {
    process.stdout.write(IMPORT_HELP);
    return 0;
  }
  let options, url, inventory, profiles = null, password = null;
  try {
    options = parseImportArguments(argv);
    inventory = parseInventory(await readInput(options.inventory, '--inventario', { limit: 1024 * 1024, secret: false }));
    if (options.profiles) profiles = parseProfiles(await readInput(options.profiles, '--perfiles', { limit: 4 * 1024 * 1024, secret: true }), inventory);
    if (options.passwordFile) password = readPassword(await readInput(options.passwordFile, '--clave-archivo', { limit: 4096, secret: true }));
    sanitizeEnvironment(process.env);
    url = await databaseUrl(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError || error instanceof SharedUsageError ? error.message : 'Entrada inválida.'}\n`);
    return 2;
  }
  let pool;
  try {
    const [store, protocol, passwords] = await Promise.all([
      load('packages/store/src/index.ts', 'packages/store/dist/index.js'),
      load('packages/protocol/src/index.ts', 'packages/protocol/dist/index.js'),
      load('services/gateway/src/password.ts', 'services/gateway/dist/password.js'),
    ]);
    pool = store.createPool(url, { max: 1, applicationName: 'cauce-company-import' });
    const report = await runImport({ store, protocol, hashPassword: passwords.hashPassword, pool },
      { inventory, profiles, email: options.email, name: options.name, password, admin: options.admin, dryRun: options.dryRun });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ImportRejected) process.stderr.write(`Importación rechazada: ${error.message}.\n`);
    else if (isDatabaseError(error)) process.stderr.write(`Importación rechazada por PostgreSQL (${error.code}); no se confirmó nada.\n`);
    else if (typeof error?.code === 'string' && /^[a-z_]{1,32}$/u.test(error.code)) {
      process.stderr.write(`Importación rechazada (${error.code}): ${error.message}; no se confirmó nada.\n`);
    } else process.stderr.write(`Importación no enviada: ${localReason(error)}.\n`);
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
