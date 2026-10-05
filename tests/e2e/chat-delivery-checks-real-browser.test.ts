import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  functionalTenants, newTrustedPage, startBoundedAdapter, startConsoleFunctionalFixture,
  type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('este E2E exige Testcontainers; no se acepta una base externa');
  fixture = await startConsoleFunctionalFixture();
  process.stdout.write(`chat E2E owned resources: postgres=${fixture.database.container.getId()} browser=${fixture.browserContainer} image=${fixture.browserRuntime.imageId}\n`);
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function loginAndCreateMembership(tenant: FunctionalTenant, viewport: { width: number; height: number }) {
  if (!fixture) throw new Error('fixture not initialized');
  const page = await newTrustedPage(fixture, viewport);
  const login = await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 }).catch(async (cause: unknown) => {
    throw new Error(`no apareció el login; HTTP=${String(login?.status())} URL=${page.url()}`, { cause });
  });
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('link', { name: /Conversaciones/ }).waitFor({ state: 'visible', timeout: 20_000 });

  await page.goto(`${fixture.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Administración avanzada' }).click();
  await page.getByRole('button', { name: 'Un solo recurso' }).click();
  await page.getByLabel('Recurso a crear').selectOption('membership');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant.tenant);
  await page.getByLabel('Room', { exact: true }).fill(tenant.room);
  await page.getByLabel('Alias', { exact: true }).fill(tenant.target);
  await page.getByText('Opciones de alta:', { exact: false }).click();
  await page.getByLabel('Rol de permisos', { exact: true }).fill('agent');
  await page.getByRole('button', { name: 'Previsualizar el alta' }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado por el servidor' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
  const membership = await fixture.database.pool.query<{ enabled: boolean; role: string }>(
    'SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
    [tenant.tenant, tenant.room, tenant.target],
  );
  expect(membership.rows).toEqual([{ enabled: true, role: 'agent' }]);
  return page;
}

async function waitForLease(tenant: FunctionalTenant): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const lease = await fixture.database.pool.query(
      'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()',
      [tenant.tenant, tenant.target],
    );
    if (lease.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const adapter = fixture.adapters[functionalTenants.indexOf(tenant)];
  const stderr = fixture.prompts[`${tenant.tenant}:stderr`] ?? '';
  throw new Error(`no se estableció lease de prueba para ${tenant.tenant}:${tenant.target}; adapter exit=${String(adapter?.exitCode)} signal=${String(adapter?.signalCode)} stderr=${stderr.slice(-4_000)}`);
}

async function seedStructuredFeedMessage(tenant: FunctionalTenant, type: string, body: Record<string, unknown>): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  const client = await fixture.database.pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,'interactive',10) RETURNING id`,
      [randomUUID(), randomUUID(), tenant.tenant, tenant.room, tenant.operator, JSON.stringify({ type, ...body })],
    );
    const messageId = inserted.rows[0]?.id;
    if (!messageId) throw new Error('synthetic chat message was not inserted');
    await client.query(
      'INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,$2,$3)',
      [messageId, tenant.tenant, tenant.target],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function stopSyntheticAdapter(index: number): Promise<void> {
  const child = fixture?.adapters[index];
  if (!child) throw new Error(`missing synthetic adapter ${String(index)}`);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`synthetic adapter ${String(index)} did not stop`)); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function hasHorizontalOverflow(page: Awaited<ReturnType<typeof newTrustedPage>>): Promise<boolean> {
  return page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>('.messenger-thread-scroll');
    return document.documentElement.scrollWidth > window.innerWidth
      || (thread !== null && thread.scrollWidth > thread.clientWidth + 1);
  });
}

