import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CauceRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import type { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { startSignedFleetAuthorityBridge } from '../../services/gateway/src/fleet/authority/signed-bridge.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { runAuthorityReadiness } from '../../services/gateway/src/fleet/authority/command.js';
import { FleetMtlsIdentityProvider, FleetTokenProbeAuthProvider } from '../../services/gateway/src/fleet/mtls-identities.js';
import { HostSetupPackager, resolveHostSetup } from '../../services/gateway/src/fleet/host-setup.js';
import { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import type { CompleteRelease } from './v4-alta-ordenador-completa.release.js';

const execute = promisify(execFile);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function startCompleteGateway(release: Pick<CompleteRelease, 'setupConfig' | 'signingKey'>) {
  let auth: PasswordAuthProvider | undefined;
  const fixture = await startConsoleFunctionalFixture({ browserLifetimeSeconds: 1800,
    configureGateway: (_app, _database, provider) => { auth = provider; } });
  const directory = await mkdtemp(join(tmpdir(), 'h11-authority-'));
  let bridge: Awaited<ReturnType<typeof startSignedFleetAuthorityBridge>> | undefined;
  let bootstrap: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    for (const action of [...fixture.contexts.splice(0).map(context => () => context.close()),
      () => app?.close(), () => bootstrap?.close(), () => bridge?.close(),
      () => fixture.close(), () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'complete computer gateway cleanup failed');
  };
  try {
    await chmod(directory, 0o700);
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 });
    const registries = {
      base_mtls: join(directory, 'base-mtls/mtls_identities.json'), base_token: join(directory, 'base-token/token_hashes.json'),
      fleet_mtls: join(directory, 'fleet-mtls/mtls_identities.json'), fleet_token: join(directory, 'fleet-token/token_hashes.json'),
      pty: join(directory, 'pty/pty_agent_identities.json'),
    };
    for (const [name, file] of Object.entries(registries)) {
      await mkdir(dirname(file), { mode: 0o700 });
      await writeFile(file, JSON.stringify({ version: 1, ...(name === 'pty' ? { agents: [] } : { identities: [] }) }), { mode: 0o600 });
    }
    const ca = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=H11 laboratory authority',
      '-keyout', key, '-out', ca, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    await chmod(key, 0o600);
    const policyFile = join(directory, 'issuer-policy.json');
    await writeFile(policyFile, JSON.stringify({ version: 1, state_root: state, registries,
      signer: { certificate: ca, key, certificate_sha256: hash(await readFile(ca)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
    const executable = join(process.cwd(), 'ops/cli/fleet-authority-issuer.py');
    const uid = process.geteuid?.() ?? 0, socket = join(directory, 'signed.sock');
    const authorityCommand = { python: '/usr/bin/python3', executable, sha256: hash(await readFile(executable)),
      policy_file: policyFile, policy_sha256: hash(await readFile(policyFile)) };
    await runAuthorityReadiness(authorityCommand);
    bridge = await startSignedFleetAuthorityBridge(socket, fixture.database.pool, { ownerUid: uid, peerUid: uid,
      command: authorityCommand });
    const client = new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid });
    const serverKey = join(directory, 'server.key'), serverCsr = join(directory, 'server.csr'), serverCert = join(directory, 'server.crt');
    const extensions = join(directory, 'extensions');
    await writeFile(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
    await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', serverKey, '-out', serverCsr]);
    await execute('openssl', ['x509', '-req', '-in', serverCsr, '-CA', ca, '-CAkey', key, '-CAcreateserial', '-days', '1',
      '-extfile', extensions, '-out', serverCert]);
    const provider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
      registries.base_mtls, registries.fleet_mtls, namespace, uid));
    bootstrap = await buildGateway({ pool: fixture.database.pool, repository: new CauceRepository(fixture.database.pool),
      logger: false, authProvider: provider('normal'), signedFleetAuthorityClient: client,
      bootstrapProviders: { bootstrap: provider('bootstrap'), normal: provider('normal'),
        token: new FleetTokenProbeAuthProvider(registries.fleet_token, uid, registries.base_token) },
      https: { key: await readFile(serverKey), cert: await readFile(serverCert), ca: await readFile(ca), requestCert: true, rejectUnauthorized: true } });
    const bootstrapUrl = await bootstrap.listen({ host: '127.0.0.1', port: 0 });
    const setup = { ...release.setupConfig, files: [{ name: 'fleet-ca', path: ca }], policy: { ...release.setupConfig.policy,
      transport: { bootstrap_url: bootstrapUrl, gateway_url: bootstrapUrl, ca_certificate: '@install@/files/fleet-ca', network: 'host' },
      authority: { identity_directory: '@identity@', host_id: '@host@', ca_certificate: '@install@/files/fleet-ca' } } };
    const resolved = await resolveHostSetup(setup);
    const packager = new HostSetupPackager(resolved, release.signingKey);
    const setContainerTemplatePrefix = (prefix: string) => {
      const template = resolved.policy.container_templates[0];
      if (!template || typeof template.prefix !== 'string') throw new Error('laboratory container template is unavailable');
      const previous = template.prefix;
      template.prefix = prefix;
      return previous;
    };
    const port = Number(new URL(fixture.gatewayUrl).port);
    await fixture.app.close();
    if (!auth) throw new Error('laboratory password authority was not captured');
    app = await buildGateway({ pool: fixture.database.pool, authProvider: auth,
      logger: { level: 'info', stream: fixture.gatewayDiagnostics }, hostSetup: packager, signedFleetAuthorityClient: client,
      consoleOrigins: [fixture.baseUrl], https: { key: await readFile(fixture.pki.server.key), cert: await readFile(fixture.pki.server.cert),
        ca: await readFile(fixture.pki.ca.cert), requestCert: true, rejectUnauthorized: true } });
    await app.listen({ host: '127.0.0.1', port });
    return { ...fixture, app, bootstrapUrl, authorityCa: ca, setContainerTemplatePrefix, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'complete gateway setup and cleanup failed'); }
    throw error;
  }
}
