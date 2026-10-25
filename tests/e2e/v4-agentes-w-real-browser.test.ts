import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiMutation } from './v4-office-real-browser.helpers.js';
import {
  apiGet, asV4Page, fillRegistration, login, openRegistration, syntheticPerson,
  type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'e2e-a2-cobertura-w-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const directory = join(process.cwd(), '.delegados/v4/recibos', task, 'w', run);
const person = {
  ...syntheticPerson('wizard', run), name: prefix, email: `${prefix}@example.test`,
  company: { name: prefix, slug: prefix },
};
const evidence: Record<string, unknown> = { task, run, mocks: false, physicalExecutor: false, rows: {}, captures: [] };
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';
const extraTenant = `zz-canary-w-${run}`;
const host = `zz-canary-w-host-${run}`;
const active = () => { if (!fixture) throw new Error('wizard fixture unavailable'); return fixture; };
const browser = () => { if (!page) throw new Error('wizard browser unavailable'); return page; };
const pool = () => active().database.pool;
const dialog = () => browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
interface RouteAbort { abort(errorCode?: string): Promise<void> }
interface RoutablePage { route(url: string, handler: (route: RouteAbort) => Promise<void>): Promise<void>; unroute(url: string): Promise<void> }
const routable = (page: V4Page): RoutablePage => page as unknown as RoutablePage;

const next = () => dialog().getByRole('button', { name: 'Siguiente', exact: true }).click();
const back = () => dialog().getByRole('button', { name: 'Atrás', exact: true }).click();

async function capture(label: string): Promise<void> {
  for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
    await browser().setViewportSize({ width, height });
    await browser().screenshot({ path: join(directory, `${label}-${device}.png`), fullPage: true });
    (evidence.captures as string[]).push(`${label}-${device}.png`);
  }
  await browser().setViewportSize({ width: 1440, height: 900 });
}

async function scenario(ids: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
    Object.assign(evidence.rows as object, Object.fromEntries(ids.map(id => [id, 'PASA'])));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    const body = await browser().locator('body').innerText().catch(() => 'No browser body');
    await writeFile(join(directory, `failure-${ids.join('-')}.txt`), `${detail}\n${body.replaceAll(person.password, '[REDACTED]')}\n`);
    await browser().screenshot({ path: join(directory, `failure-${ids.join('-')}.png`), fullPage: true }).catch(() => undefined);
    Object.assign(evidence.rows as object, Object.fromEntries(ids.map(id => [id, 'FALLA'])));
    throw cause;
  }
}

