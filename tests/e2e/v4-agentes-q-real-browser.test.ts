import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet, bodySnippet, type IgnoredConsoleRule, type V4Locator } from './v4-console-real-browser.helpers.js';
import { coverageCapture, createCoverageAgent, startCoverageFixture } from './v4-agentes-l-helpers.js';

type CoverageFixture = Awaited<ReturnType<typeof startCoverageFixture>>;
let fixture: CoverageFixture | undefined;
let alias = '';
let draftAlias = '';
let container = '';
const evidence: Record<string, unknown> = { section: 'Q', mocks: false };
const fixtureRules: IgnoredConsoleRule[] = [
  { id: 'coverage-terminal-inventories-404', reason: 'computer fixture has no terminal relay',
    matches: (text, url) => text.includes('status of 404')
      && ['/v3/console/terminal/sessions', '/v3/console/terminal/targets'].includes(new URL(url).pathname) },
  { id: 'coverage-backups-404', reason: 'computer fixture does not configure the space backup service',
    matches: (text, url) => text.includes('status of 404')
      && /^\/v3\/console\/spaces\/hub-[a-f0-9]{32}\/quick[a-f0-9]{8}\/backups$/u.test(new URL(url).pathname) },
  { id: 'coverage-native-admin-501', reason: 'computer fixture does not configure native administration',
    matches: (text, url) => text.includes('status of 501')
      && /^\/v3\/console\/tenants\/hub-[a-f0-9]{32}\/agents\/quick[a-f0-9]{8}\/native\/skill$/u.test(new URL(url).pathname) },
];
const active = () => { if (!fixture) throw new Error('quick actions fixture is unavailable'); return fixture; };

async function operationCount(): Promise<number> {
  return Number((await active().computer.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM fleet_operations WHERE target->>\'tenant_id\'=$1', [active().tenantId],
  )).rows[0]?.count);
}

async function capture(name: string): Promise<void> {
  await coverageCapture(active(), name);
}

async function openSheet(agentAlias = alias): Promise<V4Locator> {
  const { page, baseUrl, tenantId, computer } = active();
  const row = (await computer.pool.query<{ display_name: string }>(
    'SELECT display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, agentAlias],
  )).rows[0];
  if (!row) throw new Error(`owned agent ${agentAlias} is missing`);
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${agentAlias}`)}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog', { name: row.display_name, exact: true });
  await sheet.waitFor({ timeout: 30_000 });
  return sheet;
}

async function unchanged(action: () => Promise<void>): Promise<void> {
  const before = await operationCount();
  await action();
  expect(await operationCount()).toBe(before);
}

async function retiredRuntime(): Promise<{ processes: number; credentials: boolean }> {
  return JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
    'import json,os,pathlib,sys;key=sys.argv[1];count=0\nfor pid in filter(str.isdigit,os.listdir("/proc")):\n'
    + ' try:\n  env=pathlib.Path("/proc",pid,"environ").read_bytes().split(bytes([0]));count+=bytes("CAUCE_RUNTIME_KEY="+key,"utf8") in env\n'
    + ' except OSError:pass\nprint(json.dumps({"processes":count,"credentials":(pathlib.Path("/run/cauce-credentials")/key).exists()}))',
    `quick-${active().run}`])) as { processes: number; credentials: boolean };
}

beforeAll(async () => {
  fixture = await startCoverageFixture('q', { ignoredConsoleRules: fixtureRules, extraSourceFiles: [
    'packages/store/src/device-authorization.ts', 'packages/store/src/device-authorization-authority.ts',
    'services/gateway/src/device-authorization.ts',
  ] });
  alias = `quick${fixture.run}`;
  draftAlias = `draft${fixture.run}`;
  await fixture.computer.pool.query(`INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id)
    VALUES($1,$2,$3,false,$4)`, [fixture.tenantId, draftAlias, `Borrador ${fixture.run}`, fixture.companyId]);
  await fixture.computer.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES($1,$2,$3,'agent')`, [fixture.tenantId, fixture.room, draftAlias]);
}, 900_000);

