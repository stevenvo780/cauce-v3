import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserPage } from './console-functional-browser.fixtures.js';
import { startAccountsAssignmentsFixture, type AccountsAssignmentsFixture } from './accounts-assignments-real-browser.fixtures.js';

let fixture: AccountsAssignmentsFixture | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('este E2E exige Testcontainers propios; CAUCE_TEST_DATABASE_URL no se acepta');
  }
  fixture = await startAccountsAssignmentsFixture();
  process.stdout.write(
    `Accounts E2E owned resources: run=${fixture.runId} pg=${fixture.database.container.getId()} `
    + `browser=${fixture.browserContainer} image=${fixture.agentImageId} agent=${fixture.agentContainerId} `
    + `ports=${JSON.stringify(fixture.relayPorts)} scratch=${fixture.directory}\n`,
  );
}, 10 * 60_000);

afterAll(async () => {
  if (!fixture) return;
  const active = fixture;
  await active.close();
  process.stdout.write(
    `Accounts E2E cleanup verified by fixture: run=${active.runId} pg=${active.database.container.getId()} `
    + `browser=${active.browserContainer} image=${active.agentImageId} agent=${active.agentContainerId}\n`,
  );
});

async function loginThroughBrowser(page: BrowserPage, active: AccountsAssignmentsFixture, email: string, password: string) {
  const response = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('link', { name: 'Conversaciones' }).waitFor({ state: 'visible', timeout: 20_000 });
  const cookies = await page.context().cookies(active.baseUrl);
  expect(cookies.some((cookie) => cookie.name === '__Host-cauce_session' && cookie.httpOnly && cookie.secure)).toBe(true);
}

async function openAccountsFromTools(page: BrowserPage) {
  await page.getByRole('button', { name: 'Herramientas' }).click();
  const menu = page.getByRole('region', { name: 'Herramientas de Cauce' });
  await menu.waitFor({ state: 'visible', timeout: 10_000 });
  await menu.getByRole('link', { name: 'Cuentas y cuotas' }).click();
  await page.getByRole('heading', { name: 'Cuentas y cuotas', exact: true }).waitFor({ timeout: 20_000 });
}

async function preview(page: BrowserPage, label: string) {
  const actions = page.getByRole('group', { name: `Acciones de ${label}` });
  await actions.getByRole('button', { name: 'Previsualizar (dry-run)' }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado:' }).waitFor({ timeout: 20_000 });
  return actions;
}

async function apply(page: BrowserPage, actions: ReturnType<BrowserPage['getByRole']>) {
  await actions.getByRole('button', { name: 'Aplicar' }).click();
  await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
}

async function saveScreenshot(page: BrowserPage, name: string) {
  const directory = process.env.CAUCE_E2E_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: false });
}

