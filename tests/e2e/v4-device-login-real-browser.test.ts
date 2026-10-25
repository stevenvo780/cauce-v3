import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';
import {
  deviceRequest, sessionCookie, startCli, startDeviceCli, type DeviceFixture, type DeviceGrant,
} from './v4-device-login.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/l1-login-dispositivo-1025', run);
const people = ['a', 'b'].map(label => {
  const person = syntheticPerson(label, run);
  person.email = `zz-canary-device-${label}-${run}@example.invalid`;
  person.company.slug = `zz-canary-device-${label}-${run}`;
  return person;
});
let fixture: DeviceFixture | undefined;
const pages: V4Page[] = [];

function active(): DeviceFixture {
  if (!fixture) throw new Error('Device login fixture is not initialized');
  return fixture;
}
function person(index: number): V4Person {
  const value = people[index];
  if (!value) throw new Error('Device login person is not initialized');
  return value;
}
function page(index: number): V4Page {
  const value = pages[index];
  if (!value) throw new Error('Device login page is not initialized');
  return value;
}
function sessionFile(label: string): string { return join(active().directory, `zz-canary-device-${label}.json`); }

async function screenshot(browserPage: V4Page, label: string): Promise<void> {
  await browserPage.screenshot({ path: join(evidence, `${label}.png`), fullPage: true });
}

