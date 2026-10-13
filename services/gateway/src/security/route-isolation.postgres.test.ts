import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { IsolationHarness, assertRouteCoverage, expandProbe, routeKey, type IsolationSession } from './route-isolation-harness.js';
import { ROUTE_ISOLATION_MATRIX, type RouteIsolationEntry } from './route-isolation-matrix.js';
import { snapshotCompany } from './route-isolation-fixtures.js';
import { assertForeignWebSockets } from './route-isolation-sockets.js';
import { seedProviderSession } from './route-isolation-provider.js';
import { validateCanaryFixtures } from './route-isolation-canary.js';

const harness = new IsolationHarness();
let ownerA: IsolationSession;
let ownerB: IsolationSession;
preparePostgresSuite(import.meta.url, async () => {
  await harness.start();
  ownerA = await harness.login(harness.fixtures.a);
  ownerB = await harness.login(harness.fixtures.b);
  if (harness.baseUrl !== undefined) return;
  const requestId = randomUUID();
  const ownerToken = randomUUID();
  const terminal = await harness.request('POST', '/v3/console/terminal/sessions', ownerB,
    { tenant_id: harness.fixtures.b.tenant, alias: harness.fixtures.b.alias, mode: 'shell', cols: 80, rows: 24,
      request_id: requestId, owner_token: ownerToken });
  if (terminal.status !== 201) throw new Error(`own B terminal issuance failed (${String(terminal.status)})`);
  const issued = JSON.parse(terminal.body) as { session_id: string; authority_proof: string; owner_generation: string };
  Object.assign(harness.fixtures.b, { session: issued.session_id, authorityProof: issued.authority_proof,
    requestId, ownerToken, ownerGeneration: issued.owner_generation });
  if (!harness.current) throw new Error('local isolation database unavailable');
  Object.assign(harness.fixtures.b, await seedProviderSession(harness.current.pool, harness.fixtures.b));
  const connectionInstance = randomUUID();
  const hello = await harness.request('POST', '/v3/connections/hello', ownerB,
    { type: 'hello', version: '3.0', tenant_id: harness.fixtures.b.tenant, alias: harness.fixtures.b.ownerAlias,
      instance_id: connectionInstance, capabilities: [] });
  if (hello.status !== 200) throw new Error(`own B lease issuance failed (${String(hello.status)})`);
  const lease = JSON.parse(hello.body) as { epoch: number; connection_token: string };
  Object.assign(harness.fixtures.b, { connectionInstance, connectionEpoch: lease.epoch, connectionToken: lease.connection_token });
}, 120_000);
afterAll(async () => { await harness.close(); });

function foreignData(body: string, entry: RouteIsolationEntry): boolean {
  const fixture = harness.fixtures.b;
  const markers = [fixture.company, fixture.tenant, fixture.alias, fixture.human, fixture.host,
    fixture.account, fixture.environment, fixture.backup, fixture.message, fixture.delivery, fixture.blob, fixture.operation,
    fixture.invitation, fixture.quotaOperation, fixture.trace, fixture.gate, fixture.session, fixture.nativeOperation,
    ...(fixture.providerOperation === undefined ? [] : [fixture.providerOperation]), ...fixture.privateSentinels];
  let content = body;
  if (entry.errorMessageEcho !== undefined && body.startsWith('{')) {
    const result = JSON.parse(body) as { error?: string; message?: string };
    const echo = expandProbe({ ...entry, probe: { url: entry.errorMessageEcho } }, fixture, harness.fixtures.a).url;
    if (result.error === 'forbidden' && result.message === echo) { delete result.message; content = JSON.stringify(result); }
  }
  if (entry.url === '/v3/console/egress/notifications' && body.startsWith('{') && Array.isArray((JSON.parse(body) as { items?: unknown }).items)) {
    const result = JSON.parse(body) as { items: Record<string, unknown>[] };
    for (const item of result.items) {
      if (item.decision === 'denied') delete item.handle;
    }
    content = JSON.stringify(result);
  }
  return markers.some(value => content.includes(value));
}

function assertIsolationResponse(entry: RouteIsolationEntry, status: number, body: string): void {
  expect(harness.fixtures.b.privateSentinels.some(value => body.includes(value)),
  `${entry.method} ${entry.url} exposed private content in HTTP ${String(status)}`).toBe(false);
  expect(foreignData(body, entry), `${entry.method} ${entry.url} exposed company B data in HTTP ${String(status)}`).toBe(false);
  const allowed = entry.probe?.expectedStatus ?? (entry.kind === 'scoped' ? [403, 404] : [200]);
  const error = body.startsWith('{') ? (JSON.parse(body) as { error?: string }).error : undefined;
  if (!allowed.includes(status) && harness.baseUrl === undefined) {
    const result = body.startsWith('{') ? JSON.parse(body) as { message?: string } : {};
    console.info(`ISOLATION_CONTRACT_FAILURE=${JSON.stringify({ route: entry.url, status, error, message: result.message })}`);
  }
  expect(allowed, `${entry.method} ${entry.url} returned HTTP ${String(status)}/${error ?? 'success'}`).toContain(status);
  if (status >= 200 && status < 300 && body.length && entry.url.endsWith('/chains/:traceId')) {
    expect(JSON.parse(body)).toMatchObject({ nodes: [], edges: [], origin_relays: [] });
  }
}

