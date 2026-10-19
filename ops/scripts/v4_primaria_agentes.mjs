#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPANIES = ['humanizar', 'praxis'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HELP = `Uso: node ops/scripts/v4_primaria_agentes.mjs [--empresa humanizar|praxis] [--simular]
     node ops/scripts/v4_primaria_agentes.mjs --aplicar --empresa ID --actor UUID --revision N
También admite: docker exec -i GATEWAY node --input-type=module - [opciones] < ops/scripts/v4_primaria_agentes.mjs
Por defecto solo lee, con transacción REPEATABLE READ READ ONLY y ROLLBACK.
Las propuestas salen de bindings habilitados; no demuestran identidad efectiva.
--aplicar ENCOLA el update canónico: puede detener y volver a autenticar agentes.
La primaria solo cambia al ejecutar el flujo físico; encolar no acredita admisión.
Encola como máximo un agente; espera su cierre y vuelve a simular con revisión fresca.
Los agentes deshabilitados o en borrador requieren activación explícita por otro flujo.
Los legacy sin placement completo requieren adopción previa; nunca se inventa.
DATABASE_URL_FILE tiene prioridad; no se muestran credenciales ni identidades de proveedor.`;

export function parseArguments(args) {
  const options = { apply: false, companies: [...COMPANIES] };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('opción repetida');
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--aplicar') options.apply = true;
    else if (flag === '--simular') options.simulate = true;
    else if (['--empresa', '--actor', '--revision'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('falta el valor de una opción');
      if (flag === '--empresa') {
        if (!COMPANIES.includes(value)) throw new Error('empresa fuera del alcance');
        options.companies = [value];
      } else if (flag === '--actor') {
        if (!UUID.test(value)) throw new Error('actor inválido');
        options.actor = value;
      } else {
        if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('revisión inválida');
        options.revision = Number(value);
      }
    } else throw new Error('opción desconocida');
  }
  if (options.apply && (options.simulate || options.companies.length !== 1 || !options.actor || options.revision === undefined)) {
    throw new Error('--aplicar exige una empresa, actor humano y revisión CAS, sin --simular');
  }
  return options;
}

async function readAgents(client, companies) {
  return (await client.query(`SELECT agent.company_id,agent.tenant_id,agent.alias,agent.enabled,
    agent.lifecycle_state,agent.runtime_key,agent.harness_id,agent.display_name,agent.primary_room_id,
    agent.primary_account_id,agent.model_id,agent.reasoning_effort,agent.extensions,agent.host_id,
    agent.runtime_mode,agent.container_name,agent.runtime_user,agent.home_directory,agent.state_directory,agent.systemd_user,
    EXISTS(SELECT 1 FROM company_system_principals principal WHERE principal.tenant_id=agent.tenant_id
      AND principal.principal_alias=agent.alias AND to_jsonb(principal)->>'delivery_source_only'='true') AS system_delivery_source,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',binding.account_id,
      'provider',account.provider,'eligible',account.enabled AND
        (account.payer_tenant_id=agent.tenant_id OR account.shared_with_pool)) ORDER BY binding.account_id)
      FROM agent_account_bindings binding JOIN provider_accounts account ON account.id=binding.account_id
      WHERE binding.tenant_id=agent.tenant_id AND binding.agent_alias=agent.alias AND binding.enabled
        AND binding.company_id=agent.company_id AND account.company_id=agent.company_id),'[]'::jsonb) AS bindings,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('room_id',member.room_id,'role',member.role,
      'enabled',member.enabled) ORDER BY member.room_id) FROM memberships member
      WHERE member.tenant_id=agent.tenant_id AND member.alias=agent.alias AND member.retired_at IS NULL),'[]'::jsonb) AS memberships
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id JOIN companies company ON company.id=tenant.company_id
    WHERE company.id=ANY($1::text[]) AND company.enabled AND company.retired_at IS NULL
      AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND agent.retired_at IS NULL AND agent.purged_at IS NULL
    ORDER BY agent.company_id,agent.tenant_id,agent.alias`, [companies])).rows;
}

export function proposePrimary(agent, revision) {
  const proposal = { company_id: agent.company_id, tenant_id: agent.tenant_id, alias: agent.alias,
    enabled: agent.enabled, lifecycle_state: agent.lifecycle_state, primary_account_id: agent.primary_account_id,
    bindings: agent.bindings, proposed_account_id: null, effective_identity: 'sin confirmar',
    system_delivery_source: agent.system_delivery_source === true, status: 'sin bindings habilitados' };
  if (proposal.system_delivery_source) return { ...proposal, status: 'principal interno sin ejecución; no se modifica' };
  if (agent.bindings.length > 1) proposal.status = 'decide el dueño';
  if (agent.primary_account_id !== null) return { ...proposal,
    status: agent.bindings.length > 1 ? 'primaria existente; se conserva; decide el dueño entre bindings' : 'primaria existente; se conserva' };
  if (agent.bindings.length !== 1) return proposal;
  proposal.proposed_account_id = agent.bindings[0].account_id;
  if (!agent.bindings[0].eligible) return { ...proposal, status: 'cuenta deshabilitada o sin consentimiento del pagador' };
  if (!agent.enabled || agent.lifecycle_state === 'draft') return { ...proposal,
    status: 'agente deshabilitado o borrador; requiere activación explícita del dueño' };
  const required = ['runtime_key', 'harness_id', 'primary_room_id', 'host_id', 'runtime_mode', 'container_name',
    'runtime_user', 'home_directory', 'state_directory', 'systemd_user'];
  const missing = required.filter(field => !agent[field]);
  if (missing.length || !['container', 'native'].includes(agent.runtime_mode) || !agent.memberships.length) {
    return { ...proposal, status: 'requiere adopción o placement completo', missing };
  }
  const identity = [agent.company_id, agent.tenant_id, agent.alias, proposal.proposed_account_id];
  const request = { kind: 'update', target: { resource: 'agent', tenant_id: agent.tenant_id, alias: agent.alias },
    expected_revision: revision, idempotency_key: `qa9-primary-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    parameters: { runtime_key: agent.runtime_key, harness_id: agent.harness_id, display_name: agent.display_name,
      primary_room_id: agent.primary_room_id, memberships: agent.memberships, primary_account_id: proposal.proposed_account_id,
      model_id: agent.model_id, reasoning_effort: agent.reasoning_effort, extensions: agent.extensions,
      placement: { host_id: agent.host_id, mode: agent.runtime_mode, container_name: agent.container_name, runtime_user: agent.runtime_user,
        home_directory: agent.home_directory, state_directory: agent.state_directory, systemd_user: agent.systemd_user } } };
  return { ...proposal, status: 'propuesta; requiere validación canónica y ejecución física', request };
}

