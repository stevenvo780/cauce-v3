import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

/**
 * Sliding console session in a real Chromium against the real gateway and PostgreSQL. The windows are
 * the production ones scaled down: 100 s of inactivity and a 150 s ceiling from the login, with the
 * console revalidating every 60 s. Without sliding the cookie would be gone 100 s after the login.
 */
const INACTIVITY_MS = 100_000;
const CEILING_MS = 150_000;

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('este E2E exige Testcontainers; CAUCE_TEST_DATABASE_URL no se acepta');
  fixture = await startConsoleFunctionalFixture({ sessionTtlMs: INACTIVITY_MS, sessionMaxMs: CEILING_MS });
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('sesión deslizante de la consola en un navegador real', () => {
  it('una consola abierta sigue autenticada pasada la ventana de inactividad y pide login al llegar al tope', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const page = await newTrustedPage(fixture, { width: 1280, height: 800 });
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Correo').waitFor({ timeout: 30_000 });
    await page.getByLabel('Correo').fill(isaTenant.email);
    await page.getByLabel('Contraseña').fill(isaTenant.password);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    const navigation = page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]');
    await navigation.waitFor({ state: 'visible', timeout: 30_000 });
    const loggedInAt = Date.now();
    const authenticated = () => page.evaluate(async () => {
      const response = await fetch('/v3/auth/session', { credentials: 'include' });
      return ((await response.json()) as { authenticated: boolean }).authenticated;
    });
    expect(await authenticated()).toBe(true);

    // Nothing is touched: only the console's own background revalidation keeps the session alive.
    await sleep(Math.max(0, loggedInAt + INACTIVITY_MS + 25_000 - Date.now()));
    expect(Date.now() - loggedInAt).toBeGreaterThan(INACTIVITY_MS);
    expect(await navigation.count()).toBeGreaterThan(0);
    expect(await authenticated()).toBe(true);

    // The ceiling counts from the login, whatever the activity: the console falls back to the login form.
    await sleep(Math.max(0, loggedInAt + CEILING_MS + 5_000 - Date.now()));
    await page.getByLabel('Correo').waitFor({ state: 'visible', timeout: 90_000 });
    expect(await authenticated()).toBe(false);
    const denied = await page.evaluate(async () => (await fetch('/v3/console/access', { credentials: 'include' })).status);
    // Behind the proxy's machine certificate the gateway answers a person-only route with 4xx, never with the console's data.
    expect(denied).toBeGreaterThanOrEqual(400);

    await page.getByLabel('Correo').fill(isaTenant.email);
    await page.getByLabel('Contraseña').fill(isaTenant.password);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await navigation.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await authenticated()).toBe(true);
  }, 8 * 60_000);
});
