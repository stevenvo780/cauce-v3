import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { isaTenant, newTrustedPage, startBoundedAdapter, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'e2e-a2-cobertura-w-1025';
const driverSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const person = syntheticPerson('status', run);
person.company = { name: prefix, slug: prefix };
const directory = join(process.cwd(), '.delegados/v4/recibos', task, 's', run);
const accountId = `${prefix}-subscription`;
const hostId = `${prefix}-host`;
const states = ['down', 'blocked', 'delegating', 'receiving', 'thinking', 'idle', 'unprepared'] as const;
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const checks: Record<string, unknown> = {};
const screenshots: string[] = [];
const originalApprovals = process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE;
const originalDescriptors = process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';
let payer = '';
let failure = 0;

function active() { if (!fixture) throw new Error('status fixture unavailable'); return fixture; }
function browser() { if (!page) throw new Error('status browser unavailable'); return page; }
function pool() { return active().database.pool; }
function alias(state = 'idle') { return `${prefix}-${state}`; }
function ref(agentAlias = alias()) { return `${tenant}/${agentAlias}`; }
function sheet(target = browser()) { return target.getByRole('dialog').first(); }
interface RouteAbort { abort(errorCode?: string): Promise<void> }
interface RoutablePage { route(url: string, handler: (route: RouteAbort) => Promise<void>): Promise<void>; unroute(url: string): Promise<void> }
const routable = (page: V4Page): RoutablePage => page as unknown as RoutablePage;

function panel(target = browser()) { return sheet(target).getByRole('region', { name: `Estado de ${ref()}`, exact: true }); }
function quota() { return sheet().getByRole('region', { name: `Cuota de ${alias()}`, exact: true }); }

function record(id: string, data: unknown): void {
  checks[id] = data;
  process.stdout.write(`STATUS_COVERAGE ${id} ${JSON.stringify(data)}\n`);
}

async function capture(label: string, target = browser(), focus?: V4Locator): Promise<void> {
  for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
    await target.setViewportSize({ width, height });
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
    await target.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); }); });
    const file = `${label}-${device}.png`;
    await target.screenshot({ path: join(directory, file) });
    screenshots.push(file);
  }
  await target.setViewportSize({ width: 1440, height: 900 });
}

async function openSheet(agentAlias = alias(), target = browser(), targetTenant = tenant): Promise<void> {
  await target.goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await target.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
  await target.getByLabel('Buscar agente o grupo', { exact: true }).fill(agentAlias);
  await target.getByRole('button', { name: `Abrir agente ${targetTenant}/${agentAlias}`, exact: true }).click();
  await sheet(target).waitFor({ timeout: 20_000 });
}

async function tile(question: string): Promise<string> {
  return panel().locator('dl > div').filter({ hasText: question }).innerText();
}

async function activity(agentAlias = alias()): Promise<Record<string, unknown>> {
  const result = await apiGet(browser(), '/v3/console/activity');
  expect(result.status).toBe(200);
  const agent = (result.body.agents as Record<string, unknown>[]).find(row => row.tenant_id === tenant && row.alias === agentAlias);
  if (!agent) throw new Error(`activity missing ${agentAlias}`);
  return agent;
}