afterAll(async () => {
  if (!fixture) return;
  try {
    await writeFile(join(fixture.receipts, 'evidence.json'), JSON.stringify({
      ...evidence, run: fixture.run, browserErrors: fixture.errors.unexpected,
      ignoredConsoleRules: Object.fromEntries(fixture.errors.ignored),
      fixtureCapabilities: { terminalRelay: false, spaceBackups: false, nativeAdministration: false },
    }, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture.close(); }
}, 300_000);

afterEach(async ({ task }) => {
  if (fixture && task.result?.state === 'fail') {
    evidence.lastFailure = { test: task.name, page: await bodySnippet(fixture.page) };
    await capture('failure');
  }
});

describe.sequential('acciones frecuentes de Agentes con Chromium y persistencia reales', () => {
  it('Q01/Q07: el borrador dirige a Preparar y a Ajustes sin crear operaciones', async () => {
    const { page, tenantId } = active();
    await unchanged(async () => {
      let sheet = await openSheet(draftAlias);
      expect(await sheet.getByRole('button', { name: `Iniciar sesión de ${draftAlias}`, exact: true }).isDisabled()).toBe(true);
      await sheet.getByRole('link', { name: `Preparar ${draftAlias}`, exact: true }).click();
      await sheet.getByRole('region', { name: `Operación de ${tenantId}/${draftAlias}`, exact: true }).waitFor({ timeout: 30_000 });
      expect(await sheet.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('create');
      await capture('Q01-preparar');
      sheet = await openSheet(draftAlias);
      await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${draftAlias}`, exact: true }).click();
      expect(await sheet.getByRole('tab', { name: 'Ajustes', exact: true }).evaluate(element => element.getAttribute('aria-selected'))).toBe('true');
      await sheet.getByRole('button', { name: 'Eliminar registro', exact: true }).waitFor({ timeout: 15_000 });
      await capture('Q07-ir-a-eliminar');
    });
    expect((await apiGet(page, '/v3/console/config')).status).toBe(200);
    evidence.draftActions = { prepareKind: 'create', deleteTab: 'Ajustes', enqueued: 0 };
  }, 180_000);

  it('prepara el agente de las acciones mediante Chromium y verifica el contenedor real', async () => {
    await createCoverageAgent(active(), alias, `quick-${active().run}`);
    const { computer, tenantId } = active();
    const row = (await computer.pool.query<{ container_name: string; runtime_key: string; enabled: boolean }>(
      'SELECT container_name,runtime_key,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0];
    if (!row) throw new Error('created quick-action agent is missing');
    container = row.container_name;
    expect(row.enabled).toBe(true);
    expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
    evidence.prepared = { alias, runtime: row.runtime_key, container, running: true };
  }, 600_000);

  it('Q01: el agente preparado abre el diálogo de inicio de sesión desde Estado', async () => {
    await unchanged(async () => {
      const sheet = await openSheet();
      const button = sheet.getByRole('button', { name: `Iniciar sesión de ${alias}`, exact: true });
      await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
      await button.click();
      const dialog = active().page.getByRole('dialog', { name: 'Iniciar sesión en GPT / Codex', exact: true });
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByRole('note').filter({ hasText: 'no tiene ninguna operación esperando el inicio de sesión' }).waitFor({ timeout: 30_000 });
      await capture('Q01-login-preparado');
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
      evidence.login = { opened: true, waitingOperation: false, providerAuthenticationPerformed: false };
    });
  }, 120_000);

  it('Q02/Q03/Q04: abre terminal, chat y contexto del agente elegido por sus enlaces', async () => {
    const { page, tenantId } = active();
    const targets = [
      { label: `Abrir terminal de ${tenantId}/${alias}`, pathname: '/terminal', query: '', heading: 'Terminal de agentes', id: 'Q02' },
      { label: `Abrir chat de ${tenantId}/${alias}`, pathname: '/messages', query: '', heading: alias, id: 'Q03' },
      { label: `Perfil y contexto de ${tenantId}/${alias}`, pathname: '/messages', query: '?view=context', heading: `Perfil y contexto de ${alias}`, id: 'Q04' },
    ];
    for (const target of targets) {
      await unchanged(async () => {
        const sheet = await openSheet();
        await sheet.getByRole('link', { name: target.label, exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
          .toBe(`${target.pathname}/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}`);
        expect(new URL(page.url()).search).toBe(target.query);
        await page.getByRole('heading', { name: target.heading, exact: true }).waitFor({ timeout: 30_000 });
        if (target.id === 'Q02') await page.getByText('Canal PTY no disponible en este stack', { exact: true }).waitFor({ timeout: 20_000 });
        if (target.id === 'Q03') await page.getByLabel(`Mensaje para ${alias}`, { exact: true }).waitFor({ timeout: 20_000 });
        if (target.id === 'Q04') {
          await page.getByRole('region', { name: `Perfil y contexto de ${alias}`, exact: true }).waitFor({ timeout: 20_000 });
          await page.getByRole('alert').filter({ hasText: 'No se encontró el agente, su ubicación o el backup.' }).waitFor({ timeout: 20_000 });
        }
        await capture(`${target.id}-enlace`);
      });
    }
    evidence.navigation = targets.map(({ id, pathname, query }) => ({ id, pathname, query, enqueued: 0 }));
  }, 240_000);

  it('Q05/Q06: Arrancar y Detener solo preseleccionan la operación y no tocan el runtime', async () => {
    const { tenantId } = active();
    const before = await docker(['inspect', '--format', '{{.State.StartedAt}}', container]);
    for (const [label, kind, id] of [['Arrancar', 'start', 'Q05'], ['Detener', 'stop', 'Q06']] as const) {
      await unchanged(async () => {
        const sheet = await openSheet();
        await sheet.getByRole('button', { name: label, exact: true }).click();
        const panel = sheet.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
        expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe(kind);
        expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
        await capture(`${id}-preseleccion`);
      });
    }
    expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
    expect(await docker(['inspect', '--format', '{{.State.StartedAt}}', container])).toBe(before);
    evidence.power = { selected: ['start', 'stop'], enqueued: 0, containerStillRunning: true, startedAtUnchanged: true };
  }, 180_000);

  it('Q07: Retirar o eliminar guía al retiro real y después a Eliminar definitivamente', async () => {
    const { page, tenantId, computer } = active();
    let sheet = await openSheet();
    const before = await operationCount();
    await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true });
    const panel = dialog.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
    await panel.waitFor({ timeout: 20_000 });
    expect(await operationCount()).toBe(before);
    await capture('Q07-retiro-guiado');
    const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await expect.poll(() => preview.isDisabled(), { timeout: 30_000 }).toBe(false);
    await preview.click();
    const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
    await expect.poll(() => confirm.isDisabled(), { timeout: 30_000 }).toBe(false);
    await confirm.click();
    await expect.poll(async () => (await computer.pool.query<{ status: string }>(
      "SELECT status FROM fleet_operations WHERE target->>'tenant_id'=$1 AND target->>'alias'=$2 AND kind='retire' ORDER BY created_at DESC LIMIT 1",
      [tenantId, alias],
    )).rows[0]?.status, { timeout: 180_000 }).toBe('succeeded');
    const row = (await computer.pool.query<{ enabled: boolean; retired: boolean }>(
      'SELECT enabled,retired_at IS NOT NULL AS retired FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0];
    expect(row).toEqual({ enabled: false, retired: true });
    const observed = await retiredRuntime();
    expect(observed).toEqual({ processes: 0, credentials: false });
    sheet = await openSheet();
    await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true }).click();
    await dialog.getByRole('region', { name: 'Recursos que se borrarán', exact: true }).waitFor({ timeout: 20_000 });
    expect(await dialog.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
    await capture('Q07-eliminar-definitivamente');
    expect(await operationCount()).toBe(before + 1);
    evidence.removal = { draftRedirected: true, retireSucceeded: true, retiredRow: row, observed, purgeOpened: true, purgeEnqueued: false };
    active().errors.assertClean();
  }, 360_000);
});
