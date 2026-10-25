import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objectRecord } from '@cauce/protocol';
import { browserExec as exec } from './browser-owned-lifecycle.js';
import { functionalTenants, type FunctionalTenant, type startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;

/** Sets up a normal synthetic adapter; host provenance and fleet lifecycle are not exercised. */
export async function prepareChatRuntimeIdentity(fixture: Fixture, tenant: FunctionalTenant): Promise<string> {
  if (process.env.CAUCE_TEST_DATABASE_URL || !fixture.directory.startsWith(join(tmpdir(), 'cauce-ui-functional-'))) {
    throw new Error('Chat runtime identity requires an owned functional fixture');
  }
  const index = functionalTenants.findIndex((item) => item.tenant === tenant.tenant && item.target === tenant.target);
  const tls = fixture.pki.adapterCerts[index];
  if (index < 0 || !tls) throw new Error('Missing owned chat adapter certificate');
  const runtimeKey = `chat-${tenant.tenant.toLowerCase()}-${tenant.target}`;
  const original = new X509Certificate(await readFile(tls.cert)).fingerprint256.replaceAll(':', '').toLowerCase();
  const document = objectRecord(JSON.parse(await readFile(fixture.pki.identityPath, 'utf8')) as unknown);
  if (document?.version !== 1 || !Array.isArray(document.identities)) throw new Error('Invalid owned mTLS registry');
  const identities = document.identities.map((entry: unknown) => objectRecord(entry));
  const matches = identities.filter((entry) => entry?.certificate_sha256 === original);
  const identity = matches[0];
  const principal = objectRecord(identity?.principal);
  if (matches.length !== 1 || !identity || principal?.tenant_id !== tenant.tenant || principal.alias !== tenant.target) {
    throw new Error('Owned chat adapter identity is not unique');
  }
  const existing = await fixture.database.pool.query<{ runtime_key: string | null; runtime_mode: string | null; host_id: string | null }>(
    'SELECT runtime_key,runtime_mode,host_id FROM agents WHERE tenant_id=$1 AND alias=$2 AND home_directory=$3',
    [tenant.tenant, tenant.target, fixture.directory],
  );
  const agent = existing.rows[0];
  if (existing.rows.length !== 1 || agent?.runtime_key !== null || agent.runtime_mode !== null || agent.host_id !== null) {
    throw new Error('Chat fixture adapter already has a durable runtime placement');
  }
  const stem = join(fixture.directory, `chat-normal-${randomUUID()}`);
  const certificatePath = `${stem}.crt`;
  const config = `${stem}.cnf`;
  const csr = `${stem}.csr`;
  await writeFile(config, `[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=${runtimeKey}\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:cauce:runtime:${runtimeKey}\n`, { mode: 0o600, flag: 'wx' });
  await exec('openssl', ['req', '-new', '-key', tls.key, '-out', csr, '-config', config]);
  await exec('openssl', ['x509', '-req', '-in', csr, '-CA', fixture.pki.ca.cert, '-CAkey', fixture.pki.ca.key,
    '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', certificatePath, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(certificatePath, 0o600);
  const certificate = new X509Certificate(await readFile(certificatePath));
  if (certificate.subjectAltName !== `URI:urn:cauce:runtime:${runtimeKey}`) throw new Error('Chat runtime certificate SAN differs');
  const updated = await fixture.database.pool.query(
    `UPDATE agents SET runtime_key=$3,runtime_mode='native'
       WHERE tenant_id=$1 AND alias=$2 AND home_directory=$4
         AND runtime_key IS NULL AND runtime_mode IS NULL AND host_id IS NULL`,
    [tenant.tenant, tenant.target, runtimeKey, fixture.directory],
  );
  if (updated.rowCount !== 1) throw new Error('Owned chat adapter placement changed during setup');
  const reserved = await fixture.database.pool.query(
    'SELECT 1 FROM fleet_runtime_identities WHERE runtime_key=$1 AND tenant_id=$2 AND alias=$3 AND NOT baseline AND baseline_state IS NULL',
    [runtimeKey, tenant.tenant, tenant.target],
  );
  if (reserved.rowCount !== 1) throw new Error('Chat runtime was not reserved by the standard agent trigger');
  identity.certificate_sha256 = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  identity.principal = { ...principal, channel: 'adapter', session_id: `adapter-${runtimeKey}`, roles: ['adapter'], permissions: ['read', 'route'] };
  const registryPath = `${stem}.identities.json`;
  await writeFile(registryPath, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
  await rename(registryPath, fixture.pki.identityPath);
  tls.cert = certificatePath;
  return runtimeKey;
}
