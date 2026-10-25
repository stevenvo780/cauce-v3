import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const OWNER = 'e2e-huecos-b2-1025';
const artifacts = join(process.cwd(), '.delegados/v4/recibos', OWNER);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

async function login(tenant: FunctionalTenant, viewport = { width: 1440, height: 900 }): Promise<V4Page> {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const rawPage = await newTrustedPage(fixture, viewport);
  const page = asV4Page(rawPage);
  const response = await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 }).catch(async (cause: unknown) => {
    throw new Error(`login form missing: status=${String(response?.status())}`, { cause });
  });
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true })
    .locator('a[href="/messages"], a[href^="/messages/"]')
    .waitFor({ state: 'visible', timeout: 20_000 });
  return page;
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
});

describe('Huecos E2E en Señales, Auditoría y Mensajería (v4-huecos-senales)', () => {
  it('ejerce refresco de señales, estado vacío de relays y validación de identificador en cadena diagnóstica', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const page = await login(isaTenant, { width: 1440, height: 900 });
    try {
      await page.goto(`${fixture.baseUrl}/observability`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Señales y auditoría', exact: true }).waitFor({ timeout: 20_000 });

      // 1. Estado vacío de relays al origen
      await page.getByText(
        'No hay avisos de vuelta a tu cuenta. Aparecen aquí cuando un mensaje tiene que salir de Cauce hacia su canal de origen.',
        { exact: true },
      ).waitFor({ timeout: 15_000 });

      // 2. Botón de refresco manual de la página
      const btnActualizar = page.getByRole('button', { name: 'Actualizar' });
      await btnActualizar.waitFor({ state: 'visible', timeout: 10_000 });
      await btnActualizar.click();
      await page.getByText('Leído ', { exact: false }).waitFor({ timeout: 10_000 });

      // 3. Pestaña de Auditoría y validación de identificador vacío en cadena diagnóstica
      await page.getByRole('tab', { name: 'Auditoría', exact: true }).click();
      const inputId = page.getByLabel('Identificador', { exact: true });
      await inputId.waitFor({ state: 'visible', timeout: 10_000 });
      await inputId.fill('');

      const btnConsultar = page.getByRole('button', { name: 'Consultar cadena', exact: true });
      await btnConsultar.click();

      // Debe aparecer alerta exigiendo el identificador
      await page.getByRole('alert').filter({ hasText: 'Escribe el identificador de la cadena.' }).waitFor({ timeout: 10_000 });

      await page.screenshot({ path: join(artifacts, 'observabilidad-huecos-1440.png'), fullPage: true });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('explica la conversación inexistente en mensajes y navega de vuelta a la lista', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const page = await login(isaTenant, { width: 1440, height: 900 });
    try {
      // 1. Abrir conversación inexistente
      await page.goto(`${fixture.baseUrl}/messages/inexistente/fantasma`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'No encontramos esa conversación', exact: true }).waitFor({ timeout: 20_000 });

      // Comprobar mensaje explicativo
      await page.getByText(
        'El servidor no observa a inexistente:fantasma en la topología, la presencia, ni en el registro de agentes ni en los mensajes.',
        { exact: false },
      ).waitFor({ timeout: 10_000 });

      await page.screenshot({ path: join(artifacts, 'mensajeria-inexistente-1440.png'), fullPage: true });

      // Móvil 390x844
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(artifacts, 'mensajeria-inexistente-390.png'), fullPage: true });

      // 2. Pulsar botón Volver a los chats
      await page.getByRole('link', { name: 'Volver a los chats', exact: true }).click();
      await expect.poll(() => page.url()).toBe(`${fixture.baseUrl}/messages`);
      await page.locator('section[data-state="welcome"]').waitFor({ timeout: 15_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
