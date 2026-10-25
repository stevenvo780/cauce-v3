import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserPage } from './console-functional-browser.fixtures.js';
import type { AccountsAssignmentsFixture } from './accounts-assignments-real-browser.fixtures.js';

let fixture: AccountsAssignmentsFixture | undefined;
let currentPage: BrowserPage | undefined;
let accountId: string;
let secondAccountId: string;
let operatorSession: { cookie: string; csrf: string } | undefined;
const artifacts = process.env.CAUCE_E2E_ARTIFACT_DIR
  ?? join(process.cwd(), '.delegados/v4/recibos/e2e-a7-cuotas-1025b/accounts');

beforeAll(async () => {
  vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('este E2E exige Testcontainers propios');
  const { startAccountsAssignmentsFixture } = await import('./accounts-assignments-real-browser.fixtures.js');
  fixture = await startAccountsAssignmentsFixture();
  const active = fixture;
  const authority = await active.database.adminPool.query<{ company_id: string }>(
    `INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
     SELECT tenant.company_id,person.id,'owner','platform',person.id
     FROM console_users person JOIN tenants tenant ON tenant.id=person.tenant_id
     JOIN human_tenant_memberships home ON home.human_id=person.id AND home.tenant_id=person.tenant_id
     WHERE person.email=$1 AND person.tenant_id=$2 AND person.alias=$3
       AND home.actor_alias=person.alias AND home.enabled AND home.revoked_at IS NULL
     RETURNING company_id`, [active.operatorEmail, active.tenant, active.operatorAlias],
  );
  expect(authority.rows).toEqual([{ company_id: 'humanizar' }]);
  const suffix = active.runId.replaceAll('-', '').slice(0, 8);
  accountId = `zz-canary-e2e-a7-cuotas-1025b-accounts-${suffix}`;
  secondAccountId = `${accountId}-second`;
  await active.database.pool.query(
    `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
      credential_ref_kind,credential_ref,shared_with_pool,enabled)
     VALUES($1,'codex',$1,$3,'Cuenta de inventario','env_path','CAUCE_SYNTHETIC_ACCOUNT_PATH',false,true),
           ($2,'codex',$2,$3,'Cuenta secundaria','env_path','CAUCE_SYNTHETIC_SECOND_PATH',false,true)`,
    [accountId, secondAccountId, active.tenant],
  );
  await mkdir(artifacts, { recursive: true });
  process.stdout.write(`Accounts owned fixture run=${active.runId} pg=${active.database.container.getId()} browser=${active.browserContainer} agent=${active.agentContainerId}\n`);
}, 10 * 60_000);

afterEach(async (context) => {
  if (context.task.result?.state !== 'fail' || !currentPage) return;
  await writeFile(join(artifacts, 'failure-body.txt'), await currentPage.locator('body').innerText());
  await currentPage.screenshot({ path: join(artifacts, 'failure.png'), fullPage: false });
});

afterAll(async () => {
  try {
    if (!fixture) return;
    await fixture.close();
    process.stdout.write(`Accounts cleanup verified: run=${fixture.runId}\n`);
  } finally {
    vi.unstubAllEnvs();
  }
});

function activeFixture(): AccountsAssignmentsFixture {
  if (!fixture) throw new Error('accounts E2E fixture not initialized');
  return fixture;
}

async function screenshot(page: BrowserPage, name: string) {
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: false });
}

async function apiSession() {
  operatorSession ??= await activeFixture().login();
  return operatorSession;
}

async function login(page: BrowserPage, reader = false) {
  const active = activeFixture();
  const response = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').fill(reader ? active.readerEmail : active.operatorEmail);
  await page.getByLabel('Contraseña').fill(reader ? active.readerPassword : active.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true })
    .locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ timeout: 20_000 });
  const cookies = await page.context().cookies(active.baseUrl);
  expect(cookies.some((cookie) => cookie.name === '__Host-cauce_session' && cookie.httpOnly && cookie.secure)).toBe(true);
}

async function openAccounts(page: BrowserPage) {
  const mobile = await page.evaluate(() => window.innerWidth <= 760);
  await page.getByRole('button', { name: mobile ? 'Más' : 'Gestión', exact: true }).click();
  const menu = mobile ? page.getByRole('dialog', { name: 'Gestión', exact: true })
    : page.getByRole('navigation', { name: 'Navegación principal', exact: true });
  await menu.getByRole('link', { name: 'Cuentas', exact: true }).click();
  await page.getByRole('heading', { name: 'Cuentas', exact: true, }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).waitFor({ timeout: 20_000 });
}

