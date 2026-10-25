import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = syntheticPerson('cfg', run);
const agentAliasA = `cfg-agent-a-${run}`;
const agentAliasB = `cfg-agent-b-${run}`;
const artifactDirectory = join(process.cwd(), '.delegados/v4/recibos/e2e-huecos-a2-1025/config');
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
const originalDeadlineFactor = process.env.CAUCE_PLAZOS_FACTOR;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let tenant = '';
let ownerId = '';
let activeOpId = '';
let finishedOpId = '';
let pageA: V4Page | undefined;

const sha256Hex = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const active = () => {
  if (!fixture) throw new Error('Config huecos fixture is not initialized');
  return fixture;
};
const pool = () => active().database.pool;
const base = () => active().baseUrl;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function shot(page: V4Page, name: string): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: join(artifactDirectory, `${name}.png`), fullPage: true });
}

async function register(page: V4Page, person: typeof owner): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  try {
    fixture = await startConsoleFunctionalFixture();
    await mkdir(artifactDirectory, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to start functional fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 600_000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (originalDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
    else process.env.CAUCE_PLAZOS_FACTOR = originalDeadlineFactor;
  }
}, 180_000);

describe('huecos de config y operaciones recientes en navegador real contra gateway y PostgreSQL reales', () => {
  it('registra empresa, siembra operaciones recientes activas y terminadas, y las despliega en Avanzado', async () => {
    pageA = await freshPage('owner');
    const page = pageA;
    await step(page, 'registro de empresa', async () => register(page, owner));

    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email],
    );
    ownerId = identity.rows[0]?.id ?? '';
    tenant = identity.rows[0]?.tenant_id ?? '';
    expect(tenant).not.toBe('');
    expect(ownerId).not.toBe('');

    await pool().query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
       VALUES($1,$2,'codex',$2,true,$4,'stev',$5,$6,$7),
             ($1,$3,'codex',$3,true,$8,'stev',$9,$10,$7)`,
      [
        tenant, agentAliasA, agentAliasB,
        `cauce-e2e-${run}-a`, `/srv/cauce-e2e/${run}-a`, `/srv/cauce-e2e/${run}-a/state`, owner.company.slug,
        `cauce-e2e-${run}-b`, `/srv/cauce-e2e/${run}-b`, `/srv/cauce-e2e/${run}-b/state`,
      ],
    );

    const activeReq = {
      kind: 'stop',
      target: { resource: 'agent', tenant_id: tenant, alias: agentAliasA },
      parameters: {},
      expected_revision: 0,
      idempotency_key: `idemp-active-${run}`,
    };
    const activeSteps = [
      { name: 'prepare', status: 'succeeded' },
      { name: 'stop', status: 'failed' },
    ];
    const activeErr = { code: 'STEP_FAILED', step: 'stop', retryable: true };

    const activeRow = (await pool().query<{ id: string }>(
      `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,
        request_hash,idempotency_key,expected_revision,steps,status,error,company_id)
       VALUES($1,$2,$3::jsonb,$4,$5,'server','stop',$6::jsonb,$7,$8,0,$9::jsonb,'failed',$10::jsonb,$11) RETURNING id::text`,
      [
        tenant, 'owner', JSON.stringify(activeReq.target), sha256Hex(activeReq.target), `fleet:${owner.company.slug}:server`,
        JSON.stringify(activeReq), sha256Hex(activeReq), activeReq.idempotency_key, JSON.stringify(activeSteps),
        JSON.stringify(activeErr), owner.company.slug,
      ],
    )).rows[0];
    activeOpId = activeRow?.id ?? '';
    expect(activeOpId).not.toBe('');

    await pool().query(
      `INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
       VALUES($1::uuid,0,'queued',$2::jsonb)`,
      [activeOpId, JSON.stringify({ acting_company: owner.company.slug, actor_subject: `console:${ownerId}` })],
    );

    const finishedReq = {
      kind: 'stop',
      target: { resource: 'agent', tenant_id: tenant, alias: agentAliasB },
      parameters: {},
      expected_revision: 0,
      idempotency_key: `idemp-done-${run}`,
    };
    const finishedSteps = [
      { name: 'prepare', status: 'succeeded' },
      { name: 'stop', status: 'succeeded' },
    ];

    const finishedRow = (await pool().query<{ id: string }>(
      `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,
        request_hash,idempotency_key,expected_revision,steps,status,company_id)
       VALUES($1,$2,$3::jsonb,$4,$5,'server','stop',$6::jsonb,$7,$8,0,$9::jsonb,'succeeded',$10) RETURNING id::text`,
      [
        tenant, 'owner', JSON.stringify(finishedReq.target), sha256Hex(finishedReq.target), `fleet:${owner.company.slug}:server`,
        JSON.stringify(finishedReq), sha256Hex(finishedReq), finishedReq.idempotency_key, JSON.stringify(finishedSteps),
        owner.company.slug,
      ],
    )).rows[0];
    finishedOpId = finishedRow?.id ?? '';
    expect(finishedOpId).not.toBe('');

    await pool().query(
      `INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
       VALUES($1::uuid,0,'queued',$2::jsonb)`,
      [finishedOpId, JSON.stringify({ acting_company: owner.company.slug, actor_subject: `console:${ownerId}` })],
    );

    await step(page, 'navegar a Avanzado y verificar operaciones', async () => {
      await page.goto(`${base()}/config?seccion=avanzado`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });

      const seccionOperaciones = page.locator('section').filter({ hasText: 'Operaciones de flota recientes' });
      await seccionOperaciones.waitFor({ timeout: 20_000 });

      const botonReleer = seccionOperaciones.getByRole('button', { name: 'Releer', exact: true });
      await botonReleer.click();

      const listaAtencion = seccionOperaciones.getByRole('list', { name: 'Operaciones que necesitan atención', exact: true });
      await listaAtencion.waitFor({ timeout: 20_000 });
      expect(await listaAtencion.innerText()).toContain(agentAliasA);

      await shot(page, 'config-operaciones-recientes-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, 'config-operaciones-recientes-390');
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  });

  it('despliega detalle de operación en curso y ejecuta cancelación con efecto durable', async () => {
    const page = pageA ?? await freshPage('owner');
    const seccionOperaciones = page.locator('section').filter({ hasText: 'Operaciones de flota recientes' });

    await step(page, 'desplegar detalle y cancelar operación', async () => {
      const botonVerDetalle = seccionOperaciones.getByRole('button', { name: /Ver detalle de Detener/u });
      await botonVerDetalle.first().click();

      const regionOperacion = seccionOperaciones.getByRole('region', { name: 'Operación de flota', exact: true });
      await regionOperacion.waitFor({ timeout: 20_000 });
      await regionOperacion.getByText('Detalles técnicos', { exact: true }).click();
      expect(await regionOperacion.innerText()).toContain('ID:');
      expect(await regionOperacion.innerText()).toContain(activeOpId);

      const botonCancelar = regionOperacion.getByRole('button', { name: 'Cancelar', exact: true });
      await botonCancelar.click();

      const avisoCancelada = seccionOperaciones.getByRole('status').filter({ hasText: 'cancelada.' });
      await avisoCancelada.waitFor({ timeout: 20_000 });

      const dbStatus = (await pool().query<{ status: string }>(
        'SELECT status FROM fleet_operations WHERE id=$1', [activeOpId],
      )).rows[0]?.status;
      expect(['cancelled', 'cancelling']).toContain(dbStatus);

      await shot(page, 'config-operacion-cancelada-1440');
    });
  });

  it('despliega grupo de terminadas y verifica detalle de operación concluida', async () => {
    const page = pageA ?? await freshPage('owner');
    const seccionOperaciones = page.locator('section').filter({ hasText: 'Operaciones de flota recientes' });

    await step(page, 'abrir terminadas y revisar detalle', async () => {
      const detallesTerminadas = seccionOperaciones.locator('details').filter({ hasText: 'Terminadas' });
      await detallesTerminadas.locator('summary').click();

      const botonVerTerminada = detallesTerminadas.getByRole('button', { name: /Ver detalle de Detener/u });
      await botonVerTerminada.first().click();

      const regionDetalle = detallesTerminadas.getByRole('region', { name: 'Operación de flota', exact: true });
      await regionDetalle.waitFor({ timeout: 20_000 });
      await regionDetalle.getByText('Detalles técnicos', { exact: true }).click();
      expect(await regionDetalle.innerText()).toContain('ID:');
      expect(await regionDetalle.innerText()).toContain(finishedOpId);

      await shot(page, 'config-operacion-terminada-detalle-1440');
    });
  });

  it('sin errores inesperados en el registro del navegador', () => {
    errors.assertClean();
  });
});
