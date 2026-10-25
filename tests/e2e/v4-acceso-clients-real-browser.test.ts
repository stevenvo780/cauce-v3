import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOAuthStore } from '../../services/gateway/src/oauth-authorization-store.js';
import { secretHash, type OAuthPasswordSession } from '../../services/gateway/src/oauth-authorization-types.js';
import type { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerClientDelegationRoutes } from '../../services/gateway/src/routes/mcp-client-delegations.js';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, asV4Page, login, type V4Page } from './v4-console-real-browser.helpers.js';
import { plazo } from '../helpers/plazos.js';

const issuer = 'https://cauce-access.example.invalid';
const resource = `${issuer}/mcp`;
const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-commit-1025/clients');
const path = '/v3/console/mcp/client-delegations';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let auth: PasswordAuthProvider | undefined;
let page: V4Page | undefined;
let ownerId = '';
let grantId = '';
let dropMutationResponse = false;

function active() {
  if (!fixture || !page || !auth) throw new Error('client connections fixture unavailable');
  return { fixture, page, auth };
}

async function openConnections() {
  const { page } = active();
  if (!(await page.getByRole('button', { name: 'Conexiones MCP', exact: true }).isVisible())) {
    const account = page.getByRole('button', { name: 'Cuenta de Isa E2E operator', exact: true });
    if (!(await account.isVisible()) && (page.viewportSize()?.width ?? 1440) < 768) {
      await page.getByRole('button', { name: 'Más', exact: true }).click();
    }
    await account.waitFor({ timeout: 30_000 });
    if (!(await page.getByRole('heading', { name: 'Cuenta y apariencia', exact: true }).isVisible())) await account.click();
  }
  const trigger = page.getByRole('button', { name: 'Conexiones MCP', exact: true });
  const region = page.getByRole('region', { name: 'Declaraciones de cliente', exact: true });
  if (!(await region.isVisible())) await trigger.click();
  await region.waitFor({ timeout: 20_000 });
  return region;
}

