// Throwaway TLS material for the interop harness.
//
// Everything here lives in a temporary directory created at test time and is destroyed with
// it: no production key ever touches this tree. Only paths and byte lengths are ever logged.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Generates a self-signed certificate valid for localhost/127.0.0.1 and returns the PEM
 * bytes plus the directory holding them. Uses the system openssl: adding a certificate
 * library to the repo for a test fixture is not worth a dependency.
 */
export function createSelfSignedCert(options = {}) {
  const directory = mkdtempSync(path.join(options.directory ?? tmpdir(), 'cauce-pty-tls-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', String(options.days ?? 1),
    '-keyout', keyPath, '-out', certPath,
    '-subj', `/CN=${options.common_name ?? 'localhost'}`,
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'pipe' });
  return {
    directory,
    key_path: keyPath,
    cert_path: certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}
