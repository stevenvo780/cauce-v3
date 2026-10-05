import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CauceRepository } from '@cauce/store';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

const execFileAsync = promisify(execFile);
const reader = {
  tenant: 'Isa' as const, alias: isaTenant.operator, email: 'queues-reader@cauce.test', password: randomUUID(),
};
const artifacts = '/tmp/cauce-programa-20261004/queues-dlq-browser';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

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
  await page.getByRole('link', { name: /Conversaciones/u }).waitFor({ state: 'visible', timeout: 20_000 });
  return page;
}

async function ensureRecipientMembership(page: Awaited<ReturnType<typeof newTrustedPage>>) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  await page.goto(`${fixture.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Administración avanzada' }).click();
  await page.getByRole('button', { name: 'Un solo recurso' }).click();
  await page.getByLabel('Recurso a crear').selectOption('membership');
  await page.getByLabel('Tenant', { exact: true }).fill(isaTenant.tenant);
  await page.getByLabel('Room', { exact: true }).fill(isaTenant.room);
  await page.getByLabel('Alias', { exact: true }).fill(isaTenant.target);
  await page.getByText('Opciones de alta:', { exact: false }).click();
  await page.getByLabel('Rol de permisos', { exact: true }).fill('agent');
  await page.getByRole('button', { name: 'Previsualizar el alta' }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado por el servidor' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
  const membership = await fixture.database.pool.query<{ enabled: boolean; role: string }>(
    'SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
    [isaTenant.tenant, isaTenant.room, isaTenant.target],
  );
  expect(membership.rows).toEqual([{ enabled: true, role: 'agent' }]);
}

async function publishPending(page: Awaited<ReturnType<typeof newTrustedPage>>, marker: string) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: isaTenant.target, exact: true }).waitFor({ timeout: 20_000 });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`).fill(marker);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.getByText(marker, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  let persisted = await fixture.database.pool.query<{ message_id: string; delivery_id: string; status: string }>(
    `SELECT message.id AS message_id,delivery.id AS delivery_id,delivery.status
       FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
      WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$3`,
    [isaTenant.tenant, marker, isaTenant.target],
  );
  const deadline = Date.now() + 10_000;
  while (persisted.rows.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    persisted = await fixture.database.pool.query(
      `SELECT message.id AS message_id,delivery.id AS delivery_id,delivery.status
         FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
        WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$3`,
      [isaTenant.tenant, marker, isaTenant.target],
    );
  }
  if (persisted.rows.length !== 1) {
    const found = await fixture.database.pool.query(
      'SELECT id,tenant_id,room_id,actor_alias,body FROM messages WHERE body::text LIKE $1', [`%${marker}%`],
    );
    throw new Error(`UI publish was not durably routed once: matching=${JSON.stringify(found.rows)} rows=${JSON.stringify(persisted.rows)}`);
  }
  expect(persisted.rows[0]?.status).toBe('pending');
  const row = persisted.rows[0];
  if (!row?.message_id || !row.delivery_id) throw new Error('publish did not persist its single delivery');
  return row;
}

async function confirmDeliveryAction(
  page: Awaited<ReturnType<typeof newTrustedPage>>, action: 'cancel' | 'replay', deliveryId: string,
) {
  const button = action === 'cancel'
    ? page.getByRole('button', { name: `Cancelar delivery ${deliveryId}`, exact: true })
    : page.getByRole('button', { name: `Replay delivery ${deliveryId}`, exact: true });
  await button.click();
  const confirmName = action === 'cancel' ? 'Sí, cancelar la entrega' : 'Sí, reinyectar';
  await page.getByRole('alertdialog').getByRole('button', { name: confirmName, exact: true }).click();
}

