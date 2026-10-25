import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

async function ensureRecipientMembership(page: V4Page): Promise<void> {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  await page.goto(`${fixture.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Espacios y salas', exact: true }).click();
  await page.getByRole('button', { name: 'Un solo recurso' }).click();
  await page.getByLabel('Recurso a crear').selectOption('membership');
  await page.getByLabel('Espacio', { exact: true }).fill(isaTenant.tenant);
  await page.getByLabel('Sala', { exact: true }).fill(isaTenant.room);
  await page.getByLabel('Identificador', { exact: true }).fill(isaTenant.target);
  await page.getByText('Opciones de alta:', { exact: false }).click();
  await page.getByLabel('Rol de permisos', { exact: true }).fill('agent');
  await page.getByRole('button', { name: 'Previsualizar el alta' }).click();
  await page.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
}

interface SeededDelivery {
  messageId: string;
  deliveryId: string;
  status: string;
  marker: string;
}

async function seedDelivery(status: 'pending' | 'retry' | 'dead', marker: string, errorText?: string): Promise<SeededDelivery> {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const pool = fixture.database.pool;
  const insertedMsg = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,'interactive',10) RETURNING id`,
    [randomUUID(), randomUUID(), isaTenant.tenant, isaTenant.room, isaTenant.operator, JSON.stringify({ text: marker })],
  );
  const messageId = insertedMsg.rows[0]?.id;
  if (!messageId) throw new Error('could not insert synthetic message');

  const insertedDeliv = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,last_error)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [messageId, isaTenant.tenant, isaTenant.target, status, status === 'retry' ? 1 : 0, 3, errorText ?? null],
  );
  const deliveryId = insertedDeliv.rows[0]?.id;
  if (!deliveryId) throw new Error('could not insert synthetic delivery');

  if (status === 'dead') {
    await pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
       VALUES($1,$2,$3,'{}'::jsonb,3)`,
      [deliveryId, isaTenant.tenant, 'Synthetic dead letter for e2e test'],
    );
  }

  return { messageId, deliveryId, status, marker };
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
});

describe('Huecos E2E en Colas y DLQ operativo (v4-huecos-colas)', () => {
  it('filtra por grupo de estado, realiza búsqueda libre y quita los filtros en la tabla de entregas', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const page = await login(isaTenant, { width: 1440, height: 900 });
    try {
      await ensureRecipientMembership(page);

      const runTag = randomUUID().slice(0, 8);
      const pendingMarker = `PEND-${runTag}`;
      const retryMarker = `RETRY-${runTag}`;
      const deadMarker = `DEAD-${runTag}`;

      const pending = await seedDelivery('pending', pendingMarker);
      const retry = await seedDelivery('retry', retryMarker, `Error retry ${runTag}`);
      const dead = await seedDelivery('dead', deadMarker, `Error dead ${runTag}`);

      await page.goto(`${fixture.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Colas y DLQ operativo', exact: true }).waitFor({ timeout: 20_000 });

      // Esperar a que la tabla contenga las filas
      const tabla = page.getByRole('table', { name: 'Colas, reintentos y entregas muertas' });
      await tabla.waitFor({ timeout: 15_000 });
      await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).waitFor({ timeout: 15_000 });

      // 1. Filtrar por "Pendientes"
      const groupFilter = page.getByRole('group', { name: 'Filtrar por estado' });
      const btnPendientes = groupFilter.getByRole('button', { name: /Pendientes/u });
      await btnPendientes.click();
      expect(await btnPendientes.evaluate((el) => (el as HTMLElement).getAttribute('aria-pressed'))).toBe('true');
      await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);
      expect(await page.getByText(dead.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);

      // 2. Filtrar por "En reintento"
      const btnRetry = groupFilter.getByRole('button', { name: /En reintento/u });
      await btnRetry.click();
      expect(await btnRetry.evaluate((el) => (el as HTMLElement).getAttribute('aria-pressed'))).toBe('true');
      await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);
      expect(await page.getByText(dead.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);

      // 3. Filtrar por "Entregas muertas"
      const btnDead = groupFilter.getByRole('button', { name: /Entregas muertas/u });
      await btnDead.click();
      expect(await btnDead.evaluate((el) => (el as HTMLElement).getAttribute('aria-pressed'))).toBe('true');
      await page.getByText(dead.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);
      expect(await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);

      // 4. Volver a "Todas"
      const btnTodas = groupFilter.getByRole('button', { name: /Todas/u });
      await btnTodas.click();
      expect(await btnTodas.evaluate((el) => (el as HTMLElement).getAttribute('aria-pressed'))).toBe('true');
      await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByText(dead.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });

      // 5. Búsqueda por texto (último error del retry)
      const inputBusqueda = page.locator('input[placeholder="Alias, espacio, id de entrega, id de mensaje o error"]');
      await inputBusqueda.fill(`Error retry ${runTag}`);
      await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).count()).toBe(0);

      // 6. Búsqueda sin coincidencias -> Estado vacío
      await inputBusqueda.fill(`inexistente-${runTag}`);
      await page.getByText(/Ninguna de las .* entregas de esta lectura es/u).waitFor({ timeout: 10_000 });

      // 7. Quitar el filtro
      await page.getByRole('button', { name: 'Quitar el filtro' }).click();
      await page.getByText(pending.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByText(retry.deliveryId.slice(0, 8), { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });

      await page.screenshot({ path: join(artifacts, 'colas-filtros-1440.png'), fullPage: true });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('ejerce enlace profundo existente e inexistente, y cancela el diálogo sin modificar el estado durable', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const page = await login(isaTenant, { width: 1440, height: 900 });
    try {
      const runTag = randomUUID().slice(0, 8);
      const delivery = await seedDelivery('pending', `FOCO-${runTag}`);

      // 1. Enlace profundo a entrega existente
      await page.goto(`${fixture.baseUrl}/queues?delivery=${delivery.deliveryId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('status').filter({ hasText: 'Filtrado a la entrega' }).waitFor({ timeout: 15_000 });
      expect(await page.getByText(delivery.deliveryId).count()).toBeGreaterThan(0);

      // Botón "Ver todas las entregas" quita el foco sin recargar
      await page.getByRole('button', { name: 'Ver todas las entregas' }).click();
      await expect.poll(() => page.url()).not.toContain('delivery=');
      await page.getByRole('status').filter({ hasText: 'Filtrado a la entrega' }).waitFor({ state: 'hidden', timeout: 10_000 });

      // 2. Enlace profundo a entrega inexistente
      const inexistente = randomUUID();
      await page.goto(`${fixture.baseUrl}/queues?delivery=${inexistente}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('alert').filter({ hasText: 'Esa entrega no está en esta página' }).waitFor({ timeout: 15_000 });
      await page.getByText('Esta lectura no trae ninguna fila para la entrega pedida.', { exact: true }).waitFor({ timeout: 10_000 });

      // Quitar foco de la entrega ausente
      await page.getByRole('button', { name: 'Ver todas las entregas' }).click();
      await expect.poll(() => page.url()).not.toContain('delivery=');
      await page.getByText('Esta lectura no trae ninguna fila para la entrega pedida.', { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });

      // 3. Abrir diálogo de cancelar y descartar con "No hacer nada"
      await page.getByRole('button', { name: `Cancelar delivery ${delivery.deliveryId}`, exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: `Cancelar delivery ${delivery.deliveryId}`, exact: true }).click();
      await page.getByRole('alertdialog').waitFor({ timeout: 10_000 });

      // Pulsar "No hacer nada"
      await page.getByRole('button', { name: 'No hacer nada', exact: true }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'hidden', timeout: 10_000 });

      // Comprobar efecto real: en BD la entrega sigue siendo 'pending' y no se canceló
      const dbCheck = await fixture.database.pool.query<{ status: string; cancelled_at: Date | null }>(
        'SELECT status, cancelled_at FROM deliveries WHERE id=$1',
        [delivery.deliveryId],
      );
      expect(dbCheck.rows[0]?.status).toBe('pending');
      expect(dbCheck.rows[0]?.cancelled_at).toBeNull();

      // Móvil 390x844
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(artifacts, 'colas-movil-390.png'), fullPage: true });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
