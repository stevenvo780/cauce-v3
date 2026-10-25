import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startAgentQuotaDocker, type QuotaAgentPlacement } from './v4-cuotas-agent-real-browser.fixtures.js';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration,
  type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const directory = resolve('.delegados/v4/recibos/e2e-a7-commit-1025/agent', run);
const person: V4Person = { email: `zz-canary-e2e-a7-commit-1025-${run}@example.invalid`, name: 'Dueño cuotas E2E',
  password: `Synthetic-quota-${run}-password`,
  company: { slug: `zz-canary-e2e-a7-commit-1025-${run}`, name: 'Cuotas E2E' } };
const readerPerson = { ...person, email: `zz-canary-reader-${run}@example.invalid`, name: 'Lector cuotas E2E' };
let preferencesUnavailable = false;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'owned-preferences-relation-unavailable', reason: 'the owned test database temporarily hides its preferences relation',
  matches: (text, url) => preferencesUnavailable && text.includes('status of 500') && url.endsWith('/v3/console/preferences'),
}]);
const readerErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'reader-management-capabilities-forbidden', reason: 'reader has no permission to open a terminal or manage fleet hosts',
  matches: (text, url) => text.includes('status of 403') && ['/v3/console/terminal/capability',
    '/v3/console/fleet/capability', '/v3/console/fleet/hosts'].some(path => url.endsWith(path)),
}]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let physical: Awaited<ReturnType<typeof startAgentQuotaDocker>> | undefined;
let page: V4Page;
let failurePage: V4Page | undefined;
const active = () => { if (!fixture) throw new Error('quota browser fixture missing'); return fixture; };
const runtime = () => { if (!physical) throw new Error('physical quota fixture missing'); return physical; };
const quotaPath = (agent: QuotaAgentPlacement) => `/v3/console/agents/${agent.tenant_id}/${agent.alias}/quota`;

async function screenshot(name: string) {
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: false });
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(page, 'quota-agent-owner');
  const form = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  physical = await startAgentQuotaDocker(fixture, person.email, directory, readerPerson);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', physical.approvalsFile);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', physical.descriptors);
}, 600_000);

afterAll(async () => {
  try { await physical?.close(); }
  finally { try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } }
}, 180_000);

afterEach(async context => {
  const target = failurePage ?? page;
  failurePage = undefined;
  if (context.task.result?.state !== 'fail') return;
  await target.screenshot({ path: resolve(directory, `failure-${context.task.id.replaceAll(/[^a-z0-9_-]/giu, '_')}.png`), fullPage: false });
  await writeFile(resolve(directory, 'failure-body.txt'), await target.locator('body').innerText());
});

async function openSheet(agent: QuotaAgentPlacement) {
  await runtime().announce();
  await page.goto(`${active().baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${agent.tenant_id}/${agent.alias}`)}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog');
  await sheet.getByText(agent.alias, { exact: true }).first().waitFor({ timeout: 20_000 });
  await sheet.getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true }).waitFor({ timeout: 20_000 });
  return sheet;
}