async function seedDelivery(recipient: string, status: string, sender = recipient, overdue = false): Promise<string> {
  const result = await pool().query<{ id: string }>(`WITH message AS (
    INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
    VALUES($1,$2,$3,'office',$4,jsonb_build_object('text','Synthetic status fixture'),'interactive',10) RETURNING id)
    INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,claim_token,
      consumer_instance_id,consumer_epoch,claimed_at,ack_deadline_at)
    SELECT id,$3,$5,$6,1,gen_random_uuid(),$7,1,now(),
      now()+CASE WHEN $8 THEN interval '-1 minute' ELSE interval '1 hour' END FROM message RETURNING id`,
  [randomUUID(), randomUUID(), tenant, sender, recipient, status, prefix, overdue]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('delivery fixture missing');
  await pool().query(`INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,attempt,claim_token,event_id)
    SELECT id,$2,$3,1,true,1,claim_token,gen_random_uuid() FROM deliveries WHERE id=$1`, [id, status, prefix]);
  return id;
}

async function placement(): Promise<Record<string, unknown>> {
  const result = await pool().query(`SELECT company_id,tenant_id,alias,harness_id,host_id,runtime_mode,
    container_name,runtime_user,home_directory,state_directory,runtime_key,systemd_user,primary_account_id
    FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, alias()]);
  return result.rows[0] as Record<string, unknown>;
}

async function observation(status: 'ok' | 'error', remaining: number): Promise<void> {
  const captured = new Date().toISOString();
  const sample = { provider: 'codex', ok: status === 'ok', available: status === 'ok', account_id: accountId,
    note: status === 'error' ? 'rate_limited' : undefined, effective_remaining_percent: remaining,
    available_groups: [], limiting_groups: [], windows: [{ group_key: 'default', window_key: 'weekly',
      remaining_percent: remaining, reset_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: captured }] };
  await pool().query(`INSERT INTO agent_quota_observations(company_id,tenant_id,alias,agent_snapshot,
    reader_available,status,captured_at,account_id,sample) VALUES($1,$2,$3,$4,true,$5,$6,$7,$8)
    ON CONFLICT(tenant_id,alias) DO UPDATE SET agent_snapshot=EXCLUDED.agent_snapshot,status=EXCLUDED.status,
      reader_available=true,captured_at=EXCLUDED.captured_at,account_id=EXCLUDED.account_id,sample=EXCLUDED.sample`,
  [person.company.slug, tenant, alias(), JSON.stringify(await placement()), status, captured, accountId, JSON.stringify(sample)]);
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('status coverage requires isolated PostgreSQL and mocks=false');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  const descriptorDirectory = join(process.cwd(), 'packages/adapter-sdk/descriptors');
  const approvals = join(active().directory, 'status-descriptor-approvals.json');
  await writeFile(approvals, JSON.stringify({ codex: createHash('sha256').update(await readFile(join(descriptorDirectory, 'codex.json'))).digest('hex') }));
  process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE = approvals;
  process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY = descriptorDirectory;
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(browser(), 'status-owner');
  const form = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  tenant = (await pool().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  expect(tenant).not.toBe('');
  payer = `${prefix}-payer`;
  await pool().query('INSERT INTO tenants(id,company_id,display_name) VALUES($1,$2,$3)', [payer, person.company.slug, `Patrocinador visible ${run}`]);
  await pool().query(`INSERT INTO fleet_hosts(host_id,company_id,display_name,controller_status,controller_seen_at,enabled)
    VALUES($1,$2,'Computadora de estados','reachable',now(),true)`, [hostId, person.company.slug]);
  await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
    credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id)
    VALUES($1,'codex',$1,$2,$3,'secret_manager',$4,true,true,$5)`,
  [accountId, payer, `Suscripción visible ${run}`, `op:zz-canary/status/${run}`, person.company.slug]);
  for (const state of states) {
    await pool().query(`INSERT INTO agents(tenant_id,alias,display_name,company_id,harness_id,enabled,lifecycle_state,
      runtime_key,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,model_id,primary_account_id)
      VALUES($1,$2,$2,$3,'codex',$4,$5,$6,$7,'container',$6,'node','/home/node','/home/node/.cauce','gpt-5.5',$8)`,
    [tenant, alias(state), person.company.slug, state !== 'unprepared', state === 'unprepared' ? 'draft' : 'ready', `${prefix}-${state}-runtime`, hostId, accountId]);
    if (state !== 'down' && state !== 'unprepared') await pool().query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
      VALUES($1,$2,$3,1,now()+interval '1 hour')`, [tenant, alias(state), prefix]);
    await pool().query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')`, [tenant, alias(state)]);
  }
  await seedDelivery(alias('blocked'), 'started', alias('blocked'), true);
  await seedDelivery(alias('receiving'), 'accepted');
  await seedDelivery(alias('thinking'), 'started');
  await seedDelivery(alias('thinking'), 'started', alias('delegating'));
  await pool().query(`INSERT INTO rooms(id,tenant_id,company_id,display_name) VALUES($1,$2,$3,$4)`, [`${prefix}-team`, tenant, person.company.slug, `Equipo visible ${run}`]);
  await pool().query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,'agent',true),($1,'office',$3,'agent',false)
    ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET enabled=EXCLUDED.enabled`, [tenant, `${prefix}-team`, alias()]);
  await pool().query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)', [tenant, alias(), `Responsabilidad visible ${run}`]);
  await pool().query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
    VALUES($1,$2,$3,$4,$1)`, [tenant, alias(), accountId, payer]);
  await pool().query('INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,enabled) VALUES($1,$2,$3,true)', [tenant, alias(), accountId]);
}, 600_000);

