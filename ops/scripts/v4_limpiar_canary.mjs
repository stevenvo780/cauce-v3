#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANARY = /^zz-canary-[a-z0-9_-]{1,54}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HELP = `Uso: node ops/scripts/v4_limpiar_canary.mjs [--simular | --aplicar --admin UUID] [--empresa zz-canary-ID]
Sin opciones solo inventaría y planifica con SELECT en una transacción READ ONLY que termina en ROLLBACK.
--aplicar usa autoridad de plataforma y operaciones canónicas; nunca confirma efectos físicos al encolar.
Los recursos físicos avanzan por fases: repetir explícitamente tras comprobar el resultado de cada operación.
Las copias de espacio y los entornos de cuota conservados requieren resolución por su vía canónica.
Conexión: DATABASE_URL_FILE; ejecución por stdin: node --input-type=module - --simular < script.mjs
`;

export function assertCanary(company) {
  if (!CANARY.test(company)) throw new Error('Solo se admiten identificadores zz-canary- completos.');
}

export function parseArguments(argv) {
  const options = { apply: false, company: null, actor: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--simular', '--aplicar', '--empresa', '--admin'].includes(key) || seen.has(key)) {
      throw new Error('Opción desconocida o repetida; consultar --help.');
    }
    seen.add(key);
    if (key === '--aplicar') options.apply = true;
    else if (key !== '--simular') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Falta valor de ${key}.`);
      options[key === '--empresa' ? 'company' : 'actor'] = value;
    }
  }
  if (seen.has('--simular') && options.apply) throw new Error('--simular y --aplicar son excluyentes.');
  if (options.company !== null) assertCanary(options.company);
  if (options.actor !== null && !UUID.test(options.actor)) throw new Error('--admin debe ser un UUID.');
  if (options.apply && options.actor === null) throw new Error('--aplicar exige --admin UUID explícito.');
  return options;
}

