import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';

const execute = promisify(execFile);
const password = 'zz-canary-rupture-password';
export interface DiagnosticItem {
  type: string; id: string; component: string; error_code?: string; summary?: string;
}
export interface Diagnosis { id: string; company_id: string; items: DiagnosticItem[] }
export interface RuptureReceipt {
  kind: string; id: string; component: string; cause: string; command: string;
  operator_evidence: unknown;
}
export function receipt(value: RuptureReceipt): void {
  process.stdout.write(`V4_RUPTURE_RECEIPT ${JSON.stringify(value)}\n`);
}
export async function operatorGateway(pool: DatabasePool, email: string, source?: FleetHostSource) {
  const directory = await mkdtemp('/var/tmp/zz-canary-rupturas-');
  const app = await buildGateway({ pool, logger: { level: 'info', file: join(directory, 'gateway.log') },
    consoleOrigins: ['http://localhost'],
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 93) }),
    ...(source === undefined ? {} : { fleetOperationsRepository: source }) }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true }); throw error;
  });
  try {
    await pool.query('UPDATE console_users SET password_hash=$1 WHERE email_normalized=$2',
      [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 }), email]);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${url}/v3/auth/login`, { method: 'POST', headers: {
      origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    const body = await login.json() as { csrf_token: string };
    if (!cookie) throw new Error('Canary operator session is missing');
    const session = join(directory, 'console-session.json');
    await writeFile(session, JSON.stringify({ cookie, csrf_token: body.csrf_token, gateway: url, origin: 'http://localhost' }), { mode: 0o600 });
    const curlConfig = join(directory, 'operator-request.conf');
    await writeFile(curlConfig, `header = "Cookie: ${cookie}"\nheader = "Origin: http://localhost"\n`, { mode: 0o600 });
    const args = ['--gateway', url, '--origin', 'http://localhost', '--session-file', session];
    return {
      app, url, args, directory,
      async diagnose(id: string) {
        const command = ['bash', 'ops/cli/cauce-diagnose', id, ...args].join(' ');
        const output = await execute('bash', ['ops/cli/cauce-diagnose', id, ...args], { timeout: 70_000 });
        expect(output.stderr).toBe('');
        return { command, diagnosis: JSON.parse(output.stdout) as Diagnosis };
      },
      async request(path: string) {
        const output = await execute('curl', ['--silent', '--show-error', '--fail', '--config', curlConfig, url + path]);
        return JSON.parse(output.stdout) as unknown;
      },
      requestCommand: (path: string) => `curl --silent --show-error --fail --config ${curlConfig} '${url + path}'`,
      async close() { try { await app.close(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await app.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