beforeEach(async () => {
  await browser().context().close();
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(browser(), 'status-owner-fresh-context');
  await login(browser(), active().baseUrl, person);
}, 120_000);

afterEach(async context => {
  if (context.task.result?.state !== 'fail' || !page) return;
  const stem = `failure-${String(failure++)}`;
  const body = await browser().locator('body').innerText().catch(() => 'Body unavailable');
  await writeFile(join(directory, `${stem}.txt`), body.replaceAll(person.password, '[REDACTED]'));
  const target = browser() as unknown as { screenshot(options: { path: string; timeout: number }): Promise<Buffer> };
  await target.screenshot({ path: join(directory, `${stem}.png`), timeout: 10_000 }).catch(() => undefined);
});

afterAll(async () => {
  try {
    await writeFile(join(directory, 'receipt.json'), JSON.stringify({ task, run, driverSha256, tenant, mocks: false, checks, screenshots,
      unexpectedErrors: errors.unexpected, ignoredErrors: Object.fromEntries(errors.ignored) }, null, 2) + '\n');
  } finally {
    if (originalApprovals === undefined) delete process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE;
    else process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE = originalApprovals;
    if (originalDescriptors === undefined) delete process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
    else process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY = originalDescriptors;
    await fixture?.close();
  }
}, 180_000);