describe('cuotas desde la ficha con Chromium, canal firmado, Docker y PostgreSQL reales', () => {
  it('consulta dos agentes, persiste ventanas y muestra una cuenta compartida sin duplicar el saldo', async () => {
    const measured: { account_id: string; remaining_percent: number }[] = [];
    for (const [index, agent] of runtime().agents.slice(0, 2).entries()) {
      const sheet = await openSheet(agent);
      const reader = sheet.getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
      await expect.poll(async () => reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
      await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
      await screenshot(`query-pending-${String(index)}-1440`);
      expect(await runtime().executor.runOnce()).toBe(true);
      await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
      await reader.getByText('Último saldo medido: 75%.', { exact: true }).waitFor({ timeout: 20_000 });
      await reader.getByText('5h: 75% medido', { exact: true }).waitFor({ timeout: 20_000 });
      await reader.getByText('Reinicio no informado.', { exact: true }).waitFor({ timeout: 20_000 });
      const reading = await apiGet(page, quotaPath(agent));
      expect(reading.status).toBe(200);
      expect(reading.body).toMatchObject({ status: 'ok', reader_available: true, operation: { status: 'done' },
        sample: { windows: [expect.objectContaining({ remaining_percent: 75, window_minutes: 300 })] } });
      const stored = (await active().database.pool.query<{ account_id: string; sample: { effective_remaining_percent: number } }>(
        'SELECT account_id,sample FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2', [agent.tenant_id, agent.alias])).rows[0];
      if (!stored) throw new Error('quota observation was not persisted');
      measured.push({ account_id: stored.account_id, remaining_percent: stored.sample.effective_remaining_percent });
      await screenshot(`agent-measured-${String(index)}-1440`);
    }
    expect(measured).toEqual([{ account_id: measured[0]?.account_id, remaining_percent: 75 },
      { account_id: measured[0]?.account_id, remaining_percent: 75 }]);
    const accounts = (await apiGet(page, '/v3/console/quota-accounts')).body as { accounts: { id: string; remaining_percent: number; agent_count: number }[] };
    expect(accounts.accounts.filter(account => account.id === measured[0]?.account_id))
      .toEqual([expect.objectContaining({ remaining_percent: 75, agent_count: 2 })]);
    const second = runtime().agents[1];
    if (!second) throw new Error('second agent missing');
    await openSheet(second);
    await page.getByText('Consumo compartido por 2 agentes; el saldo pertenece a la misma suscripción.', { exact: false }).waitFor({ timeout: 20_000 });
    await screenshot('shared-quota-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('shared-quota-390');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await writeFile(resolve(directory, 'shared-quota.json'), JSON.stringify({ measured, shared_agents: 2,
      observations: (await active().database.pool.query('SELECT alias,status,account_id,captured_at FROM agent_quota_observations WHERE company_id=$1', [person.company.slug])).rows }, null, 2));
  }, 180_000);

  it('explica un harness sin lector y mantiene la consulta deshabilitada', async () => {
    const agent = runtime().agents[2];
    if (!agent) throw new Error('unsupported agent missing');
    const sheet = await openSheet(agent);
    await sheet.getByText('Sin lector de cuota para este harness: el proveedor no expone una ventana de consumo medible.', { exact: true }).waitFor({ timeout: 20_000 });
    expect(await sheet.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ status: 'unsupported', reader_available: false, reason: 'quota_reader_unavailable' });
    await screenshot('unsupported-reader-390');
  });

  it('muestra el fallo real del contenedor y sus detalles y permite consultar después de recuperarlo', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('quota agent missing');
    await page.setViewportSize({ width: 1440, height: 900 });
    const reader = (await openSheet(agent)).getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await runtime().docker(['stop', '--time', '1', agent.container_name]);
    try {
      await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
      await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await runtime().executor.runOnce()).toBe(true);
      await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
      await reader.getByText('La operación falló', { exact: true }).waitFor({ timeout: 20_000 });
      await reader.getByText('Detalles técnicos', { exact: true }).click();
      await reader.getByText('RUNTIME_UNAVAILABLE', { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ status: 'failed', operation: { status: 'failed', error_code: 'RUNTIME_UNAVAILABLE' } });
      await screenshot('agent-query-failed-details-1440');
    } finally { await runtime().docker(['start', agent.container_name]); }
    await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
    await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
    expect(await runtime().executor.runOnce()).toBe(true);
    await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await reader.getByText('Medición recibida', { exact: true }).waitFor({ timeout: 20_000 });
    expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ status: 'ok', operation: { status: 'done' } });
    await screenshot('agent-query-recovered-1440');
  }, 120_000);

  it('muestra la consulta en ejecución mientras el ejecutor mantiene la reserva antes de leer el contenedor', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('quota agent missing');
    const reader = (await openSheet(agent)).getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
    await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
    const release = runtime().holdExecution();
    const executing = runtime().executor.runOnce();
    try {
      await expect.poll(async () => (await apiGet(page, quotaPath(agent))).body.status, { timeout: 15_000 }).toBe('running');
      await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
      await reader.getByText('Consultando en el ordenador', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
      await screenshot('agent-query-running-1440');
    } finally { release(); expect(await executing).toBe(true); }
    await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await reader.getByText('Medición recibida', { exact: true }).waitFor({ timeout: 20_000 });
  }, 90_000);

  it('distingue la sesión caducada del agotamiento y muestra el saldo como no acreditado', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('quota agent missing');
    const reader = (await openSheet(agent)).getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await runtime().setReaderMode(agent, 'token_expired');
    try {
      await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
      await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await runtime().executor.runOnce()).toBe(true);
      await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
      await reader.getByText('Sesión caducada: autenticar de nuevo', { exact: true }).waitFor({ timeout: 20_000 });
      await reader.getByText('Saldo no acreditado en la última medición.', { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ status: 'error', sample: { ok: false, note: 'token_expired' } });
      expect(await reader.getByText('Último saldo medido: 0%.', { exact: true }).count()).toBe(0);
      await screenshot('agent-token-expired-1440');
    } finally { await runtime().setReaderMode(agent, 'normal'); }
  }, 120_000);

  it('explica la falta de respuesta sin inventar un saldo y la relectura recupera la consulta pendiente', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('quota agent missing');
    const reader = (await openSheet(agent)).getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
    await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
    expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    await reader.getByText('El ordenador no responde. Relee la cuota para comprobar si la consulta terminó.', { exact: true }).waitFor({ timeout: 145_000 });
    expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ status: 'pending', operation: { status: 'pending' } });
    await screenshot('agent-query-unresponsive-1440');
    await expect.poll(async () => (await apiGet(page, quotaPath(agent))).body.reason, { timeout: 45_000 }).toBe('quota_host_unavailable');
    expect((await apiGet(page, quotaPath(agent))).body).toMatchObject({ can_query: false, reason: 'quota_host_unavailable' });
    await screenshot('agent-host-unavailable-1440');
    await runtime().announce();
    expect(await runtime().executor.runOnce()).toBe(true);
    await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await reader.getByText('Medición recibida', { exact: true }).waitFor({ timeout: 20_000 });
    expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(false);
    await screenshot('agent-unresponsive-recovered-1440');
  }, 200_000);

  it('el lector ve la cuota compartida pero no puede consultar ni administrar cuentas', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('quota agent missing');
    await runtime().announce();
    const readPage = asV4Page(await newTrustedPage(active(), { width: 390, height: 844 }));
    failurePage = readPage;
    readerErrors.watch(readPage, 'quota-reader');
    await login(readPage, active().baseUrl, readerPerson);
    expect((await apiGet(readPage, '/v3/auth/session')).body).toMatchObject({ authority: { role: 'reader' } });
    await readPage.goto(`${active().baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${agent.tenant_id}/${agent.alias}`)}`, { waitUntil: 'domcontentloaded' });
    const reader = readPage.getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await reader.getByText('Tu rol permite ver la cuota, pero no consultarla. Pide a un propietario o administrador de la empresa que la consulte.', { exact: true }).waitFor({ timeout: 20_000 });
    expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    const before = await active().database.pool.query('SELECT id,status FROM agent_quota_operations WHERE company_id=$1 ORDER BY id', [person.company.slug]);
    readerErrors.expectHttpError(quotaPath(agent), 403);
    const status = await readPage.evaluate(async (path: string) => {
      const session = await (await fetch('/v3/auth/session')).json() as { csrf_token: string };
      return (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
        body: JSON.stringify({ expected_revision: 0, idempotency_key: 'reader-forbidden' }) })).status;
    }, quotaPath(agent));
    expect(status).toBe(403);
    expect((await active().database.pool.query('SELECT id,status FROM agent_quota_operations WHERE company_id=$1 ORDER BY id', [person.company.slug])).rows).toEqual(before.rows);
    await readPage.screenshot({ path: resolve(directory, 'quota-reader-sheet-390.png'), fullPage: false });
    await readPage.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await readPage.getByRole('region', { name: 'Tarjetas de Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    for (const name of ['Registrar cuenta', 'Editar cuenta', 'Eliminar cuenta', 'Iniciar sesión']) {
      expect(await readPage.getByRole('button', { name, exact: true }).first().isDisabled()).toBe(true);
    }
    await readPage.screenshot({ path: resolve(directory, 'quota-reader-my-quotas-390.png'), fullPage: false });
  }, 90_000);

  it('Mis cuotas conserva tarjetas, filtros, pausa y reanudación y resuelve conflictos entre dos sesiones', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    const cards = () => page.getByRole('region', { name: 'Tarjetas de Mis cuotas', exact: true });
    await page.getByRole('button', { name: 'Ver solo cuentas fijadas', exact: true }).click();
    await page.getByText('No has fijado ninguna cuenta. Muestra todas y elige las que quieras seguir.', { exact: true }).waitFor({ timeout: 15_000 });
    await screenshot('pinned-empty-1440');
    await page.getByRole('button', { name: 'Ver todas las cuentas', exact: true }).click();
    await cards().getByRole('button', { name: 'Fijar cuenta', exact: true }).click();
    await cards().getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 15_000 });
    const preferences = (await apiGet(page, '/v3/console/preferences')).body as { pinned_quota_accounts: string[] };
    expect(preferences.pinned_quota_accounts).toHaveLength(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await cards().getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 20_000 });
    const second = asV4Page(await newTrustedPage(active(), { width: 390, height: 844 }));
    errors.watch(second, 'quota-preferences-second');
    await login(second, active().baseUrl, person);
    await second.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await second.getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 20_000 });
    await second.screenshot({ path: resolve(directory, 'pinned-second-session-390.png'), fullPage: false });

    await cards().getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    const form = page.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true });
    await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('Cuota con pausa');
    await form.getByLabel('Pausa hasta (hora de tu navegador)', { exact: true }).fill('2030-12-10T08:30');
    await form.getByLabel('Motivo de pausa', { exact: true }).fill('Pausa E2E');
    await form.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await page.getByRole('article', { name: 'Cuotas de Cuota con pausa', exact: true }).waitFor({ timeout: 20_000 });
    const accountId = preferences.pinned_quota_accounts[0];
    const paused = await active().database.pool.query('SELECT paused_until IS NOT NULL AS paused,paused_reason FROM provider_accounts WHERE id=$1', [accountId]);
    expect(paused.rows).toEqual([{ paused: true, paused_reason: 'Pausa E2E' }]);
    await screenshot('paused-account-1440');
    await cards().getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    await form.getByLabel('Reanudar ahora (quita la pausa)', { exact: true }).check();
    await form.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await page.getByText('Cuenta actualizada.', { exact: true }).waitFor({ timeout: 15_000 });
    expect((await active().database.pool.query('SELECT paused_until,paused_reason FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ paused_until: null, paused_reason: null }]);

    await cards().getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('Borrador conservado');
    await second.reload({ waitUntil: 'domcontentloaded' });
    await second.getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    const otherForm = second.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true });
    await otherForm.getByLabel('Nombre de la cuenta', { exact: true }).fill('Cambio concurrente');
    await otherForm.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await second.getByRole('article', { name: 'Cuotas de Cambio concurrente', exact: true }).waitFor({ timeout: 20_000 });
    errors.expectHttpError(`/v3/console/quota-accounts/${String(accountId)}`, 409);
    await form.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    const conflict = page.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await form.getByLabel('Nombre de la cuenta', { exact: true }).inputValue()).toBe('Borrador conservado');
    expect(await conflict.innerText()).toContain('Cambio concurrente');
    await screenshot('account-cas-conflict-1440');
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    await page.getByRole('article', { name: 'Cuotas de Borrador conservado', exact: true }).waitFor({ timeout: 20_000 });
    expect((await active().database.pool.query('SELECT label FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ label: 'Borrador conservado' }]);
    await cards().getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('Borrador descartado');
    await second.reload({ waitUntil: 'domcontentloaded' });
    await second.getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    await otherForm.getByLabel('Nombre de la cuenta', { exact: true }).fill('Servidor conservado');
    await otherForm.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await second.getByRole('article', { name: 'Cuotas de Servidor conservado', exact: true }).waitFor({ timeout: 20_000 });
    errors.expectHttpError(`/v3/console/quota-accounts/${String(accountId)}`, 409);
    await form.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    expect(await form.getByLabel('Nombre de la cuenta', { exact: true }).inputValue()).toBe('Servidor conservado');
    expect((await active().database.pool.query('SELECT label FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ label: 'Servidor conservado' }]);
    await screenshot('account-cas-discard-1440');
    await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await cards().getByRole('button', { name: 'Desfijar cuenta', exact: true }).click();
    await cards().getByRole('button', { name: 'Fijar cuenta', exact: true }).waitFor({ timeout: 15_000 });
    expect(((await apiGet(page, '/v3/console/preferences')).body as { pinned_quota_accounts: string[] }).pinned_quota_accounts).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('my-quotas-390');
    const layout = await page.evaluate(() => ({ viewport: window.innerWidth, scroll: document.documentElement.scrollWidth,
      overflow: Array.from(document.querySelectorAll('body *')).filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map(element => ({ tag: element.tagName, classes: element.getAttribute('class'), width: element.getBoundingClientRect().width,
          overflowWrap: getComputedStyle(element).overflowWrap, minWidth: getComputedStyle(element).minWidth,
          text: element.textContent.slice(0, 120) })).slice(0, 30) }));
    await writeFile(resolve(directory, 'my-quotas-mobile-layout.json'), JSON.stringify(layout, null, 2));
    expect(layout.scroll <= layout.viewport).toBe(true);
  }, 180_000);

  it('ordena las tarjetas fijadas antes de las demás y protege la eliminación de una cuenta compartida', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    for (const label of ['AAA sin fijar', 'ZZZ fijada']) {
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill(label);
      await form.locator('select').selectOption('codex');
      await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await page.getByRole('article', { name: `Cuotas de ${label}`, exact: true }).waitFor({ timeout: 20_000 });
    }
    const cards = page.getByRole('region', { name: 'Tarjetas de Mis cuotas', exact: true });
    await page.getByRole('article', { name: 'Cuotas de ZZZ fijada', exact: true }).getByRole('button', { name: 'Fijar cuenta', exact: true }).click();
    await page.getByRole('article', { name: 'Cuotas de ZZZ fijada', exact: true }).getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 15_000 });
    expect(await cards.getByRole('article').first().getByRole('heading').innerText()).toBe('ZZZ fijada');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await cards.getByRole('article').first().getByRole('heading', { name: 'ZZZ fijada', exact: true }).waitFor({ timeout: 20_000 });
    await screenshot('pinned-first-multiple-1440');
    const shared = page.getByRole('article', { name: 'Cuotas de Servidor conservado', exact: true });
    await shared.getByRole('button', { name: 'Eliminar cuenta', exact: true }).click();
    const account = (await active().database.pool.query<{ id: string }>('SELECT id FROM provider_accounts WHERE company_id=$1 AND label=$2', [person.company.slug, 'Servidor conservado'])).rows[0];
    if (!account) throw new Error('shared account missing');
    errors.expectHttpError(`/v3/console/quota-accounts/${account.id}`, 409);
    await page.getByRole('button', { name: 'Confirmar eliminación de cuenta', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Otro cambio llegó antes, o el recurso aún tiene dependencias.' }).waitFor({ timeout: 20_000 });
    expect((await active().database.pool.query('SELECT id FROM provider_accounts WHERE id=$1', [account.id])).rowCount).toBe(1);
    await screenshot('account-delete-dependencies-1440');
    await page.getByRole('region', { name: 'Confirmar eliminación de cuenta', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
    for (const label of ['AAA sin fijar', 'ZZZ fijada']) {
      await page.getByRole('article', { name: `Cuotas de ${label}`, exact: true }).getByRole('button', { name: 'Eliminar cuenta', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar eliminación de cuenta', exact: true }).click();
      await expect.poll(async () => page.getByRole('article', { name: `Cuotas de ${label}`, exact: true }).count(), { timeout: 20_000 }).toBe(0);
    }
  }, 90_000);

  it('muestra carga y error reales de las preferencias y las recupera desde Releer tarjetas fijadas', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const lock = await active().database.adminPool.connect();
    let transaction = false;
    let renamed = false;
    try {
      await lock.query('BEGIN');
      transaction = true;
      await lock.query('LOCK TABLE console_company_preferences IN ACCESS EXCLUSIVE MODE');
      await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Leyendo tarjetas fijadas…', { exact: true }).waitFor({ timeout: 15_000 });
      await screenshot('preferences-loading-1440');
      preferencesUnavailable = true;
      await lock.query('ALTER TABLE console_company_preferences RENAME TO zz_canary_quota_preferences_unavailable');
      renamed = true;
      await lock.query('COMMIT');
      transaction = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Releer tarjetas fijadas', exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Releer tarjetas fijadas', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      expect(await page.getByRole('button', { name: 'Ver solo cuentas fijadas', exact: true }).isDisabled()).toBe(true);
      expect(errors.ignored.get('owned-preferences-relation-unavailable') ?? 0).toBeGreaterThan(0);
      await screenshot('preferences-read-failed-1440');
    } finally {
      try {
        if (transaction) await lock.query('ROLLBACK');
        await lock.query("SET lock_timeout='5s'");
        if (renamed) await lock.query('ALTER TABLE zz_canary_quota_preferences_unavailable RENAME TO console_company_preferences');
      } finally {
        preferencesUnavailable = false;
        try { await lock.query('RESET lock_timeout'); } finally { lock.release(); }
      }
    }
    await page.getByRole('button', { name: 'Releer tarjetas fijadas', exact: true }).click();
    await expect.poll(async () => page.getByRole('button', { name: 'Ver solo cuentas fijadas', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    expect((await apiGet(page, '/v3/console/preferences')).status).toBe(200);
    await screenshot('preferences-read-recovered-1440');
  }, 90_000);

  it('no registra errores inesperados del navegador', () => { errors.assertClean(); readerErrors.assertClean(); });
});
