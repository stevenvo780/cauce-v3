import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Throwaway CA, server and client certificates made with the system openssl, like the relay tests. */
export interface TestPki {
  readonly directory: string;
  readonly caCert: string;
  readonly serverCert: string;
  readonly serverKey: string;
  client(name: string): { cert: string; key: string; fingerprint: string };
  foreignClient(): { cert: string; key: string; ca: string };
}

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

function issue(directory: string, name: string, caKey: string, caCert: string, extensions: string): { cert: string; key: string } {
  const key = join(directory, `${name}.key`);
  const csr = join(directory, `${name}.csr`);
  const cert = join(directory, `${name}.crt`);
  const ext = join(directory, `${name}.ext`);
  writeFileSync(ext, extensions);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`]);
  openssl(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-sha256', '-extfile', ext]);
  chmodSync(key, 0o600);
  chmodSync(cert, 0o600);
  return { cert, key };
}

function authority(directory: string, name: string): { key: string; cert: string } {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', key, '-out', cert, '-subj', `/CN=${name}`]);
  chmodSync(cert, 0o600);
  return { key, cert };
}

export function createTestPki(): TestPki {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-decisiones-pki-'));
  const ca = authority(directory, 'ca');
  const server = issue(directory, 'server', ca.key, ca.cert, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  const clients = new Map<string, { cert: string; key: string; fingerprint: string }>();
  return {
    directory,
    caCert: ca.cert,
    serverCert: server.cert,
    serverKey: server.key,
    client(name) {
      const known = clients.get(name);
      if (known !== undefined) return known;
      const issued = issue(directory, `client-${name}`, ca.key, ca.cert, 'extendedKeyUsage=clientAuth\n');
      const fingerprint = new X509Certificate(readFileSync(issued.cert)).fingerprint256.replaceAll(':', '').toLowerCase();
      const entry = { ...issued, fingerprint };
      clients.set(name, entry);
      return entry;
    },
    foreignClient() {
      const foreign = authority(directory, 'foreign-ca');
      const issued = issue(directory, 'client-foreign', foreign.key, foreign.cert, 'extendedKeyUsage=clientAuth\n');
      return { ...issued, ca: foreign.cert };
    },
  };
}

export interface IdentityEntry {
  readonly fingerprint: string;
  readonly alias: string;
  readonly tenant?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly expiresAt?: string;
}

/** Same document shape as the gateway's mtls_identities.json. */
export function writeIdentities(path: string, entries: readonly IdentityEntry[]): void {
  writeFileSync(path, JSON.stringify({
    version: 1,
    identities: entries.map((entry) => ({
      certificate_sha256: entry.fingerprint,
      expires_at: entry.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      principal: {
        tenant_id: entry.tenant ?? 'Steven',
        alias: entry.alias,
        session_id: `mtls-${entry.alias}`,
        channel: 'mtls',
        roles: entry.roles ?? ['adapter'],
        permissions: entry.permissions ?? ['route', 'read'],
      },
    })),
  }));
}