async function openWizard(width = 1440): Promise<void> {
  await browser().setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
  await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
  await dialog().getByLabel('Alias', { exact: true }).waitFor();
  await expect.poll(() => dialog().getByLabel('Alias', { exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
}

async function identity(alias: string, name = alias): Promise<void> {
  await dialog().getByText('Solo preparar, sin desplegar', { exact: true }).click();
  await dialog().getByText('Registrar el agente', { exact: true }).click();
  await dialog().getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(tenant);
  await dialog().getByLabel('Alias', { exact: true }).fill(alias);
  await dialog().getByLabel('Nombre visible', { exact: true }).fill(name);
}

async function review(alias: string): Promise<void> {
  await identity(alias);
  await next(); await next(); await next();
  await dialog().getByRole('heading', { name: 'Revisar y crear', exact: true }).waitFor();
}

async function revision(): Promise<number> {
  const response = await apiGet(browser(), '/v3/console/config');
  expect(response.status).toBe(200);
  if (typeof response.body.revision !== 'number') throw new Error('missing config revision');
  return response.body.revision;
}

async function stored(alias: string): Promise<Record<string, unknown>[]> {
  return (await pool().query(`SELECT alias,display_name,enabled,harness_id,max_concurrent_deliveries,
    host_id,container_name,runtime_user,home_directory,state_directory FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, alias])).rows as Record<string, unknown>[];
}

async function preview(): Promise<void> {
  await dialog().getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
  await expect.poll(() => dialog().getByRole('button', { name: 'Crear registro', exact: true }).isDisabled(), { timeout: 30_000 }).toBe(false);
}

async function concurrentWrite(label: string): Promise<void> {
  const alias = `zz-canary-concurrent-${label}-${run}`;
  const status = await apiMutation(browser(), '/v3/console/config/changes', {
    expected_revision: await revision(), dry_run: false,
    mutation: { resource: 'agent', action: 'create', tenant_id: tenant, alias,
      value: { display_name: alias, enabled: false, max_concurrent_deliveries: 2 } },
  });
  expect(status).toBe(201);
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('wizard E2E requires isolated Testcontainers PostgreSQL');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  browser().on('pageerror', (value: unknown) => {
    evidence.pageError = value instanceof Error ? value.stack ?? value.message : String(value);
  });
  const registration = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const user = await pool().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email]);
  tenant = user.rows[0]?.tenant_id ?? '';
  expect(tenant).toMatch(/^hub-[a-f0-9]+$/u);
  await pool().query('INSERT INTO tenants(id,display_name,company_id) VALUES($1,$1,$2)', [extraTenant, person.company.slug]);
  await pool().query(`INSERT INTO fleet_hosts(host_id,display_name,company_id,controller_status,controller_seen_at)
    VALUES($1,$1,$2,'reachable',now()),($3,$3,$2,'unreachable',now())`, [host, person.company.slug, `${host}-off`]);
  await pool().query(`INSERT INTO fleet_hosts(host_id,display_name,company_id,enabled) VALUES($1,$1,$2,false)`, [`${host}-disabled`, person.company.slug]);
  evidence.tenant = tenant;
}, 600_000);

afterAll(async () => {
  try { await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
  finally { await fixture?.close(); }
}, 180_000);

describe.sequential('W: asistente de Agentes con Chromium y PostgreSQL reales', () => {
  it('W01 W03 W05 W11 W12 W15 W16 W17 W20: valida límites y placement, cambia espacio y vacía el grupo', async () => {
    await scenario(['W01', 'W03', 'W05', 'W11', 'W12', 'W15', 'W16', 'W17', 'W20'], async () => {
      await openWizard();
      await identity(`${prefix}-bounds`);
      await dialog().getByLabel('Nombre visible', { exact: true }).fill('n'.repeat(129));
      expect(await dialog().getByLabel('Nombre visible', { exact: true }).inputValue()).toHaveLength(128);
      await next();
      for (const invalid of ['0', '101', '-1', '1.5', '']) {
        await dialog().getByLabel('Mensajes a la vez', { exact: true }).fill(invalid);
        await next();
        await dialog().getByRole('alert').filter({ hasText: 'La capacidad debe ser un entero entre 1 y 100.' }).waitFor();
      }
      await dialog().getByLabel('Mensajes a la vez', { exact: true }).fill('1');
      await next(); await back();
      await dialog().getByLabel('Mensajes a la vez', { exact: true }).fill('100');
      const computer = dialog().getByRole('combobox', { name: 'Computadora (opcional)', exact: true });
      await expect.poll(() => computer.locator('option').count()).toBeGreaterThanOrEqual(4);
      expect(await computer.locator(`option[value="${host}-off"]`).evaluate(element => element.disabled)).toBe(true);
      expect(await computer.locator(`option[value="${host}-disabled"]`).evaluate(element => element.disabled)).toBe(true);
      await computer.selectOption(host);
      await dialog().getByText('Entorno de ejecución (opcional)', { exact: true }).click();
      await dialog().getByLabel('Nombre del contenedor', { exact: true }).fill(`zz-canary-w-${run}`);
      await next();
      await dialog().getByRole('alert').filter({ hasText: 'Completa los cuatro campos' }).waitFor();
      await dialog().getByLabel('Usuario de ejecución', { exact: true }).fill('dev');
      await dialog().getByLabel('Directorio personal', { exact: true }).fill('/home/dev');
      await dialog().getByLabel('Directorio de estado', { exact: true }).fill('/home/dev/.cauce');
      await capture('placement-complete');
      await pool().query("UPDATE fleet_hosts SET controller_status='unreachable',controller_seen_at=now() WHERE host_id=$1", [host]);
      await dialog().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await dialog().waitFor({ state: 'hidden' });
      await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
      await dialog().getByRole('alert').filter({ hasText: `La computadora ${host} está sin conexión.` }).waitFor();
      await next();
      await dialog().getByRole('heading', { name: 'Arnés y computadora', exact: true }).waitFor();
      await capture('selected-host-offline');
      await pool().query("UPDATE fleet_hosts SET controller_status='reachable',controller_seen_at=now() WHERE host_id=$1", [host]);
      await dialog().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await dialog().waitFor({ state: 'hidden' });
      await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
      await expect.poll(() => computer.locator(`option[value="${host}"]`).evaluate(element => element.disabled)).toBe(false);
      await next();
      await dialog().getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
      await back(); await back();
      await dialog().getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(extraTenant);
      await next(); await next();
      expect(await dialog().getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).inputValue()).toBe('');
      expect(await dialog().getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).isDisabled()).toBe(true);
      await dialog().getByText('Este espacio no tiene grupos habilitados.', { exact: true }).waitFor();
      await capture('empty-groups');
      await dialog().getByRole('button', { name: 'Cerrar', exact: true }).click();
      expect(await stored(`${prefix}-bounds`)).toEqual([]);
    });
  }, 180_000);

  it('W07 W21 W24 W27: completa los cuatro pasos móviles, revisa todas las filas e invalida preview al editar', async () => {
    await scenario(['W07', 'W21', 'W24', 'W27'], async () => {
      const alias = `${prefix}-mobile`;
      await openWizard(390);
      await identity(alias);
      for (const [index, heading] of ['Identidad', 'Arnés y computadora', 'Grupos', 'Revisar y crear'].entries()) {
        expect(await dialog().locator('li[aria-current="step"]').innerText()).toContain(String(index + 1));
        await dialog().getByText(`Paso ${String(index + 1)} de 4 · ${heading}`, { exact: true }).waitFor();
        await dialog().getByRole('heading', { name: heading, exact: true }).waitFor();
        await browser().screenshot({ path: join(directory, `mobile-step-${String(index + 1)}.png`), fullPage: true });
        if (index < 3) await next();
      }
      const summary = await dialog().locator('dl[aria-label="Resumen del alta"]').innerText();
      for (const value of ['Espacio de trabajo', person.company.name, 'Alias', alias, 'Nombre visible', 'Tipo de agente', 'Sin declarar',
        'Computadora', 'Sin computadora por ahora', 'Entregas concurrentes', '2', 'Grupo inicial', 'Sin grupo inicial']) expect(summary).toContain(value);
      await dialog().getByText('Sin computadora, el agente quedará registrado pero no responderá:', { exact: false }).waitFor();
      expect(await dialog().getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(true);
      const before = await revision();
      await preview();
      expect(await revision()).toBe(before); expect(await stored(alias)).toEqual([]);
      await back(); await back(); await back();
      await dialog().getByLabel('Nombre visible', { exact: true }).fill(`${alias} edited`);
      await next(); await next(); await next();
      expect(await dialog().getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(true);
      await preview();
      await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
      await dialog().getByText(`Registro creado: ${tenant}/${alias}.`, { exact: true }).waitFor({ timeout: 30_000 });
      await dialog().getByText('Computadora: sin asignar', { exact: true }).waitFor();
      await dialog().getByText('Asigna una computadora en Editar registro para prepararlo.', { exact: true }).waitFor();
      const rows = await stored(alias);
      expect(rows).toMatchObject([{ display_name: `${alias} edited`, enabled: false, host_id: null }]);
      evidence.mobileCreated = rows;
      await capture('mobile-created');
      await dialog().getByRole('button', { name: 'Terminar', exact: true }).click();
      await dialog().waitFor({ state: 'hidden' });
    });
  }, 180_000);

  it('W10 W15 W16 W17: usa arnés de catálogo y persiste los cuatro campos de ejecución exactos', async () => {
    await scenario(['W15', 'W16', 'W17'], async () => {
      const alias = `${prefix}-placed`;
      await openWizard(); await identity(alias); await next();
      const harness = dialog().getByRole('combobox', { name: 'Tipo de agente (opcional)', exact: true });
      expect(await harness.evaluate(element => element.tagName)).toBe('SELECT');
      await harness.selectOption('codex');
      await dialog().getByRole('combobox', { name: 'Computadora (opcional)', exact: true }).selectOption(host);
      await dialog().getByText('Entorno de ejecución (opcional)', { exact: true }).click();
      for (const [label, value] of [['Nombre del contenedor', `zz-canary-w-${run}`], ['Usuario de ejecución', 'dev'],
        ['Directorio personal', '/home/dev'], ['Directorio de estado', '/home/dev/.cauce']]) {
        if (!label || !value) throw new Error('missing placement fixture');
        await dialog().getByLabel(label, { exact: true }).fill(value);
      }
      await next(); await next(); await preview();
      await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
      await dialog().getByText(`Registro creado: ${tenant}/${alias}.`, { exact: true }).waitFor({ timeout: 30_000 });
      const rows = await stored(alias);
      expect(rows).toMatchObject([{ enabled: false, harness_id: 'codex', host_id: host, container_name: `zz-canary-w-${run}`,
        runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce' }]);
      evidence.placedCreated = rows;
      await capture('placed-created');
    });
  }, 180_000);

  it('W10: sin catálogo ofrece texto y conserva un tipo válido', async () => {
    const enabled = (await pool().query<{ id: string }>('SELECT id FROM harness_definitions WHERE enabled')).rows.map(row => row.id);
    try {
      await active().database.adminPool.query('UPDATE harness_definitions SET enabled=false WHERE enabled');
      await scenario(['W10'], async () => {
        await openWizard(); await identity(`${prefix}-text`); await next();
        const harness = dialog().getByLabel('Tipo de agente (opcional)', { exact: true });
        expect(await harness.evaluate(element => element.tagName)).toBe('INPUT');
        await harness.fill('Invalid Harness'); await next();
        await dialog().getByRole('alert').filter({ hasText: 'El tipo de agente debe empezar' }).waitFor();
        await harness.fill('codex'); await next(); await back();
        expect(await harness.inputValue()).toBe('codex');
        await capture('harness-free-text');
      });
    } finally { await active().database.adminPool.query('UPDATE harness_definitions SET enabled=true WHERE id=ANY($1::text[])', [enabled]); }
  }, 180_000);

  it('W25: rechaza alias duplicado con 409 sin modificar la fila persistida', async () => {
    await scenario(['W25'], async () => {
      const alias = `${prefix}-duplicate`;
      await pool().query('INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id) VALUES($1,$2,$2,false,$3)', [tenant, alias, person.company.slug]);
      const before = await stored(alias);
      const responses: number[] = [];
      browser().on('response', response => { if (new URL(response.url()).pathname === '/v3/console/config/changes') responses.push(response.status()); });
      await openWizard(); await review(alias);
      await dialog().getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      await dialog().getByRole('alert').filter({ hasText: 'ya existe un registro con esa identidad' }).waitFor({ timeout: 30_000 });
      expect(responses).toContain(409); expect(await stored(alias)).toEqual(before);
      expect(await dialog().getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(true);
      evidence.duplicate = { statuses: responses, before, after: await stored(alias) };
      await capture('duplicate-rejected');
    });
  }, 180_000);

  it('W26: un cambio concurrente produce CAS409, permite releer/reintentar y descartar el borrador', async () => {
    await scenario(['W26'], async () => {
      const alias = `${prefix}-conflict`;
      await openWizard(); await review(alias); await preview();
      await concurrentWrite('retry');
      await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
      const conflict = dialog().getByRole('group', { name: 'Conflicto de versión', exact: true });
      await conflict.waitFor({ timeout: 30_000 });
      expect(await stored(alias)).toEqual([]);
      await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
      await expect.poll(() => dialog().getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(false);
      await capture('conflict-retry');
      await concurrentWrite('discard');
      await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
      await conflict.waitFor({ timeout: 30_000 });
      await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
      expect(await dialog().getByLabel('Alias', { exact: true }).inputValue()).toBe('');
      expect(await dialog().getByLabel('Nombre visible', { exact: true }).inputValue()).toBe('');
      expect(await stored(alias)).toEqual([]);
      await capture('conflict-discard');
    });
  }, 180_000);

  it('W32: cierre y Escape conservan borrador, restauran foco y no escriben en PostgreSQL', async () => {
    await scenario(['W32'], async () => {
      const alias = `${prefix}-draft`;
      await openWizard(); await identity(alias);
      const before = await revision();
      for (const close of ['button', 'escape']) {
        if (close === 'button') await dialog().getByRole('button', { name: 'Cerrar', exact: true }).click();
        else await dialog().getByLabel('Alias', { exact: true }).press('Escape');
        await dialog().waitFor({ state: 'hidden' });
        await expect.poll(() => browser().evaluate(() => document.activeElement?.textContent)).toBe('Añadir agente');
        await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
        expect(await dialog().getByLabel('Alias', { exact: true }).inputValue()).toBe(alias);
        expect(await dialog().getByLabel('Nombre visible', { exact: true }).inputValue()).toBe(alias);
        await expect.poll(() => dialog().getByLabel('Alias', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
      }
      expect(await stored(alias)).toEqual([]); expect(await revision()).toBe(before);
      await capture('preserved-draft');
    });
  }, 180_000);

  it('W28: observa checking y applying con PostgreSQL lento, confirma done y contrasta failed por rol inexistente', async () => {
    const phases: { alias: string; dryRun: boolean }[] = [];
    browser().on('request', (value: unknown) => {
      const request = value as { url(): string; method(): string; postDataJSON(): { dry_run: boolean; mutation: { resource: string; alias: string } } };
      if (new URL(request.url()).pathname !== '/v3/console/config/changes' || request.method() !== 'POST') return;
      const body = request.postDataJSON();
      if (body.mutation.resource === 'membership') phases.push({ alias: body.mutation.alias, dryRun: body.dry_run });
    });
    await active().database.adminPool.query(`CREATE FUNCTION zz_canary_w_slow_membership() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(4); RETURN NEW; END $$;
      CREATE TRIGGER zz_canary_w_slow_membership BEFORE INSERT ON memberships
      FOR EACH ROW EXECUTE FUNCTION zz_canary_w_slow_membership()`);
    try {
      await scenario(['W28'], async () => {
        const alias = `${prefix}-group`;
        await openWizard(); await identity(alias); await next(); await next();
        await dialog().getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
        await next(); await preview();
        await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
        await expect.poll(() => phases.some(phase => phase.alias === alias && phase.dryRun), { timeout: 30_000 }).toBe(true);
        await dialog().getByText(/Grupo inicial: .*, pendiente\./u).waitFor();
        expect(await dialog().getByRole('button', { name: 'Cerrar', exact: true }).isDisabled()).toBe(true);
        await browser().screenshot({ path: join(directory, 'group-checking-desktop.png'), fullPage: true });
        await expect.poll(() => phases.some(phase => phase.alias === alias && !phase.dryRun), { timeout: 30_000 }).toBe(true);
        await dialog().getByText(/Grupo inicial: .*, pendiente\./u).waitFor();
        await browser().screenshot({ path: join(directory, 'group-applying-desktop.png'), fullPage: true });
        await dialog().getByText(/Grupo inicial: .*, creada\./u).waitFor({ timeout: 30_000 });
        expect((await pool().query('SELECT role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
          .toEqual([{ role: 'agent', enabled: true }]);
        await capture('group-done');
        await dialog().getByRole('button', { name: 'Terminar', exact: true }).click();
        const failed = `${prefix}-group-failed`;
        await openWizard(); await identity(failed); await next(); await next();
        await dialog().getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
        await dialog().getByLabel('Rol en el grupo', { exact: true }).fill('zz-canary-missing-role');
        await next(); await preview();
        await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
        await dialog().getByText(/Grupo inicial: .*, no creada\./u).waitFor({ timeout: 30_000 });
        expect(await stored(failed)).toHaveLength(1);
        expect((await pool().query('SELECT role FROM memberships WHERE tenant_id=$1 AND alias=$2', [tenant, failed])).rows).toEqual([]);
        await capture('group-failed');
        evidence.groupPhases = phases;
      });
    } finally {
      await active().database.adminPool.query('DROP TRIGGER zz_canary_w_slow_membership ON memberships; DROP FUNCTION zz_canary_w_slow_membership()');
    }
  }, 180_000);

  it('W34: escritura aceptada con tabla de lectura temporalmente no disponible muestra resultado parcial', async () => {
    await scenario(['W34'], async () => {
      const alias = `${prefix}-reload`;
      await openWizard(); await review(alias); await preview();
      await active().database.adminPool.query(`CREATE FUNCTION zz_canary_w_fail_reload() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
        BEGIN ALTER TABLE public.rooms RENAME TO zz_canary_w_rooms; RETURN NEW; END $$;
        CREATE TRIGGER zz_canary_w_fail_reload AFTER INSERT ON config_revisions
        FOR EACH ROW EXECUTE FUNCTION zz_canary_w_fail_reload()`);
      try {
        await dialog().getByRole('button', { name: 'Crear registro', exact: true }).click();
        await dialog().getByText(`Registro creado: ${tenant}/${alias}.`, { exact: true }).waitFor({ timeout: 30_000 });
        await dialog().getByRole('status').filter({ hasText: 'PERO la relectura del inventario no llegó' }).waitFor({ timeout: 30_000 });
        expect(await stored(alias)).toMatchObject([{ enabled: false, display_name: alias }]);
        evidence.partialWrite = { durable: await stored(alias), notice: await dialog().getByRole('status').filter({ hasText: 'PERO la relectura' }).innerText() };
        await capture('write-accepted-reload-failed');
      } finally {
        await active().database.adminPool.query('ALTER TABLE IF EXISTS zz_canary_w_rooms RENAME TO rooms; DROP TRIGGER zz_canary_w_fail_reload ON config_revisions; DROP FUNCTION zz_canary_w_fail_reload()');
      }
      expect((await apiGet(browser(), '/v3/console/config')).status).toBe(200);
    });
  }, 180_000);

  it('W33: un fallo real de lectura de acceso deja el alta inerte con aviso de no verificado', async () => {
    const target = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    await routable(target).route('**/v3/console/access', async (route) => { await route.abort('failed'); });
    await login(target, active().baseUrl, person);
    await target.goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await target.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
    await target.getByRole('button', { name: 'Añadir agente', exact: true }).click();
    const modal = target.getByRole('dialog', { name: 'Añadir agente', exact: true });
    await modal.getByText(/no pudimos verificarlo/u).waitFor({ timeout: 20_000 });
    expect(await modal.getByLabel('Nombre visible', { exact: true }).isDisabled()).toBe(true);
    await target.screenshot({ path: join(directory, `${run}-W33-acceso-fallido-1440.png`) });
    await routable(target).unroute('**/v3/console/access');
    await target.reload({ waitUntil: 'domcontentloaded' });
    await target.getByRole('button', { name: 'Añadir agente', exact: true }).click();
    await expect.poll(() => modal.getByLabel('Nombre visible', { exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    await target.context().close();
    (evidence.rows as Record<string, string>)['W33/fallo-de-lectura'] = 'PASA';
  });

  it('W33: el lector abre el alta con campos inertes y el servidor rechaza su escritura sin cambios', async () => {
    const target = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    const readerAlias = `zz-canary-w-reader-${run}`;
    const reader = { ...syntheticPerson('wizard-reader', run), email: `${readerAlias}@example.test` };
    await pool().query('INSERT INTO agents(tenant_id,alias,enabled,company_id) VALUES($1,$2,false,$3)', [tenant, readerAlias, person.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, readerAlias]);
    await maintainConsoleUser(pool(), { email: reader.email, name: readerAlias, role: 'reader', tenant,
      alias: readerAlias, updateOnly: false, activate: true }, await hashPassword(reader.password));
    await login(target, active().baseUrl, reader);
    await target.goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await target.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
    await target.getByRole('button', { name: 'Añadir agente', exact: true }).click();
    const modal = target.getByRole('dialog', { name: 'Añadir agente', exact: true });
    await modal.getByText(/Tu autoridad de empresa no permite administrar agentes|Tu cuenta no tiene permiso para modificar este registro/u).waitFor();
    for (const field of ['Alias', 'Nombre visible']) expect(await modal.getByLabel(field, { exact: true }).isDisabled()).toBe(true);
    expect(await modal.getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).isDisabled()).toBe(true);
    const before = await apiGet(target, '/v3/console/config');
    expect(before.status).toBe(200);
    const deniedAlias = `${readerAlias}-denied`;
    expect(await apiMutation(target, '/v3/console/config/changes', { expected_revision: before.body.revision, dry_run: false,
      mutation: { resource: 'agent', action: 'create', tenant_id: tenant, alias: deniedAlias,
        value: { display_name: deniedAlias, enabled: false, max_concurrent_deliveries: 2 } } })).toBe(403);
    expect(await stored(deniedAlias)).toEqual([]);
    expect((await apiGet(target, '/v3/console/config')).body.revision).toBe(before.body.revision);
    for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
      await target.setViewportSize({ width, height });
      await target.screenshot({ path: join(directory, `reader-create-denied-${device}.png`), fullPage: true });
    }
    (evidence.rows as Record<string, string>)['W33/permiso-ausente'] = 'PASA';
    evidence.readerCreate = { permissionAbsent: true, unknownPermissionTested: false, accessReadFailureTested: false,
      status: 403, unchangedRevision: before.body.revision, durableAgents: [] };
    evidence.emptyCompanyInvariants = {
      foreignKeys: (await pool().query(`SELECT conrelid::regclass::text AS table_name,conname,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid IN ('company_admins'::regclass,'console_users'::regclass) AND contype='f'
        ORDER BY conrelid::regclass::text,conname`)).rows,
      ownerRequired: (await pool().query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid='companies'::regclass AND tgname='companies_owner_required'`)).rows,
      emptyWizardExercised: false,
    };
  }, 180_000);

});