describe('real gateway exhaustive route isolation under signed owner sessions', () => {
  it('validates every PostgreSQL canary resource and rejects a mixed-company manifest', async context => {
    if (harness.baseUrl !== undefined) { context.skip(); return; }
    const valid = await validateCanaryFixtures(harness.snapshotPool, harness.fixtures, { requireCanaryNames: false });
    expect(valid.checkedFields).toContain('b.backup');
    expect(valid.checkedFields).toContain('b.connectionInstance/connectionEpoch/connectionToken');
    await expect(validateCanaryFixtures(harness.snapshotPool,
      { a: harness.fixtures.a, b: { ...harness.fixtures.b, host: harness.fixtures.a.host } }, { requireCanaryNames: false }))
      .rejects.toThrow('distinct host');
    await expect(validateCanaryFixtures(harness.snapshotPool,
      { a: harness.fixtures.a, b: { ...harness.fixtures.b, invitation: harness.fixtures.a.invitation } }, { requireCanaryNames: false }))
      .rejects.toThrow('b.invitation');
    console.info(`ISOLATION_CANARY_VALIDATOR=${JSON.stringify({ checked: valid.checkedFields.length, limits: valid.unverifiableFields })}`);
  });

  it('rejects B identifiers and private content even inside HTTP denial metadata', () => {
    const entry = ROUTE_ISOLATION_MATRIX.find(route => route.url === '/v3/console/companies/:company_id');
    if (!entry) throw new Error('company isolation route missing');
    expect(() => { assertIsolationResponse(entry, 403, JSON.stringify({ error: 'forbidden', metadata: { host: harness.fixtures.b.host } })); })
      .toThrow('exposed company B data');
    expect(() => { assertIsolationResponse(entry, 404, JSON.stringify({ error: 'not_found', metadata: { content: harness.fixtures.b.privateSentinels[0] } })); })
      .toThrow('exposed private content');
    assertIsolationResponse(entry, 403, JSON.stringify({ error: 'forbidden' }));
    const office = ROUTE_ISOLATION_MATRIX.find(route => route.method === 'PUT' && route.url === '/v3/console/office/layout');
    if (!office?.errorMessageEcho) throw new Error('office denial echo missing');
    const message = expandProbe({ ...office, probe: { url: office.errorMessageEcho } }, harness.fixtures.b, harness.fixtures.a).url;
    assertIsolationResponse(office, 403, JSON.stringify({ error: 'forbidden', message }));
    expect(() => { assertIsolationResponse(office, 403, JSON.stringify({ error: 'forbidden', message, metadata: { account: harness.fixtures.b.account } })); })
      .toThrow('exposed company B data');
  });

  it('enumerates onRoute registrations and rejects every uncovered method/path', () => {
    assertRouteCoverage(harness.catalogRoutes);
    console.info(`ISOLATION_ROUTE_COUNT=${String(new Set(harness.catalogRoutes.map(route => routeKey(route.method, route.url))).size)}`);
  });

  it('proves the enumeration guard catches an added real Fastify route', async () => {
    const routes = [...harness.catalogRoutes];
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.addHook('onRoute', route => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.push({ method, url: route.url });
    });
    try {
      app.get('/v3/zz-uncovered-isolation-probe', async () => ({ ok: true }));
      await app.ready();
      expect(() => { assertRouteCoverage(routes); }).toThrow('uncovered routes: GET /v3/zz-uncovered-isolation-probe');
    } finally { await app.close(); }
  });

  it('proves the enumeration guard catches a removed Fastify registration', () => {
    const key = 'GET /v3/console/companies/:company_id';
    expect(harness.catalogRoutes.some(route => routeKey(route.method, route.url) === key)).toBe(true);
    const routes = harness.catalogRoutes.filter(route => routeKey(route.method, route.url) !== key);
    expect(() => { assertRouteCoverage(routes); }).toThrow(`unregistered matrix routes: ${key}`);
  });

  it('does not require websocket registrations for the HTTP catalog', () => {
    const sockets = new Set(ROUTE_ISOLATION_MATRIX.filter(route => route.kind === 'websocket').map(route => routeKey(route.method, route.url)));
    assertRouteCoverage(harness.catalogRoutes.filter(route => !sockets.has(routeKey(route.method, route.url))));
  });

  it('proves both sessions are owners of distinct populated companies and foreign resources exist', async () => {
    const { a, b } = harness.fixtures;
    expect(a.company).not.toBe(b.company);
    expect(a.alias).not.toBe(b.alias);
    for (const [owner, fixture] of [[ownerA, a], [ownerB, b]] as const) {
      const company = await harness.request('GET', `/v3/console/companies/${fixture.company}`, owner);
      expect(company.status).toBe(200);
      expect(JSON.parse(company.body)).toMatchObject({ id: fixture.company });
      const context = await harness.request('GET', `/v3/console/context/agents/${fixture.tenant}/${fixture.alias}`, owner);
      expect(context.status).toBe(200);
      expect(JSON.parse(context.body)).toMatchObject({ version: fixture.contextVersion });
      const backup = await harness.request('GET', `/v3/console/spaces/${fixture.tenant}/${fixture.alias}/backups/${fixture.backup}/download`, owner);
      expect(backup.status).toBe(200);
      expect(backup.body.length).toBeGreaterThan(0);
    }
    const provider = await harness.request('GET', `/v3/console/provider-auth/sessions/${b.providerSession ?? ''}`, ownerB);
    expect(provider.status).toBe(200);
    const terminal = await harness.request('GET', '/v3/console/terminal/sessions', ownerB);
    expect(terminal.status).toBe(200);
    expect(terminal.body).toContain(b.session);
    const before = await snapshotCompany(harness.snapshotPool, b);
    expect(before.count).toBeGreaterThan(20);
    expect(Object.values(before.tables).filter(table => table.count > 0).length).toBeGreaterThan(10);
    console.info(`ISOLATION_SNAPSHOT=${JSON.stringify({ count: before.count, sha256: before.sha256,
      tables: Object.entries(before.tables).filter(([, table]) => table.count > 0).map(([table]) => table) })}`);
  });

  it('detects B updates, inserts and deletes while ignoring a change owned solely by A', async context => {
    if (harness.baseUrl !== undefined) { context.skip(); return; }
    const pool = harness.snapshotPool;
    const { a, b } = harness.fixtures;
    const original = await snapshotCompany(pool, b);
    try {
      await pool.query("UPDATE companies SET name='snapshot mutation' WHERE id=$1", [b.company]);
      const updated = await snapshotCompany(pool, b);
      expect(updated.count).toBe(original.count);
      expect(updated.sha256).not.toBe(original.sha256);
      await pool.query('UPDATE companies SET name=id WHERE id=$1', [b.company]);
      expect(await snapshotCompany(pool, b)).toEqual(original);
      await pool.query('INSERT INTO rooms(tenant_id,id,company_id) VALUES($1,$2,$3)', [b.tenant, 'snapshot-probe-room', b.company]);
      expect((await snapshotCompany(pool, b)).count).toBe(original.count + 1);
      await pool.query('DELETE FROM rooms WHERE tenant_id=$1 AND id=$2', [b.tenant, 'snapshot-probe-room']);
      expect(await snapshotCompany(pool, b)).toEqual(original);
      await pool.query("UPDATE companies SET name='own A mutation' WHERE id=$1", [a.company]);
      expect(await snapshotCompany(pool, b)).toEqual(original);
    } finally {
      await pool.query('UPDATE companies SET name=id WHERE id=ANY($1::text[])', [[a.company, b.company]]);
      await pool.query('DELETE FROM rooms WHERE tenant_id=$1 AND id=$2', [b.tenant, 'snapshot-probe-room']);
    }
  });

  it('includes descendants of a second B tenant in company row hashes', async context => {
    if (harness.baseUrl !== undefined) { context.skip(); return; }
    const pool = harness.snapshotPool;
    const b = harness.fixtures.b;
    const tenant = `isolation-second-${randomUUID()}`;
    const before = await snapshotCompany(pool, b);
    try {
      await pool.query('INSERT INTO tenants(id,company_id,is_hub) VALUES($1,$2,false)', [tenant, b.company]);
      await pool.query('INSERT INTO rooms(tenant_id,id,company_id) VALUES($1,$2,$3)', [tenant, tenant, b.company]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$1,'snapshot-child','agent')", [tenant]);
      const added = await snapshotCompany(pool, b);
      expect(added.count).toBe(before.count + 3);
      await pool.query("UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND alias='snapshot-child'", [tenant]);
      expect((await snapshotCompany(pool, b)).sha256).not.toBe(added.sha256);
    } finally {
      await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [tenant]);
      await pool.query('DELETE FROM rooms WHERE tenant_id=$1', [tenant]);
      await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
    }
    expect(await snapshotCompany(pool, b)).toEqual(before);
  });

  it('answers B hosts exactly like absent ones and lets A invite only inside its own host partition', async context => {
    if (harness.baseUrl !== undefined) { context.skip(); return; }
    const { a, b } = harness.fixtures;
    const before = await snapshotCompany(harness.snapshotPool, b);
    const invite = (host_id: string) => harness.request('POST', '/v3/console/fleet/hosts/enrollments', ownerA, { host_id, display_name: 'isolation' });
    const registered = await invite(b.host);
    const pending = await invite(`${b.company}-pending`);
    const absent = await invite(`${b.company}-zz_canary_${randomUUID().replaceAll('-', '')}`);
    const unqualified = await invite(`zz-canary-isolation-${randomUUID()}`);
    for (const response of [registered, pending, absent, unqualified]) {
      expect(response.status).toBe(403);
      expect(response.body).toBe(registered.body);
    }
    expect(JSON.parse(registered.body)).toMatchObject({ error: 'forbidden' });
    const own = await invite(`${a.company}-zz_canary_${randomUUID().replaceAll('-', '')}`);
    expect(own.status).toBe(201);
    expect(JSON.parse(own.body)).toMatchObject({ company_id: a.company, state: 'pending' });
    expect(await snapshotCompany(harness.snapshotPool, b)).toEqual(before);
  });

  for (const entry of ROUTE_ISOLATION_MATRIX.filter(route => route.probe !== undefined && route.kind !== 'websocket' && route.kind !== 'public')) {
    it(`${entry.method} ${entry.url} denies or filters company B without changing its rows`, async context => {
      if (!harness.routes.some(route => routeKey(route.method, route.url) === routeKey(entry.method, entry.url))) {
        context.skip();
        return;
      }
      const probe = expandProbe(entry, harness.fixtures.b, harness.fixtures.a);
      const before = await snapshotCompany(harness.snapshotPool, harness.fixtures.b);
      try {
        const response = await harness.request(entry.method, probe.url, ownerA, probe.payload);
        assertIsolationResponse(entry, response.status, response.body);
        if (entry.method === 'GET') {
          const head = await harness.request('HEAD', probe.url, ownerA);
          assertIsolationResponse(entry, head.status, '');
        }
      } finally {
        const after = await snapshotCompany(harness.snapshotPool, harness.fixtures.b);
        expect(after, `company B rows changed under ${entry.method} ${entry.url}`).toEqual(before);
      }
    });
  }

  it('keeps aged quota history of B under an A sample until a B collector prunes it', async context => {
    if (harness.baseUrl !== undefined) { context.skip(); return; }
    const pool = harness.snapshotPool;
    const sampleOf = (host: string) => ({ host, captured_at: new Date().toISOString(), schema_version: 1, providers: [] });
    const collection = await harness.request('POST', '/v3/quotas/samples', ownerB, sampleOf('isolation-retention-b'));
    expect(collection.status).toBe(202);
    const { collection_id: collectionId } = JSON.parse(collection.body) as { collection_id: string };
    await pool.query("UPDATE quota_collections SET received_at=now()-interval '31 days',captured_at=now()-interval '31 days' WHERE id=$1", [collectionId]);
    const before = await snapshotCompany(pool, harness.fixtures.b);
    const foreign = await harness.request('POST', '/v3/quotas/samples', ownerA, sampleOf('isolation-retention-a'));
    expect(foreign.status).toBe(202);
    expect(JSON.parse(foreign.body)).toMatchObject({ pruned_collections: 0 });
    expect(await snapshotCompany(pool, harness.fixtures.b)).toEqual(before);
    const own = await harness.request('POST', '/v3/quotas/samples', ownerB, sampleOf('isolation-retention-b'));
    expect(own.status).toBe(202);
    expect(JSON.parse(own.body)).toMatchObject({ pruned_collections: 1 });
    expect((await pool.query('SELECT id FROM quota_collections WHERE id=$1', [collectionId])).rowCount).toBe(0);
  });

  it('uses real WS frames to admit A and reject B hello/subscription without modifying B', async () => {
    const before = await snapshotCompany(harness.snapshotPool, harness.fixtures.b);
    try {
      const b = harness.fixtures.b as typeof harness.fixtures.b & { providerSession: string };
      const ticket = await harness.request('POST', `/v3/console/provider-auth/sessions/${b.providerSession}/ticket`, ownerB, {});
      expect(ticket.status).toBe(200);
      const evidence = await assertForeignWebSockets(await harness.websocketUrl(), ownerA,
        { ...harness.fixtures, foreignSentinels: harness.fixtures.b.privateSentinels,
          providerAuth: { sessionId: b.providerSession, ticket: (JSON.parse(ticket.body) as { ticket: string }).ticket } });
      expect(evidence).toHaveLength(4);
      for (const row of evidence) console.info(`ISOLATION_WS=${JSON.stringify(row)}`);
    } finally {
      expect(await snapshotCompany(harness.snapshotPool, harness.fixtures.b)).toEqual(before);
    }
  });
});