describe.sequential('Estado del agente con Chromium, gateway y PostgreSQL reales', () => {
  it('S01 contrasta siete estados de lectura contra la actividad persistida del laboratorio', async () => {
    const expected = {
      down: 'No está conectado: no va a tomar mensajes nuevos.', blocked: 'Tomó un mensaje y no avanza.',
      delegating: 'Está trabajando junto con otro agente.', receiving: 'Le acaba de llegar un mensaje.',
      thinking: 'Está trabajando en un mensaje.', idle: 'Conectado y libre, esperando mensajes.',
      unprepared: 'Su entorno todavía no está listo para trabajar.',
    };
    for (const state of states) {
      await openSheet(alias(state));
      const section = sheet().getByRole('region', { name: `Estado de ${ref(alias(state))}`, exact: true });
      await section.getByText(expected[state], { exact: true }).waitFor({ timeout: 20_000 });
      record(`S01-${state}`, { state, source: 'isolated PostgreSQL activity fixture; no physical runtime claimed', activity: await activity(alias(state)) });
      await capture(`S01-${state}`);
    }
    record('S01-limits', { settled: 'FleetProvider calls buildLiveViews(activityData, {}, Date.now()): no pulses reach this sheet',
      missing: 'No activity transport failure injected; not certified', complete: false });
  }, 180_000);

  it('S02 contrasta los ciclos publicables y documenta la ficha especial de retiro', async () => {
    for (const [state, text] of [['ready', 'Sesión activa'], ['auth_pending', 'Falta iniciar sesión'], ['draft', 'Sin preparar'], ['failed', 'Con error'], ['verifying', 'Sin dato']] as const) {
      await pool().query('UPDATE agents SET lifecycle_state=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, alias(), state]);
      await openSheet();
      await expect.poll(() => tile('Sesión del proveedor')).toContain(text);
      expect((await pool().query('SELECT lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias()])).rows).toEqual([{ lifecycle_state: state }]);
      await capture(`S02-${state}`);
    }
    const nullable = await pool().query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
      AND table_name='agents' AND column_name='lifecycle_state'`);
    expect(nullable.rows).toEqual([{ is_nullable: 'NO' }]);
    await pool().query(`UPDATE agents SET lifecycle_state='retired',retired_at=now(),enabled=false WHERE tenant_id=$1 AND alias=$2`, [tenant, alias()]);
    await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('button', { name: `Restaurar o revisar ${ref()}`, exact: true }).click();
    await sheet().getByRole('note').filter({ hasText: 'su historial se conserva' }).waitFor();
    expect(await panel().count()).toBe(0);
    await capture('S02-retired-special-sheet');
    record('S02', { observed: ['ready', 'auth_pending', 'draft', 'failed', 'verifying -> Sin dato'], retired: 'special sheet has no session tile',
      nullableLifecycle: false, complete: false });
    await pool().query(`UPDATE agents SET lifecycle_state='ready',retired_at=NULL,enabled=true WHERE tenant_id=$1 AND alias=$2`, [tenant, alias()]);
  }, 180_000);

  it('S03 muestra computadora conectada, no disponible y sin computadora con sus nombres', async () => {
    for (const scenario of [
      { status: 'reachable', enabled: true, label: 'Conectada', detail: 'La computadora está conectada.' },
      { status: 'unreachable', enabled: true, label: 'No disponible', detail: 'Deshabilitado: computadora sin conexión' },
      { status: 'reachable', enabled: false, label: 'No disponible', detail: 'Deshabilitado: computadora deshabilitada' },
    ]) {
      await pool().query('UPDATE fleet_hosts SET controller_status=$2,controller_seen_at=now(),enabled=$3 WHERE host_id=$1', [hostId, scenario.status, scenario.enabled]);
      await openSheet();
      await expect.poll(() => tile('Dónde corre')).toContain(scenario.detail);
      const text = await tile('Dónde corre');
      expect(text).toContain('Computadora de estados');
      expect(text).toContain(scenario.label);
      await capture(`S03-${scenario.status}-${String(scenario.enabled)}`);
      record(`S03-${scenario.status}-${String(scenario.enabled)}`, { text, host: (await apiGet(browser(), '/v3/console/fleet/hosts')).body });
    }
    await pool().query('UPDATE agents SET host_id=NULL WHERE tenant_id=$1 AND alias=$2', [tenant, alias()]);
    await openSheet();
    await expect.poll(() => tile('Dónde corre')).toContain('Todavía no tiene una computadora asignada.');
    await capture('S03-no-computer');
    record('S03', { complete: true, noComputer: await tile('Dónde corre') });
    await pool().query('UPDATE agents SET host_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, alias(), hostId]);
    await pool().query(`UPDATE fleet_hosts SET enabled=true,controller_status='reachable',controller_seen_at=now() WHERE host_id=$1`, [hostId]);
  }, 180_000);

  it('S04 S05 muestra nombres de cuenta, proveedor y pagador junto con todos los datos del registro', async () => {
    await openSheet();
    await expect.poll(() => tile('Cuenta que usa')).toContain(`Suscripción visible ${run}`);
    expect(await tile('Cuenta que usa')).toContain('GPT / Codex');
    expect(await tile('Cuenta que usa')).toContain(`Paga: Patrocinador visible ${run}.`);
    const facts = sheet().getByRole('region', { name: `Datos de ${ref()}`, exact: true });
    const expected = { Programa: 'codex', Modelo: 'gpt-5.5', Pagador: `Patrocinador visible ${run}`,
      Preparación: 'Listo para trabajar', 'Recepción de mensajes': 'Activo',
      Grupos: `Equipo visible ${run}`, Responsabilidad: `Responsabilidad visible ${run}` };
    for (const [label, value] of Object.entries(expected)) expect(await facts.locator('dl > div').filter({ hasText: label }).innerText()).toContain(value);
    expect(await facts.locator('dl > div').filter({ hasText: 'Grupos' }).innerText()).toContain('(pausada)');
    await capture('S04-S05-published-names-data');
    await capture('S05-more-data', browser(), facts);
    record('S05', { complete: true, expected, placement: await placement(), facts: await facts.innerText() });
    const ownAccount = `${prefix}-own-account`;
    await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
      credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id)
      SELECT $2,provider,$2,$3,label,credential_ref_kind,credential_ref,false,true,company_id
      FROM provider_accounts WHERE id=$1`, [accountId, ownAccount, tenant]);
    await pool().query('UPDATE agents SET primary_account_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, alias(), ownAccount]);
    await openSheet();
    await expect.poll(() => tile('Cuenta que usa')).toContain('Paga: La misma empresa.');
    await capture('S04-own-payer');
    await pool().query('UPDATE provider_accounts SET label=NULL WHERE id=$1', [ownAccount]);
    await openSheet();
    await expect.poll(() => tile('Cuenta que usa')).toContain('Cuenta sin etiqueta');
    await capture('S04-unlabelled-account');
    await pool().query('UPDATE agents SET primary_account_id=NULL WHERE tenant_id=$1 AND alias=$2', [tenant, alias()]);
    await openSheet();
    await expect.poll(() => tile('Cuenta que usa')).toContain('Elige su cuenta principal en «Ejecución».');
    await capture('S04-no-account');
    record('S04', { complete: true, variants: ['external named payer', 'same company', 'unlabelled account', 'no account'] });
    await pool().query('UPDATE agents SET primary_account_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, alias(), accountId]);
    await pool().query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [accountId, `Suscripción visible ${run}`]);
  }, 180_000);

  it('S06 relee la medición persistida y conserva el error sin acreditar el saldo antiguo', async () => {
    await openSheet();
    const path = `/v3/console/agents/${tenant}/${alias()}/quota`;
    const unknown = await apiGet(browser(), path);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ reader_available: true, status: 'unknown' });
    await quota().getByText('Sin ubicación operativa', { exact: true }).waitFor();
    await capture('S06-no-measurement', browser(), quota());
    await observation('ok', 61);
    await quota().getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await quota().getByText('Último saldo medido: 61%.', { exact: true }).waitFor();
    await quota().getByText('Sin ubicación operativa', { exact: true }).waitFor();
    expect((await apiGet(browser(), path)).body).toMatchObject({ status: 'ok', binding: { account_id: accountId } });
    await capture('S06-measured', browser(), quota());
    await observation('error', 61);
    await quota().getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await quota().getByText('El proveedor limitó la consulta; se reintentará', { exact: true }).waitFor();
    await quota().getByText('Saldo no acreditado en la última medición.', { exact: true }).waitFor();
    expect(await quota().getByText('Último saldo medido: 61%.', { exact: true }).count()).toBe(0);
    await capture('S06-provider-error', browser(), quota());
    record('S06', { source: 'synthetic persisted observations, real HTTP and Releer cuota',
      observed: ['unknown', 'ok', 'error'], unavailableHost: 'no executor advertised; UI correctly prioritizes unavailable placement', complete: false });
    errors.assertClean();
  }, 120_000);

  it('S06 contrasta todos los estados de disponibilidad de la cuenta en la ficha de configuración', async () => {
    const cases = [
      { state: 'unknown', remaining: null, status: 'unknown' }, { state: 'error', remaining: 0, status: 'error' },
      { state: 'stale', remaining: 0, status: 'ok' }, { state: 'exhausted', remaining: 0, status: 'ok' },
      { state: 'low', remaining: 24, status: 'ok' }, { state: 'available', remaining: 25, status: 'ok' },
      { state: 'paused', remaining: 60, status: 'ok' }, { state: 'model_dependent', remaining: 0, status: 'ok' },
      { state: 'pending_auth', remaining: null, status: 'unknown' },
    ];
    for (const scenario of cases) {
      await pool().query('DELETE FROM quota_window_state WHERE account_id=$1', [accountId]);
      await pool().query(`UPDATE provider_accounts SET enabled=$2,
        paused_until=CASE WHEN $3 THEN now()+interval '1 hour' ELSE NULL END,
        paused_reason=CASE WHEN $3 THEN 'manual' ELSE NULL END WHERE id=$1`,
      [accountId, scenario.state !== 'pending_auth', scenario.state === 'paused']);
      if (scenario.remaining !== null) {
        const observed = new Date(Date.now() - (scenario.state === 'stale' ? 901_000 : 0)).toISOString();
        for (const [model, remaining] of scenario.state === 'model_dependent'
          ? [['model-a', 0], ['model-b', 80]] as const : [[null, scenario.remaining]] as const) {
          await pool().query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,
            captured_at,received_at,remaining_percent,reset_at,status,model,account_id,company_id)
            VALUES($1,$2,'codex','default','week',$3,$3,$4,now()+interval '1 hour',$5,$6,$7,$8)`,
          [tenant, hostId, observed, remaining, scenario.status, model, accountId, person.company.slug]);
        }
      }
      const accounts = await apiGet(browser(), '/v3/console/quota-accounts');
      expect(accounts.status).toBe(200);
      const stored = (accounts.body.accounts as Record<string, unknown>[]).find(account => account.id === accountId);
      expect(stored).toMatchObject({ observation_status: scenario.state === 'stale' ? 'stale' : scenario.status });
      await openSheet();
      const availability = sheet().getByRole('region', { name: `Disponibilidad de ${alias()}`, exact: true });
      await expect.poll(() => availability.locator('[data-fatigue]').evaluate(element => element.dataset.fatigue)).toBe(scenario.state);
      await availability.getByRole('article', { name: `Cuotas de Suscripción visible ${run}`, exact: true }).waitFor();
      await capture(`S06-account-${scenario.state}`, browser(), availability);
      record(`S06-account-${scenario.state}`, stored);
    }
    await pool().query('UPDATE provider_accounts SET enabled=true WHERE id=$1', [accountId]);
    await pool().query('UPDATE agent_account_bindings SET enabled=false WHERE tenant_id=$1 AND agent_alias=$2', [tenant, alias()]);
    await pool().query(`UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2`, [tenant, alias()]);
    await openSheet();
    await sheet().getByText('Sin lector de cuota para este harness: el proveedor no expone una ventana de consumo medible.', { exact: true }).waitFor();
    expect(await quota().getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    await capture('S06-no-reader', browser(), sheet().getByRole('region', { name: `Disponibilidad de ${alias()}`, exact: true }));
    record('S06-availability', { complete: true, states: cases.map(item => item.state).concat('no_reader') });
    await pool().query(`UPDATE agents SET harness_id='codex' WHERE tenant_id=$1 AND alias=$2`, [tenant, alias()]);
    await pool().query('UPDATE agent_account_bindings SET enabled=true WHERE tenant_id=$1 AND agent_alias=$2', [tenant, alias()]);
    errors.assertClean();
  }, 240_000);

  it('S06 relee operaciones pendientes, en ejecución y fallidas desde filas durables del laboratorio', async () => {
    const id = randomUUID();
    const agentSnapshot = { ...await placement(), operation_id: id, expected_revision: 0 };
    await pool().query(`INSERT INTO agent_quota_operations(id,company_id,tenant_id,alias,host_id,requested_by,
      expected_revision,idempotency_key,agent_snapshot,status,expires_at)
      SELECT $1,$2,$3,$4,$5,id,0,$6,$7,'pending',now()+interval '1 hour' FROM console_users WHERE email=$8`,
    [id, person.company.slug, tenant, alias(), hostId, `${prefix}-quota-read`, JSON.stringify(agentSnapshot), person.email]);
    for (const status of ['pending', 'running', 'failed'] as const) {
      await pool().query(`UPDATE agent_quota_operations SET status=$2,claim_token=gen_random_uuid(),worker_id=$3,
        lease_until=now()+interval '1 hour',error_code=CASE WHEN $2='failed' THEN 'RUNTIME_UNAVAILABLE' ELSE NULL END,
        updated_at=now() WHERE id=$1`, [id, status, prefix]);
      await openSheet();
      const result = await apiGet(browser(), `/v3/console/agents/${tenant}/${alias()}/quota`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status, operation: { id, status } });
      if (status === 'failed') await quota().getByText('Puedes volver a consultar cuando la computadora responda.', { exact: true }).waitFor();
      else await quota().getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor();
      await capture(`S06-reader-${status}`, browser(), quota());
      record(`S06-reader-${status}`, { result: result.body, fixtureOnly: true, physicalQueryExecuted: false });
    }
    record('S06-reading-limits', { pendingRunningFailed: 'real PostgreSQL operations read over HTTP, no executor query run',
      transportErrorAndLoading: 'not injected; not certified', complete: false });
    errors.assertClean();
  }, 180_000);

  it('S01 ejecuta un adaptador real con lease, mensaje, respuesta y ACK final persistidos', async () => {
    await prepareChatRuntimeIdentity(active(), isaTenant);
    await pool().query(`UPDATE agents SET lifecycle_state='ready' WHERE tenant_id=$1 AND alias=$2`, [isaTenant.tenant, isaTenant.target]);
    await pool().query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING`, [isaTenant.tenant, isaTenant.room, isaTenant.target]);
    await startBoundedAdapter(active(), isaTenant);
    await expect.poll(async () => (await pool().query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [isaTenant.tenant, isaTenant.target])).rowCount,
      { timeout: 30_000 }).toBe(1);
    const target = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    const runtimeErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
      id: 'tenant-operator-fleet-hosts-403', reason: 'the fixture operator has tenant authority and cannot read company computers',
      matches: (text, url) => text.includes('status of 403') && url === `${active().baseUrl}/v3/console/fleet/hosts`,
    }]);
    runtimeErrors.watch(target, 'real-adapter-operator');
    const operator = { ...person, email: isaTenant.email, password: isaTenant.password };
    await login(target, active().baseUrl, operator);
    await openSheet(isaTenant.target, target, isaTenant.tenant);
    await sheet(target).getByText('Conectado y libre, esperando mensajes.', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('S01-real-adapter-idle', target);
    const harness = join(active().directory, `${isaTenant.tenant}-codex-shim.mjs`);
    const source = await readFile(harness, 'utf8');
    const anchor = "const prompt=Buffer.concat(chunks).toString('utf8');";
    expect(source).toContain(anchor);
    await writeFile(harness, source.replace(anchor, `${anchor}\nawait new Promise(resolve => setTimeout(resolve, 20_000));`));
    const marker = `UI-HUMAN-STATUS-${run.toUpperCase()}`;
    await target.goto(`${active().baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    await target.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(marker);
    await target.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect.poll(async () => (await pool().query<{ status: string }>(`SELECT d.status FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 AND m.body->>'text'=$3`, [isaTenant.tenant, isaTenant.target, marker])).rows[0]?.status,
    { timeout: 15_000 }).toBe('started');
    await openSheet(isaTenant.target, target, isaTenant.tenant);
    await sheet(target).getByText('Está trabajando en un mensaje.', { exact: true }).waitFor({ timeout: 10_000 });
    await capture('S01-real-adapter-thinking', target);
    await expect.poll(async () => (await pool().query<{ status: string }>(`SELECT d.status FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 AND m.body->>'text'=$3`, [isaTenant.tenant, isaTenant.target, marker])).rows[0]?.status,
    { timeout: 30_000 }).toBe('done');
    await target.goto(`${active().baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    await target.getByText(`respuesta sintética ${isaTenant.tenant} ${marker}`, { exact: true }).waitFor({ timeout: 20_000 });
    const acknowledged = (await pool().query(`SELECT k.status,k.applied FROM delivery_acks k JOIN deliveries d ON d.id=k.delivery_id
      JOIN messages m ON m.id=d.message_id WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 AND m.body->>'text'=$3 ORDER BY k.id`,
    [isaTenant.tenant, isaTenant.target, marker])).rows;
    expect(acknowledged).toEqual(expect.arrayContaining([{ status: 'started', applied: true }, { status: 'done', applied: true }]));
    await capture('S01-real-adapter-done', target);
    runtimeErrors.assertClean();
    record('S01-real-adapter', { runtime: 'real adapter SDK process with synthetic codex harness', lease: true, observedStates: ['idle', 'thinking'], delivery: 'done', acknowledged,
      settledNotCertified: 'the configuration FleetProvider does not retain activity pulses',
      unexpectedErrors: runtimeErrors.unexpected, ignoredErrors: Object.fromEntries(runtimeErrors.ignored) });
    await target.context().close();
  }, 120_000);

  it('S01 settled y sin dato desde productores reales: turno completado y agente sin actividad', async () => {
    const bare = `${prefix}-nodata`;
    await pool().query(`INSERT INTO agents(tenant_id,alias,display_name,company_id,enabled,harness_id,max_concurrent_deliveries,lifecycle_state)
      VALUES($1,$2,$2,$3,false,'codex',1,'ready') ON CONFLICT DO NOTHING`, [tenant, bare, person.company.slug]);
    // The activity endpoint always reports every agent (a ready agent without a lease reads
    // 'No responde'), so 'Sin dato' is the transport-failure state: it appears when the activity
    // read itself fails. Cut it for real and the sheet must say it has no data.
    await routable(browser()).route('**/v3/console/activity', async (route) => { await route.abort('failed'); });
    try {
      await openSheet(bare);
      const bareSection = sheet().getByRole('region', { name: `Estado de ${ref(bare)}`, exact: true });
      await bareSection.getByText('La actividad de la flota no informa de este agente ahora mismo.', { exact: true }).waitFor({ timeout: 20_000 });
    } finally {
      await routable(browser()).unroute('**/v3/console/activity');
    }
    record('S01-sin-dato', { state: 'activity transport failure renders Sin dato; endpoint otherwise always reports' });
    await capture('S01-sin-dato');

    await pool().query(`UPDATE agents SET lifecycle_state='ready' WHERE tenant_id=$1 AND alias=$2`, [isaTenant.tenant, isaTenant.target]);
    await pool().query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING`, [isaTenant.tenant, isaTenant.room, isaTenant.target]);
    const leaseCount = async () => (await pool().query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [isaTenant.tenant, isaTenant.target])).rowCount;
    if ((await leaseCount()) === 0) await startBoundedAdapter(active(), isaTenant);
    await expect.poll(leaseCount, { timeout: 30_000 }).toBe(1);

    const target = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    const operator = { ...person, email: isaTenant.email, password: isaTenant.password };
    await login(target, active().baseUrl, operator);
    await target.goto(`${active().baseUrl}/live`, { waitUntil: 'domcontentloaded' });
    await target.getByText(/1 libre/u).waitFor({ timeout: 30_000 }).catch(() => undefined);
    const harness = join(active().directory, `${isaTenant.tenant}-codex-shim.mjs`);
    const source = await readFile(harness, 'utf8');
    const anchor = "const prompt=Buffer.concat(chunks).toString('utf8');";
    expect(source).toContain(anchor);
    await writeFile(harness, source.replace(anchor, `${anchor}\nawait new Promise(resolve => setTimeout(resolve, 20_000));`));
    const marker = `UI-SETTLED-${run.toUpperCase()}`;
    const sender = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    await login(sender, active().baseUrl, operator);
    await sender.goto(`${active().baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    await sender.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(marker);
    await sender.getByRole('button', { name: 'Enviar', exact: true }).click();
    await target.getByText(/Salió de vuelo/u).first().waitFor({ timeout: 45_000 });
    await sender.context().close();
    await capture('S01-settled-live', target);
    record('S01-settled', { state: 'settled shown in /live after a real completed turn (sheet provider keeps no pulses)' });
    await target.context().close();
  }, 240_000);

});
