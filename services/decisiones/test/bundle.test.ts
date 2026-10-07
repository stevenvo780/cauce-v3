import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeJev } from './support/fake-jev.js';
import { createTestPki, writeIdentities } from './support/pki.js';

/**
 * The artifact that ships: the single-file bundle started as `node dist/decisiones.mjs`, configured
 * only by environment, answering over mTLS and stopping cleanly on SIGTERM.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0); });
    });
  });
}

describe('bundle de despliegue', () => {
  const jev = new FakeJev();
  let child: ChildProcess | undefined;
  afterAll(async () => {
    child?.kill('SIGKILL');
    await jev.stop();
  });

  it('arranca sólo con variables de entorno, decide por mTLS y se apaga con SIGTERM', async () => {
    execFileSync('pnpm', ['run', 'build'], { cwd: PACKAGE, stdio: 'ignore' });
    const hostUid = process.getuid?.(); const hostGid = process.getgid?.();
    if (hostUid === undefined || hostGid === undefined) throw new Error('Bundle fixture requires POSIX UID and GID');
    const asRoot = hostUid === 0;
    const uid = asRoot ? 65534 : hostUid; const gid = asRoot ? 65534 : hostGid;
    const bundle = join(PACKAGE, 'dist/decisiones.mjs');
    if (asRoot) {
      const refused = spawnSync(process.execPath, [bundle], {
        env: { PATH: process.env.PATH, NODE_ENV: 'test' }, timeout: 5_000, encoding: 'utf8',
      });
      expect(refused.status).toBe(78);
      expect(`${refused.stdout}${refused.stderr}`).toContain('decisiones_rechazado');
      expect(`${refused.stdout}${refused.stderr}`).toContain('root_euid');
    }
    await jev.start();
    const pki = createTestPki();
    const directory = mkdtempSync(join(tmpdir(), 'cauce-decisiones-bundle-'));
    const serverCert = join(directory, 'server.crt'); const serverKey = join(directory, 'server.key');
    const caCert = join(directory, 'ca.crt');
    for (const [source, target] of [[pki.serverCert, serverCert], [pki.serverKey, serverKey], [pki.caCert, caCert]] as const) {
      copyFileSync(source, target);
    }
    const identities = join(directory, 'mtls_identities.json');
    writeIdentities(identities, [{ fingerprint: pki.client('zeus').fingerprint, alias: 'zeus' }]);
    const keyFile = join(directory, 'jev.key');
    writeFileSync(keyFile, 'tsk_bundle_0123456789abcdefghijkl\n', { mode: 0o600 });
    for (const path of [serverCert, serverKey, caCert, identities, keyFile]) {
      chmodSync(path, 0o600);
      if (asRoot) chownSync(path, uid, gid);
    }
    chmodSync(directory, 0o700);
    if (asRoot) chownSync(directory, uid, gid);
    const auditFile = join(directory, 'auditoria.jsonl');
    const [port, healthPort] = [await freePort(), await freePort()];
    child = spawn(process.execPath, [bundle], {
      ...(asRoot ? { uid, gid } : {}),
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test',
        CAUCE_DECISIONES_HOST: '127.0.0.1', CAUCE_DECISIONES_PORT: String(port), CAUCE_DECISIONES_HEALTH_PORT: String(healthPort),
        CAUCE_DECISIONES_TLS_CERT_FILE: serverCert, CAUCE_DECISIONES_TLS_KEY_FILE: serverKey,
        CAUCE_DECISIONES_CLIENT_CA_FILE: caCert, CAUCE_DECISIONES_IDENTITY_FILE: identities,
        CAUCE_DECISIONES_JEV_URL: jev.url, CAUCE_DECISIONES_JEV_KEY_FILE: keyFile,
        CAUCE_DECISIONES_AUDIT_FILE: auditFile,
        CAUCE_DECISIONES_ALIASES: 'zeus', CAUCE_DECISIONES_TENANTS: 'Steven',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => { child?.once('exit', (code) => { resolve(code); }); });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      ready = await fetch(`http://127.0.0.1:${String(healthPort)}/health/ready`).then((response) => response.ok, () => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const zeus = pki.client('zeus');
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const outgoing = request({
        host: '127.0.0.1', port, path: '/v1/decidir', method: 'POST', headers: { 'content-type': 'application/json' },
        ca: readFileSync(pki.caCert), cert: readFileSync(zeus.cert), key: readFileSync(zeus.key),
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => { resolve(JSON.parse(text) as Record<string, unknown>); });
      });
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify({ plantilla: 'requiere_respuesta', state: { mensaje: 'gracias' } }));
    });
    expect(answer).toMatchObject({ plantilla: 'requiere_respuesta', origen: 'jev' });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    child = undefined;
    const audit = statSync(auditFile);
    expect(audit.uid).toBe(uid); expect(audit.gid).toBe(gid);
    expect(audit.mode & 0o777).toBe(0o600);
    console.info('DECISIONES_BUNDLE_RUNTIME_IDENTITY', JSON.stringify({ hostUid, uid: audit.uid, gid: audit.gid }));
  });
});