async function capture(name: string, responsive = true) {
  const { page } = active();
  const referenceField = page.getByLabel('connection_ref verificada', { exact: true });
  const reference = await referenceField.isVisible() ? await referenceField.inputValue() : undefined;
  const labelField = page.getByLabel('Etiqueta declarada', { exact: true });
  const label = await labelField.isVisible() ? await labelField.inputValue() : undefined;
  for (const [variant, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    if (!responsive && variant === 'mobile') continue;
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }))));
    const panel = await openConnections();
    if (reference !== undefined) {
      await panel.getByLabel('connection_ref verificada', { exact: true }).waitFor();
      const field = panel.getByLabel('connection_ref verificada', { exact: true });
      if (await field.inputValue() !== reference) await field.fill(reference);
    }
    if (label !== undefined && await labelField.isVisible() && await labelField.inputValue() !== label) await labelField.fill(label);
    await page.screenshot({ path: join(receipts, `${name}-${variant}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }))));
  const panel = await openConnections();
  if (reference !== undefined) {
    await panel.getByLabel('connection_ref verificada', { exact: true }).waitFor();
    const field = panel.getByLabel('connection_ref verificada', { exact: true });
    if (await field.inputValue() !== reference) await field.fill(reference);
  }
  if (label !== undefined && await labelField.isVisible() && await labelField.inputValue() !== label) await labelField.fill(label);
}

async function connections() {
  const result = await apiGet(active().page, path);
  expect(result.status).toBe(200);
  const body = result.body as { items: { connection_ref: string; label: string | null; binding_id: string | null; revoked: boolean }[]; truncated: boolean };
  return body;
}

async function consent() {
  const { page, fixture, auth } = active();
  const cookie = (await page.context().cookies()).find(item => item.name === auth.cookieName);
  if (!cookie) throw new Error('ephemeral browser session missing');
  const payload = cookie.value.split('.')[1];
  if (!payload) throw new Error('ephemeral browser session invalid');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub: string; credential_stamp: string; csrf: string; iat: number; exp: number;
  };
  ownerId = claims.sub;
  const session: OAuthPasswordSession = { userId: ownerId, credentialStamp: claims.credential_stamp,
    csrf: claims.csrf, issuedAt: claims.iat, expiresAt: claims.exp };
  const store = new PostgresOAuthStore(fixture.database.pool, issuer, auth.verifyCredentialStamp.bind(auth));
  const request = { idHash: secretHash(randomUUID()), browserHash: secretHash(randomUUID()),
    clientId: 'https://client.example.invalid/metadata', clientName: 'zz-canary-e2e-a1-acceso-1025b',
    redirectUri: 'https://client.example.invalid/callback', resource, scopes: ['cauce.read'] as const,
    challenge: 'x'.repeat(43), state: 'synthetic-access' };
  const context = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
  await store.createRequest(request, context());
  const result = await store.consent(request.idHash, request.browserHash, session, request.scopes, context());
  expect(typeof result.code).toBe('string');
  const grant = await fixture.database.pool.query<{ id: string }>(
    'SELECT id FROM cauce_oauth_grants WHERE human_id=$1 AND issuer=$2 ORDER BY created_at DESC LIMIT 1', [ownerId, issuer]);
  grantId = grant.rows[0]?.id ?? '';
  expect(grantId).not.toBe('');
}

describe('acceso: conexiones de clientes con navegador y PostgreSQL reales', () => {
  beforeAll(async () => {
    await mkdir(receipts, { recursive: true });
    fixture = await startConsoleFunctionalFixture({ configureGateway(app, database, provider) {
      auth = provider;
      registerClientDelegationRoutes(app, database.pool, provider,
        { issuer, resource, verifyCredentialStamp: provider.verifyCredentialStamp.bind(provider) });
      app.addHook('onSend', async (request, reply, payload) => {
        if (dropMutationResponse && request.method === 'POST' && request.url === path && reply.statusCode === 200) {
          dropMutationResponse = false;
          reply.raw.destroy();
        }
        return payload;
      });
    } });
    page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
    await login(page, fixture.baseUrl, { ...isaTenant, name: 'Isa E2E operator', company: { name: 'Isa', slug: 'Isa' } });
  }, plazo(180_000));

  afterAll(async () => { await fixture?.close(); }, plazo(90_000));

  it('abre, recarga y cierra el inventario vacío sin atribuir un cliente vivo', async () => {
    const panel = await openConnections();
    await panel.getByText('No hay conexiones visibles para esta cuenta.', { exact: true }).waitFor();
    expect(await connections()).toEqual({ items: [], truncated: false });
    expect(await panel.innerText()).toContain('No prueba que Dots u otro cliente esté conectado ahora');
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('No hay conexiones visibles para esta cuenta.', { exact: true }).waitFor();
    await capture('empty');
    await active().page.getByRole('heading', { name: 'Declaraciones de cliente', exact: true }).press('Escape');
    expect(await panel.isVisible()).toBe(false);
  });

  it('anuncia la consulta pendiente, bloquea controles y recupera un error real de PostgreSQL', async () => {
    const { fixture, page } = active();
    const panel = await openConnections();
    const blocker = await fixture.database.adminPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE cauce_oauth_grants IN ACCESS EXCLUSIVE MODE');
      await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
      await panel.getByText('Consultando al servidor…', { exact: true }).waitFor();
      expect(await panel.evaluate(element => element.getAttribute('aria-busy'))).toBe('true');
      expect(await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).isDisabled()).toBe(true);
      await page.screenshot({ path: join(receipts, 'loading-desktop.png') });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await panel.getByText('No hay conexiones visibles para esta cuenta.', { exact: true }).waitFor();
    await fixture.database.adminPool.query('ALTER TABLE cauce_oauth_grants RENAME TO zz_canary_access_grants_unavailable');
    try {
      await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
      await panel.getByRole('alert').waitFor();
      expect(await panel.getByLabel('connection_ref verificada', { exact: true }).count()).toBe(0);
      await page.screenshot({ path: join(receipts, 'server-error-desktop.png') });
    } finally {
      await fixture.database.adminPool.query('ALTER TABLE zz_canary_access_grants_unavailable RENAME TO cauce_oauth_grants');
    }
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('No hay conexiones visibles para esta cuenta.', { exact: true }).waitFor();
    expect(await panel.getByRole('alert').count()).toBe(0);
    expect(await connections()).toEqual({ items: [], truncated: false });
    await capture('server-recovered');
  });

  it('verifica la referencia exacta y valida la etiqueta antes de crear la declaración durable', async () => {
    await consent();
    const panel = await openConnections();
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('Grant vigente según expiración', { exact: true }).waitFor();
    const reference = (await connections()).items[0]?.connection_ref;
    if (!reference) throw new Error('real OAuth grant missing from browser inventory');
    await panel.getByLabel('connection_ref verificada', { exact: true }).fill('invalid');
    expect(await panel.getByRole('alert').innerText()).toContain('64 caracteres');
    await panel.getByLabel('connection_ref verificada', { exact: true }).fill('0'.repeat(64));
    expect(await panel.getByRole('alert').innerText()).toContain('no se encontró');
    await panel.getByLabel('connection_ref verificada', { exact: true }).fill(reference);
    await panel.getByLabel('Etiqueta declarada', { exact: true }).fill(' inválida ');
    await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).click();
    expect(await panel.getByRole('alert').innerText()).toContain('ASCII');
    expect((await active().fixture.database.pool.query('SELECT 1 FROM human_oauth_client_delegations')).rowCount).toBe(0);
    await capture('validation', false);
    await panel.getByLabel('Etiqueta declarada', { exact: true }).fill('Dots QA');
    const blocker = await active().fixture.database.adminPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM cauce_oauth_grants WHERE id=$1 FOR UPDATE', [grantId]);
      await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).click();
      await panel.getByText('Consultando al servidor…', { exact: true }).waitFor();
      expect(await panel.getByLabel('connection_ref verificada', { exact: true }).isDisabled()).toBe(true);
      expect(await panel.getByRole('button', { name: 'Reintentar mismo intento', exact: true }).isDisabled()).toBe(true);
      expect(await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).isDisabled()).toBe(true);
      await active().page.screenshot({ path: join(receipts, 'saving-desktop.png') });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await panel.getByText('Dots QA por cuenta de Isa E2E operator', { exact: true }).waitFor();
    expect((await connections()).items[0]).toMatchObject({ label: 'Dots QA', revoked: false });
    const stored = await active().fixture.database.pool.query<{ label: string; human_id: string }>(
      'SELECT label,human_id FROM human_oauth_client_delegations WHERE local_oauth_grant_id=$1 AND revoked_at IS NULL', [grantId]);
    expect(stored.rows).toEqual([{ label: 'Dots QA', human_id: ownerId }]);
    await capture('created');
  });

  it('renombra y quita la declaración conservando el grant OAuth y la evidencia anterior', async () => {
    const panel = await openConnections();
    const { page, fixture } = active();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await openConnections();
    await reloaded.getByText('Dots QA por cuenta de Isa E2E operator', { exact: true }).waitFor();
    await reloaded.getByRole('radio').check();
    await reloaded.getByLabel('Etiqueta declarada', { exact: true }).fill('Dots QA 2');
    await reloaded.getByRole('button', { name: 'Renombrar declaración', exact: true }).click();
    await reloaded.getByText('Dots QA 2 por cuenta de Isa E2E operator', { exact: true }).waitFor();
    expect((await connections()).items[0]?.label).toBe('Dots QA 2');
    await capture('renamed');
    await reloaded.getByRole('button', { name: 'Quitar declaración', exact: true }).click();
    await reloaded.getByText('Sin declaración', { exact: true }).waitFor();
    expect((await connections()).items[0]).toMatchObject({ label: null, binding_id: null, revoked: false });
    expect((await fixture.database.pool.query('SELECT 1 FROM cauce_oauth_grants WHERE id=$1', [grantId])).rowCount).toBe(1);
    expect((await fixture.database.pool.query('SELECT 1 FROM cauce_oauth_grant_revocations WHERE grant_id=$1', [grantId])).rowCount).toBe(0);
    expect((await fixture.database.pool.query('SELECT 1 FROM human_oauth_client_delegations WHERE local_oauth_grant_id=$1 AND revoked_at IS NOT NULL', [grantId])).rowCount).toBe(2);
    expect((await fixture.database.pool.query('SELECT 1 FROM human_client_delegation_operations WHERE human_id=$1', [ownerId])).rowCount).toBe(3);
    await capture('removed');
    expect(await panel.count()).toBe(1);
  });

  it('rechaza una declaración concurrente, exige releer y permite recuperar el formulario', async () => {
    const { page, fixture } = active();
    const panel = await openConnections();
    await panel.getByRole('radio').check();
    await panel.getByLabel('Etiqueta declarada', { exact: true }).fill('Original');
    await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).click();
    await panel.getByText('Original por cuenta de Isa E2E operator', { exact: true }).waitFor();
    const other = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
    await login(other, fixture.baseUrl, { ...isaTenant, name: 'Isa E2E operator', company: { name: 'Isa', slug: 'Isa' } });
    await other.getByRole('button', { name: 'Cuenta de Isa E2E operator', exact: true }).click();
    await other.getByRole('button', { name: 'Conexiones MCP', exact: true }).click();
    const otherPanel = other.getByRole('region', { name: 'Declaraciones de cliente', exact: true });
    await otherPanel.getByRole('radio').check();
    await otherPanel.getByLabel('Etiqueta declarada', { exact: true }).fill('Concurrent');
    await otherPanel.getByRole('button', { name: 'Renombrar declaración', exact: true }).click();
    await otherPanel.getByText('Concurrent por cuenta de Isa E2E operator', { exact: true }).waitFor();
    await panel.getByLabel('Etiqueta declarada', { exact: true }).fill('Stale');
    await panel.getByRole('button', { name: 'Renombrar declaración', exact: true }).click();
    await panel.getByRole('alert').waitFor();
    expect(await panel.getByRole('alert').innerText()).toContain('La declaración cambió');
    expect((await connections()).items[0]?.label).toBe('Concurrent');
    await capture('conflict', false);
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('Concurrent por cuenta de Isa E2E operator', { exact: true }).waitFor();
    await panel.getByRole('radio').check();
    await panel.getByRole('button', { name: 'Quitar declaración', exact: true }).click();
    await panel.getByText('Sin declaración', { exact: true }).waitFor();
    await other.context().close();
    expect(await page.getByRole('button', { name: 'Guardar declaración', exact: true }).isVisible()).toBe(true);
  });

  it('recupera una respuesta perdida después del commit reintentando el mismo intento sin duplicar efectos', async () => {
    const { fixture, page } = active();
    const panel = await openConnections();
    await panel.getByRole('radio').check();
    await panel.getByLabel('Etiqueta declarada', { exact: true }).fill('Respuesta perdida');
    const operations = () => fixture.database.pool.query<{ request_id: string }>(
      'SELECT request_id FROM human_client_delegation_operations WHERE human_id=$1 ORDER BY created_at', [ownerId]);
    const before = await operations();
    dropMutationResponse = true;
    await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'No se pudo confirmar el resultado.' }).waitFor();
    expect(dropMutationResponse).toBe(false);
    const committed = await operations();
    expect(committed.rowCount).toBe((before.rowCount ?? 0) + 1);
    expect((await connections()).items[0]?.label).toBe('Respuesta perdida');
    expect(await panel.getByLabel('connection_ref verificada', { exact: true }).isDisabled()).toBe(true);
    expect(await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).count()).toBe(0);
    await page.screenshot({ path: join(receipts, 'uncertain-result-desktop.png') });
    await panel.getByRole('button', { name: 'Reintentar mismo intento', exact: true }).click();
    await panel.getByText('Respuesta perdida por cuenta de Isa E2E operator', { exact: true }).waitFor();
    expect((await operations()).rows).toEqual(committed.rows);
    expect((await fixture.database.pool.query('SELECT 1 FROM human_oauth_client_delegations WHERE local_oauth_grant_id=$1 AND revoked_at IS NULL', [grantId])).rowCount).toBe(1);
    await writeFile(join(receipts, 'uncertain-result.json'), JSON.stringify({
      responseDroppedAfterCommit: !dropMutationResponse,
      committedOperations: committed.rowCount, operationsAfterRetry: (await operations()).rowCount,
      requestIdentityPreserved: true, activeDeclarations: 1,
    }, null, 2));
    await capture('uncertain-recovered');
    await panel.getByRole('button', { name: 'Quitar declaración', exact: true }).click();
    await panel.getByText('Sin declaración', { exact: true }).waitFor();
  });

  it('muestra grants revocados y bloquea guardar sin modificar declaraciones', async () => {
    const { fixture } = active();
    await fixture.database.pool.query('INSERT INTO cauce_oauth_grant_revocations(grant_id) VALUES($1)', [grantId]);
    const panel = await openConnections();
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('Grant OAuth revocado', { exact: true }).waitFor();
    await panel.getByRole('radio').check();
    expect(await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).isDisabled()).toBe(true);
    expect((await connections()).items[0]?.revoked).toBe(true);
    expect((await fixture.database.pool.query('SELECT 1 FROM human_oauth_client_delegations WHERE revoked_at IS NULL')).rowCount).toBe(0);
    await capture('grant-revoked');
  });

  it('distingue grants vencidos y listas truncadas sin seleccionar otra referencia', async () => {
    const { fixture } = active();
    const expiredId = randomUUID();
    const columns = 'human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp';
    await fixture.database.pool.query(`INSERT INTO cauce_oauth_grants(id,${columns},created_at,expires_at)
      SELECT $1,${columns},created_at-interval '31 days',expires_at-interval '31 days'
      FROM cauce_oauth_grants WHERE id=$2`, [expiredId, grantId]);
    const panel = await openConnections();
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText('Grant vencido', { exact: true }).waitFor();
    const expiredRef = (await connections()).items.find(item => !item.revoked)?.connection_ref;
    if (!expiredRef) throw new Error('expired fixture grant not visible');
    await panel.getByLabel('connection_ref verificada', { exact: true }).fill(expiredRef);
    expect(await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).isDisabled()).toBe(true);
    await capture('grant-expired');
    await fixture.database.pool.query(`INSERT INTO cauce_oauth_grants(id,${columns},created_at,expires_at)
      SELECT gen_random_uuid(),${columns},created_at+n*interval '1 microsecond',expires_at
      FROM cauce_oauth_grants CROSS JOIN generate_series(1,101) n WHERE id=$1`, [grantId]);
    await panel.getByRole('button', { name: 'Recargar conexiones', exact: true }).click();
    await panel.getByText(/Lista limitada a 100 conexiones/u).waitFor();
    expect((await connections()).items).toHaveLength(100);
    expect((await connections()).truncated).toBe(true);
    await panel.getByLabel('connection_ref verificada', { exact: true }).fill(expiredRef);
    expect(await panel.getByRole('alert').innerText()).toContain('lista truncada');
    expect(await panel.getByRole('button', { name: 'Guardar declaración', exact: true }).count()).toBe(0);
    await capture('truncated');
  });
});