describe('Estados durables y contenido estructurado en el chat web', () => {
  it('muestra el ping con confirmaciones durables y la respuesta separada en escritorio y móvil', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const activeFixture = fixture;
    const artifacts = process.env.CAUCE_E2E_ARTIFACT_DIR;
    if (artifacts) await mkdir(artifacts, { recursive: true });

    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 360;
      const page = await loginAndCreateMembership(tenant, { width, height: width === 360 ? 800 : 1000 });
      await startBoundedAdapter(activeFixture, tenant);
      await waitForLease(tenant);
      const nonce = `CHAT-CHECK-${tenant.tenant}-${randomUUID()}`;
      await page.goto(`${activeFixture.baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: tenant.target, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByLabel(`Mensaje para ${tenant.target}`).fill(nonce);
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();

      const bubble = page.getByText(nonce, { exact: true });
      await bubble.waitFor({ state: 'visible', timeout: 20_000 });
      const entry = bubble.locator('xpath=ancestor::article[contains(@class,"transcript-entry")]');
      await entry.locator('.chat-delivery-check[aria-label="Entrega: El agente terminó; respuesta recibida"]')
        .waitFor({ state: 'visible', timeout: 35_000 });
      const reply = page.locator('.transcript-entry.output[data-reply-to] .canonical-reply');
      await reply.getByText(new RegExp(`respuesta sintética ${tenant.tenant}`)).waitFor({ state: 'visible', timeout: 20_000 });
      expect(await page.getByText(/ACK llega por polling/i).count()).toBe(0);
      expect(await page.getByText(/Mensaje aceptado para entrega/i).count()).toBe(0);
      expect(await entry.locator('.chat-delivery-check').innerText()).toBe('✓✓');
      expect(await reply.innerText()).toContain(`respuesta sintética ${tenant.tenant}`);
      const body = await page.locator('body').innerText();
      expect(body).not.toContain('{"type":"system.gate.probe"');
      const overflow = await hasHorizontalOverflow(page);
      expect(overflow, `desbordamiento horizontal a ${String(width)}px`).toBe(false);
      if (artifacts) await page.screenshot({ path: join(artifacts, `chat-${String(width)}.png`) });

      const persisted = await activeFixture.database.pool.query<{ state: string; actor_alias: string; body: { text?: string } }>(
        `SELECT delivery.status AS state,message.actor_alias,message.body
           FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
          WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_alias=$3`,
        [tenant.tenant, nonce, tenant.target],
      );
      expect(persisted.rows).toEqual([{ state: 'done', actor_alias: tenant.operator, body: { text: nonce } }]);

      await stopSyntheticAdapter(index);
      const probeBody = { nonce: `PROBE-${randomUUID()}`, timeout_ms: 90_000 };
      await seedStructuredFeedMessage(tenant, 'system.gate.probe', probeBody);
      await seedStructuredFeedMessage(tenant, '__proto__', { marker: randomUUID() });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const feed = await page.evaluate(async () => {
        const response = await fetch('/v3/console/messages');
        const body = await response.json() as { items?: { body_preview?: string | null }[] };
        return { status: response.status, bodies: body.items?.map((item) => item.body_preview ?? '') ?? [] };
      });
      expect(feed.status).toBe(200);
      expect(feed.bodies.join('\n')).toContain(probeBody.nonce);
      expect(feed.bodies.join('\n')).toContain('__proto__');

      const probe = page.getByRole('group', { name: 'Comprobación de conexión' });
      await probe.getByText('Solicitud para comprobar la disponibilidad del agente.').waitFor({ timeout: 15_000 });
      await probe.getByText('Plazo').waitFor({ state: 'visible' });
      await probe.getByText('90 segundos').waitFor({ state: 'visible' });
      const technicalJson = probe.locator('pre');
      await technicalJson.waitFor({ state: 'hidden' });
      await probe.getByText('Detalle técnico').press('Enter');
      await technicalJson.waitFor({ state: 'visible' });
      expect(await technicalJson.innerText()).toBe(JSON.stringify({ type: 'system.gate.probe', ...probeBody }, null, 2));
      await page.getByText('Tipo: __proto__', { exact: true }).waitFor({ state: 'visible' });
      expect(await hasHorizontalOverflow(page)).toBe(false);
      if (artifacts) await page.screenshot({ path: join(artifacts, `chat-probe-${String(width)}.png`) });
    }
  }, 180_000);
});