async function exhaustOwnedDelivery(deliveryId: string) {
  if (!fixture) throw new Error('functional browser fixture is not initialized');
  const repository = new CauceRepository(fixture.database.pool);
  const maxAttempts = await fixture.database.pool.query<{ max_attempts: number }>(
    'SELECT max_attempts FROM deliveries WHERE id=$1', [deliveryId],
  );
  const attempts = maxAttempts.rows[0]?.max_attempts;
  if (!attempts || attempts < 1 || attempts > 5) throw new Error(`unexpected fixture delivery attempt ceiling: ${String(attempts)}`);
  const instanceId = `queues-e2e-${randomUUID()}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, instanceId, [], 30_000);
    if (!lease.acquired || lease.epoch === undefined || !lease.connection_token) {
      throw new Error(`could not acquire owned delivery lease: ${JSON.stringify(lease)}`);
    }
    const claims = await repository.claimDeliveries(
      isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, 1, 1_000, 1, {}, lease.connection_token,
    );
    const claim = claims.find((item) => item.delivery_id === deliveryId);
    if (!claim) throw new Error(`the real claim operation did not claim the target delivery on attempt ${String(attempt + 1)}`);
    await fixture.database.pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1 AND status IN ('leased','accepted','started')`,
      [deliveryId],
    );
    if (!await repository.releaseLease(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, lease.connection_token)) {
      throw new Error(`could not release the test consumer lease after attempt ${String(attempt + 1)}`);
    }
    const reaped = await repository.retryStaleDeliveries(0, 100, { parkWithoutConsumer: false });
    if (attempt + 1 === attempts) expect(reaped.dead).toBe(1);
    else expect(reaped.retried).toBe(1);
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

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  const active = fixture;
  const provision = await execFileAsync(`${process.cwd()}/node_modules/.bin/tsx`, [
    'services/gateway/src/console-user-cli.ts', '--email', reader.email, '--name', 'Queues reader E2E',
    '--role', 'reader', '--tenant', reader.tenant, '--alias', reader.alias,
  ], {
    cwd: process.cwd(), timeout: 15_000, maxBuffer: 16 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', DATABASE_URL: active.database.url, CAUCE_CONSOLE_USER_PASSWORD: reader.password },
  });
  if (!provision.stdout.includes('cuenta guardada') || provision.stdout.includes(reader.password)) {
    throw new Error(`reader provisioning did not confirm safely: ${provision.stdout.replaceAll(reader.password, '[REDACTED]')}`);
  }
  process.stdout.write(`queues E2E owned resources: postgres=${active.database.container.getId()} browser=${active.browserContainer} image=${active.browserRuntime.image} imageId=${active.browserRuntime.imageId}\n`);
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