async function disabled(page: BrowserPage, name: string): Promise<boolean> {
  return page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll('button')).find((item) =>
      item.getAttribute('aria-label') === label || item.textContent.trim() === label);
    if (!button) throw new Error(`missing button ${label}`);
    return button.disabled;
  }, name);
}

async function preview(page: BrowserPage, label: string) {
  const actions = page.getByRole('group', { name: `Acciones de ${label}`, exact: true });
  await actions.getByRole('button', { name: 'Previsualizar cambio' }).click();
  await page.getByRole('status').filter({ hasText: 'Vista previa aceptada:' }).waitFor({ timeout: 20_000 });
  return actions;
}

async function apply(page: BrowserPage, label: string) {
  const actions = await preview(page, label);
  await actions.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
}

async function accountState(id = accountId) {
  const active = activeFixture();
  const session = await apiSession();
  const response = await active.request('/v3/console/config', {
    headers: { cookie: session.cookie, accept: 'application/json' },
  });
  expect(response.status).toBe(200);
  const snapshot = JSON.parse(response.body) as { provider_accounts: Record<string, unknown>[] };
  expect(response.body).not.toContain('CAUCE_SYNTHETIC_ACCOUNT_PATH');
  return snapshot.provider_accounts.find((row) => row.id === id);
}

async function bindingState(id = accountId) {
  const active = activeFixture();
  const result = await active.database.pool.query<{ priority: number; enabled: boolean }>(
    'SELECT priority,enabled FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
    [active.tenant, active.targetAlias, id],
  );
  return result.rows;
}

