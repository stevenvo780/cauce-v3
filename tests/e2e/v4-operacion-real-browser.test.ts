import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CauceRepository } from '@cauce/store';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserContext, type BrowserPage, type FunctionalTenant, type Locator,
} from './console-functional-browser.fixtures.js';

const execFileAsync = promisify(execFile);
const OWNER = 'e2e-a11-operacion-1025';
const PREFIX = `zz-canary-${OWNER}`;
const ACCION = 'zz.canary.operacion';
const receipts = `/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/${OWNER}`;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const reader = {
  tenant: 'Isa' as const, alias: isaTenant.operator, email: 'operacion-reader@cauce.test', password: randomUUID(),
};
const DELIVERY_LABELS = ['PENDIENTE', 'TOMADA', 'ACEPTADA', 'EN CURSO', 'HECHA', 'FALLÓ', 'EN REINTENTO', 'MUERTA'] as const;
const VISTAS: { href: string; espera: string }[] = [
  { href: '/messages', espera: 'Sin conversación abierta' },
  { href: '/live', espera: 'Oficina' },
  { href: '/accounts', espera: 'Cuentas' },
  { href: '/my-quotas', espera: 'Mis cuotas' },
  { href: '/queues', espera: 'Colas y DLQ operativo' },
  { href: '/observability', espera: 'Señales y auditoría' },
  { href: '/config', espera: 'Ajustes' },
  { href: '/terminal', espera: 'Elige un agente en la barra lateral' },
  { href: '/ayuda', espera: 'Ayuda y documentación' },
];

interface PageControls {
  route(url: string, handler: (route: { abort(errorCode?: string): Promise<void> }) => Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
  keyboard: { press(combo: string): Promise<void> };
}
interface PageEvents { waitForEvent(event: 'page', options?: { timeout?: number }): Promise<BrowserPage> }
interface ClosablePage { close(): Promise<void> }
interface Publicado { messageId: string; deliveryId: string; traceId: string }

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let publicado: Publicado | undefined;

function controls(page: BrowserPage): asserts page is BrowserPage & PageControls {
  if (!('route' in page) || !('unroute' in page) || !('keyboard' in page)) {
    throw new Error('the browser page does not expose route or keyboard');
  }
}

function controlClick(locator: Locator): Promise<void> {
  const click: (options: { modifiers: 'Control'[] }) => Promise<void> = locator.click.bind(locator);
  return click({ modifiers: ['Control'] });
}

function pageEvents(context: BrowserContext): asserts context is BrowserContext & PageEvents {
  if (!('waitForEvent' in context)) throw new Error('browser context does not expose waitForEvent');
}

function closable(page: BrowserPage): asserts page is BrowserPage & ClosablePage {
  if (!('close' in page)) throw new Error('browser page does not expose close');
}

async function pause(ms: number) {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function login(tenant: FunctionalTenant, viewport: { width: number; height: number }) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const page = await newTrustedPage(fixture, viewport);
  const response = await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 }).catch(async (cause: unknown) => {
    throw new Error(`password login form missing: status=${String(response?.status())} body=${(await page.locator('body').innerText()).slice(0, 800)}`, { cause });
  });
  expect(await page.getByText('MOCK API', { exact: true }).count()).toBe(0);
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
  return page;
}

async function shot(page: BrowserPage, name: string) {
  await page.screenshot({ path: `${receipts}/${name}.png`, fullPage: true });
}

