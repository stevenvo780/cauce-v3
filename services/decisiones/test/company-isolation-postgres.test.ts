import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDevelopmentDatabase } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresAudit } from '../src/audit.js';
import { durableCompanyResolver } from '../src/identity.js';
import { defaultAnswers } from './support/fake-jev.js';
import { startHarness, type Harness, type HarnessOptions } from './support/servicio.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let harness: Harness | undefined;
const CATALOG = fileURLToPath(new URL('../catalogo/', import.meta.url));
const FREE = { state: 'hello', questions: { ready: { type: 'noul', instructions: 'is this ready?' } } };

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  await seedDevelopmentDatabase(current.adminUrl, () => undefined);
  await current.adminPool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Hospital','grp.hospital','zeus','agent');
    INSERT INTO agents(tenant_id,alias,company_id,harness_id,enabled,container_name,runtime_user,home_directory,state_directory,primary_room_id)
    VALUES('Hospital','zeus','praxis','fake',true,'fixture-praxis-zeus','fixture','/fixture','/fixture/state','grp.hospital')`);
});
afterEach(async () => { await harness?.stop(); harness = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function start(catalogDir = CATALOG, burst = 100, options: Pick<HarnessOptions, 'limits' | 'jev' | 'config'> = {}): Promise<Harness> {
  if (!current) throw new Error('test database absent');
  harness = await startHarness({
    identities: (pki) => [
      { fingerprint: pki.client('humanizar').fingerprint, alias: 'zeus', tenant: 'Steven' },
      { fingerprint: pki.client('praxis').fingerprint, alias: 'zeus', tenant: 'Hospital' },
    ],
    config: { allowedTenants: new Set(['Steven', 'Hospital']), catalogDir, ...options.config },
    limits: { burst, ...options.limits },
    ...(options.jev === undefined ? {} : { jev: options.jev }),
    dependencies: { resolveCompany: durableCompanyResolver(current.pool), audit: new PostgresAudit(current.pool) },
  });
  return harness;
}

describe('decisiones scoped by durable company and mTLS', () => {
  it('lists and reads private templates only for the company resolved from the certificate tenant', async () => {
    const h = await start();
    const own = await h.call(h.pki.client('humanizar'), 'GET', '/v1/plantillas');
    const other = await h.call(h.pki.client('praxis'), 'GET', '/v1/plantillas');
    expect(own.status).toBe(200);
    expect((own.body.plantillas as unknown[]).length).toBe(11);
    expect(other.status).toBe(200);
    expect((other.body.plantillas as { id: string }[]).map((entry) => entry.id)).toEqual([
      'cabe_en_un_turno', 'elegir_modelo', 'requiere_respuesta', 'respuesta_cumple', 'triage_urgencia',
    ]);
    expect((await h.call(h.pki.client('humanizar'), 'GET', '/v1/plantillas/aprobacion_humana')).status).toBe(200);
    expect((await h.call(h.pki.client('praxis'), 'GET', '/v1/plantillas/aprobacion_humana')).body).toMatchObject({ error: 'plantilla_desconocida' });
  });

  it('a homonymous alias cannot inherit approval exceptions, routing or a private fallback', async () => {
    const h = await start();
    for (const template of ['aprobacion_humana', 'ruteo_alias', 'clasificar_fallo', 'reintentar_escalar_cerrar', 'aclarar_o_actuar', 'guardia_privacidad_jarvis']) {
      const answer = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', { plantilla: template, state: { accion_propuesta: 'docker compose up' } });
      expect(answer.status, template).toBe(404);
      expect(answer.body).not.toHaveProperty('respaldo');
      expect(JSON.stringify(answer.body)).not.toContain('exige_aprobacion');
    }
    const forged = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', { ...FREE, company: 'humanizar' });
    expect(forged.status).toBe(400);
    expect(h.jev.seen).toHaveLength(0);
  });

  it('revocation of company, tenant, agent, membership, room or route policy applies on the next request', async () => {
    const h = await start();
    if (!current) throw new Error('test database absent');
    const changes = [
      ["UPDATE companies SET enabled=false WHERE id='praxis'", "UPDATE companies SET enabled=true WHERE id='praxis'"],
      ["UPDATE tenants SET enabled=false WHERE id='Hospital'", "UPDATE tenants SET enabled=true WHERE id='Hospital'"],
      ["UPDATE agents SET enabled=false WHERE tenant_id='Hospital' AND alias='zeus'", "UPDATE agents SET enabled=true WHERE tenant_id='Hospital' AND alias='zeus'"],
      ["UPDATE memberships SET enabled=false WHERE tenant_id='Hospital' AND alias='zeus'", "UPDATE memberships SET enabled=true WHERE tenant_id='Hospital' AND alias='zeus'"],
      ["UPDATE rooms SET enabled=false WHERE id='grp.hospital'", "UPDATE rooms SET enabled=true WHERE id='grp.hospital'"],
      ["UPDATE role_policies SET allow_route=false WHERE role='agent'", "UPDATE role_policies SET allow_route=true WHERE role='agent'"],
    ];
    for (const [disable, enable] of changes) {
      if (!disable || !enable) throw new Error('fixture statement absent');
      expect((await h.call(h.pki.client('praxis'), 'GET', '/v1/plantillas')).status).toBe(200);
      await current.adminPool.query(disable);
      const result = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: {} });
      expect(result.status, disable).toBe(403);
      expect(result.body).not.toHaveProperty('respaldo');
      await current.adminPool.query(enable);
    }
    expect(h.jev.seen).toHaveLength(0);
  });

  it('isolates the rate buckets of homonymous identities', async () => {
    const h = await start(CATALOG, 1);
    expect((await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE)).status).toBe(200);
    expect((await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE)).status).toBe(429);
    expect((await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', FREE)).status).toBe(200);
    expect(h.jev.seen).toHaveLength(2);
  });

  it('separates daily budgets and enforces the shared global budget', async () => {
    const h = await start(CATALOG, 100, { limits: { dailyInputTokens: 1_000, dailyInputTokensTotal: 1_700 }, jev: { maxRounds: 1 } });
    expect((await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE)).status).toBe(200);
    const ownCap = await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE);
    expect(ownCap.status).toBe(429);
    expect(ownCap.body.mensaje).toContain('cupo diario');
    expect((await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', FREE)).status).toBe(200);
    expect(h.jev.seen).toHaveLength(2);
    await h.stop();
    harness = undefined;
    const shared = await start(CATALOG, 100, { limits: { dailyInputTokens: 10_000, dailyInputTokensTotal: 1_100 }, jev: { maxRounds: 1 } });
    expect((await shared.call(shared.pki.client('humanizar'), 'POST', '/v1/decidir', FREE)).status).toBe(200);
    const fleetCap = await shared.call(shared.pki.client('praxis'), 'POST', '/v1/decidir', FREE);
    expect(fleetCap.status).toBe(429);
    expect(fleetCap.body.mensaje).toContain('la flota');
    expect(shared.jev.seen).toHaveLength(1);
  });

  it('keeps simultaneous slots separate for homonymous identities', async () => {
    const h = await start(CATALOG, 100, { limits: { concurrencyPerAlias: 1 } });
    h.jev.respond((request) => ({ delayMs: 200, body: { model: 'jev-1.13.0', answers: defaultAnswers(request.body.questions), usage: { input_tokens: 100, output_tokens: 1 } } }));
    const first = h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE);
    await vi.waitFor(() => { expect(h.jev.seen).toHaveLength(1); });
    const own = await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', FREE);
    expect(own.status).toBe(429);
    const other = h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', FREE);
    await vi.waitFor(() => { expect(h.jev.seen).toHaveLength(2); });
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  it('stores tenant, alias, company, operation and the durable host without copying state or provider credentials', async () => {
    if (!current) throw new Error('test database absent');
    await current.adminPool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('fixture-host','Fixture','praxis')");
    await current.adminPool.query("UPDATE agents SET host_id='fixture-host' WHERE tenant_id='Hospital' AND alias='zeus'");
    const h = await start();
    const response = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', FREE);
    expect(response.status).toBe(200);
    const row = (await current.pool.query<{ tenant_id: string; actor_alias: string; company_id: string; metadata: Record<string, unknown> }>(
      "SELECT tenant_id,actor_alias,company_id,metadata FROM audit_events WHERE action='decision.resolved' ORDER BY id DESC LIMIT 1",
    )).rows[0];
    expect(row).toMatchObject({ tenant_id: 'Hospital', actor_alias: 'zeus', company_id: 'praxis', metadata: { operation_id: response.body.id, operation: 'free', host_id: 'fixture-host' } });
    expect(row?.metadata.state_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain('hello');
    expect(row?.metadata).not.toHaveProperty('state');
  });

  it('resolves a same-named private template and its fallback from the caller company only', async () => {
    const catalogDir = await mkdtemp(join(tmpdir(), 'decisiones-scoped-catalog-'));
    await cp(CATALOG, catalogDir, { recursive: true });
    const destination = join(catalogDir, 'empresas', 'praxis', 'plantillas');
    await mkdir(destination, { recursive: true });
    const definition = JSON.parse(await readFile(join(CATALOG, 'empresas', 'humanizar', 'plantillas', 'aprobacion_humana.json'), 'utf8')) as Record<string, unknown>;
    definition.prefiltros = [{ campos: ['accion_propuesta'], patron: '.', entonces: { decision: 'fixture_praxis', motivo: 'fixture only', llm: false } }];
    definition.si_falla = { decision: 'fixture_closed', motivo: 'fixture only', llm: false };
    await writeFile(join(destination, 'aprobacion_humana.json'), JSON.stringify(definition));
    const h = await start(catalogDir);
    const praxis = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'rm -rf /data' } });
    const own = await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'rm -rf /data' } });
    expect(praxis.body).toMatchObject({ decision: 'fixture_praxis', origen: 'prefiltro' });
    expect(own.body.decision).not.toBe('fixture_praxis');
    const fallback = await h.call(h.pki.client('praxis'), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: {} });
    expect(fallback.body).toMatchObject({ respaldo: { decision: 'fixture_closed' } });
    const foreign = await h.call(h.pki.client('humanizar'), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: {} });
    expect(foreign.body).toMatchObject({ respaldo: { decision: 'exige_aprobacion' } });
  });
});
