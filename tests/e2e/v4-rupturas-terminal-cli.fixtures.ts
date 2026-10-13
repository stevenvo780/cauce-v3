import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { objectRecord } from '@cauce/protocol';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { closeTestDatabase, startTestDatabase } from '../helpers/postgres.js';

export const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
export interface CliResult { code: number | null; stdout: string; stderr: string }
export interface RuptureReceipt {
  kind: string; id: string; component: string; cause: string; command: string;
  operator_evidence: Record<string, unknown>;
}
export function emitReceipt(receipt: RuptureReceipt): void {
  process.stdout.write(`V4_RUPTURE_RECEIPT ${JSON.stringify(receipt)}\n`);
}
export async function runCli(args: string[], input = ''): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', [join(root, 'ops/cli/cauce'), ...args], {
      cwd: root, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let expired = false;
    const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 40_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', () => { clearTimeout(deadline); reject(new Error('CLI drill process did not start')); });
    child.once('close', code => {
      clearTimeout(deadline);
      if (expired) reject(new Error('CLI drill process exceeded its deadline'));
      else resolveResult({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
export function jsonLogLines(raw: string): Record<string, unknown>[] {
  return raw.split('\n').flatMap(line => {
    try {
      const value: unknown = JSON.parse(line);
      const row = objectRecord(value);
      return row ? [row] : [];
    } catch { return []; }
  });
}
export async function startCliDrill() {
  const directory = await mkdtemp(join(tmpdir(), 'zz-canary-cli-rupture-'));
  const database = await startTestDatabase({ requireOwnedContainer: true }).catch(async error => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const close = async () => {
    try { await app?.close(); }
    finally {
      try { await closeTestDatabase(database); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
  try {
    await seedSyntheticCompanyContexts(database.adminUrl);
    const password = randomBytes(24).toString('base64url');
    await database.adminPool.query('UPDATE console_users SET password_hash=$1',
      [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 })]);
    app = await buildGateway({ pool: database.pool,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(database.pool), signingKey: randomBytes(32) }),
      logger: { level: 'info', file: join(directory, 'gateway.log') },
    });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const sessionFile = join(directory, 'operator.session');
    const login = await runCli(['login', '--gateway', gateway, '--email', 'context_alpha@dev.example',
      '--password-stdin', '--session-file', sessionFile], `${password}\n`);
    if (login.code !== 0) throw new Error('CLI drill human login failed');
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as { cookie: string; csrf_token: string };
    const secrets = [password, session.cookie, session.csrf_token];
    const inputFile = join(directory, 'context-input.json');
    await writeFile(inputFile, JSON.stringify([{ path: 'context/mission.md', content: 'Synthetic CLI rupture mission.' }]), { mode: 0o600 });
    return { directory, gateway, sessionFile, inputFile, secrets, close,
      logs: () => readFile(join(directory, 'gateway.log'), 'utf8'),
      contextArgs: ['context', '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile,
        '--tenant', 'ContextAlpha', '--alias', 'director', 'edit', '--expected-version', '0', '--input', inputFile],
    };
  } catch (error) { await close(); throw error; }
}