describe('administración real de cuentas y asignaciones', () => {
  it('previsualiza y aplica en PG, refleja techo/binding en 1440/360 y mantiene scope/locator', async () => {
    if (!fixture) throw new Error('accounts E2E fixture not initialized');
    const active = fixture;
    const run = active.runId.replaceAll('-', '').slice(0, 18);
    const accountId = `e2e-codex-${run}`;
    const externalId = `synthetic-subscription-${active.runId}`;
    const credentialLocator = `CAUCE_E2E_ACCOUNT_${run.toUpperCase()}_PATH`;
    const accountLabel = `Cuenta E2E ${run}`;
    const expectedMutations: { method: string; status: number }[] = [];
    const page = await active.browserPage({ width: 1440, height: 1000 });
    page.on('response', (response) => {
      try {
        if (new URL(response.url()).pathname === '/v3/console/config/changes') {
          expectedMutations.push({ method: response.request().method(), status: response.status() });
        }
      } catch { /* Ignore non-URL browser responses. */ }
    });
    await loginThroughBrowser(page, active, active.operatorEmail, active.operatorPassword);
    await openAccountsFromTools(page);
    await page.getByRole('tab', { name: 'Inventario' }).click();
    await page.getByLabel('Id de cuenta').fill(accountId);
    await page.getByRole('textbox', { name: /^Proveedor codex, gemini/u }).fill('codex');
    await page.getByLabel('Id externo de la suscripción').fill(externalId);
    await page.getByLabel('Tenant pagador').fill('Steven');
    await page.getByLabel('Etiqueta').fill(accountLabel);
    await page.getByLabel('Locator de la credencial').fill(credentialLocator);
    await page.getByLabel('Habilitada').click();
    await saveScreenshot(page, 'accounts-inventory-1440.png');

    const accountActions = await preview(page, 'alta de cuenta');
    const previewText = await page.getByLabel('Dry-run de alta de cuenta').innerText();
    const accountPreview = JSON.parse(previewText) as {
      mutation: { value: Record<string, unknown> }; inverse_mutation: Record<string, unknown>;
    };
    expect(accountPreview.mutation.value).not.toHaveProperty('credential_ref');
    expect(accountPreview.inverse_mutation).not.toHaveProperty('value.credential_ref');
    expect(previewText).not.toMatch(/"credential_ref"\s*:/u);
    expect(previewText).not.toContain(credentialLocator);
    await apply(page, accountActions);

    const account = await active.database.pool.query<{
      id: string; provider: string; external_account_id: string; payer_tenant_id: string;
      credential_ref: string; shared_with_pool: boolean; enabled: boolean;
    }>(
      `SELECT id,provider,external_account_id,payer_tenant_id,credential_ref,shared_with_pool,enabled
       FROM provider_accounts WHERE id=$1`, [accountId],
    );
    expect(account.rows).toEqual([{
      id: accountId, provider: 'codex', external_account_id: externalId, payer_tenant_id: 'Steven',
      credential_ref: credentialLocator, shared_with_pool: false, enabled: true,
    }]);

    const accountRevision = await active.database.pool.query<{
      id: string; operation: { resource?: string; id?: string; value?: Record<string, unknown> };
      inverse_operation: Record<string, unknown>;
    }>(
      `SELECT id::text,operation,inverse_operation FROM config_revisions
       WHERE actor_tenant=$1 AND actor_alias=$2 AND operation->>'resource'='provider_account'
         AND operation->>'id'=$3 ORDER BY id DESC LIMIT 1`,
      [active.tenant, active.operatorAlias, accountId],
    );
    expect(accountRevision.rows).toHaveLength(1);
    const durableRevision = accountRevision.rows[0];
    expect(durableRevision?.operation.value?.credential_ref).toBe(credentialLocator);
    expect(durableRevision?.inverse_operation).toEqual({ resource: 'provider_account', action: 'delete', id: accountId });
    const revisionId = durableRevision?.id;
    expect(revisionId).toBeDefined();
    const accountAudit = await active.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE tenant_id=$1 AND actor_alias=$2 AND action='config.change'
         AND metadata->>'revision'=$3 AND metadata->'mutation'->>'id'=$4`,
      [active.tenant, active.operatorAlias, revisionId, accountId],
    );
    expect(accountAudit.rows[0]?.count).toBe('1');

    const operatorSession = await active.login();
    const operatorHeaders = {
      origin: new URL(active.baseUrl).origin,
      cookie: operatorSession.cookie,
      'x-csrf-token': operatorSession.csrf,
    };
    const deletion = await active.request('/v3/console/config/changes', {
      method: 'POST', headers: operatorHeaders,
      body: {
        dry_run: false,
        mutation: { resource: 'provider_account', action: 'delete', id: accountId },
      },
    });
    expect(deletion.status).toBe(201);
    const deletionReceipt = JSON.parse(deletion.body) as {
      applied?: boolean; dry_run?: boolean; revision?: number; rolled_back_revision_id?: number | null;
    };
    expect(deletionReceipt).toMatchObject({ applied: true, dry_run: false, rolled_back_revision_id: null });
    expect(Number.isSafeInteger(deletionReceipt.revision)).toBe(true);
    const deletionRevision = deletionReceipt.revision;
    expect(deletionRevision).toBeDefined();
    const savedInverse = await active.database.pool.query<{ inverse_operation: { value?: Record<string, unknown> } }>(
      'SELECT inverse_operation FROM config_revisions WHERE id=$1', [deletionRevision],
    );
    expect(savedInverse.rows[0]?.inverse_operation.value?.credential_ref).toBe(credentialLocator);
    const removedAccount = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM provider_accounts WHERE id=$1', [accountId],
    );
    expect(removedAccount.rows[0]?.count).toBe('0');

    const rollback = await active.request(`/v3/console/config/revisions/${String(deletionRevision)}/rollback`, {
      method: 'POST', headers: operatorHeaders, body: { dry_run: false },
    });
    expect(rollback.status).toBe(201);
    expect(JSON.parse(rollback.body)).toMatchObject({
      applied: true, dry_run: false, rolled_back_revision_id: deletionRevision,
    });
    const restoredAccount = await active.database.pool.query<{ credential_ref: string; label: string }>(
      'SELECT credential_ref,label FROM provider_accounts WHERE id=$1', [accountId],
    );
    expect(restoredAccount.rows).toEqual([{ credential_ref: credentialLocator, label: accountLabel }]);
    const rollbackAudit = await active.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE tenant_id=$1 AND actor_alias=$2 AND action='config.rollback'
         AND metadata->>'rolled_back_revision'=$3`,
      [active.tenant, active.operatorAlias, String(deletionRevision)],
    );
    expect(rollbackAudit.rows[0]?.count).toBe('1');

    await page.getByRole('button', { name: 'Actualizar' }).click();
    await page.getByRole('row', { name: new RegExp(accountId, 'u') }).waitFor({ state: 'visible', timeout: 20_000 });
    const operatorSnapshot = await active.request('/v3/console/config', {
      headers: { cookie: operatorSession.cookie, accept: 'application/json' },
    });
    expect(operatorSnapshot.status).toBe(200);
    expect(operatorSnapshot.body).toContain(accountId);
    const operatorConfig = JSON.parse(operatorSnapshot.body) as { provider_accounts?: Record<string, unknown>[] };
    const createdAccountProjection = operatorConfig.provider_accounts?.find((row) => row.id === accountId);
    expect(createdAccountProjection).toBeDefined();
    expect(createdAccountProjection && Object.hasOwn(createdAccountProjection, 'credential_ref')).toBe(false);
    expect(operatorSnapshot.body).not.toContain(credentialLocator);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('tab', { name: 'Asignaciones' }).click();
    await page.getByRole('combobox', { name: /^Agente/u }).selectOption(`${active.tenant}/${active.targetAlias}`);
    await page.getByRole('combobox', { name: /^Cuenta/u }).selectOption(accountId);
    const ceilingActions = await preview(page, 'asignación');
    await apply(page, ceilingActions);
    const ceiling = await active.database.pool.query<{ tenant_id: string; alias: string; account_id: string; account_payer_tenant: string }>(
      `SELECT tenant_id,alias,account_id,account_payer_tenant FROM alias_routing_ceiling
       WHERE tenant_id=$1 AND alias=$2 AND account_id=$3`,
      [active.tenant, active.targetAlias, accountId],
    );
    expect(ceiling.rows).toEqual([{
      tenant_id: active.tenant, alias: active.targetAlias, account_id: accountId, account_payer_tenant: active.tenant,
    }]);

    await page.getByLabel('Operación').selectOption('create-binding');
    await page.getByLabel('Prioridad').fill('7');
    const bindingActions = await preview(page, 'asignación');
    await apply(page, bindingActions);
    const binding = await active.database.pool.query<{ tenant_id: string; agent_alias: string; account_id: string; priority: number; enabled: boolean }>(
      `SELECT tenant_id,agent_alias,account_id,priority,enabled FROM agent_account_bindings
       WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3`,
      [active.tenant, active.targetAlias, accountId],
    );
    expect(binding.rows).toEqual([{
      tenant_id: active.tenant, agent_alias: active.targetAlias, account_id: accountId, priority: 7, enabled: true,
    }]);
    await page.getByRole('button', { name: 'Actualizar' }).click();
    await page.getByRole('button', { name: new RegExp(`${active.tenant}/${active.targetAlias} × ${accountId}`, 'u') })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await saveScreenshot(page, 'accounts-assignments-360.png');

    const assignmentRevisions = await active.database.pool.query<{ id: string; resource: string }>(
      `SELECT id::text,operation->>'resource' AS resource FROM config_revisions
       WHERE actor_tenant=$1 AND actor_alias=$2
         AND operation->>'resource' IN ('alias_routing_ceiling','agent_account_binding')
         AND operation->>'account_id'=$3 ORDER BY id`,
      [active.tenant, active.operatorAlias, accountId],
    );
    expect(assignmentRevisions.rows.map((row) => row.resource)).toEqual([
      'alias_routing_ceiling', 'agent_account_binding',
    ]);
    const auditCount = await active.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE tenant_id=$1 AND actor_alias=$2 AND action='config.change'
         AND metadata->>'revision'=ANY($3::text[])`,
      [active.tenant, active.operatorAlias, assignmentRevisions.rows.map((row) => row.id)],
    );
    expect(auditCount.rows[0]?.count).toBe('2');
    expect(expectedMutations).toEqual([
      { method: 'POST', status: 200 }, { method: 'POST', status: 201 },
      { method: 'POST', status: 200 }, { method: 'POST', status: 201 },
      { method: 'POST', status: 200 }, { method: 'POST', status: 201 },
    ]);
  }, 3 * 60_000);

  it('un lector de otro tenant ve sólo su proyección redacted y no puede aplicar cambios', async () => {
    if (!fixture) throw new Error('accounts E2E fixture not initialized');
    const active = fixture;
    const page = await active.browserPage({ width: 360, height: 800 });
    await loginThroughBrowser(page, active, active.readerEmail, active.readerPassword);
    await openAccountsFromTools(page);
    await page.getByRole('tab', { name: 'Inventario' }).click();
    await page.getByRole('row', { name: new RegExp(active.foreignPoolAccountId, 'u') }).waitFor({ state: 'visible', timeout: 20_000 });
    const body = await page.locator('body').innerText();
    expect(body).toContain('No visible: la paga Jhon');
    expect(body).not.toContain(active.foreignExternalMarker);
    expect(body).not.toContain(active.foreignCredentialLocator);

    const session = await active.loginReader();
    const snapshot = await active.request('/v3/console/config', {
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toContain(active.foreignPoolAccountId);
    expect(snapshot.body).not.toContain(active.foreignPrivateAccountId);
    const readerConfig = JSON.parse(snapshot.body) as { provider_accounts?: Record<string, unknown>[] };
    const sharedAccountProjection = readerConfig.provider_accounts?.find((row) => row.id === active.foreignPoolAccountId);
    expect(sharedAccountProjection).toMatchObject({ external_account_id: null, credential_ref_kind: null });
    expect(sharedAccountProjection && Object.hasOwn(sharedAccountProjection, 'credential_ref')).toBe(false);
    expect(snapshot.body).not.toContain(active.foreignExternalMarker);
    expect(snapshot.body).not.toContain(active.foreignCredentialLocator);

    const beforeDeniedWrite = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM provider_accounts WHERE id=$1', [active.foreignPrivateAccountId],
    );
    expect(beforeDeniedWrite.rows[0]?.count).toBe('1');
    const denial = await active.request('/v3/console/config/changes', {
      method: 'POST',
      headers: {
        origin: new URL(active.baseUrl).origin,
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      body: {
        dry_run: false,
        mutation: {
          resource: 'provider_account', action: 'delete', id: active.foreignPrivateAccountId,
        },
      },
    });
    expect(denial.status).toBe(403);
    const afterDeniedWrite = await active.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM provider_accounts WHERE id=$1', [active.foreignPrivateAccountId],
    );
    expect(afterDeniedWrite.rows).toEqual([{ count: '1' }]);
    const blockedButtons = await page.evaluate(() => Array.from(
      document.querySelectorAll('[aria-label="Acciones de alta de cuenta"] button'),
    ).map((button) => (button as HTMLButtonElement).disabled));
    expect(blockedButtons).toEqual([true, true]);
  }, 2 * 60_000);
});
