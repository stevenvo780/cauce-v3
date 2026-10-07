import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository } from '@cauce/store';
import {
  isaTenant, jhonTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserPage, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

const execFileAsync = promisify(execFile);
const evidenceDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
const workloadMarkers = new Map<string, string[]>();

async function publishMarker(repository: CauceRepository, tenant: FunctionalTenant, suffix: string): Promise<string> {
  const marker = `OVERVIEW-${tenant.tenant}-${suffix}-${randomUUID()}`;
  await repository.publish({
    version: '3.0', request_id: randomUUID(), trace_id: `overview-${randomUUID()}`,
    tenant_id: tenant.tenant, room_id: tenant.room, actor_alias: tenant.operator,
    recipients: [{ tenant_id: tenant.tenant, alias: tenant.target }],
    body: { text: marker }, idempotency_key: randomUUID(), lane: 'interactive', priority: 0,
  });
  workloadMarkers.set(tenant.tenant, [...(workloadMarkers.get(tenant.tenant) ?? []), marker]);
  return marker;
}

async function seedWorkload(): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  const database = fixture.database;
  const repository = new CauceRepository(database.pool);
  for (const tenant of [isaTenant, jhonTenant]) {
    await database.pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role)
       VALUES($1,$2,$3,'agent') ON CONFLICT(tenant_id,room_id,alias) DO NOTHING`,
      [tenant.tenant, tenant.room, tenant.target],
    );
  }

  await publishMarker(repository, isaTenant, 'dead');
  const instanceId = `overview-${randomUUID()}`;
  const lease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, instanceId, [], 120_000);
  if (!lease.acquired || lease.epoch === undefined) throw new Error('own fixture lease was not acquired');
  const [failed] = await repository.claimDeliveries(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, 1);
  if (!failed) throw new Error('the own fixture failure delivery was not claimed');
  const failedAck = await repository.ackDelivery(failed.delivery_id, isaTenant.tenant, isaTenant.target, {
    version: '3.0', status: 'failed', instance_id: instanceId, epoch: lease.epoch,
    event_id: randomUUID(), claim_token: failed.claim_token, attempt: failed.attempt,
    retryable: false, error: 'E2E fixture terminal failure',
  });
  if (!failedAck.applied || failedAck.status !== 'failed') throw new Error('the fixture failure ACK was not applied');

  await publishMarker(repository, isaTenant, 'started');
  const [started] = await repository.claimDeliveries(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, 1);
  if (!started) throw new Error('the own fixture in-flight delivery was not claimed');
  const startedAck = await repository.ackDelivery(started.delivery_id, isaTenant.tenant, isaTenant.target, {
    version: '3.0', status: 'started', instance_id: instanceId, epoch: lease.epoch,
    event_id: randomUUID(), claim_token: started.claim_token, attempt: started.attempt,
    retryable: false,
  });
  if (!startedAck.applied || startedAck.status !== 'started') throw new Error('the fixture started ACK was not applied');
  await publishMarker(repository, isaTenant, 'pending');
  await publishMarker(repository, jhonTenant, 'pending');
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.CAUCE_TEST_DOCKER_NETWORK
      || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER) {
    throw new Error('este E2E requiere recursos Testcontainers propios, sin base/red externa');
  }
  fixture = await startConsoleFunctionalFixture();
  process.stdout.write(`overview roles owned resources: postgres=${fixture.database.container.getId()} browser=${fixture.browserContainer} image=${fixture.browserRuntime.imageId}\n`);
  const readerPassword = randomBytes(24).toString('base64url');
  await execFileAsync(`${process.cwd()}/node_modules/.bin/tsx`, [
    'services/gateway/src/console-user-cli.ts', '--email', 'overview-reader@cauce.test',
    '--name', 'Overview E2E reader', '--role', 'reader', '--tenant', jhonTenant.tenant,
    '--alias', jhonTenant.operator,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test',
      DATABASE_URL: fixture.database.url, CAUCE_CONSOLE_USER_PASSWORD: readerPassword,
    },
    timeout: 15_000,
  }).then(({ stdout }) => {
    if (!stdout.includes('cuenta guardada') || stdout.includes(readerPassword)) {
      throw new Error('la CLI no confirmó el alta del lector sin filtrar su contraseña');
    }
    reader.password = readerPassword;
  });
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

const reader: FunctionalTenant = { ...jhonTenant, email: 'overview-reader@cauce.test', password: '' };

async function signIn(page: BrowserPage, user: FunctionalTenant): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

async function overviewReads(page: BrowserPage) {
  return page.evaluate(async () => {
    const read = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(path, { credentials: 'include' });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const [status, queues, activity, access, session] = await Promise.all([
      read('/v3/status'), read('/v3/console/queues'), read('/v3/console/activity'),
      read('/v3/console/access'), read('/v3/auth/session'),
    ]);
    return { status, queues, activity, access, session };
  });
}

async function expectMetric(page: BrowserPage, label: string, value: unknown): Promise<void> {
  const card = page.locator('article[data-tone], [aria-label="Filtrar por estado"] button').filter({ hasText: label });
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await expect.poll(async () => card.locator('strong').innerText(), { timeout: 20_000 }).toBe(String(value));
}

async function openSignals(page: BrowserPage): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  await page.goto(`${fixture.baseUrl}/observability`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Señales y auditoría', exact: true }).waitFor({ timeout: 20_000 });
}

async function expectAgentMetrics(page: BrowserPage, tenant: FunctionalTenant, inFlight: unknown, queued: unknown): Promise<void> {
  if (!fixture) throw new Error('fixture not initialized');
  await page.goto(`${fixture.baseUrl}/live?agente=${encodeURIComponent(`${tenant.tenant}/${tenant.target}`)}`, { waitUntil: 'domcontentloaded' });
  const detail = page.getByRole('dialog', { name: tenant.target, exact: true });
  await detail.waitFor({ state: 'visible', timeout: 20_000 });
  for (const [label, value] of [['En vuelo', inFlight], ['En cola', queued]] as const) {
    await expect.poll(async () => detail.getByText(label, { exact: true }).locator('..').locator('dd').innerText(), { timeout: 20_000 }).toBe(String(value));
  }
  await detail.getByRole('button', { name: 'Cerrar el detalle', exact: true }).click();
}

async function openQueues(page: BrowserPage, mobile: boolean): Promise<void> {
  await page.getByRole('button', { name: mobile ? 'Más' : 'Gestión', exact: true }).click();
  const tools = mobile ? page.getByRole('dialog', { name: 'Gestión', exact: true }) : page.getByRole('navigation', { name: 'Navegación principal', exact: true });
  await tools.getByRole('link', { name: 'Colas y DLQ', exact: true }).click();
  await page.getByRole('heading', { name: 'Colas y DLQ operativo' }).waitFor({ timeout: 20_000 });
}

describe('overview de consola con roles reales y aislamiento por tenant', () => {
  it('reconcilia indicadores con PostgreSQL, navega en escritorio y mantiene lecturas seguras en móvil', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const active = fixture;
    const operatorPage = await newTrustedPage(active, { width: 1440, height: 1000 });
    await signIn(operatorPage, isaTenant);
    await openSignals(operatorPage);

    const baseline = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM deliveries',
    );
    expect(baseline.rows[0]?.count).toBe('0');
    await expectMetric(operatorPage, 'En línea', 0);
    await expectAgentMetrics(operatorPage, isaTenant, 0, 0);
    await openQueues(operatorPage, false);
    await expectMetric(operatorPage, 'Dead letters', 0);
    await seedWorkload();

    const reads = await overviewReads(operatorPage);
    expect(reads.status.status).toBe(200);
    expect(reads.queues.status).toBe(200);
    expect(reads.activity.status).toBe(200);
    const status = reads.status.body as { online?: number };
    const queues = reads.queues.body as { dead?: number; totals?: { pending?: number; dead?: number } };
    const activity = reads.activity.body as { totals?: { in_flight?: number; queued?: number } };
    const pgDeliveries = await active.database.pool.query<{ pending: string; dead: string; in_flight: string; queued: string }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started'))::text AS pending,
              count(*) FILTER (WHERE d.status IN ('dead','failed'))::text AS dead,
              count(*) FILTER (WHERE d.status IN ('leased','accepted','started'))::text AS in_flight,
              count(*) FILTER (WHERE d.status IN ('pending','retry'))::text AS queued
         FROM deliveries d JOIN messages m ON m.id=d.message_id
        WHERE d.recipient_tenant=$1 AND EXISTS (
          SELECT 1 FROM memberships source_member
           WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
             AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1
        )`, [isaTenant.tenant, isaTenant.operator],
    );
    expect(pgDeliveries.rows[0]).toMatchObject({ pending: '2', dead: '1', in_flight: '1', queued: '1' });
    expect(queues.dead).toBe(Number(pgDeliveries.rows[0]?.dead));
    expect(queues.totals?.pending).toBe(Number(pgDeliveries.rows[0]?.pending));
    expect(activity.totals?.in_flight).toBe(Number(pgDeliveries.rows[0]?.in_flight));
    expect(activity.totals?.queued).toBe(Number(pgDeliveries.rows[0]?.queued));
    const pgOnline = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM connection_leases WHERE tenant_id=$1 AND lease_until>now()',
      [isaTenant.tenant],
    );
    expect(status.online).toBe(Number(pgOnline.rows[0]?.count));
    expect(status.online).toBe(1);
    const foreignWork = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias<>$2',
      [isaTenant.tenant, isaTenant.target],
    );
    expect(foreignWork.rows[0]?.count).toBe('0');
    await openSignals(operatorPage);
    await expectMetric(operatorPage, 'En línea', status.online);
    await expectAgentMetrics(operatorPage, isaTenant, activity.totals?.in_flight, activity.totals?.queued);
    await openQueues(operatorPage, false);
    await expectMetric(operatorPage, 'Dead letters', queues.dead);
    const operatorOverviewBody = await operatorPage.locator('body').innerText();
    expect(operatorOverviewBody).not.toContain(jhonTenant.target);
    expect(operatorOverviewBody).not.toContain(jhonTenant.marker);
    for (const marker of workloadMarkers.get(jhonTenant.tenant) ?? []) {
      expect(operatorOverviewBody).not.toContain(marker);
    }
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await operatorPage.screenshot({ path: join(evidenceDirectory, 'overview-operator-1440.png') });
    }

    expect(await operatorPage.getByRole('button', { name: /Replay delivery/u }).count()).toBeGreaterThan(0);
    expect(await operatorPage.locator('table tbody tr').count()).toBeGreaterThanOrEqual(3);
    expect(await operatorPage.locator('body').innerText()).toContain(isaTenant.target);
    if (evidenceDirectory) await operatorPage.screenshot({ path: join(evidenceDirectory, 'queues-operator-1440.png') });

    const readerPage = await newTrustedPage(active, { width: 360, height: 800 });
    await signIn(readerPage, reader);
    await openSignals(readerPage);
    const readerReads = await overviewReads(readerPage);
    expect(readerReads.status.status).toBe(200);
    expect(readerReads.queues.status).toBe(200);
    expect(readerReads.activity.status).toBe(200);
    const readerQueue = readerReads.queues.body as { dead?: number; totals?: { pending?: number }; items?: { recipient_alias?: string; state?: string }[] };
    const readerVisiblePg = await active.database.pool.query<{ pending: string; dead: string; visible: string }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started'))::text AS pending,
              count(*) FILTER (WHERE d.status IN ('dead','failed'))::text AS dead,
              count(*)::text AS visible
         FROM deliveries d JOIN messages m ON m.id=d.message_id
        WHERE d.recipient_tenant=$1 AND EXISTS (
          SELECT 1 FROM memberships source_member
           WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
             AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1
        )`, [jhonTenant.tenant, jhonTenant.operator],
    );
    expect(readerVisiblePg.rows[0]).toMatchObject({ pending: '1', dead: '0', visible: '1' });
    expect(readerQueue.totals?.pending).toBe(Number(readerVisiblePg.rows[0]?.pending));
    expect(readerQueue.dead).toBe(Number(readerVisiblePg.rows[0]?.dead));
    expect(readerQueue.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipient_alias: jhonTenant.target, state: 'pending' }),
    ]));
    const access = readerReads.access.body as { permissions?: string[] };
    const session = readerReads.session.body as { authenticated?: boolean; roles?: string[]; permissions?: string[] };
    expect(readerReads.session.status).toBe(200);
    expect(session.authenticated).toBe(true);
    expect(session.roles).toEqual([]);
    expect(session.permissions).toContain('read');
    expect(session.permissions).not.toContain('control');
    expect(session.permissions).not.toContain('route');
    expect(access.permissions).not.toContain('delivery.replay');
    expect(access.permissions).not.toContain('delivery.cancel');
    expect(access.permissions).not.toContain('config.write');
    await expectMetric(readerPage, 'En línea', (readerReads.status.body as { online?: number }).online);
    const readerForeignWork = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias<>$2',
      [jhonTenant.tenant, jhonTenant.target],
    );
    expect(readerForeignWork.rows[0]?.count).toBe('0');
    await expectAgentMetrics(readerPage, reader, 0, (readerReads.activity.body as { totals?: { queued?: number } }).totals?.queued);
    await openQueues(readerPage, true);
    await expectMetric(readerPage, 'Dead letters', 0);
    const readerOverviewOverflow = await readerPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(readerOverviewOverflow, 'reader overview horizontal overflow at 360px').toBe(false);
    const readerOverviewBody = await readerPage.locator('body').innerText();
    expect(readerOverviewBody).not.toContain(isaTenant.target);
    expect(readerOverviewBody).not.toContain(isaTenant.marker);
    for (const marker of workloadMarkers.get(isaTenant.tenant) ?? []) {
      expect(readerOverviewBody).not.toContain(marker);
    }
    if (evidenceDirectory) await readerPage.screenshot({ path: join(evidenceDirectory, 'overview-reader-360.png') });
    expect(await readerPage.locator('table tbody tr').count()).toBeGreaterThanOrEqual(1);
    expect(await readerPage.locator('body').innerText()).toContain(jhonTenant.target);
    expect(await readerPage.locator('body').innerText()).not.toContain(isaTenant.target);
    for (const marker of workloadMarkers.get(isaTenant.tenant) ?? []) {
      expect(await readerPage.locator('body').innerText()).not.toContain(marker);
    }
    const readerActions = await readerPage.evaluate(() => Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Replay delivery"], button[aria-label^="Cancelar delivery"]'),
    ).map((button) => ({ disabled: button.disabled, label: button.getAttribute('aria-label') })));
    expect(readerActions.length).toBeGreaterThan(0);
    expect(readerActions.every((action) => action.disabled)).toBe(true);

    const foreignProfile = await readerPage.evaluate(async (alias) => {
      const response = await fetch(`/v3/console/agents/${encodeURIComponent(alias)}/perfil`, { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    }, isaTenant.target);
    expect(foreignProfile.status).toBe(404);
    expect(foreignProfile.body).not.toContain(isaTenant.marker);
    expect(await readerPage.locator('body').innerText()).not.toContain(isaTenant.marker);
    if (evidenceDirectory) await readerPage.screenshot({ path: join(evidenceDirectory, 'queues-reader-360.png') });
  }, 180_000);
});