async function ensureRecipientMembership(page: BrowserPage) {
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

async function publishPending(page: BrowserPage, marker: string) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: isaTenant.target, exact: true }).waitFor({ timeout: 20_000 });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`).fill(marker);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.getByLabel('Historial de la conversación', { exact: true }).getByText(marker, { exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  let persisted = await fixture.database.pool.query<{ message_id: string; delivery_id: string; status: string; trace_id: string }>(
    `SELECT message.id AS message_id,message.trace_id,delivery.id AS delivery_id,delivery.status
       FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
      WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$3`,
    [isaTenant.tenant, marker, isaTenant.target],
  );
  const deadline = Date.now() + 10_000;
  while (persisted.rows.length === 0 && Date.now() < deadline) {
    await pause(100);
    persisted = await fixture.database.pool.query(
      `SELECT message.id AS message_id,message.trace_id,delivery.id AS delivery_id,delivery.status
         FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
        WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$3`,
      [isaTenant.tenant, marker, isaTenant.target],
    );
  }
  const row = persisted.rows[0];
  if (persisted.rows.length !== 1 || !row?.message_id || !row.delivery_id || !row.trace_id) {
    throw new Error(`UI publish was not durably routed once: ${JSON.stringify(persisted.rows)}`);
  }
  expect(row.status).toBe('pending');
  return { messageId: row.message_id, deliveryId: row.delivery_id, traceId: row.trace_id };
}

async function confirmDelivery(page: BrowserPage, action: 'cancel' | 'replay', deliveryId: string) {
  const button = action === 'cancel'
    ? page.getByRole('button', { name: `Cancelar entrega ${deliveryId}`, exact: true })
    : page.getByRole('button', { name: `Reinyectar entrega ${deliveryId}`, exact: true });
  await button.click();
  const confirmName = action === 'cancel' ? 'Sí, cancelar la entrega' : 'Sí, reinyectar';
  await page.getByRole('alertdialog').getByRole('button', { name: confirmName, exact: true }).click();
}

async function retryOnce(deliveryId: string) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const repository = new CauceRepository(fixture.database.pool);
  const instanceId = `${PREFIX}-${randomUUID()}`;
  const lease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, instanceId, [], 30_000);
  if (!lease.acquired || lease.epoch === undefined || !lease.connection_token) {
    throw new Error(`could not acquire owned delivery lease: ${JSON.stringify(lease)}`);
  }
  const claims = await repository.claimDeliveries(
    isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, 1, 1_000, 1, {}, lease.connection_token,
  );
  if (!claims.some((item) => item.delivery_id === deliveryId)) {
    throw new Error('the real claim operation did not claim the target delivery');
  }
  await fixture.database.pool.query(
    `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1 AND status IN ('leased','accepted','started')`,
    [deliveryId],
  );
  if (!await repository.releaseLease(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, lease.connection_token)) {
    throw new Error('could not release the test consumer lease');
  }
  await reapOwned(deliveryId, 'retry');
}

async function reapOwned(deliveryId: string, wanted: 'retry' | 'dead') {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const repository = new CauceRepository(fixture.database.pool);
  const deadline = Date.now() + 8_000;
  let last = 'missing';
  while (Date.now() < deadline) {
    await repository.retryStaleDeliveries(0, 100, { parkWithoutConsumer: false });
    const row = await fixture.database.pool.query<{ status: string; last_error: string | null }>(
      'SELECT status,last_error FROM deliveries WHERE id=$1', [deliveryId],
    );
    const current = row.rows[0];
    last = JSON.stringify(current ?? null);
    if (wanted === 'retry' && current?.status === 'retry' && current.last_error === 'ACK timeout') return;
    if (wanted === 'dead' && current?.status === 'dead') return;
    if (wanted === 'retry' && current?.status === 'dead') throw new Error(`delivery died before the last attempt: ${last}`);
    await pause(100);
  }
  throw new Error(`reaper left ${deliveryId} outside ${wanted}: ${last}`);
}

async function exhaustOwnedDelivery(deliveryId: string) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const repository = new CauceRepository(fixture.database.pool);
  const maxAttempts = await fixture.database.pool.query<{ max_attempts: number }>(
    'SELECT max_attempts FROM deliveries WHERE id=$1', [deliveryId],
  );
  const attempts = maxAttempts.rows[0]?.max_attempts;
  if (!attempts || attempts < 1 || attempts > 5) throw new Error(`unexpected fixture delivery attempt ceiling: ${String(attempts)}`);
  const instanceId = `${PREFIX}-dead-${randomUUID()}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, instanceId, [], 30_000);
    if (!lease.acquired || lease.epoch === undefined || !lease.connection_token) {
      throw new Error(`could not acquire owned delivery lease: ${JSON.stringify(lease)}`);
    }
    const claims = await repository.claimDeliveries(
      isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, 1, 1_000, 1, {}, lease.connection_token,
    );
    if (!claims.some((item) => item.delivery_id === deliveryId)) {
      throw new Error(`the real claim operation did not claim the target delivery on attempt ${String(attempt + 1)}`);
    }
    await fixture.database.pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1 AND status IN ('leased','accepted','started')`,
      [deliveryId],
    );
    if (!await repository.releaseLease(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, lease.connection_token)) {
      throw new Error(`could not release the test consumer lease after attempt ${String(attempt + 1)}`);
    }
    await reapOwned(deliveryId, attempt + 1 === attempts ? 'dead' : 'retry');
    if (attempt + 1 < attempts) {
      await fixture.database.pool.query(
        "UPDATE deliveries SET available_at=now()-interval '1 second' WHERE id=$1 AND status='retry'", [deliveryId],
      );
    }
  }
  const plan = await fixture.database.pool.query<{ value: { planSha256?: string } }>(
    'SELECT cauce_dlq_plan_030($1,$2) AS value', [isaTenant.tenant, isaTenant.operator],
  );
  const planSha = plan.rows[0]?.value.planSha256;
  if (typeof planSha !== 'string' || !/^[a-f0-9]{64}$/u.test(planSha)) throw new Error('canonical DLQ classification plan has no digest');
  const applied = await fixture.database.pool.query<{ value: { dispositionCount?: number } }>(
    'SELECT cauce_dlq_apply_030($1,$2,$3) AS value', [isaTenant.tenant, isaTenant.operator, planSha],
  );
  expect(applied.rows[0]?.value.dispositionCount).toBeGreaterThan(0);
  const posted = await fixture.database.pool.query<{ value: { planSha256?: string } }>(
    'SELECT cauce_dlq_post_030($1,$2,$3) AS value', [isaTenant.tenant, isaTenant.operator, planSha],
  );
  expect(posted.rows[0]?.value.planSha256).toBe(planSha);
}

async function sidebar(page: BrowserPage): Promise<string> {
  return page.evaluate(() => document.querySelector('[data-sidebar]')?.getAttribute('data-sidebar') ?? '');
}

async function waitSidebar(page: BrowserPage, expected: string) {
  const deadline = Date.now() + 5_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await sidebar(page);
    if (last === expected) return;
    await pause(50);
  }
  throw new Error(`sidebar was ${last}, expected ${expected}`);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  const active = fixture;
  const provision = await execFileAsync(`${process.cwd()}/node_modules/.bin/tsx`, [
    'services/gateway/src/console-user-cli.ts', '--email', reader.email, '--name', 'Operacion reader E2E',
    '--role', 'reader', '--tenant', reader.tenant, '--alias', reader.alias,
  ], {
    cwd: process.cwd(), timeout: 15_000, maxBuffer: 16 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', DATABASE_URL: active.database.url, CAUCE_CONSOLE_USER_PASSWORD: reader.password },
  });
  if (!provision.stdout.includes('cuenta guardada') || provision.stdout.includes(reader.password)) {
    throw new Error('reader provisioning did not confirm safely');
  }
  process.stdout.write(`operacion E2E owned resources: postgres=${active.database.container.getId()} browser=${active.browserContainer}\n`);
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

describe('operación de colas, señales, auditoría y ayuda', () => {
  it('filtra colas, enfoca una entrega, muestra el último error y cierra un DLQ sin reinyectar', async () => {
    if (!fixture) throw new Error('functional browser fixture is not initialized');
    const active = fixture;
    const operator = await login(isaTenant, DESKTOP);
    try {
      await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await operator.getByRole('heading', { name: 'Colas y DLQ operativo', exact: true }).waitFor({ timeout: 20_000 });
      await operator.getByText('No hay entregas informadas.', { exact: true }).waitFor({ timeout: 20_000 });
      await shot(operator, 'colas-vacio-1440');

      await ensureRecipientMembership(operator);
      const pending = await publishPending(operator, `${PREFIX}-pendiente`);
      publicado = pending;
      const stored = await active.database.pool.query<{ status: string; last_error: string | null }>(
        'SELECT status,last_error FROM deliveries WHERE id=$1', [pending.deliveryId],
      );
      expect(stored.rows).toEqual([{ status: 'pending', last_error: null }]);

      const readerPage = await login({ ...isaTenant, email: reader.email, password: reader.password }, PHONE);
      try {
        await readerPage.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
        await readerPage.getByRole('button', { name: `Cancelar entrega ${pending.deliveryId}`, exact: true }).waitFor({ timeout: 20_000 });
        const states = await readerPage.evaluate(() => Array.from(
          document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Cancelar entrega"],button[aria-label^="Reinyectar entrega"]'),
        ).map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })));
        expect(states).toEqual([{ label: `Cancelar entrega ${pending.deliveryId}`, disabled: true }]);
        await shot(readerPage, 'colas-lector-390');
      } finally {
        await readerPage.context().close();
      }

      await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await operator.getByText('PENDIENTE', { exact: true }).waitFor({ timeout: 20_000 });
      await operator.getByText('sin error', { exact: true }).waitFor();
      const filtros = operator.getByRole('group', { name: 'Filtrar por estado' });
      await filtros.getByRole('button', { name: /Pendientes/u }).click();
      expect(await operator.locator('table tbody tr').count()).toBe(1);
      await filtros.getByRole('button', { name: /Entregas muertas/u }).click();
      await operator.getByText('Ninguna de las 1 entregas de esta lectura es las que requieren revisión.', { exact: true }).waitFor();
      expect(await operator.locator('table tbody tr').count()).toBe(0);
      await operator.getByRole('button', { name: 'Quitar el filtro', exact: true }).click();
      await operator.getByLabel('Buscar entrega').fill(`${PREFIX}-no-existe`);
      await operator.getByText(`Ninguna de las 1 entregas de esta lectura es todas las entregas y dice «${PREFIX}-no-existe».`, { exact: true }).waitFor();
      await operator.getByRole('button', { name: 'Quitar el filtro', exact: true }).click();
      expect(await operator.locator('table tbody tr').count()).toBe(1);

      await operator.goto(`${active.baseUrl}/queues?delivery=${pending.deliveryId}`, { waitUntil: 'domcontentloaded' });
      await operator.getByText(pending.deliveryId, { exact: true }).waitFor({ timeout: 20_000 });
      expect(await operator.locator('tr[aria-current="true"]').count()).toBe(1);
      await shot(operator, 'colas-foco-1440');
      await operator.getByRole('button', { name: 'Ver todas las entregas', exact: true }).click();
      expect(new URL(operator.url()).searchParams.get('delivery')).toBeNull();
      const missing = randomUUID();
      await operator.goto(`${active.baseUrl}/queues?delivery=${missing}`, { waitUntil: 'domcontentloaded' });
      await operator.getByText('Esa entrega no está en esta página', { exact: false }).waitFor({ timeout: 20_000 });
      await operator.getByRole('button', { name: 'Ver todas las entregas', exact: true }).click();

      await retryOnce(pending.deliveryId);
      const retried = await active.database.pool.query<{ status: string; last_error: string }>(
        'SELECT status,last_error FROM deliveries WHERE id=$1', [pending.deliveryId],
      );
      expect(retried.rows).toEqual([{ status: 'retry', last_error: 'ACK timeout' }]);
      await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await operator.getByText('EN REINTENTO', { exact: true }).waitFor({ timeout: 20_000 });
      await operator.getByText('ACK timeout', { exact: true }).waitFor();
      await filtros.getByRole('button', { name: /En reintento/u }).click();
      expect(await operator.locator('table tbody tr').count()).toBe(1);
      await filtros.getByRole('button', { name: /Pendientes/u }).click();
      await operator.getByText('Ninguna de las 1 entregas de esta lectura es las pendientes o en manos de un adaptador.', { exact: true }).waitFor();
      expect(await operator.locator('table tbody tr').count()).toBe(0);
      await operator.setViewportSize(PHONE);
      await shot(operator, 'colas-reintento-390');
      await operator.setViewportSize(DESKTOP);

      await active.database.pool.query(
        "UPDATE deliveries SET available_at=now()+interval '1 hour' WHERE id=$1 AND status='retry'",
        [pending.deliveryId],
      );
      const resolveSource = await publishPending(operator, `${PREFIX}-cerrar`);
      await exhaustOwnedDelivery(resolveSource.deliveryId);
      const deadLetter = await active.database.pool.query<{ id: string; disposition: string; open: boolean }>(
        'SELECT id::text AS id,disposition,resolved_at IS NULL AS open FROM dead_letters WHERE delivery_id=$1',
        [resolveSource.deliveryId],
      );
      expect(deadLetter.rows).toEqual([expect.objectContaining({ disposition: 'safe_retry', open: true })]);
      const incidentId = deadLetter.rows[0]?.id;
      if (!incidentId) throw new Error('safe-retry incident has no durable identifier');
      const priorWake = await active.database.pool.query<{ wake: string }>(
        "SELECT count(*)::text AS wake FROM adapter_outbox WHERE kind='wake' AND delivery_id=$1",
        [resolveSource.deliveryId],
      );
      await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await operator.getByRole('tab', { name: 'DLQ operativo', exact: true }).click();
      await operator.getByRole('checkbox', { name: 'Solo abiertos', exact: true }).waitFor({ timeout: 20_000 });
      const disposition = operator.locator('label').filter({ hasText: 'Disposición' }).locator('select');
      await disposition.waitFor({ timeout: 20_000 });
      await disposition.selectOption('auth');
      await operator.getByText('No hay incidentes que coincidan con el filtro.', { exact: true }).waitFor();
      await disposition.selectOption('safe_retry');
      const resolveDlq = operator.locator(`tr:has(span[title="${incidentId}"])`);
      await resolveDlq.getByRole('button', { name: /Cerrar sin reinyectar/u }).waitFor({ state: 'visible', timeout: 15_000 });
      await resolveDlq.getByRole('button', { name: /Cerrar sin reinyectar/u }).click();
      const compactIncidentId = `${incidentId.slice(0, 8)}…${incidentId.slice(-6)}`;
      const resolution = operator.getByRole('alertdialog', { name: `Cerrar ${compactIncidentId} sin reinyectar`, exact: true });
      await resolution.locator('textarea[aria-label="Motivo operativo"]').fill('Prueba E2E: cierre manual sin reinyección.');
      await resolution.locator('input[type="checkbox"]').click();
      await resolution.getByRole('button', { name: 'Cerrar sin reinyectar', exact: true }).click();
      await operator.getByRole('status').filter({ hasText: 'cerrado sin reinyectar' }).waitFor({ timeout: 20_000 });
      const closed = await active.database.pool.query<{ audit_count: string; replay: string; wake: string }>(
        `SELECT
           (SELECT count(*)::text FROM dlq_operator_resolutions resolution
              JOIN audit_events audit ON audit.id=resolution.audit_event_id
             WHERE resolution.target='delivery' AND audit.action='dlq.resolve_without_replay'
               AND resolution.dead_letter_id IN (SELECT id FROM dead_letters WHERE delivery_id=$1::uuid)) AS audit_count,
           (SELECT count(*)::text FROM audit_events WHERE action='delivery.replay' AND metadata->>'replayed_from_delivery_id'=$1::text) AS replay,
           (SELECT count(*)::text FROM adapter_outbox WHERE kind='wake' AND delivery_id=$1::uuid) AS wake`,
        [resolveSource.deliveryId],
      );
      expect(closed.rows).toEqual([{ audit_count: '1', replay: '0', wake: priorWake.rows[0]?.wake }]);
      await shot(operator, 'colas-dlq-1440');

      const cancelable = await publishPending(operator, `${PREFIX}-cancelar`);
      await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
      await operator.getByRole('button', { name: `Cancelar entrega ${cancelable.deliveryId}`, exact: true }).click();
      await operator.getByRole('alertdialog').waitFor();
      controls(operator);
      await operator.keyboard.press('Escape');
      await operator.getByRole('alertdialog').waitFor({ state: 'hidden', timeout: 10_000 });
      const stillPending = await active.database.pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE id=$1', [cancelable.deliveryId],
      );
      expect(stillPending.rows).toEqual([{ status: 'pending' }]);
      await confirmDelivery(operator, 'cancel', cancelable.deliveryId);
      const compactCancel = `${cancelable.deliveryId.slice(0, 8)}…${cancelable.deliveryId.slice(-6)}`;
      await operator.locator('tr').filter({ hasText: compactCancel }).getByText('MUERTA', { exact: true }).waitFor({ timeout: 20_000 });
      const cancelled = await active.database.pool.query<{ status: string; audit_count: string }>(
        `SELECT delivery.status,(SELECT count(*)::text FROM audit_events audit
            WHERE audit.action='delivery.cancel' AND audit.delivery_id=delivery.id AND audit.decision='allow') AS audit_count
           FROM deliveries delivery WHERE delivery.id=$1`, [cancelable.deliveryId],
      );
      expect(cancelled.rows).toEqual([{ status: 'dead', audit_count: '1' }]);
      await confirmDelivery(operator, 'replay', cancelable.deliveryId);
      await operator.getByText(/Reinyección encolada para/u).waitFor({ timeout: 20_000 });
      const replay = await active.database.pool.query<{ clone_state: string | null }>(
        `SELECT cloned.status AS clone_state
           FROM audit_events replay
           JOIN deliveries cloned ON cloned.id=replay.delivery_id
          WHERE replay.action='delivery.replay' AND replay.metadata->>'replayed_from_delivery_id'=$1`,
        [cancelable.deliveryId],
      );
      expect(replay.rows).toEqual([{ clone_state: 'pending' }]);
    } finally {
      await operator.context().close();
    }
  }, 300_000);

  it('filtra la auditoría en el servidor, consulta una cadena y enseña el fallo de relectura', async () => {
    if (!fixture || !publicado) throw new Error('the queue flow did not publish a delivery');
    const active = fixture;
    const source = publicado;
    await active.database.pool.query(
      `INSERT INTO adapter_outbox
         (id,tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload,status)
       VALUES ($1,'Isa','telegram','origin_relay',$2,$3,$4,$5,$6,'{}'::jsonb,'pending')`,
      [randomUUID(), randomUUID(), randomUUID(), source.messageId, source.deliveryId, source.traceId],
    );
    await active.database.pool.query(
      `INSERT INTO audit_events (tenant_id,actor_alias,action,decision,message_id,trace_id,metadata)
       SELECT 'Isa','e2eisa',$1,'info',$2::uuid,$3,'{}'::jsonb FROM generate_series(1, 105)`,
      [ACCION, source.messageId, source.traceId],
    );
    const seeded = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_events WHERE action=$1 AND trace_id=$2',
      [ACCION, source.traceId],
    );
    expect(seeded.rows[0]?.count).toBe('105');

    const page = await login(isaTenant, DESKTOP);
    const auditUrls: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/v3/console/audit')) auditUrls.push(response.url());
    });
    try {
      await page.goto(`${active.baseUrl}/observability`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Señales y auditoría', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('En línea', { exact: true }).waitFor();
      await page.getByText('En cola', { exact: true }).waitFor();
      await page.getByText('DLQ', { exact: true }).waitFor();
      await page.getByText('Salida pendiente', { exact: true }).waitFor();
      await page.getByRole('button', { name: `Ver la auditoría del trace ${source.traceId}`, exact: true }).waitFor({ timeout: 20_000 });
      await shot(page, 'senales-1440');
      await page.setViewportSize(PHONE);
      await shot(page, 'senales-390');
      await page.setViewportSize(DESKTOP);
      await page.getByRole('link', { name: /Ver el detalle en Colas y DLQ/u }).click();
      await page.getByRole('heading', { name: 'Colas y DLQ operativo', exact: true }).waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe('/queues');
      await page.goto(`${active.baseUrl}/observability`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: `Ver la auditoría del trace ${source.traceId}`, exact: true }).click();
      await page.getByRole('tab', { name: 'Auditoría', exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: source.traceId }).waitFor({ timeout: 20_000 });

      const antes = auditUrls.length;
      await page.getByLabel('Traza', { exact: true }).fill('');
      await page.getByLabel('Alias', { exact: true }).fill('');
      await page.getByLabel('Acción', { exact: true }).fill(ACCION);
      await page.getByLabel('Desde', { exact: true }).fill('');
      await page.getByLabel('Hasta', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
      const actionDeadline = Date.now() + 20_000;
      while (!auditUrls.slice(antes).some((url) => new URL(url).searchParams.get('action') === ACCION) && Date.now() < actionDeadline) {
        await pause(100);
      }
      const actionUrl = auditUrls.slice(antes).find((url) => new URL(url).searchParams.get('action') === ACCION);
      expect(actionUrl, auditUrls.join(' | ')).toBeTruthy();
      await page.getByRole('status').filter({ hasText: ACCION }).waitFor({ timeout: 20_000 });
      const eventos = page.getByRole('list', { name: 'Eventos de auditoría' }).locator('li');
      expect(await eventos.count()).toBe(100);
      await page.getByRole('button', { name: 'Cargar anteriores', exact: true }).click();
      const pageDeadline = Date.now() + 20_000;
      while (await eventos.count() < 105 && Date.now() < pageDeadline) await pause(100);
      expect(await eventos.count()).toBe(105);
      expect(auditUrls.some((url) => new URL(url).searchParams.has('before'))).toBe(true);

      await page.getByLabel('Acción', { exact: true }).fill('');
      await page.getByLabel('Alias', { exact: true }).fill('zznoexiste');
      await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
      await page.getByText('No hay eventos que coincidan con el filtro del servidor.', { exact: true }).waitFor({ timeout: 20_000 });
      const absent = await active.database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM audit_events WHERE actor_alias=$1', ['zznoexiste'],
      );
      expect(absent.rows[0]?.count).toBe('0');

      await page.getByLabel('Alias', { exact: true }).fill('BAD');
      await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'El alias tiene que ser el del servidor' }).waitFor();

      await page.locator('form').getByRole('button', { name: 'Quitar filtros', exact: true }).click();
      await page.getByLabel('Identificador', { exact: true }).fill(source.messageId);
      await page.getByRole('button', { name: 'Consultar cadena', exact: true }).click();
      const cadena = page.getByRole('list', { name: 'Cadena diagnóstica' });
      await cadena.waitFor({ timeout: 20_000 });
      const chainText = await page.evaluate(() => document.querySelector('[aria-label="Cadena diagnóstica"]')?.textContent ?? '');
      expect(chainText).toContain(source.messageId);
      expect(chainText).toContain('message');
      const diagnosed = await page.evaluate(async (id) => {
        const response = await fetch(`/v3/console/diagnose/${encodeURIComponent(id)}`, { credentials: 'include' });
        return { status: response.status, body: await response.text() };
      }, source.messageId);
      expect(diagnosed.status).toBe(200);
      expect(diagnosed.body).toContain(source.messageId);

      const unknown = randomUUID();
      await page.getByLabel('Identificador', { exact: true }).fill(unknown);
      await page.getByRole('button', { name: 'Consultar cadena', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'No hay una cadena para ese identificador' }).waitFor({ timeout: 20_000 });
      const missingChain = await page.evaluate(async (id) => {
        const response = await fetch(`/v3/console/diagnose/${encodeURIComponent(id)}`, { credentials: 'include' });
        return response.status;
      }, unknown);
      expect(missingChain).toBe(404);

      controls(page);
      await page.route('**/v3/console/audit**', async (route) => { await route.abort('failed'); });
      await page.getByRole('button', { name: 'Releer auditoría', exact: true }).click();
      const failed = page.getByRole('alert').filter({ hasText: 'No se pudo actualizar la auditoría' });
      await failed.waitFor({ timeout: 20_000 });
      await page.unroute('**/v3/console/audit**');
      await failed.getByRole('button', { name: 'Reintentar', exact: true }).click();
      await failed.waitFor({ state: 'hidden', timeout: 20_000 });
      await shot(page, 'auditoria-1440');
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('recorre cada enlace de la ayuda y el atajo de la barra en escritorio', async () => {
    if (!fixture) throw new Error('functional browser fixture is not initialized');
    const page = await login(isaTenant, DESKTOP);
    try {
      await page.goto(`${fixture.baseUrl}/ayuda`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Ayuda y documentación', exact: true }).waitFor({ timeout: 20_000 });
      const mapa = await page.evaluate(() => Array.from(document.querySelectorAll('#mapa li')).map((item) => ({
        href: item.querySelector('a')?.getAttribute('href') ?? '',
        detail: (item.querySelector('span')?.textContent ?? '').trim(),
      })));
      expect(mapa.map((item) => item.href)).toEqual(VISTAS.map((vista) => vista.href));
      expect(mapa.every((item) => item.detail.length > 20)).toBe(true);
      for (const label of DELIVERY_LABELS) {
        expect(await page.getByText(label, { exact: true }).count()).toBeGreaterThan(0);
      }
      await page.getByText('En escritorio, pliega y despliega la barra lateral.', { exact: true }).waitFor();
      await page.getByText('Abre enlaces en una pestaña independiente. En macOS, Cmd + Clic.', { exact: true }).waitFor();
      const accounts = page.locator('#mapa a[href="/accounts"]');
      const context = page.context();
      pageEvents(context);
      const opened = context.waitForEvent('page', { timeout: 15_000 });
      await controlClick(accounts);
      const tab = await opened;
      await tab.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor({ timeout: 20_000 });
      expect(new URL(tab.url()).pathname).toBe('/accounts');
      expect(new URL(page.url()).pathname).toBe('/ayuda');
      closable(tab);
      await tab.close();
      for (const ancla of ['#mapa', '#terminal', '#conceptos', '#estados', '#atajos']) {
        await page.locator(`a[href="${ancla}"]`).click();
        expect(new URL(page.url()).hash).toBe(ancla);
      }
      expect(await sidebar(page)).toBe('expanded');
      await page.getByRole('heading', { name: 'Ayuda y documentación', exact: true }).click();
      controls(page);
      await page.keyboard.press('Alt+Shift+KeyB');
      await waitSidebar(page, 'rail');
      await page.keyboard.press('Alt+Shift+KeyB');
      await waitSidebar(page, 'expanded');
      await shot(page, 'ayuda-1440');

      for (const vista of VISTAS) {
        await page.goto(`${fixture.baseUrl}/ayuda`, { waitUntil: 'domcontentloaded' });
        await page.locator(`#mapa a[href="${vista.href}"]`).click();
        if (vista.href === '/messages') {
          await page.locator('[aria-label="Sin conversación abierta"]').waitFor({ timeout: 20_000 });
        } else if (vista.href === '/terminal') {
          await page.getByText(/Elige un agente en la barra lateral|Leyendo la flota del servidor/u).waitFor({ timeout: 20_000 });
        } else {
          await page.getByRole('heading', { name: vista.espera, exact: true }).waitFor({ timeout: 20_000 });
        }
        expect(new URL(page.url()).pathname).toBe(vista.href);
      }

      await page.setViewportSize(PHONE);
      await page.goto(`${fixture.baseUrl}/ayuda`, { waitUntil: 'domcontentloaded' });
      await waitSidebar(page, 'bottom');
      await page.keyboard.press('Alt+Shift+KeyB');
      await pause(200);
      expect(await sidebar(page)).toBe('bottom');
      await shot(page, 'ayuda-390');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