export async function readInventory(pool, company = null) {
  if (company !== null) assertCanary(company);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    const companies = (await client.query(`SELECT id,enabled,retired_at,version::text FROM companies
      WHERE id LIKE 'zz-canary-%' AND ($1::text IS NULL OR id=$1) ORDER BY id`, [company])).rows;
    const inventory = [];
    for (const row of companies) {
      assertCanary(row.id);
      const read = async sql => (await client.query(sql, [row.id])).rows;
      const agents = await read(`SELECT tenant_id,alias,enabled,lifecycle_state,retired_at,purged_at,
        host_id,container_name,runtime_mode,runtime_key FROM agents WHERE company_id=$1 ORDER BY tenant_id,alias`);
      const hosts = await read(`SELECT host.host_id,host.enabled,host.version::text,
        identity.host_id IS NOT NULL AS enrolled,identity.enabled AS identity_enabled
        FROM fleet_hosts host LEFT JOIN fleet_host_identities identity ON identity.host_id=host.host_id
        WHERE host.company_id=$1 ORDER BY host.host_id`);
      const invitations = await read(`SELECT id::text,host_id,state,expires_at FROM fleet_host_enrollments
        WHERE company_id=$1 ORDER BY id`);
      const accounts = await read(`SELECT id,provider,payer_tenant_id,enabled FROM provider_accounts
        WHERE company_id=$1 ORDER BY id`);
      const environments = await read(`SELECT id::text,account_id,host_id,container_name,status FROM quota_environments
        WHERE company_id=$1 ORDER BY id`);
      const backups = await read(`SELECT id::text,host_id,status FROM space_backups WHERE company_id=$1 ORDER BY id`);
      const operations = await read(`SELECT 'fleet' AS kind,id::text,status FROM fleet_operations
        WHERE company_id=$1 AND status IN ('queued','running','awaiting_auth','cancelling','failed')
        UNION ALL SELECT 'quota_environment',id::text,status FROM quota_environment_operations
        WHERE company_id=$1 AND status IN ('pending','running','awaiting_auth')
        UNION ALL SELECT 'agent_quota',id::text,status FROM agent_quota_operations
        WHERE company_id=$1 AND status IN ('pending','running','awaiting_auth') ORDER BY kind,id`);
      const connections = await read(`SELECT lease.tenant_id,lease.alias FROM connection_leases lease
        JOIN tenants tenant ON tenant.id=lease.tenant_id WHERE tenant.company_id=$1 AND lease.lease_until>now()
        ORDER BY lease.tenant_id,lease.alias`);
      inventory.push({ company_id: row.id, enabled: row.enabled, retired_at: row.retired_at, version: row.version,
        agents, hosts, invitations, accounts, environments, backups, operations, connections });
    }
    return inventory;
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

function physicalAgents(item) {
  return item.agents.filter(agent => !agent.purged_at
    && [agent.host_id, agent.container_name, agent.runtime_mode, agent.runtime_key].some(value => value !== null));
}

export function inventoryPlan(item) {
  assertCanary(item.company_id);
  const blockers = [
    ...physicalAgents(item).map(agent => ({ kind: 'agent', tenant_id: agent.tenant_id, alias: agent.alias,
      next: agent.retired_at ? 'purge' : 'retire', remote_effect: 'not_verified' })),
    ...item.environments.filter(value => value.status !== 'deleted').map(value => ({ kind: 'quota_environment', id: value.id, status: value.status })),
    ...item.backups.map(value => ({ kind: 'retained_space_backup', id: value.id, status: value.status })),
    ...item.operations.map(value => ({ kind: `${value.kind}_operation`, id: value.id, status: value.status })),
    ...item.connections.map(value => ({ kind: 'connection', ...value })),
  ];
  return { company_id: item.company_id, mode: 'simulation', preflight: 'not_run_read_only_plan', blockers,
    next: blockers.length ? 'resolve_dependencies' : 'retire_and_attempt_canonical_purge_including_host_identities',
    company_retirement_required: item.retired_at === null,
    registry_agents: item.agents.filter(agent => !agent.purged_at && !physicalAgents(item).includes(agent)).length,
    backup: 'required_by_canonical_purge', foreign_references: 'checked_only_by_canonical_purge' };
}

async function resolveAuthority(store, client, actor, company) {
  if (company !== undefined) assertCanary(company);
  const request = (await client.query(`SELECT id AS "humanId",tenant_id AS tenant,alias FROM console_users
    WHERE id=$1 AND active AND role='operator'`, [actor])).rows[0];
  if (!request) throw Object.assign(new Error('unavailable actor'), { code: 'forbidden' });
  const authority = await store.lockCompanyAuthority(client, { ...request, ...(company === undefined ? {} : { requestedCompany: company }) });
  store.assertPlatformAdmin(authority);
  return authority;
}

export async function applyCompany(pool, store, item, actor, environment = process.env) {
  assertCanary(item.company_id);
  const company = item.company_id;
  const physical = physicalAgents(item);
  const plan = inventoryPlan(item);
  const blockers = plan.blockers.filter(value => !['agent', 'connection'].includes(value.kind));
  if (blockers.length || (item.connections.length && physical.length === 0)) {
    return { company_id: company, status: 'blocked', blockers: blockers.length ? blockers : plan.blockers };
  }
  const source = client => resolveAuthority(store, client, actor, company);
  if (physical.length) {
    if (!item.enabled || item.retired_at) return { company_id: company, status: 'blocked',
      blockers: [{ kind: 'company_authority_unavailable', next: 'resolve_physical_resources_via_authorized_gateway' }] };
    const agent = physical[0];
    const kind = agent.retired_at ? 'purge' : 'retire';
    const authority = await store.withTransaction(pool, source);
    const expected = await pool.query(`SELECT GREATEST(COALESCE((SELECT max(id) FROM config_revisions WHERE company_id=$1),0),
      COALESCE((SELECT max(id) FROM config_revisions WHERE scope='platform'),0))::text AS revision`, [company]);
    const revision = Number(expected.rows[0].revision);
    const key = createHash('sha256').update(JSON.stringify([company, agent.tenant_id, agent.alias, kind, revision])).digest('hex');
    const repository = new store.FleetOperationsRepository(pool, {
      ...(environment.CAUCE_FLEET_CONTROLLER_HOST ? { controllerHost: environment.CAUCE_FLEET_CONTROLLER_HOST } : {}),
    }).forAuthority(source);
    const operation = await repository.enqueue(authority.homeTenant, authority.alias, {
      kind, target: { resource: 'agent', tenant_id: agent.tenant_id, alias: agent.alias },
      expected_revision: revision, idempotency_key: `canary-${key}`,
      parameters: kind === 'purge' ? { confirm_alias: agent.alias } : {},
    }, `console:${actor}`);
    return { company_id: company, status: 'pending', operation_id: operation.id, kind,
      remote_effect: 'not_verified', next: 'verify_operation_then_rerun_explicitly' };
  }
  const receipt = await store.withTransaction(pool, async client => {
    const authority = await resolveAuthority(store, client, actor);
    const current = (await client.query('SELECT version::text,retired_at FROM companies WHERE id=$1', [company])).rows[0];
    if (!current) return { company_id: company, status: 'already_absent' };
    if (!current.retired_at) await store.updateCompany(client, authority, company, { expected_version: Number(current.version), state: 'retired' });
    const purged = await store.purgeCompany(client, authority, company, { confirmation: company },
      (_snapshot, serialized) => store.saveCompanyPurgeBackup(company, serialized));
    return { ...purged, status: 'purged' };
  });
  return { ...receipt, host_revocation: 'identities_and_invitations_removed_by_canonical_company_purge' };
}

export async function loadStore() {
  const runtime = resolve('packages/store/dist/index.js');
  if (existsSync(runtime)) return import(pathToFileURL(runtime).href);
  const { tsImport } = await import('tsx/esm/api');
  return tsImport(pathToFileURL(resolve('packages/store/src/index.ts')).href, import.meta.url);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? (value => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { process.stdout.write(HELP); return 0; }
  let options;
  try { options = parseArguments(argv); }
  catch (error) { output({ status: 'invalid_input', reason: error.message }); return 2; }
  let pool;
  try {
    const store = dependencies.store ?? await loadStore();
    if (options.apply && ['purgeCompany', 'saveCompanyPurgeBackup', 'updateCompany', 'lockCompanyAuthority', 'assertPlatformAdmin']
      .some(name => typeof store[name] !== 'function')) throw new Error('runtime store is incomplete');
    const url = dependencies.databaseUrl ?? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim();
    pool = store.createPool(url, { max: 2, applicationName: 'cauce-v4-canary-cleanup' });
    const inventory = await readInventory(pool, options.company);
    output({ mode: options.apply ? 'apply' : 'simulation', inventory, count: inventory.length });
    if (options.company && inventory.length === 0) output({ company_id: options.company, status: 'already_absent' });
    let incomplete = false;
    for (const item of inventory) {
      if (!options.apply) { output(inventoryPlan(item)); continue; }
      try {
        const result = await applyCompany(pool, store, item, options.actor);
        incomplete ||= result.status !== 'purged' && result.status !== 'already_absent';
        output(result);
      } catch (error) {
        incomplete = true;
        output({ company_id: item.company_id, status: 'blocked', code: error?.code ?? 'unconfirmed',
          blockers: typeof store.CompanyPurgeBlockedError === 'function' && error instanceof store.CompanyPurgeBlockedError ? error.blockers : undefined,
          reason: 'Operación canónica rechazada o sin confirmación; revisar dependencias, autoridad y recibos antes de reintentar.' });
      }
    }
    return incomplete ? 1 : 0;
  } catch (error) {
    output({ status: 'failed', code: /^[A-Z0-9_]{2,24}$/u.test(error?.code ?? '') ? error.code : 'unavailable',
      reason: 'No se completó el inventario; comprobar runtime y conexión sin exponer credenciales.' });
    return 1;
  } finally { await pool?.end().catch(() => undefined); }
}

if (process.argv[1] === '-' || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  process.exitCode = await main();
}