describe('colas y DLQ operativo con consola HTTPS y PostgreSQL reales', () => {
  it('permite lectura sin controles al reader y persiste cancelación, replay y cierre DLQ sin replay en 360/1440', async () => {
    if (!fixture) throw new Error('functional browser fixture is not initialized');
    const active = fixture;
    const operator = await login(isaTenant, { width: 1440, height: 1000 });
    await ensureRecipientMembership(operator);
    const cancelMarker = `QUEUE-CANCEL-${randomUUID()}`;
    const resolveMarker = `QUEUE-RESOLVE-${randomUUID()}`;
    const cancelSource = await publishPending(operator, cancelMarker);
    const resolveSource = await publishPending(operator, resolveMarker);

    const readerPage = await login({ ...isaTenant, email: reader.email, password: reader.password }, { width: 360, height: 800 });
    await readerPage.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
    const readerCancel = readerPage.getByRole('button', { name: `Cancelar delivery ${cancelSource.delivery_id}`, exact: true });
    const readerReplay = readerPage.getByRole('button', { name: `Replay delivery ${cancelSource.delivery_id}`, exact: true });
    const readerQueues = await readerPage.evaluate(async () => {
      const response = await fetch('/v3/console/queues', { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    });
    expect(readerQueues.status, `reader queues API: ${readerQueues.body.slice(0, 600)}`).toBe(200);
    await readerPage.getByRole('table').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await readerPage.locator('table tbody tr').count()).toBe(2);
    const readerAccess = await readerPage.evaluate(async () => {
      const response = await fetch('/v3/console/access', { credentials: 'include' });
      return await response.json() as { permissions?: string[] };
    });
    expect(readerAccess.permissions).not.toContain('delivery.cancel');
    expect(readerAccess.permissions).not.toContain('delivery.replay');
    expect(readerAccess.permissions).not.toContain('dlq.resolve');
    expect(await readerCancel.count()).toBe(1);
    const readerControlStates = await readerPage.evaluate(() => Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Cancelar delivery"],button[aria-label^="Replay delivery"]'),
    ).map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })));
    expect(readerControlStates.length).toBe(2);
    expect(readerControlStates.every((control) => control.disabled)).toBe(true);
    expect(await readerReplay.count()).toBe(0);
    await readerPage.screenshot({ path: `${artifacts}/reader-360.png`, fullPage: true });

    await operator.setViewportSize({ width: 360, height: 800 });
    await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
    await operator.getByRole('button', { name: `Cancelar delivery ${cancelSource.delivery_id}`, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await confirmDeliveryAction(operator, 'cancel', cancelSource.delivery_id);
    await operator.getByText('MUERTA', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    const cancelled = await active.database.pool.query<{
      status: string; cancelled_at: Date | null; claim_token: string | null; dead_reason: string; audit_count: string;
    }>(
      `SELECT delivery.status,delivery.cancelled_at,delivery.claim_token,letter.reason AS dead_reason,
              (SELECT count(*)::text FROM audit_events audit WHERE audit.action='delivery.cancel' AND audit.delivery_id=delivery.id AND audit.decision='allow') AS audit_count
         FROM deliveries delivery JOIN dead_letters letter ON letter.delivery_id=delivery.id
        WHERE delivery.id=$1`, [cancelSource.delivery_id],
    );
    expect(cancelled.rows).toHaveLength(1);
    expect(cancelled.rows[0]).toMatchObject({ status: 'dead', claim_token: null, audit_count: '1' });
    expect(cancelled.rows[0]?.cancelled_at).toBeInstanceOf(Date);
    expect(cancelled.rows[0]?.dead_reason).toContain('Cancelled by operator Isa:e2eisa');

    await operator.setViewportSize({ width: 1440, height: 1000 });
    await operator.screenshot({ path: `${artifacts}/operator-1440-cancelled.png`, fullPage: true });
    await operator.getByRole('button', { name: `Replay delivery ${cancelSource.delivery_id}`, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await confirmDeliveryAction(operator, 'replay', cancelSource.delivery_id);
    await operator.getByText(/Replay encolado para/u).waitFor({ state: 'visible', timeout: 15_000 });

    const replayState = await active.database.pool.query<{
      original_state: string; letter_resolved: Date | null; replay_count: string; outbox_count: string;
      audit_from_source: string; clone_message: string | null; clone_state: string | null;
    }>(
      `SELECT original.status AS original_state,letter.resolved_at AS letter_resolved,
              (SELECT count(*)::text FROM audit_events audit WHERE audit.action='delivery.replay' AND audit.metadata->>'replayed_from_delivery_id'=original.id::text) AS replay_count,
              (SELECT count(*)::text FROM adapter_outbox wake WHERE wake.kind='wake' AND wake.delivery_id=cloned_delivery.id) AS outbox_count,
              (SELECT count(*)::text FROM audit_events audit WHERE audit.action='delivery.replay' AND audit.delivery_id=cloned_delivery.id) AS audit_from_source,
              clone.id::text AS clone_message,cloned_delivery.status AS clone_state
         FROM deliveries original JOIN dead_letters letter ON letter.delivery_id=original.id
         LEFT JOIN audit_events replay ON replay.action='delivery.replay' AND replay.metadata->>'replayed_from_delivery_id'=original.id::text
         LEFT JOIN deliveries cloned_delivery ON cloned_delivery.id=replay.delivery_id
         LEFT JOIN messages clone ON clone.id=cloned_delivery.message_id
        WHERE original.id=$1`, [cancelSource.delivery_id],
    );
    expect(replayState.rows).toHaveLength(1);
    expect(replayState.rows[0]).toMatchObject({ original_state: 'dead', replay_count: '1', outbox_count: '1', audit_from_source: '1', clone_state: 'pending' });
    expect(replayState.rows[0]?.letter_resolved).toBeInstanceOf(Date);
    expect(replayState.rows[0]?.clone_message).not.toBeNull();

    await exhaustOwnedDelivery(resolveSource.delivery_id);
    const deadLetter = await active.database.pool.query<{ id: string; disposition: string; evidence_sha256: string; open: boolean }>(
      'SELECT id::text AS id,disposition,evidence_sha256,resolved_at IS NULL AS open FROM dead_letters WHERE delivery_id=$1',
      [resolveSource.delivery_id],
    );
    expect(deadLetter.rows).toHaveLength(1);
    expect(deadLetter.rows[0]).toMatchObject({ disposition: 'safe_retry', open: true });
    expect(deadLetter.rows[0]?.evidence_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const resolveIncidentId = deadLetter.rows[0]?.id;
    if (!resolveIncidentId) throw new Error('safe-retry incident has no durable identifier');

    await operator.setViewportSize({ width: 360, height: 800 });
    await operator.goto(`${active.baseUrl}/queues`, { waitUntil: 'domcontentloaded' });
    await operator.getByRole('tab', { name: 'DLQ operativo', exact: true }).click();
    await operator.getByRole('heading', { name: 'DLQ operativo', exact: true }).waitFor({ timeout: 15_000 });
    const resolveDlq = operator.locator(`tr:has(span[title="${resolveIncidentId}"])`);
    await resolveDlq.getByRole('button', { name: /Cerrar sin replay/u }).waitFor({ state: 'visible', timeout: 15_000 });
    const priorWakeCount = await active.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM adapter_outbox WHERE kind='wake' AND delivery_id=$1",
      [resolveSource.delivery_id],
    );
    expect(priorWakeCount.rows).toHaveLength(1);
    await resolveDlq.getByRole('button', { name: /Cerrar sin replay/u }).click();
    const resolution = operator.getByRole('alertdialog', { name: 'Cerrar incidente DLQ sin replay' });
    await resolution.locator('textarea[aria-label="Motivo operativo"]').fill('Prueba E2E: cierre manual sin reinyección.');
    await resolution.locator('input[type="checkbox"]').click();
    await resolution.getByRole('button', { name: 'Cerrar sin replay', exact: true }).click();
    await operator.getByRole('status').filter({ hasText: 'cerrado sin replay' }).waitFor({ timeout: 15_000 });
    const resolvedState = await active.database.pool.query<{
      delivery_state: string; resolved_at: Date | null; disposition: string; audit_count: string; clone_count: string;
    }>(
      `SELECT delivery.status AS delivery_state,letter.resolved_at,letter.disposition,
              (SELECT count(*)::text FROM audit_events audit WHERE audit.id=resolution.audit_event_id AND audit.action='dlq.resolve_without_replay') AS audit_count,
              (SELECT count(*)::text FROM audit_events audit WHERE audit.action='delivery.replay' AND audit.metadata->>'replayed_from_delivery_id'=delivery.id::text) AS clone_count
         FROM deliveries delivery JOIN dead_letters letter ON letter.delivery_id=delivery.id
         JOIN dlq_operator_resolutions resolution ON resolution.target='delivery' AND resolution.dead_letter_id=letter.id
        WHERE delivery.id=$1`,
      [resolveSource.delivery_id],
    );
    expect(resolvedState.rows).toHaveLength(1);
    expect(resolvedState.rows[0]).toMatchObject({ delivery_state: 'dead', disposition: 'safe_retry', audit_count: '1', clone_count: '0' });
    expect(resolvedState.rows[0]?.resolved_at).toBeInstanceOf(Date);
    const effectCounts = await active.database.pool.query<{ replay: string; wake: string; resolution: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE action='delivery.replay' AND metadata->>'replayed_from_delivery_id'=$1) AS replay,
        (SELECT count(*)::text FROM adapter_outbox WHERE kind='wake' AND delivery_id=$1::uuid) AS wake,
        (SELECT count(*)::text FROM dlq_operator_resolutions WHERE target='delivery' AND dead_letter_id IN (SELECT id FROM dead_letters WHERE delivery_id=$1::uuid)) AS resolution`,
      [resolveSource.delivery_id],
    );
    expect(effectCounts.rows).toEqual([{ replay: '0', wake: priorWakeCount.rows[0]?.count, resolution: '1' }]);

    await operator.screenshot({ path: `${artifacts}/operator-360-resolution.png`, fullPage: true });
    expect(await operator.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }, 240_000);
});