export async function runPrimary({ pool, store, options }) {
  const client = await pool.connect();
  try {
    await client.query(options.apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    let actor;
    if (options.apply) {
      await store.lockFleetRevision(client);
      actor = (await client.query('SELECT tenant_id,alias FROM console_users WHERE id=$1', [options.actor])).rows[0];
      if (!actor) throw Object.assign(new Error('autoridad humana no disponible'), { code: 'forbidden' });
      const authority = await store.lockCompanyAuthority(client, { tenant: actor.tenant_id, alias: actor.alias,
        humanId: options.actor, requestedCompany: options.companies[0] });
      if (authority.actingCompany !== options.companies[0] || !['company', 'platform'].includes(authority.scope)) {
        throw Object.assign(new Error('autoridad de empresa no disponible'), { code: 'forbidden' });
      }
    }
    const revisions = {};
    for (const company of options.companies) revisions[company] = await store.companyRevision(client, company);
    const agents = await readAgents(client, options.companies);
    const proposals = agents.map(agent => proposePrimary(agent, options.revision ?? revisions[agent.company_id]));
    const report = { mode: options.apply ? 'aplicar' : 'simular', revisions, effective_identity: 'sin confirmar',
      canonical_preview_executed: false, operations_enqueued: 0, proposals };
    if (options.apply) {
      const repository = new store.FleetOperationsRepository(pool, { transactionClient: client }).forCompany(options.companies[0]);
      const subject = `console:${options.actor}`;
      const pending = (await client.query(`SELECT id FROM fleet_operations WHERE company_id=$1
        AND idempotency_key LIKE 'qa9-primary-%' AND status NOT IN ('succeeded','cancelled') LIMIT 1`, [options.companies[0]])).rows[0];
      for (const proposal of proposals) {
        if (!proposal.request) continue;
        const prior = (await client.query(`SELECT id FROM fleet_operations WHERE actor_tenant=$1 AND actor_alias=$2
          AND idempotency_key=$3 AND company_id=$4`, [actor.tenant_id, actor.alias, proposal.request.idempotency_key, proposal.company_id])).rows[0];
        if (prior) {
          const operation = await repository.get(actor.tenant_id, actor.alias, prior.id, subject);
          proposal.operation = { id: operation.id, status: operation.status, duplicate: true };
          proposal.status = 'operación previa; no se reencola ni reanuda';
        } else if (pending || report.operations_enqueued > 0) {
          proposal.status = 'diferida; completa la operación pendiente y vuelve a simular con revisión CAS fresca';
        } else {
          const operation = await repository.enqueue(actor.tenant_id, actor.alias, proposal.request, subject);
          proposal.operation = { id: operation.id, status: operation.status, duplicate: false };
          proposal.status = 'encolada; primaria pendiente del flujo físico';
          report.operations_enqueued++;
        }
      }
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function loadStore() {
  for (const location of ['packages/store/dist/index.js', 'dist/packages/store/src/index.js']) {
    const runtime = resolve(process.cwd(), location);
    if (existsSync(runtime)) return import(pathToFileURL(runtime).href);
  }
  const source = resolve(process.cwd(), 'packages/store/src/index.ts');
  if (!existsSync(source)) throw new Error('runtime store no disponible');
  const { tsImport } = await import('tsx/esm/api');
  return tsImport(pathToFileURL(source).href, import.meta.url);
}

async function main() {
  let pool;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    const url = process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim() : process.env.DATABASE_URL;
    if (!url) throw new Error('falta DATABASE_URL_FILE o DATABASE_URL');
    const store = await loadStore();
    pool = store.createPool(url);
    console.log(JSON.stringify(await runPrimary({ pool, store, options }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'bloqueada', code: error?.code ?? 'invalid_input',
      message: 'No se aplicó el lote. Revisa argumentos, autoridad, revisión CAS, placement y operaciones existentes; no se omiten barreras.' }));
    process.exitCode = 2;
  } finally { await pool?.end(); }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) await main();
