import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { browserDeliveryFailure } from './browser-delivery-diagnostics.js';
import {
  functionalTenants, isaSecondHuman, isaTenant, jhonTenant, newTrustedPage, startBoundedAdapter,
  startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
const receipts = new Map<string, string>();
let isaOwnerPage: Awaited<ReturnType<typeof newTrustedPage>> | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('este E2E exige Testcontainers; CAUCE_TEST_DATABASE_URL no se acepta');
  fixture = await startConsoleFunctionalFixture();
  process.stdout.write(`E2E owned resources: postgres=${fixture.database.container.getId()} browser=${fixture.browserContainer} image=${fixture.browserRuntime.image} imageId=${fixture.browserRuntime.imageId}\n`);
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function loginAndCreateMembership(tenant: FunctionalTenant, viewport: { width: number; height: number }, createMembership = true) {
  if (!fixture) throw new Error('fixture not initialized');
  const page = await newTrustedPage(fixture, viewport);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => { browserErrors.push(String(error)); });
  page.on('console', (message) => { if (String(message).includes('error')) browserErrors.push(String(message)); });
  const response = await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 }).catch(async (cause: unknown) => {
    throw new Error(`el login de contraseña no apareció; status=${String(response?.status())} url=${page.url()} body=${JSON.stringify((await page.locator('html').innerText()).slice(0, 1200))} browser=${JSON.stringify(browserErrors)}`, { cause });
  });
  expect(await page.getByText('MOCK API', { exact: true }).count()).toBe(0);
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 }).catch(async (cause: unknown) => {
    const state = await page.evaluate(async () => {
      const response = await fetch('/v3/console/access', { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    }).catch((error: unknown) => ({ status: 0, body: String(error) }));
    throw new Error(`authenticated console navigation missing; url=${page.url()} body=${JSON.stringify((await page.locator('body').innerText()).slice(0, 1200))} access=${JSON.stringify(state)}`, { cause });
  });
  if (!createMembership) return page;
  await page.goto(`${fixture.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Espacios', exact: true }).click();
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
  const rows = await fixture.database.pool.query<{ enabled: boolean; role: string }>(
    'SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
    [tenant.tenant, tenant.room, tenant.target],
  );
  expect(rows.rows).toEqual([{ enabled: true, role: 'agent' }]);
  const revisions = await fixture.database.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM config_revisions WHERE actor_tenant=$1 AND actor_alias=$2 AND operation->>'resource'='membership'",
    [tenant.tenant, tenant.operator],
  );
  expect(Number(revisions.rows[0]?.count)).toBeGreaterThan(0);
  return page;
}

async function waitForLease(tenant: FunctionalTenant) {
  if (!fixture) throw new Error('fixture not initialized');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await fixture.database.pool.query(
      'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()',
      [tenant.tenant, tenant.target],
    );
    if (result.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`SDK adapter did not establish a live PostgreSQL lease for ${tenant.tenant}:${tenant.target}; ${fixture.prompts[`${tenant.tenant}:stderr`] ?? ''}`);
}

describe('E2E funcional de consola real, dos tenants y entrega durable', () => {
  it('autentica por HTTPS, crea membership desde la UI, publica y recibe respuesta del SDK con contexto propio en 360/1440', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const activeFixture = fixture;
    const isaPage = await loginAndCreateMembership(isaTenant, { width: 1440, height: 1000 });
    isaOwnerPage = isaPage;
    const jhonPage = await loginAndCreateMembership(jhonTenant, { width: 360, height: 800 });
    const cookie = await isaPage.context().cookies(activeFixture.baseUrl);
    expect(cookie.some((item) => item.name === '__Host-cauce_session' && item.httpOnly && item.secure)).toBe(true);
    expect(await isaPage.locator('body').innerText()).not.toContain(jhonTenant.email);
    expect(await jhonPage.locator('body').innerText()).not.toContain(isaTenant.email);

    for (const tenant of functionalTenants) await startBoundedAdapter(activeFixture, tenant);
    await Promise.all(functionalTenants.map((tenant) => waitForLease(tenant)));
    const pages = [isaPage, jhonPage];
    for (const [index, tenant] of functionalTenants.entries()) {
      const page = pages[index];
      if (!page) throw new Error(`missing browser page for ${tenant.tenant}`);
      const nonce = `UI-FLOW-${tenant.tenant}-${randomUUID()}`;
      await page.goto(`${activeFixture.baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: tenant.target, exact: true }).waitFor({ timeout: 20_000 });
      const editor = page.getByLabel(`Mensaje para ${tenant.target}`);
      await editor.fill(nonce);
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
      const bubble = page.getByText(nonce, { exact: true });
      await bubble.waitFor({ timeout: 20_000 });
      const entry = bubble.locator('xpath=ancestor::article[contains(@class,"transcript-entry")]');
      await entry.getByRole('button', { name: 'Opciones del mensaje', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Ver detalle', exact: true }).click();
      await page.getByRole('group', { name: 'Detalle del mensaje seleccionado', exact: true }).waitFor({ timeout: 10_000 });
      await entry.locator('.chat-delivery-check[aria-label="Entrega: Recibido por el agente · ejecución terminada"]')
        .waitFor({ state: 'visible', timeout: 35_000 }).catch(async (cause: unknown) => {
        throw await browserDeliveryFailure(cause, {
          pool: activeFixture.database.pool, tenant, instanceId: `ui-e2e-${tenant.tenant.toLowerCase()}`,
          selector: { kind: 'text', value: nonce },
          stdout: activeFixture.prompts[`${tenant.tenant}:stdout`] ?? '',
          stderr: activeFixture.prompts[`${tenant.tenant}:stderr`] ?? '',
          child: activeFixture.adapters[functionalTenants.indexOf(tenant)],
        });
      });
      receipts.set(tenant.tenant, nonce);
      const persisted = await activeFixture.database.pool.query<{ id: string; delivery_id: string; actor_alias: string; body: { text?: string }; tenant_id: string; auth_channel: string | null; auth_session_id: string | null }>(
        `SELECT message.id,delivery.id AS delivery_id,message.actor_alias,message.body,message.tenant_id,message.auth_channel,message.auth_session_id
           FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
          WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_alias=$3`,
        [tenant.tenant, nonce, tenant.target],
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({ actor_alias: tenant.operator, tenant_id: tenant.tenant, body: { text: nonce }, auth_channel: 'console' });
      expect(persisted.rows[0]?.auth_session_id).toMatch(/^console:/u);
      const messageId = persisted.rows[0]?.id;
      const deliveryId = persisted.rows[0]?.delivery_id;
      if (!messageId || !deliveryId) throw new Error(`missing persisted message or delivery id for ${tenant.tenant}`);
      const reply = page.locator(`.transcript-entry.output[data-reply-to="${messageId}"] .canonical-reply[data-delivery-id="${deliveryId}"]`);
      const historyReads: string[] = [];
      page.on('request', (value) => {
        if (value === null || typeof value !== 'object' || !('url' in value) || !('method' in value)
            || typeof value.url !== 'function' || typeof value.method !== 'function') return;
        const request = value as { url(): string; method(): string };
        if (request.method() === 'GET') historyReads.push(request.url());
      });
      historyReads.length = 0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: tenant.target, exact: true }).waitFor({ timeout: 20_000 });
      const historyBubble = page.getByText(nonce, { exact: true });
      await historyBubble.waitFor({ state: 'visible', timeout: 20_000 });
      const historyEntry = historyBubble.locator('xpath=ancestor::article[contains(@class,"transcript-entry")]');
      expect(await historyEntry.count()).toBe(1);
      await reply.getByText(`respuesta sintética ${tenant.tenant}`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      expect(await reply.count()).toBe(1);
      expect(historyReads).toContain(`${activeFixture.baseUrl}/v3/console/messages/${encodeURIComponent(messageId)}`);
      const detail = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        return { status: response.status, body: await response.json() as unknown };
      }, `${activeFixture.baseUrl}/v3/console/messages/${encodeURIComponent(messageId)}`);
      expect(detail.status).toBe(200);
      const canonical = detail.body as { chain_open?: unknown; deliveries?: { tenant_id?: unknown; alias?: unknown; reply?: unknown }[] };
      const canonicalDelivery = canonical.deliveries?.find((delivery) => delivery.tenant_id === tenant.tenant && delivery.alias === tenant.target);
      expect(canonicalDelivery?.reply).toBe(`respuesta sintética ${tenant.tenant}`);
      expect(canonical.chain_open).toBe(false);
      const otherPage = pages[1 - index];
      if (!otherPage) throw new Error(`missing opposite browser session for ${tenant.tenant}`);
      const foreignDetail = await otherPage.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        return { status: response.status, body: await response.json() as unknown };
      }, `${activeFixture.baseUrl}/v3/console/messages/${encodeURIComponent(messageId)}`);
      expect(foreignDetail.status, 'a different tenant session must not read message detail').toBe(404);
      expect(JSON.stringify(foreignDetail.body)).not.toContain(`respuesta sintética ${tenant.tenant}`);
      await reply.getByText(`respuesta sintética ${tenant.tenant}`, { exact: true }).waitFor({ state: 'visible', timeout: 12_000 });
      const delivered = await activeFixture.database.pool.query<{ status: string; result: unknown; attempt: number }>(
        `SELECT status,result,attempt FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`, [tenant.tenant, nonce, tenant.target],
      );
      expect(delivered.rows).toHaveLength(1);
      expect(delivered.rows[0]).toMatchObject({ status: 'done', attempt: 1 });
      expect(JSON.stringify(delivered.rows[0]?.result)).toContain(`respuesta sintética ${tenant.tenant}`);
      const acknowledgements = await activeFixture.database.pool.query<{ status: string; applied: boolean }>(
        `SELECT ack.status,ack.applied FROM delivery_acks ack JOIN deliveries delivery ON delivery.id=ack.delivery_id
          JOIN messages message ON message.id=delivery.message_id
          WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_alias=$3 ORDER BY ack.id DESC LIMIT 1`,
        [tenant.tenant, nonce, tenant.target],
      );
      expect(acknowledgements.rows).toEqual([{ status: 'done', applied: true }]);
      const capture = activeFixture.prompts[`${tenant.tenant}:capture`];
      if (!capture) throw new Error(`missing prompt capture path for ${tenant.tenant}`);
      const prompt = await readFile(capture, 'utf8');
      expect(prompt).toContain(nonce);
      expect(prompt).toContain(tenant.marker);
      const otherTenant = functionalTenants[1 - index];
      if (!otherTenant) throw new Error('missing opposite tenant fixture');
      expect(prompt).not.toContain(otherTenant.marker);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `${tenant.tenant} horizontal overflow at ${String(page.viewportSize()?.width)}px`).toBe(false);
    }
    const crossTenant = await activeFixture.database.pool.query<{ tenant_id: string; body: { text: string } }>(
      "SELECT tenant_id,body FROM messages WHERE body->>'text' LIKE 'UI-FLOW-%' ORDER BY tenant_id",
    );
    expect(crossTenant.rows.map((row) => [row.tenant_id, row.body.text])).toEqual(
      functionalTenants.map((tenant) => [tenant.tenant, receipts.get(tenant.tenant)]),
    );
    const audit = await activeFixture.database.pool.query<{ tenant_id: string; action: string; outcome: string }>(
      "SELECT tenant_id,action,decision AS outcome FROM audit_events WHERE action='message.publish' ORDER BY tenant_id",
    );
    expect(audit.rows.map((row) => [row.tenant_id, row.action, row.outcome])).toEqual([
      ['Isa', 'message.publish', 'allow'], ['Jhon', 'message.publish', 'allow'],
    ]);

  }, 180_000);

  it('recupera solo las respuestas humanas propias para UUID distintos con el mismo tenant y alias', async () => {
    if (!fixture || !isaOwnerPage) throw new Error('fixture or primary human session not initialized');
    const activeFixture = fixture;
    const firstHumanPage = isaOwnerPage;
    const secondHumanPage = await loginAndCreateMembership(isaSecondHuman, { width: 360, height: 800 }, false);
    const accessFor = async (page: Awaited<ReturnType<typeof newTrustedPage>>) => page.evaluate(async () => {
      const response = await fetch('/v3/console/access', { credentials: 'include' });
      return { status: response.status, body: await response.json() as { subject?: unknown; human_subject?: unknown } };
    });
    const [firstAccess, secondAccess] = await Promise.all([accessFor(firstHumanPage), accessFor(secondHumanPage)]);
    expect(firstAccess.status).toBe(200);
    expect(secondAccess.status).toBe(200);
    expect(firstAccess.body.subject).toBe(secondAccess.body.subject);
    expect(firstAccess.body.human_subject).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(secondAccess.body.human_subject).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(secondAccess.body.human_subject).not.toBe(firstAccess.body.human_subject);
    const operators = await activeFixture.database.pool.query<{
      alias: string; email: string; id: string; tenant_id: string;
    }>(
      `SELECT id::text AS id,email,tenant_id,alias FROM console_users
        WHERE email IN ($1,$2) ORDER BY email`,
      [isaTenant.email, isaSecondHuman.email],
    );
    expect(operators.rows).toHaveLength(2);
    expect(operators.rows.every((operator) => operator.tenant_id === 'Isa' && operator.alias === 'e2eisa')).toBe(true);
    expect(operators.rows.every((operator) => /^[0-9a-f-]{36}$/u.test(operator.id))).toBe(true);
    expect(new Set(operators.rows.map((operator) => operator.id)).size).toBe(2);
    process.stdout.write(`E2E human identities: ${JSON.stringify(operators.rows.map(({ id, email }) => ({ id, email })))}; human_subjects=${JSON.stringify([firstAccess.body.human_subject, secondAccess.body.human_subject])}\n`);
    expect(await firstHumanPage.locator('body').innerText()).not.toContain(isaSecondHuman.email);
    expect(await secondHumanPage.locator('body').innerText()).not.toContain(isaTenant.email);

    const ownerNonce = `UI-HUMAN-ISA-${randomUUID().toUpperCase()}`;
    const secondNonce = `UI-HUMAN-ISA-${randomUUID().toUpperCase()}`;
    const publish = async (page: Awaited<ReturnType<typeof newTrustedPage>>, nonce: string) => {
      await page.goto(`${activeFixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: isaTenant.target, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByLabel(`Mensaje para ${isaTenant.target}`).fill(nonce);
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
      const message = page.getByText(nonce, { exact: true });
      await message.waitFor({ timeout: 20_000 });
      const entry = message.locator('xpath=ancestor::article[contains(@class,"transcript-entry")]');
      await entry.getByRole('button', { name: 'Opciones del mensaje', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Ver detalle', exact: true }).click();
      await page.getByRole('group', { name: 'Detalle del mensaje seleccionado', exact: true })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await entry.locator('.chat-delivery-check[aria-label="Entrega: Recibido por el agente · ejecución terminada"]')
        .waitFor({ state: 'visible', timeout: 35_000 }).catch(async (cause: unknown) => {
          throw await browserDeliveryFailure(cause, {
            pool: activeFixture.database.pool, tenant: isaTenant, instanceId: `ui-e2e-${isaTenant.tenant.toLowerCase()}`,
            selector: { kind: 'text', value: nonce },
            stdout: activeFixture.prompts[`${isaTenant.tenant}:stdout`] ?? '',
            stderr: activeFixture.prompts[`${isaTenant.tenant}:stderr`] ?? '',
            child: activeFixture.adapters[functionalTenants.indexOf(isaTenant)],
          });
        });
      const persisted = await activeFixture.database.pool.query<{ id: string; author: { subject_id?: string } | null }>(
        `SELECT message.id,
                (SELECT author_audit.metadata->'console_author'
                   FROM audit_events author_audit
                  WHERE author_audit.message_id=message.id AND author_audit.action='message.publish'
                    AND author_audit.decision='allow' ORDER BY author_audit.created_at DESC LIMIT 1) AS author
           FROM messages message WHERE message.tenant_id=$1 AND message.body->>'text'=$2`,
        [isaTenant.tenant, nonce],
      );
      expect(persisted.rows).toHaveLength(1);
      const messageId = persisted.rows[0]?.id;
      if (!messageId) throw new Error(`missing durable message ID for ${nonce}`);
      const delivery = await activeFixture.database.pool.query<{ id: string; attempt: number; result: unknown; status: string }>(
        `SELECT delivery.id,delivery.status,delivery.attempt,delivery.result FROM deliveries delivery WHERE delivery.message_id=$1`, [messageId],
      );
      expect(delivery.rows).toHaveLength(1);
      expect(delivery.rows[0]).toMatchObject({ status: 'done', attempt: 1 });
      expect(JSON.stringify(delivery.rows[0]?.result)).toContain(`respuesta sintética Isa ${nonce}`);
      const deliveryId = delivery.rows[0]?.id;
      if (!deliveryId) throw new Error(`missing durable delivery ID for ${nonce}`);
      const acknowledgement = await activeFixture.database.pool.query<{ status: string; applied: boolean }>(
        'SELECT status,applied FROM delivery_acks WHERE delivery_id=$1 ORDER BY id DESC LIMIT 1', [deliveryId],
      );
      expect(acknowledgement.rows).toEqual([{ status: 'done', applied: true }]);
      return { id: messageId, deliveryId, author: persisted.rows[0]?.author };
    };

    const firstMessage = await publish(firstHumanPage, ownerNonce);
    const secondMessage = await publish(secondHumanPage, secondNonce);
    expect(firstMessage.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondMessage.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(firstMessage.author?.subject_id).toBe(firstAccess.body.human_subject);
    expect(secondMessage.author?.subject_id).toBe(secondAccess.body.human_subject);
    expect(firstMessage.author?.subject_id).not.toBe(secondMessage.author?.subject_id);

    await firstHumanPage.reload({ waitUntil: 'domcontentloaded' });
    await firstHumanPage.getByText(ownerNonce, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const firstReply = firstHumanPage.locator(`.transcript-entry.output[data-reply-to="${firstMessage.id}"] .canonical-reply[data-delivery-id="${firstMessage.deliveryId}"]`);
    await firstReply.getByText(`respuesta sintética Isa ${ownerNonce}`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await firstReply.count()).toBe(1);
    await firstHumanPage.getByText(secondNonce, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await firstHumanPage.locator(`.transcript-entry.output[data-reply-to="${secondMessage.id}"]`).count()).toBe(0);
    expect(await firstHumanPage.getByText(`respuesta sintética Isa ${secondNonce}`, { exact: true }).count()).toBe(0);

    await secondHumanPage.reload({ waitUntil: 'domcontentloaded' });
    await secondHumanPage.getByText(secondNonce, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const secondReply = secondHumanPage.locator(`.transcript-entry.output[data-reply-to="${secondMessage.id}"] .canonical-reply[data-delivery-id="${secondMessage.deliveryId}"]`);
    await secondReply.getByText(`respuesta sintética Isa ${secondNonce}`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await secondReply.count()).toBe(1);
    await secondHumanPage.getByText(ownerNonce, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await secondHumanPage.locator(`.transcript-entry.output[data-reply-to="${firstMessage.id}"]`).count()).toBe(0);
    expect(await secondHumanPage.getByText(`respuesta sintética Isa ${ownerNonce}`, { exact: true }).count()).toBe(0);

    const crossTenantPage = await loginAndCreateMembership(jhonTenant, { width: 360, height: 800 }, false);
    const crossTenantDetail = await crossTenantPage.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    }, `${activeFixture.baseUrl}/v3/console/messages/${encodeURIComponent(firstMessage.id)}`);
    expect(crossTenantDetail.status).toBe(404);
    expect(crossTenantDetail.body).not.toContain(`respuesta sintética Isa ${ownerNonce}`);
    expect(await secondHumanPage.locator('body').innerText()).not.toContain(jhonTenant.email);
    expect(await crossTenantPage.locator('body').innerText()).not.toContain(isaSecondHuman.email);
  }, 180_000);
});
