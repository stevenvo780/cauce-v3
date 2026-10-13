import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, createPool, stableHostJson, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { HostSetupConfigSchema, HostSetupPackager } from './host-setup.js';
import { claimSetupHost, hostSetupConfig, inviteSetupHost, registerSetupOwner, setupPacket } from './host-setup.fixtures.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
const packager = new HostSetupPackager(HostSetupConfigSchema.parse(hostSetupConfig()), generateKeyPairSync('ed25519').privateKey);
async function gateway(setup: HostSetupPackager | undefined) {
  await app?.close();
  app = await buildGateway({ pool, repository: new CauceRepository(pool), consoleOrigins: ['http://localhost'], logger: false,
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 59) }),
    ...(setup === undefined ? {} : { hostSetup: setup }) });
  return app;
}
async function enrolledComputer(slug: string, name = 'laptop') {
  if (!app) throw new Error('gateway absent');
  const owner = await registerSetupOwner(app, slug);
  const invitation = await inviteSetupHost(app, owner, `${slug}-${name}`);
  return { owner, invitation, host: await claimSetupHost(app, invitation) };
}
function artifact(host: Parameters<typeof setupPacket>[0], wanted: { name: string; sha256: string; offset: number },
  overrides: Parameters<typeof setupPacket>[1] = {}, headers: Record<string, string> = {}) {
  if (!app) throw new Error('gateway absent');
  return app.inject({ method: 'POST', url: `/v3/fleet/hosts/${overrides.path_host ?? overrides.host_id ?? host.host_id}/setup/artifact`,
    headers, payload: setupPacket(host, overrides, wanted) });
}
function setup(host: Parameters<typeof setupPacket>[0], overrides: Parameters<typeof setupPacket>[1] = {}, headers: Record<string, string> = {}) {
  if (!app) throw new Error('gateway absent');
  return app.inject({ method: 'POST', url: `/v3/fleet/hosts/${overrides.path_host ?? overrides.host_id ?? host.host_id}/setup`,
    headers, payload: setupPacket(host, overrides) });
}
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 4 });
  await gateway(packager);
});
afterEach(async () => { await app?.close(); app = undefined; await pool.end(); await current?.close(); });
afterAll(async () => { await database?.pool.end(); await database?.container.stop(); });

