import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, type V4Page } from './v4-console-real-browser.helpers.js';
import { quotaCanaryPerson, startQuotaDockerHost, type QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';
import { prepareGrokMuseQuotaImage } from './v4-cuotas-grok-muse.fixtures.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', process.env.CAUCE_PLAZOS_FACTOR ?? '3');
process.env.CAUCE_QUOTA_DOCKER_CONTEXT = 'lab';
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const execute = promisify(execFile);
const task = 'q2-entornos-grok-muse-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const owner = quotaCanaryPerson('q2-grok-muse', run);
const hostId = `${owner.company.slug}-host`;
const evidence = join(process.cwd(), '.delegados/v4/recibos', task, 'environments', run);
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let host: Awaited<ReturnType<typeof startQuotaDockerHost>> | undefined;
let image: QuotaDockerImage | undefined;
let page: V4Page;

function active() { if (!fixture) throw new Error('quota cycle fixture unavailable'); return fixture; }
function runtime() { if (!host) throw new Error('quota cycle host unavailable'); return host; }
async function record(name: string, value: unknown) {
  await writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
async function docker(args: string[]) {
  return execute('docker', ['--context', 'lab', ...args], { timeout: 30_000 });
}
async function sessionText(container: string, path: string) {
  return (await docker(['exec', '--user', '1000:1000', container, 'cat', path])).stdout;
}

describe('Mis cuotas con dobles de Grok y Muse en docker-lab', () => {
  it('crea, autentica, consulta, actualiza el CLI y elimina cada entorno', async () => {
    await mkdir(evidence, { recursive: true });
    image = await prepareGrokMuseQuotaImage(evidence, prefix, task);
    await record('image', { image: image.image, tag: image.tag, providers: image.providers });
    fixture = await startConsoleFunctionalFixture();
    page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
    errors.watch(page, 'quota-grok-muse');
    const registration = await openRegistration(page, fixture.baseUrl);
    await fillRegistration(registration, owner);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    host = await startQuotaDockerHost(fixture, owner, hostId, image, evidence);
    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    const providers = [
      { id: 'grok', label: 'Grok', version: 'grok-cli 1.0.0', updated: 'grok-cli 2.0.0', session: '/home/node/.grok-quota-session' },
      { id: 'muse', label: 'Muse', version: 'muse-cli 1.0.0', updated: 'muse-cli 2.0.0', session: '/home/node/.muse-quota-session' },
    ] as const;
    for (const provider of providers) {
      const accountLabel = `${prefix}-${provider.id}`;
      const environmentLabel = `${prefix}-${provider.id}-env`;
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const accountForm = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
      await accountForm.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
      await accountForm.locator('select').selectOption(provider.id);
      await accountForm.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
      const accounts = await apiGet(page, '/v3/console/quota-accounts');
      const account = (accounts.body as unknown as { accounts: { id: string; label: string }[] }).accounts.find(row => row.label === accountLabel);
      if (!account) throw new Error(`${provider.id} account was not persisted`);
      const form = page.getByRole('form', { name: 'Crear entorno de cuotas', exact: true });
      await form.locator('select').nth(0).selectOption(account.id);
      await form.locator('select').nth(1).selectOption(hostId);
      await form.getByLabel('Nombre del entorno', { exact: true }).fill(environmentLabel);
      await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
      const card = () => page.getByRole('article', { name: `Entorno ${environmentLabel}`, exact: true });
      await card().waitFor({ timeout: 20_000 });
      const listed = await apiGet(page, '/v3/console/quota-environments');
      const environment = (listed.body as unknown as { environments: { id: string; label: string }[] }).environments
        .find(row => row.label === environmentLabel);
      if (!environment) throw new Error(`${provider.id} environment was not persisted`);
      const created = await runtime().waitOperation(environment.id, 'create');
      expect(created.result).toMatchObject({ runtime_verified: true, cli_version: provider.version });
      const observed = await runtime().inspect(environment.id);
      expect(observed).toMatchObject({ present: true, volume_present: true, image: image.image });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card().getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      const unauthenticated = await runtime().waitOperation(environment.id, 'query');
      expect(unauthenticated.result).toMatchObject({
        observation_status: 'error', provider_report: { ok: false, note: 'not_authenticated', windows: [] } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const login = page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });
      await login.waitFor({ timeout: 20_000 });
      const environmentChoice = login.getByLabel('Entorno u ordenador', { exact: true });
      if (await environmentChoice.count() > 0) await environmentChoice.selectOption(environment.id);
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`${provider.id} authentication stream did not become ready`)); }, 30_000);
        page.on('websocket', candidate => {
          if (!candidate.url().includes('/provider-auth/sessions/')) return;
          const socket = candidate as unknown as { on(event: 'framereceived', callback: (frame: { payload: string | Buffer }) => void): void };
          let marked = false;
          let output = false;
          socket.on('framereceived', ({ payload }) => {
            if (Buffer.isBuffer(payload)) output ||= payload.length > 0;
            else marked ||= payload === '{"type":"ready"}';
            if (marked && output) { clearTimeout(timer); resolve(); }
          });
        });
      });
      await login.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      try { await ready; }
      catch (error) {
        const text = await page.locator('body').innerText();
        const operations = (await active().database.pool.query(
          'SELECT action,status,error_code,result FROM quota_environment_operations WHERE environment_id=$1 ORDER BY created_at',
          [environment.id])).rows;
        await record(`${provider.id}-auth-blocked`, { text, operations, console: errors.trace });
        throw new Error(`${provider.id} login did not open a terminal: ${text.slice(0, 1500)}`, { cause: error });
      }
      const dialog = page.getByRole('dialog');
      const terminal = dialog.getByLabel('Terminal privada de autenticación', { exact: true });
      await terminal.waitFor({ timeout: 30_000 });
      const textarea = terminal.locator('textarea') as unknown as { pressSequentially(value: string): Promise<void>; press(value: string): Promise<void> };
      await textarea.pressSequentially('APROBAR');
      await textarea.press('Enter');
      await expect.poll(async () => {
        try { await docker(['exec', '--user', '1000:1000', observed.container_name, 'test', '-s', provider.session]); return true; }
        catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      const sessionBefore = await sessionText(observed.container_name, provider.session);
      await dialog.getByRole('button', { name: 'Verificar conexión', exact: true }).click();
      await page.getByText('Sesión iniciada y verificada.', { exact: true }).waitFor({ timeout: 30_000 });
      expect((await runtime().waitOperation(environment.id, 'authenticate')).result.authenticated_verified).toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card().getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      const before = await runtime().waitOperation(environment.id, 'query', { afterId: unauthenticated.id });
      expect(before.result).toMatchObject({ observation_status: 'ok', cli_version: provider.version,
        provider_report: { ok: true, windows: [{ remaining_percent: 72, window_minutes: 300 }, { remaining_percent: 91, window_minutes: 10080 }] } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const accountCard = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
      for (const label of ['5 h', 'Semanal', '72%', '91%']) await accountCard.getByText(label, { exact: true }).waitFor({ timeout: 20_000 });
      await card().getByRole('button', { name: 'Actualizar CLI', exact: true }).click();
      expect((await runtime().waitOperation(environment.id, 'update_cli')).result).toMatchObject({
        cli_updated_verified: true, cli_version: provider.updated });
      expect(await runtime().inspect(environment.id)).toMatchObject({ present: true, volume_present: true, image: image.image });
      expect(await sessionText(observed.container_name, provider.session)).toBe(sessionBefore);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card().getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      const after = await runtime().waitOperation(environment.id, 'query', { afterId: before.id });
      const beforeReport = before.result.provider_report as { windows: unknown[]; account_id: string };
      expect(after.result).toMatchObject({ observation_status: 'ok', cli_version: provider.updated,
        provider_report: { ok: true, account_id: beforeReport.account_id, windows: beforeReport.windows } });
      await card().getByRole('button', { name: 'Eliminar entorno', exact: true }).click();
      await page.getByRole('region', { name: 'Confirmar operación del entorno', exact: true })
        .getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      expect((await runtime().waitOperation(environment.id, 'delete')).result).toMatchObject({
        stopped_verified: true, profile_removed_verified: true });
      expect(await runtime().inspect(environment.id)).toMatchObject({ present: false, volume_present: false });
      await record(provider.id, { account_id: account.id, environment_id: environment.id, image: image.image,
        cli_before: provider.version, cli_after: provider.updated, session_preserved: true });
    }
    errors.assertClean();
  }, 420_000);
});

afterAll(async () => {
  try { await host?.close(); }
  finally {
    try { await fixture?.close(); }
    finally {
      if (image) await execute('docker', ['--context', 'lab', 'image', 'rm', image.tag], { timeout: 60_000 }).catch(() => undefined);
      vi.unstubAllEnvs();
    }
  }
}, 180_000);