async function review(browserPage: V4Page, code: string): Promise<void> {
  await browserPage.goto(`${active().baseUrl}/dispositivo?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' });
  await browserPage.getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 20_000 });
  for (const label of ['Cliente', 'Solicitado', 'IP de origen', 'Caduca']) {
    await browserPage.getByText(label, { exact: true }).waitFor({ timeout: 10_000 });
  }
  await browserPage.getByText(/^Persona:/u).waitFor({ timeout: 10_000 });
  await browserPage.getByText(/^Empresa activa:/u).waitFor({ timeout: 10_000 });
}

async function grant(label: string): Promise<DeviceGrant> {
  const response = await deviceRequest(active(), '/v3/auth/device', { client_name: `zz-canary-device-${label}-${run}` });
  expect(response.status).toBe(200);
  const result = response.body as unknown as DeviceGrant;
  expect(Buffer.from(result.device_code, 'base64url').length).toBeGreaterThanOrEqual(32);
  expect(result.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
  expect(result.expires_in).toBe(600);
  expect(result.interval).toBe(5);
  return result;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Device E2E requires its own PostgreSQL Testcontainer');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('Device E2E requires the real gateway');
  await mkdir(evidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  for (const owner of people) {
    const ownerPage = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    const form = await openRegistration(ownerPage, active().baseUrl);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await ownerPage.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    pages.push(ownerPage);
  }
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('login nominal por dispositivo con CLI, Chromium y PostgreSQL reales', () => {
  it('CLI inicia, login web vuelve al dispositivo, autoriza y guarda sesión privada con lectura real', async () => {
    const file = sessionFile('success');
    const cli = startDeviceCli(active(), file);
    const prompt = await cli.prompt();
    const anonymous = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    await anonymous.goto(`${active().baseUrl}/dispositivo?code=${encodeURIComponent(prompt.code)}`, { waitUntil: 'domcontentloaded' });
    await anonymous.getByLabel('Correo', { exact: true }).fill(person(0).email);
    await anonymous.getByLabel('Contraseña', { exact: true }).fill(person(0).password);
    await anonymous.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await anonymous.getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 25_000 });
    expect(anonymous.url()).toContain('/dispositivo');
    await screenshot(anonymous, '01-solicitud-escritorio');
    await anonymous.getByRole('button', { name: 'Autorizar', exact: true }).click();
    const result = await cli.result;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({ state: 'authenticated', subject: person(0).email });
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(typeof saved.cookie).toBe('string');
    expect(typeof saved.csrf_token).toBe('string');
    expect(JSON.stringify(saved).includes(person(0).password)).toBe(false);
    expect(result.stdout.includes(String(saved.cookie))).toBe(false);
    const status = await startCli(active(), ['login', '--status'], file).result;
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout) as unknown).toMatchObject({ authenticated: true, subject: person(0).email,
      authority: { acting_company: person(0).company.slug } });
    const nominal = await apiGet(page(0), '/v3/auth/session');
    const tenant = String(nominal.body.home_tenant);
    const listed = await startCli(active(), ['spaces', 'list', '--json', '--tenant', tenant], file).result;
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout) as unknown).toMatchObject({ state: 'observed', tenant_id: tenant });
    await screenshot(anonymous, '02-autorizado');
  });

  it('alias --device y rechazo web terminan con mensaje accionable sin guardar sesión', async () => {
    const file = sessionFile('denied');
    const cli = startDeviceCli(active(), file, '--device');
    const prompt = await cli.prompt();
    await review(page(0), prompt.code);
    await page(0).getByRole('button', { name: 'Rechazar', exact: true }).click();
    const result = await cli.result;
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/rechazada/iu);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await screenshot(page(0), '03-rechazado');
  });

  it('caducidad persistida de la solicitud propia termina el CLI sin crear sesión', async () => {
    const file = sessionFile('expired');
    const cli = startDeviceCli(active(), file);
    const prompt = await cli.prompt();
    const hash = createHash('sha256').update(prompt.code.replaceAll('-', '')).digest('hex');
    const client = await active().database.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE device_authorizations DISABLE TRIGGER device_authorization_transition');
      const expired = await client.query(`UPDATE device_authorizations SET created_at=created_at-interval '11 minutes',
        expires_at=expires_at-interval '11 minutes' WHERE user_code_hash=$1 AND state='pending'`, [hash]);
      expect(expired.rowCount).toBe(1);
      await client.query('ALTER TABLE device_authorizations ENABLE TRIGGER device_authorization_transition');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    const result = await cli.result;
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/caducó/iu);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('consulta manual y autorización móvil permiten un único canje del device_code', async () => {
    const requested = await grant('single-use');
    await page(0).setViewportSize({ width: 390, height: 844 });
    await page(0).goto(`${active().baseUrl}/dispositivo`, { waitUntil: 'domcontentloaded' });
    await page(0).getByLabel('Código del dispositivo', { exact: true }).fill(requested.user_code);
    await page(0).getByRole('button', { name: 'Consultar solicitud', exact: true }).click();
    await page(0).getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 20_000 });
    await screenshot(page(0), '04-solicitud-movil');
    expect(await page(0).evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page(0).getByRole('button', { name: 'Autorizar', exact: true }).click();
    await new Promise<void>(resolve => { setTimeout(resolve, requested.interval * 1_000); });
    const redeemed = await deviceRequest(active(), '/v3/auth/device/token', { device_code: requested.device_code });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.authenticated).toBe(true);
    expect(redeemed.cookies.length).toBeGreaterThan(0);
    const reused = await deviceRequest(active(), '/v3/auth/device/token', { device_code: requested.device_code });
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('invalid_grant');
    expect(reused.cookies).toHaveLength(0);
    await screenshot(page(0), '05-autorizado-movil');
    await page(0).setViewportSize({ width: 1440, height: 900 });
  });

  it('persona de otra empresa recibe solo su identidad y sus recursos al aprobar', async () => {
    const requested = await grant('other-company');
    await review(page(1), requested.user_code);
    await page(1).getByRole('button', { name: 'Autorizar', exact: true }).click();
    await new Promise<void>(resolve => { setTimeout(resolve, requested.interval * 1_000); });
    const redeemed = await deviceRequest(active(), '/v3/auth/device/token', { device_code: requested.device_code });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.authenticated).toBe(true);
    expect(redeemed.body.subject).toBe(person(1).email);
    expect(redeemed.body.authority).toMatchObject({ acting_company: person(1).company.slug });
    const headers = { Cookie: sessionCookie(redeemed.cookies) };
    const own = await deviceRequest(active(), `/v3/console/companies/${person(1).company.slug}`, undefined, headers);
    expect(own.status).toBe(200);
    const foreign = await deviceRequest(active(), `/v3/console/companies/${person(0).company.slug}`, undefined, headers);
    expect(foreign.status).toBe(403);
    const session = await deviceRequest(active(), '/v3/auth/session', undefined, headers);
    expect(session.body.authenticated).toBe(true);
    expect(session.body.subject).toBe(person(1).email);
    expect(session.body.authority).toMatchObject({ acting_company: person(1).company.slug });
    await screenshot(page(1), '06-otra-empresa');
  });

  it('consulta inválida e inexistente muestran cómo iniciar otra solicitud', async () => {
    await page(0).goto(`${active().baseUrl}/dispositivo`, { waitUntil: 'domcontentloaded' });
    await page(0).getByLabel('Código del dispositivo', { exact: true }).fill('X');
    await page(0).getByRole('button', { name: 'Consultar solicitud', exact: true }).click();
    await page(0).getByRole('alert').filter({ hasText: 'Introduce el código de ocho caracteres' }).waitFor({ timeout: 10_000 });
    await page(0).getByLabel('Código del dispositivo', { exact: true }).fill('ZZZZ-ZZZZ');
    await page(0).getByRole('button', { name: 'Consultar solicitud', exact: true }).click();
    await page(0).getByRole('alert').filter({ hasText: 'El código no existe, caducó o ya fue utilizado' }).waitFor({ timeout: 10_000 });
    await screenshot(page(0), '07-codigo-inexistente');
  });

  it('cerrar sesión permite cambiar de persona sin perder la solicitud que se revisa', async () => {
    const requested = await grant('switch-person');
    await review(page(0), requested.user_code);
    await page(0).getByRole('button', { name: 'Cerrar sesión y usar otra cuenta', exact: true }).click();
    await page(0).getByLabel('Correo', { exact: true }).fill(person(1).email);
    await page(0).getByLabel('Contraseña', { exact: true }).fill(person(1).password);
    await page(0).getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page(0).getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 20_000 });
    await page(0).getByText(`(${person(1).email})`, { exact: false }).waitFor({ timeout: 10_000 });
    await page(0).getByRole('button', { name: 'Rechazar', exact: true }).click();
    await page(0).getByRole('status').filter({ hasText: 'Solicitud rechazada' }).waitFor({ timeout: 10_000 });
    await screenshot(page(0), '08-cambio-persona');
  });
});