async function assignment(page: BrowserPage, operation: string, id = accountId) {
  const active = activeFixture();
  await page.getByRole('button', { name: 'Nueva asignación', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agente', exact: true }).selectOption(`${active.tenant}/${active.targetAlias}`);
  await page.getByRole('combobox', { name: 'Cuenta', exact: true }).selectOption(id);
  await page.getByLabel('Operación').selectOption(operation);
}

describe('administración real de cuentas y asignaciones', () => {
  it('edita, publica y habilita inventario con dry-run exacto y persistencia en escritorio 1440×900', async () => {
    const active = activeFixture();
    const page = await active.browserPage({ width: 1440, height: 900 });
    currentPage = page;
    await login(page);
    await openAccounts(page);
    for (const label of ['Cada 30 s', 'Cada 5 min', 'Cada 60 s', 'En pausa']) {
      await page.getByRole('button', { name: /^Frecuencia de lectura:/u }).click();
      await page.getByRole('menuitemradio', { name: label, exact: true }).click();
      await page.getByRole('button', { name: `Frecuencia de lectura: ${label.toLowerCase()}` }).waitFor();
    }
    await page.getByRole('button', { name: 'Frecuencia de lectura: en pausa' }).waitFor();
    await active.database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [secondAccountId, 'Etiqueta externa']);
    await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await page.getByRole('row', { name: new RegExp(secondAccountId, 'u') }).filter({ hasText: 'Etiqueta externa' }).waitFor();
    await active.database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [secondAccountId, 'Cuenta secundaria']);
    await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await page.getByRole('row', { name: new RegExp(secondAccountId, 'u') }).filter({ hasText: 'Cuenta secundaria' }).waitFor();
    const session = await apiSession();
    const response = await active.request('/v3/console/config', { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    const inventory = (JSON.parse(response.body) as { provider_accounts: Record<string, unknown>[] }).provider_accounts;
    for (const [label, count] of [
      ['Cuentas visibles', inventory.length],
      ['Publicadas al pool', inventory.filter((row) => row.shared_with_pool === true).length],
      ['Habilitadas', inventory.filter((row) => row.enabled === true).length],
      ['Pagadas por otra empresa', inventory.filter((row) => row.payer_tenant_id !== active.tenant).length],
    ] as const) {
      const card = page.getByRole('group', { name: 'Indicadores', exact: true }).getByRole('article').filter({ hasText: label });
      expect(await card.locator('strong').innerText()).toBe(String(count));
    }
    await screenshot(page, 'inventory-1440');
    await page.getByText('¿Cómo se conecta una cuenta?', { exact: true }).click();
    await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).click();
    await page.getByLabel('Etiqueta').fill('Edición cancelada');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    expect((await accountState())?.label).toBe('Cuenta de inventario');
    await screenshot(page, 'inventory-edit-cancelled-1440');
    await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).click();
    expect(await disabled(page, 'Aplicar')).toBe(true);
    await page.getByLabel('Etiqueta').fill('Etiqueta previsualizada');
    await preview(page, 'edición de cuenta');
    expect((await accountState())?.label).toBe('Cuenta de inventario');
    await page.getByLabel('Etiqueta').fill('Etiqueta persistente');
    expect(await disabled(page, 'Aplicar')).toBe(true);
    await screenshot(page, 'inventory-edit-dry-run-1440');
    await apply(page, 'edición de cuenta');
    expect((await accountState())?.label).toBe('Etiqueta persistente');

    for (const [verb, field, expected] of [
      ['Publicar', 'shared_with_pool', true], ['Despublicar', 'shared_with_pool', false],
      ['Deshabilitar', 'enabled', false], ['Habilitar', 'enabled', true],
    ] as const) {
      const name = field === 'shared_with_pool' ? `${verb} «${accountId}» ${expected ? 'al' : 'del'} pool` : `${verb} «${accountId}»`;
      await page.getByRole('button', { name, exact: true }).click();
      await apply(page, 'edición de cuenta');
      expect((await accountState())?.[field]).toBe(expected);
      await screenshot(page, `inventory-${verb.toLowerCase()}-1440`);
    }
    for (const label of ['', 'Etiqueta persistente']) {
      await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).click();
      await page.getByLabel('Etiqueta').fill(label);
      await apply(page, 'edición de cuenta');
      expect((await accountState())?.label).toBe(label || null);
    }
    await page.reload();
    await page.getByRole('row', { name: new RegExp(accountId, 'u') }).filter({ hasText: 'Etiqueta persistente' }).waitFor();
    await page.getByRole('link', { name: 'Registrar en Mis cuotas', exact: true }).click();
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor();
    await screenshot(page, 'registration-link-1440');
  }, 3 * 60_000);

  it('asigna, ordena, pausa, reanuda y revoca con PostgreSQL real en móvil 390×844', async () => {
    const active = activeFixture();
    const page = await active.browserPage({ width: 390, height: 844 });
    currentPage = page;
    await login(page);
    await openAccounts(page);
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await page.getByText('¿Qué cambia esta asignación?', { exact: true }).click();
    await page.getByRole('button', { name: 'Nueva asignación', exact: true }).click();
    expect(await disabled(page, 'Previsualizar cambio')).toBe(true);
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await assignment(page, 'grant-ceiling');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await page.getByRole('button', { name: 'Nueva asignación', exact: true }).click();
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] select')).map((select) => (select as HTMLSelectElement).value)))
      .toEqual([`${active.tenant}/${active.targetAlias}`, accountId, 'grant-ceiling']);
    await apply(page, 'asignación');
    const cellName = `${active.tenant}/${active.targetAlias} × ${accountId}`;
    await page.getByRole('button', { name: `${cellName}: Sin orden`, exact: true }).waitFor();
    await screenshot(page, 'assign-grant-390');

    await page.getByRole('button', { name: `${cellName}: Sin orden`, exact: true }).click();
    const order = page.getByRole('textbox', { name: /^Orden de consulta/u });
    for (const invalid of ['', '-1', '1.5', '32768', 'abc']) {
      await order.fill(invalid);
      expect(await disabled(page, 'Previsualizar cambio')).toBe(true);
    }
    for (const valid of ['0', '32767', '7']) {
      await order.fill(valid);
      expect(await disabled(page, 'Previsualizar cambio')).toBe(false);
    }
    await apply(page, 'asignación');
    expect(await bindingState()).toEqual([{ priority: 7, enabled: true }]);
    await page.getByRole('button', { name: `${cellName}: 1.º en consulta`, exact: true }).waitFor();
    await screenshot(page, 'assign-bound-390');

    await page.getByRole('button', { name: `${cellName}: 1.º en consulta`, exact: true }).click();
    await order.fill('3');
    await page.getByLabel('Orden activo').click();
    await apply(page, 'asignación');
    expect(await bindingState()).toEqual([{ priority: 3, enabled: false }]);
    await page.getByRole('button', { name: `${cellName}: Pausada`, exact: true }).waitFor();
    await screenshot(page, 'assign-paused-390');
    await page.getByRole('button', { name: `${cellName}: Pausada`, exact: true }).click();
    await page.getByLabel('Orden activo').click();
    await apply(page, 'asignación');
    expect(await bindingState()).toEqual([{ priority: 3, enabled: true }]);

    await assignment(page, 'grant-ceiling', secondAccountId);
    await apply(page, 'asignación');
    await assignment(page, 'create-binding', secondAccountId);
    await order.fill('3');
    await page.getByRole('button', { name: 'Previsualizar cambio' }).click();
    await page.getByRole('alert').waitFor({ timeout: 20_000 });
    expect(await bindingState(secondAccountId)).toEqual([]);
    expect(await disabled(page, 'Aplicar')).toBe(true);
    await screenshot(page, 'assign-order-conflict-390');
    await order.fill('32767');
    await apply(page, 'asignación');
    expect(await bindingState(secondAccountId)).toEqual([{ priority: 32767, enabled: true }]);
    await screenshot(page, 'assign-max-order-390');
    await page.getByRole('button', { name: `${active.tenant}/${active.targetAlias} × ${secondAccountId}: 2.º en consulta`, exact: true }).click();
    await order.fill('1');
    await apply(page, 'asignación');
    await page.getByRole('button', { name: `${cellName}: 2.º en consulta`, exact: true }).waitFor();
    await screenshot(page, 'assign-order-390');

    await assignment(page, 'delete-binding', secondAccountId);
    await apply(page, 'asignación');
    expect(await bindingState(secondAccountId)).toEqual([]);
    await assignment(page, 'revoke-ceiling', secondAccountId);
    await apply(page, 'asignación');
    await page.getByRole('button', { name: `${cellName}: 1.º en consulta`, exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('button', { name: `Retirar o rotar «${accountId}»`, exact: true }).click();
    await page.getByLabel(`Confirmar borrado de ${accountId}`).fill(accountId);
    expect(await disabled(page, 'Previsualizar cambio')).toBe(true);
    await screenshot(page, 'inventory-dependent-delete-390');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await assignment(page, 'revoke-ceiling');
    await apply(page, 'asignación');
    expect(await bindingState()).toEqual([]);
    const ceiling = await active.database.pool.query(
      'SELECT account_id FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3',
      [active.tenant, active.targetAlias, accountId],
    );
    expect(ceiling.rows).toEqual([]);
    await page.getByRole('button', { name: `${cellName}: Sin acceso`, exact: true }).waitFor();
    await screenshot(page, 'assign-revoked-390');
    await page.reload();
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await page.getByRole('button', { name: `${cellName}: Sin acceso`, exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await assignment(page, 'grant-ceiling');
    await page.getByRole('combobox', { name: 'Agente', exact: true }).selectOption(`Isa/${active.readerAlias}`);
    await page.getByRole('button', { name: 'Previsualizar cambio' }).click();
    await page.getByRole('alert').filter({ hasText: 'NO está publicada al pool' }).waitFor();
    expect(await disabled(page, 'Aplicar')).toBe(true);
    await screenshot(page, 'assign-private-borrow-rejected-390');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('button', { name: `Publicar «${accountId}» al pool`, exact: true }).click();
    await apply(page, 'edición de cuenta');
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await assignment(page, 'grant-ceiling');
    await page.getByRole('combobox', { name: 'Agente', exact: true }).selectOption(`Isa/${active.readerAlias}`);
    await apply(page, 'asignación');
    const borrowedCell = `Isa/${active.readerAlias} × ${accountId}`;
    await page.getByRole('button', { name: `${borrowedCell}: Sin orden`, exact: true }).click();
    await order.fill('0');
    await apply(page, 'asignación');
    await page.getByRole('button', { name: `${borrowedCell}: 1.º en consulta`, exact: true }).waitFor();
    const borrowed = await active.database.pool.query(
      'SELECT priority,enabled FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
      ['Isa', active.readerAlias, accountId],
    );
    expect(borrowed.rows).toEqual([{ priority: 0, enabled: true }]);
    await screenshot(page, 'assign-borrowed-consent-390');
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('button', { name: `Despublicar «${accountId}» del pool`, exact: true }).click();
    await page.getByRole('button', { name: 'Previsualizar cambio' }).click();
    await page.getByRole('alert').filter({ hasText: 'No se puede despublicar' }).waitFor();
    expect(await disabled(page, 'Aplicar')).toBe(true);
    expect((await accountState())?.shared_with_pool).toBe(true);
    await screenshot(page, 'inventory-borrowed-unpublish-rejected-390');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await assignment(page, 'revoke-ceiling');
    await page.getByRole('combobox', { name: 'Agente', exact: true }).selectOption(`Isa/${active.readerAlias}`);
    await apply(page, 'asignación');
    const revoked = await active.database.pool.query(
      'SELECT account_id FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
      ['Isa', active.readerAlias, accountId],
    );
    expect(revoked.rows).toEqual([]);
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('button', { name: `Despublicar «${accountId}» del pool`, exact: true }).click();
    await apply(page, 'edición de cuenta');
    expect((await accountState())?.shared_with_pool).toBe(false);
  }, 4 * 60_000);

  it('recupera revisión concurrente sin aplicar un dry-run vencido y retira desde inventario', async () => {
    const active = activeFixture();
    const page = await active.browserPage({ width: 1440, height: 900 });
    currentPage = page;
    await login(page);
    await openAccounts(page);
    await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).click();
    await page.getByLabel('Etiqueta').fill('Borrador concurrente');
    await preview(page, 'edición de cuenta');
    const session = await apiSession();
    const concurrent = await active.request('/v3/console/config/changes', {
      method: 'POST', headers: { origin: new URL(active.baseUrl).origin, cookie: session.cookie, 'x-csrf-token': session.csrf },
      body: { dry_run: false, mutation: { resource: 'provider_account', action: 'update', id: accountId,
        value: { label: 'Cambio concurrente', shared_with_pool: false, enabled: true } } },
    });
    expect(concurrent.status).toBe(201);
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'La configuración cambió mientras editabas' }).waitFor({ timeout: 20_000 });
    expect((await accountState())?.label).toBe('Cambio concurrente');
    await screenshot(page, 'inventory-cas-conflict-1440');
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor();
    expect((await accountState())?.label).toBe('Borrador concurrente');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('button', { name: `Retirar o rotar «${accountId}»`, exact: true }).click();
    await page.getByLabel(`Confirmar borrado de ${accountId}`).fill('incorrecto');
    expect(await disabled(page, 'Previsualizar cambio')).toBe(true);
    await page.getByRole('link', { name: 'Eliminar en Mis cuotas', exact: true }).click();
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor();
    await page.goto(`${active.baseUrl}/accounts`);
    await page.getByRole('button', { name: `Retirar o rotar «${accountId}»`, exact: true }).click();
    await page.getByLabel(`Confirmar borrado de ${accountId}`).fill(accountId);
    await screenshot(page, 'inventory-retire-1440');
    await apply(page, 'retiro o rotación de cuenta');
    expect(await accountState()).toBeUndefined();
    const result = await active.database.pool.query('SELECT id FROM provider_accounts WHERE id=$1', [accountId]);
    expect(result.rows).toEqual([]);
    await page.getByRole('row', { name: new RegExp(accountId + '(?!-second)', 'u') }).waitFor({ state: 'hidden' });
  }, 2 * 60_000);

  it('un lector móvil ve proyección redacted y los controles quedan bloqueados', async () => {
    const active = activeFixture();
    const page = await active.browserPage({ width: 390, height: 844 });
    currentPage = page;
    await login(page, true);
    await page.goto(`${active.baseUrl}/accounts`);
    await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor();
    await page.getByRole('row', { name: new RegExp(active.foreignPoolAccountId, 'u') }).waitFor();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(active.foreignExternalMarker);
    expect(body).not.toContain(active.foreignCredentialLocator);
    expect(body).not.toContain(active.foreignPrivateAccountId);
    for (const name of [`Editar «${active.foreignPoolAccountId}»`, `Deshabilitar «${active.foreignPoolAccountId}»`,
      `Despublicar «${active.foreignPoolAccountId}» del pool`, `Retirar o rotar «${active.foreignPoolAccountId}»`]) {
      expect(await disabled(page, name)).toBe(true);
    }
    await screenshot(page, 'inventory-reader-390');
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    expect(await disabled(page, 'Nueva asignación')).toBe(true);
    const session = await active.loginReader();
    const snapshot = await active.request('/v3/console/config', {
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    expect(snapshot.status).toBe(200);
    const config = JSON.parse(snapshot.body) as { provider_accounts: Record<string, unknown>[] };
    const shared = config.provider_accounts.find((row) => row.id === active.foreignPoolAccountId);
    expect(shared).toMatchObject({ external_account_id: null, credential_ref_kind: null });
    expect(shared && Object.hasOwn(shared, 'credential_ref')).toBe(false);
    expect(snapshot.body).not.toContain(active.foreignExternalMarker);
    expect(snapshot.body).not.toContain(active.foreignCredentialLocator);
    expect(snapshot.body).not.toContain(active.foreignPrivateAccountId);
    const denial = await active.request('/v3/console/config/changes', {
      method: 'POST', headers: { origin: new URL(active.baseUrl).origin, cookie: session.cookie, 'x-csrf-token': session.csrf },
      body: { dry_run: false, mutation: { resource: 'provider_account', action: 'delete', id: active.foreignPrivateAccountId } },
    });
    expect(denial.status).toBe(403);
    const saved = await active.database.pool.query('SELECT id FROM provider_accounts WHERE id=$1', [active.foreignPrivateAccountId]);
    expect(saved.rows).toHaveLength(1);
    await screenshot(page, 'assign-reader-390');
  }, 2 * 60_000);

  it('muestra carga y error reales de PostgreSQL y recupera el inventario al reintentar', async () => {
    const active = activeFixture();
    const page = await active.browserPage({ width: 1440, height: 900 });
    currentPage = page;
    await login(page);
    const lock = await active.database.adminPool.connect();
    let renamed = false;
    try {
      await lock.query("SET lock_timeout='5s'");
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE provider_accounts IN ACCESS EXCLUSIVE MODE');
      await page.goto(`${active.baseUrl}/accounts`);
      await page.getByText('Leyendo cuentas y asignaciones…', { exact: true }).waitFor();
      await screenshot(page, 'inventory-loading-1440');
      await lock.query('ROLLBACK');
      await lock.query('ALTER TABLE provider_accounts RENAME TO zz_canary_accounts_unavailable');
      renamed = true;
      await page.reload();
      await page.getByRole('alert').filter({ hasText: 'No se pudo leer Cauce V3' }).waitFor();
      await screenshot(page, 'inventory-read-error-1440');
    } finally {
      try {
        await lock.query('ROLLBACK');
        if (renamed) await lock.query('ALTER TABLE zz_canary_accounts_unavailable RENAME TO provider_accounts');
      } finally {
        try { await lock.query('RESET lock_timeout'); } finally { lock.release(); }
      }
    }
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor();
    await page.getByRole('button', { name: `Editar «${secondAccountId}»`, exact: true }).waitFor();
    expect((await accountState(secondAccountId))?.id).toBe(secondAccountId);
    await screenshot(page, 'inventory-retry-1440');
  }, 2 * 60_000);

  it('muestra inventario y matriz sin cuentas y enlaza el registro real desde el estado vacío', async () => {
    const active = activeFixture();
    await active.database.pool.query('DELETE FROM provider_accounts WHERE id=ANY($1::text[])',
      [[accountId, secondAccountId, active.foreignPoolAccountId, active.foreignPrivateAccountId]]);
    const page = await active.browserPage({ width: 390, height: 844 });
    currentPage = page;
    await login(page);
    await page.goto(`${active.baseUrl}/accounts`);
    await page.getByText(/Todavía no hay cuentas\. Es lo normal en una empresa nueva/u).waitFor();
    expect(await accountState(secondAccountId)).toBeUndefined();
    await screenshot(page, 'inventory-empty-390');
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await page.getByText('No hay cuentas visibles para formar columnas.', { exact: true }).waitFor();
    await screenshot(page, 'assign-empty-390');
    await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
    await page.getByRole('link', { name: 'Registrar en Mis cuotas', exact: true }).click();
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor();
    await screenshot(page, 'inventory-empty-registration-390');
  }, 2 * 60_000);
});
