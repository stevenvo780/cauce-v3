import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentProfileRepository } from '@cauce/store';
import { isaTenant, type startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, type BrowserErrorLog, type V4Page } from './v4-console-real-browser.helpers.js';

interface Checks {
  fixture: () => Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
  platform: () => V4Page;
  owner: () => V4Page;
  email: string;
  ownerEmail: string;
  errors: BrowserErrorLog;
  evidence: string;
}

async function send(page: V4Page, method: string, path: string, payload?: unknown, forged = false) {
  return page.evaluate(async ({ method, path, payload, forged }) => {
    const session = await (await fetch('/v3/auth/session')).json() as { csrf_token: string };
    const response = await fetch(path, {
      method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Cauce-Console': '1',
        'X-CSRF-Token': session.csrf_token,
        ...(forged ? { 'X-Cauce-Role': 'platform_admin', 'X-Cauce-Alias': 'kant',
          'X-Cauce-Tenant': 'Steven', 'X-Cauce-Company': 'humanizar' } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { method, path, payload, forged });
}

const targets = [
  ['GET', '/v3/console/platform/catalog', undefined],
  ['POST', '/v3/console/platform/harnesses', { id: 'muse', display_name: 'Intruso', capabilities: ['messages.receive'], expected_revision: 0 }],
  ['PATCH', '/v3/console/platform/harnesses/muse', { display_name: 'Intruso', expected_revision: 0 }],
  ['DELETE', '/v3/console/platform/harnesses/muse?expected_revision=0', undefined],
  ['POST', '/v3/console/platform/role-policies', { role: 'zz_intruso', allow_control: true, expected_revision: 0 }],
  ['PATCH', '/v3/console/platform/role-policies/operator', { allow_control: false, expected_revision: 0 }],
  ['DELETE', '/v3/console/platform/role-policies/operator?expected_revision=0', undefined],
] as const;

export function catalogAdversarialTests(checks: Checks): void {
  const db = () => checks.fixture().database.pool;
  const platform = checks.platform;
  const revision = async () => (await apiGet(platform(), '/v3/console/platform/catalog')).body.revision;

  it('deniega las siete rutas a owner, admin y persona sin rol aun falsificando autoridad', async () => {
    const before = await db().query(`SELECT to_jsonb(h) AS value FROM harness_definitions h ORDER BY id`);
    const original = (await db().query<{ id: string; company_id: string }>(
      'SELECT id,company_id FROM console_users WHERE email_normalized=$1', [checks.ownerEmail.toLowerCase()])).rows[0];
    if (!original) throw new Error('owner fixture is absent');
    const replacement = (await db().query<{ id: string }>(`INSERT INTO console_users
      (email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      SELECT $2,$2,password_hash,'zz-canary-backup-owner',role,tenant_id,alias FROM console_users WHERE id=$1 RETURNING id`,
    [original.id, `zz-canary-backup-${original.id}@example.test`])).rows[0];
    if (!replacement) throw new Error('replacement owner is absent');
    await db().query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      SELECT $2,tenant_id,actor_alias,permissions FROM human_tenant_memberships WHERE human_id=$1`, [original.id, replacement.id]);
    await db().query("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES($1,$2,'owner','platform',$2)", [original.company_id, replacement.id]);
    try {
      for (const role of ['owner', 'admin', 'none']) {
        if (role === 'admin') await db().query("UPDATE company_admins SET role='admin' WHERE human_id=$1", [original.id]);
        if (role === 'none') await db().query('DELETE FROM company_admins WHERE human_id=$1', [original.id]);
        for (const [method, path, body] of targets) {
          checks.errors.expectHttpError(path.split('?')[0] ?? path, 403);
          const attack = body === undefined ? undefined : { ...body, actor_human_id: replacement.id,
            role: 'platform_admin', company_id: 'humanizar' };
          const response = await send(checks.owner(), method, path, attack, true);
          expect(response.status, `${role} ${method} ${path}: ${JSON.stringify(response.body)}`).toBe(403);
        }
        checks.errors.expectHttpError('/v3/console/platform/harnesses/zz-canary-inexistente', 403);
        expect((await send(checks.owner(), 'PATCH', '/v3/console/platform/harnesses/zz-canary-inexistente',
          { display_name: 'Intruso', expected_revision: 0 }, true)).status).toBe(403);
        const snapshot = await apiGet(checks.owner(), '/v3/console/config');
        expect(snapshot.status).toBe(200);
        expect(JSON.stringify(snapshot.body.revisions)).not.toContain(checks.email);
        const foreign = (await db().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email_normalized=$1', [checks.email.toLowerCase()])).rows[0];
        expect((snapshot.body.tenants as { id: string }[]).some(row => row.id === foreign?.tenant_id)).toBe(false);
        expect((snapshot.body.revisions as { scope: string }[]).some(row => row.scope === 'platform')).toBe(false);
      }
      expect((await db().query('SELECT to_jsonb(h) AS value FROM harness_definitions h ORDER BY id')).rows).toEqual(before.rows);
    } finally {
      await db().query("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES($1,$2,'owner','platform',$2) ON CONFLICT(company_id,human_id) DO UPDATE SET role='owner'", [original.company_id, original.id]);
    }
  });

  it('una máquina con certificado mTLS real recibe 403 en las siete rutas', async () => {
    const fixture = checks.fixture();
    const tls = fixture.pki.adapterCerts[0];
    if (!tls) throw new Error('machine certificate is absent');
    const [cert, key, ca] = await Promise.all([readFile(tls.cert), readFile(tls.key), readFile(fixture.pki.ca.cert)]);
    for (const [method, path, payload] of targets) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(new URL(path, fixture.gatewayUrl), { method, cert, key, ca,
          headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-Cauce-Role': 'platform_admin' } }, response => {
          response.resume(); response.once('end', () => { resolve(response.statusCode ?? 0); });
        });
        req.once('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
      });
      expect(status, `${method} ${path}`).toBe(403);
    }
  });

  it('dos ediciones simultáneas del rol de los operadores dejan un éxito y un CAS vencido', async () => {
    const expected = await revision();
    const blocker = await db().connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(783003004::bigint)');
    const pending = [false, true].map(allow_notify => send(platform(), 'PATCH', '/v3/console/platform/role-policies/operator',
      { allow_notify, expected_revision: expected }));
    try {
      await expect.poll(async () => (await db().query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(%'`)).rows[0]?.count).toBe(2);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    checks.errors.expectHttpError('/v3/console/platform/role-policies/operator', 409);
    const outcomes = await Promise.all(pending);
    expect(outcomes.map(value => value.status).sort()).toEqual([200, 409]);
    const conflict = outcomes.find(value => value.status === 409);
    expect(String(conflict?.body.message)).toContain('Conflicto de revisión');
  });

  it('un fallo real al COMMIT nunca devuelve recibo de éxito ni conserva cambios o auditoría', async () => {
    const before = await db().query("SELECT display_name FROM harness_definitions WHERE id='muse'");
    const expected = await revision();
    await db().query(`CREATE FUNCTION zz_canary_catalog_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.display_name='zz-canary-commit-failure' THEN RAISE EXCEPTION 'zz-canary deferred failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER zz_canary_catalog_commit_failure AFTER UPDATE ON harness_definitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zz_canary_catalog_commit_failure()`);
    try {
      checks.errors.expectHttpError('/v3/console/platform/harnesses/muse', 409);
      const result = await send(platform(), 'PATCH', '/v3/console/platform/harnesses/muse',
        { display_name: 'zz-canary-commit-failure', expected_revision: expected });
      expect(result.status).toBe(409);
      expect(result.body.applied).toBeUndefined();
      expect((await db().query("SELECT display_name FROM harness_definitions WHERE id='muse'")).rows).toEqual(before.rows);
      expect(await revision()).toBe(expected);
      expect((await db().query("SELECT 1 FROM audit_events WHERE metadata::text LIKE '%zz-canary-commit-failure%'")).rowCount).toBe(0);
    } finally {
      await db().query('DROP TRIGGER zz_canary_catalog_commit_failure ON harness_definitions; DROP FUNCTION zz_canary_catalog_commit_failure()');
    }
  });

  it.each(['harness', 'role'] as const)('releer no cambia la revisión base del formulario abierto de %s', async kind => {
    const page = platform();
    const isHarness = kind === 'harness';
    const path = `/v3/console/platform/${isHarness ? 'harnesses/muse' : 'role-policies/agent'}`;
    await page.goto(`${checks.fixture().baseUrl}/config?seccion=${isHarness ? 'arneses' : 'acceso'}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: isHarness ? 'Editar arnés muse' : 'Editar rol agent', exact: true }).click();
    const before = await revision();
    const result = await send(page, 'PATCH', path, isHarness
      ? { display_name: 'zz-canary-concurrent-winner', expected_revision: before }
      : { allow_notify: true, expected_revision: before });
    expect(result.status).toBe(200);
    await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await page.getByRole('button', { name: 'Actualizar', exact: true }).waitFor({ timeout: 10_000 });
    checks.errors.expectHttpError(path, 409);
    await page.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
    await page.getByText(/Conflicto de revisión/).waitFor({ timeout: 10_000 });
    expect(await revision()).toBe(result.body.revision);
    const stored = await db().query<{ value: string | boolean }>(isHarness
      ? "SELECT display_name AS value FROM harness_definitions WHERE id='muse'"
      : "SELECT allow_notify AS value FROM role_policies WHERE role='agent'");
    expect(stored.rows[0]?.value).toBe(isHarness ? 'zz-canary-concurrent-winner' : true);
    await page.screenshot({ path: join(checks.evidence, `cas-${kind}.png`), fullPage: true });
  });

  it('el alta y actualización real del borrador consumen el arnés editado por HTTP', async () => {
    const person = (await db().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM console_users WHERE email_normalized=$1', [checks.email.toLowerCase()])).rows[0];
    if (!person) throw new Error('platform person absent');
    const alias = 'zz-canary-catalog-effect';
    const reader = new AgentProfileRepository(db());
    const changed = await send(platform(), 'PATCH', '/v3/console/platform/harnesses/muse',
      { capabilities: ['messages.receive', 'jobs.batch'], expected_revision: await revision() });
    expect(changed.status).toBe(200);
    const snapshot = await apiGet(platform(), '/v3/console/config');
    const created = await send(platform(), 'POST', '/v3/console/config/changes', {
      dry_run: false, expected_revision: snapshot.body.revision,
      mutation: { resource: 'agent', action: 'create', tenant_id: person.tenant_id, alias,
        value: { harness_id: 'muse', enabled: false, display_name: 'zz-canary-catalog-effect' } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await reader.readContext(person.tenant_id, alias)).hechos.arnes.capacidades).toEqual(['messages.receive', 'jobs.batch']);
    const edited = await send(platform(), 'PATCH', '/v3/console/platform/harnesses/muse',
      { capabilities: ['messages.receive', 'jobs.interactive'], expected_revision: await revision() });
    expect(edited.status).toBe(200);
    const current = await apiGet(platform(), '/v3/console/config');
    const updated = await send(platform(), 'POST', '/v3/console/config/changes', {
      dry_run: false, expected_revision: current.body.revision,
      mutation: { resource: 'agent', action: 'update', tenant_id: person.tenant_id, alias,
        value: { display_name: 'zz-canary-catalog-effect-updated' } },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(201);
    expect((await reader.readContext(person.tenant_id, alias)).hechos.arnes.capacidades).toEqual(['messages.receive', 'jobs.interactive']);
    expect((await db().query<{ harness_id: string; display_name: string }>(
      'SELECT harness_id,display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [person.tenant_id, alias])).rows)
      .toEqual([{ harness_id: 'muse', display_name: 'zz-canary-catalog-effect-updated' }]);
  });

  it('la política web cambia permisos efectivos y su borrado en uso responde un conflicto claro', async () => {
    const role = 'zz_canary_effect';
    const path = `/v3/console/platform/role-policies/${role}`;
    const created = await send(platform(), 'POST', '/v3/console/platform/role-policies',
      { role, allow_read: true, expected_revision: await revision() });
    expect(created.status).toBe(201);
    await db().query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,$4)',
      [isaTenant.tenant, isaTenant.room, isaTenant.target, role]);
    const reader = new AgentProfileRepository(db());
    try {
      expect((await reader.readContext(isaTenant.tenant, isaTenant.target)).hechos.permisos)
        .toMatchObject({ lectura: true, ruta: false });
      expect((await send(platform(), 'PATCH', path, { allow_route: true, expected_revision: await revision() })).status).toBe(200);
      expect((await reader.readContext(isaTenant.tenant, isaTenant.target)).hechos.permisos)
        .toMatchObject({ lectura: true, ruta: true });
      checks.errors.expectHttpError(path, 409);
      const blocked = await send(platform(), 'DELETE', `${path}?expected_revision=${String(await revision())}`);
      expect(blocked.status).toBe(409);
      expect(String(blocked.body.message)).toContain('todavía usan');
      expect(blocked.body.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'memberships', blocking: true })]));
    } finally {
      await db().query('DELETE FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 AND role=$4',
        [isaTenant.tenant, isaTenant.room, isaTenant.target, role]);
    }
    expect((await send(platform(), 'DELETE', `${path}?expected_revision=${String(await revision())}`)).status).toBe(200);
  });

  it('cada operación web de catálogo deja identidad, mutación, revisión y fecha exactas', async () => {
    const audit = await db().query<{ resource: string; action: string; actor_matches: boolean; dated: boolean }>(
      `SELECT revision.operation->>'resource' AS resource,revision.operation->>'action' AS action,
        event.actor_human_id=person.id AND event.actor_alias=revision.actor_alias
          AND event.tenant_id=revision.actor_tenant AND event.metadata->'mutation'=revision.operation AS actor_matches,
        event.created_at IS NOT NULL AND revision.created_at IS NOT NULL AS dated
      FROM config_revisions revision JOIN console_users person ON person.id=revision.actor_human_id
      LEFT JOIN audit_events event ON event.action='config.change' AND event.company_id IS NULL
        AND (event.metadata->>'revision')::bigint=revision.id
      WHERE revision.scope='platform' AND person.email_normalized=$1`, [checks.email.toLowerCase()]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of audit.rows) { expect(row.actor_matches).toBe(true); expect(row.dated).toBe(true); }
    for (const resource of ['harness', 'role_policy']) for (const action of ['create', 'update', 'delete']) {
      expect(audit.rows.some(row => row.resource === resource && row.action === action), `${resource} ${action}`).toBe(true);
    }
    checks.errors.assertClean();
  });
}