describe('self-service computer setup', () => {
  it('a newly registered owner invites a computer that receives its company policy signed by the anchored signer', async () => {
    const { owner, invitation, host } = await enrolledComputer('setupa');
    expect(invitation.setup_signer_fingerprint).toBe(packager.signerFingerprint);
    const listed = await app?.inject({ method: 'GET', url: '/v3/console/fleet/hosts/enrollments', headers: { ...owner } });
    expect(JSON.parse(listed?.body ?? '{}')).toMatchObject({ setup_signer_fingerprint: packager.signerFingerprint,
      enrollments: [{ host_id: 'setupa-laptop', state: 'enrolled', executor_ready: false }] });
    const response = await setup(host);
    expect(response.statusCode).toBe(200);
    const signed = response.json<{ package: Record<string, unknown>; signature: string; signer_public_key: string }>();
    const key = createPublicKey({ key: Buffer.from(signed.signer_public_key, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(stableHostJson(signed.package)), key, Buffer.from(signed.signature, 'base64'))).toBe(true);
    expect(signed.signer_public_key).toBe(packager.signerPublicKey);
    expect(signed.package).toMatchObject({ version: 1, company_id: 'setupa', host_id: 'setupa-laptop', release_revision: 'a'.repeat(40) });
    expect(signed.package.policy).toMatchObject({ bundles: { codex: { directory: '@release@/adapter' }, claude: { directory: '@release@/adapter' } },
      authority: { identity_directory: '@identity@', host_id: 'setupa-laptop' } });
    const audit = await pool.query<{ company_id: string; host_id: string; claude: boolean }>(`SELECT company_id,metadata->>'host_id' AS host_id,
      metadata->'harnesses' ? 'claude' AS claude FROM audit_events WHERE action='fleet_host.setup.package'`);
    expect(audit.rows).toEqual([{ company_id: 'setupa', host_id: 'setupa-laptop', claude: true }]);
  });

  it('a computer of company A obtains neither the package of B nor a replay of its own request', async () => {
    const a = await enrolledComputer('setupa'); const b = await enrolledComputer('setupb');
    const crossed = [
      await setup(a.host, { host_id: b.host.host_id }),
      await setup(a.host, { company_id: 'setupb' }),
      await setup(a.host, { path_host: b.host.host_id }),
      await setup({ ...b.host, keys: a.host.keys }),
    ];
    for (const response of crossed) {
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('"package"');
    }
    const packet = setupPacket(a.host);
    const first = await app?.inject({ method: 'POST', url: `/v3/fleet/hosts/${a.host.host_id}/setup`, payload: packet });
    const replay = await app?.inject({ method: 'POST', url: `/v3/fleet/hosts/${a.host.host_id}/setup`, payload: packet });
    expect([first?.statusCode, replay?.statusCode]).toEqual([200, 409]);
    expect((await setup(a.host, {}, { cookie: a.owner.cookie })).statusCode).toBe(403);
    const audit = await pool.query<{ company_id: string }>("SELECT company_id FROM audit_events WHERE action='fleet_host.setup.package'");
    expect(audit.rows).toEqual([{ company_id: 'setupa' }]);
  });

  it('narrows the package when the platform disables a harness and answers 404 only to a verified computer when unconfigured', async () => {
    const { host } = await enrolledComputer('setupc');
    if (!current) throw new Error('database absent');
    await current.adminPool.query("UPDATE harness_definitions SET enabled=false WHERE id='claude'");
    const narrowed = (await setup(host)).json<{ package: { policy: { bundles: object; container_templates: { harness_id: string }[] } } }>();
    expect(Object.keys(narrowed.package.policy.bundles)).toEqual(['codex']);
    expect(narrowed.package.policy.container_templates.map(row => row.harness_id)).toEqual(['codex']);
    await gateway(undefined);
    const unconfigured = await setup(host);
    expect(unconfigured.statusCode).toBe(404);
    expect(unconfigured.json()).toMatchObject({ error: 'not_found' });
    expect((await setup({ ...host, keys: generateKeyPairSync('ed25519') })).statusCode).toBe(403);
    const audit = await pool.query("SELECT 1 FROM audit_events WHERE action='fleet_host.setup.package'");
    expect(audit.rowCount).toBe(1);
  });

  it('streams the signed release to its own computer from the signed offset, audits each request and refuses everyone else', async () => {
    const files = await mkdtemp(join(tmpdir(), 'cauce-setup-artifacts-'));
    try {
      const tar = randomBytes(300_000); const path = join(files, 'release.tar'); await writeFile(path, tar, { mode: 0o644 });
      const sha256 = createHash('sha256').update(tar).digest('hex'); const base = hostSetupConfig();
      await gateway(new HostSetupPackager(HostSetupConfigSchema.parse({ ...base, release: { ...base.release, path, sha256, size: tar.length } }),
        generateKeyPairSync('ed25519').privateKey));
      const a = await enrolledComputer('setupd'); const b = await enrolledComputer('setupe');
      const wanted = { name: 'release', sha256, offset: 0 };
      const whole = await artifact(a.host, wanted);
      expect([whole.statusCode, whole.headers['content-length'], whole.headers['content-type']]).toEqual([200, String(tar.length), 'application/octet-stream']);
      expect(whole.rawPayload.equals(tar)).toBe(true);
      const rest = await artifact(a.host, { ...wanted, offset: 1000 });
      expect([rest.statusCode, rest.headers['content-range']]).toEqual([206, `bytes 1000-${String(tar.length - 1)}/${String(tar.length)}`]);
      expect(rest.rawPayload.equals(tar.subarray(1000))).toBe(true);
      expect((await artifact(a.host, { ...wanted, sha256: 'f'.repeat(64) })).statusCode).toBe(409);
      expect((await artifact(a.host, { ...wanted, name: 'agent-image' })).statusCode).toBe(404);
      expect((await artifact(a.host, { ...wanted, offset: tar.length })).statusCode).toBe(422);
      for (const refused of [await artifact(a.host, wanted, { path_host: b.host.host_id }), await artifact({ ...b.host, keys: a.host.keys }, wanted),
        await artifact(a.host, wanted, {}, { cookie: a.owner.cookie })]) {
        expect(refused.statusCode).toBe(403); expect(refused.rawPayload.includes(tar.subarray(0, 64))).toBe(false);
      }
      const audit = await pool.query<{ company_id: string; offset: string }>(`SELECT company_id,metadata->>'offset' AS offset FROM audit_events
        WHERE action='fleet_host.setup.artifact' ORDER BY (metadata->>'offset')::bigint`);
      expect(audit.rows).toEqual([{ company_id: 'setupd', offset: '0' }, { company_id: 'setupd', offset: '1000' }]);
      await gateway(undefined);
      expect((await artifact(a.host, wanted)).statusCode).toBe(404);
    } finally { await rm(files, { recursive: true, force: true }); }
  });
});
