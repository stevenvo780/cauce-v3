import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { startLocalDeployment, type LocalDeployment } from './route-isolation-external.fixtures.js';
import { canaryStates, type CanaryState, type Side } from './route-isolation-external-canary.js';
import { compareSnapshots, volatilePaths } from './route-isolation-external-snapshot.js';
import { MATRIX_CASES, runExternalVerification, type ExternalReceipt } from './route-isolation-external.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = ['services/gateway/src/security/route-isolation-external-cli.ts'];
const tsx = join(root, 'node_modules/.bin/tsx');
let server: TestDatabase | undefined;
const deployments: LocalDeployment[] = [];
let directory: string;

async function deployment(): Promise<LocalDeployment> {
  if (!server) throw new Error('PostgreSQL test server unavailable');
  const local = await startLocalDeployment(server);
  deployments.push(local);
  return local;
}

async function command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(tsx, [...cli, ...args], { cwd: root, timeout: 300_000, env: { ...process.env, NODE_ENV: 'test' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

async function companies(local: LocalDeployment, runId: string) {
  return (await local.database.adminPool.query<{ id: string; retired: boolean }>(
    "SELECT id,retired_at IS NOT NULL AS retired FROM companies WHERE id LIKE $1 ORDER BY id", [`zz-canary-${runId}-%`])).rows;
}

preparePostgresSuite(import.meta.url, async () => {
  server = await startTestDatabase();
  directory = await mkdtemp(join(root, '.test-state/verify-external-receipts-'));
}, 180_000, ['refuses unsafe targets and plans without any network request', 'flags volatile snapshot paths and real changes']);

afterAll(async () => {
  for (const local of deployments) await local.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  await server?.pool.end();
  await server?.container.stop();
});

describe('external isolation verification against a served gateway', () => {
  it('refuses unsafe targets and plans without any network request', async () => {
    const plain = await command(['--base-url', 'http://consola.example.invalid', '--dry-run']);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('https');
    const fast = await command(['--base-url', 'https://consola.example.invalid', '--rate', '50', '--dry-run']);
    expect(fast.code).toBe(2);
    expect(fast.stderr).toContain('--rate');
    const plan = await command(['--base-url', 'https://consola.example.invalid', '--run-id', 'plan0001', '--dry-run']);
    expect(plan.code).toBe(0);
    const parsed = JSON.parse(plan.stdout) as { dry_run: boolean; canaries: { company: string }[]; matrix: { cases: number }; estimated_requests: number };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.canaries.map(item => item.company)).toEqual(['zz-canary-plan0001-a', 'zz-canary-plan0001-b']);
    expect(parsed.matrix.cases).toBe(MATRIX_CASES.length);
    expect(parsed.estimated_requests).toBeGreaterThan(MATRIX_CASES.length);
    const scratch = await mkdtemp(join(root, '.test-state/verify-external-forged-'));
    try {
      const forged = canaryStates('forged01');
      forged.b.slug = 'humanizar';
      await mkdir(join(scratch, 'forged01'), { recursive: true });
      await writeFile(join(scratch, 'forged01', 'canaries.json'), JSON.stringify(forged));
      const refused = await command(['--base-url', 'https://consola.example.invalid', '--cleanup', 'forged01', '--out-dir', scratch]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('does not describe the canaries');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it('flags volatile snapshot paths and real changes', () => {
    const first = new Map([['/a.version', '1'], ['/a.observed_at', '"t1"']]);
    const second = new Map([['/a.version', '1'], ['/a.observed_at', '"t2"']]);
    const volatile = volatilePaths(first, second);
    expect([...volatile]).toEqual(['/a.observed_at']);
    expect(compareSnapshots(second, new Map([['/a.version', '1'], ['/a.observed_at', '"t3"']]), volatile)).toEqual([]);
    expect(compareSnapshots(second, new Map([['/a.version', '2'], ['/a.observed_at', '"t3"']]), volatile)).toEqual(['/a.version']);
    expect(compareSnapshots(second, new Map([['/a.version', '1'], ['/a.observed_at', '"t3"'], ['/a.extra', '1']]), volatile)).toEqual(['/a.extra']);
  });

  it('runs the production command end to end: walk, every manipulation with zero failures, then retires both canaries', async () => {
    const local = await deployment();
    const runId = 'local0001';
    const result = await command(['--base-url', local.baseUrl, '--oauth-issuer', local.oauthIssuer, '--run-id', runId, '--rate', '100', '--out-dir', directory]);
    expect(result.stdout, result.stderr).toContain('VERIFY_EXTERNAL');
    const receipt = JSON.parse(await readFile(join(directory, runId, 'receipt.json'), 'utf8')) as ExternalReceipt;
    expect(receipt.failures, JSON.stringify(receipt.failures)).toEqual([]);
    expect(result.code).toBe(0);
    expect(receipt).toMatchObject({ schema: 'cauce.verify-external/v1', base_url: local.baseUrl, run_id: runId });
    expect(receipt.client.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(receipt.totals.cases).toBeGreaterThan(MATRIX_CASES.length);
    expect(receipt.totals.passed).toBeGreaterThan(250);
    expect(receipt.canaries).toEqual([
      { side: 'a', company: `zz-canary-${runId}-a`, registered: true, retired: true },
      { side: 'b', company: `zz-canary-${runId}-b`, registered: true, retired: true }]);
    const steps = new Set(receipt.walk.filter(step => step.outcome === 'pass').map(step => `${step.side} ${step.step}`));
    for (const name of ['register', 'login', 'session', 'room', 'person', 'invitation', 'logout']) expect(steps).toContain(`b ${name}`);
    expect(receipt.cases.filter(item => item.class === 'header').length).toBeGreaterThan(10);
    expect(Object.values(receipt.snapshot?.routes ?? {}).filter(status => status === '200').length).toBeGreaterThanOrEqual(12);
    expect(receipt.snapshot?.fields).toBeGreaterThan(50);
    expect(receipt.cases.filter(item => item.class === 'credential' && item.outcome === 'pass').length).toBeGreaterThanOrEqual(8);
    expect(receipt.cases.filter(item => item.class === 'websocket' && item.outcome === 'pass')).toHaveLength(2);
    expect(await companies(local, runId)).toEqual([{ id: `zz-canary-${runId}-a`, retired: true }, { id: `zz-canary-${runId}-b`, retired: true }]);
    const reader = await local.database.adminPool.query<{ active: boolean }>('SELECT active FROM console_users WHERE email=$1',
      [`zz-canary-${runId}-b-lector@canary.example.invalid`]);
    expect(reader.rows).toEqual([{ active: false }]);
    await expect(stat(join(directory, runId, 'canaries.json'))).rejects.toThrow();
    expect((await stat(join(directory, runId, 'receipt.json'))).mode & 0o777).toBe(0o600);
    const text = await readFile(join(directory, runId, 'receipt.json'), 'utf8');
    expect(text).not.toMatch(/password|csrf_token|cookie=/iu);
  }, 300_000);

  it('detects a leaked identifier and a cross-company write, and a stranded run is retired by --cleanup', async () => {
    const local = await deployment();
    const runId = 'local0002';
    const owners = new Map<string, Side>();
    let layoutShifted = false;
    let cut = false;
    const tampering: typeof fetch = async (input, init) => {
      if (cut) throw new Error('network down');
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const response = await fetch(input, init);
      if (url.pathname === '/v3/auth/login' && response.status === 200) {
        const email = (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { email: string }).email;
        const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
        owners.set(cookie, email.endsWith('-a@canary.example.invalid') ? 'a' : 'b');
      }
      const side = headers.cookie === undefined ? undefined : owners.get(headers.cookie);
      if (side === 'a' && init?.method === 'GET' && url.pathname === '/v3/console/topology' && !url.search && headers['x-cauce-tenant'] === undefined) {
        return new Response(`{"leak":"zz-canary-${runId}-b"}`, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (side === 'a' && init?.method === 'PATCH' && url.pathname === `/v3/console/companies/zz-canary-${runId}-b`) layoutShifted = true;
      if (side === 'b' && layoutShifted && init?.method === 'GET' && url.pathname === '/v3/console/office/layout') {
        const body = JSON.parse(await response.text()) as { version: number };
        return new Response(JSON.stringify({ ...body, version: body.version + 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return response;
    };
    const receipt = await runExternalVerification({ baseUrl: local.baseUrl, oauthIssuer: local.oauthIssuer, runId, ratePerSecond: 100,
      maxRequests: 4000, client: { sha: 'test', dirty: true }, fetchImpl: tampering });
    const failed = new Map(receipt.failures.map(item => [item.id, item.detail]));
    expect(failed.get('GET /v3/console/topology')).toContain('exposed company B data');
    expect(failed.get('PATCH /v3/console/companies/:company_id')).toContain('company B changed: /v3/console/office/layout.version');
    expect(receipt.failures).toHaveLength(2);
    expect(receipt.canaries.every(item => item.retired)).toBe(true);

    const strandedId = 'local0003';
    const statePath = join(directory, strandedId, 'canaries.json');
    let saved: Record<Side, CanaryState> = canaryStates(strandedId);
    const persist = async (states: Record<Side, CanaryState>) => { saved = structuredClone(states); };
    const cutAfterWalk: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).endsWith('/v3/console/office/layout') && init?.method === 'PUT') cut = true;
      return tampering(input, init);
    };
    owners.clear();
    const stranded = await runExternalVerification({ baseUrl: local.baseUrl, oauthIssuer: local.oauthIssuer, runId: strandedId, ratePerSecond: 100,
      maxRequests: 4000, client: { sha: 'test', dirty: true }, fetchImpl: cutAfterWalk, persist });
    expect(stranded.fatal).toBeDefined();
    expect(stranded.canaries.filter(item => item.registered && !item.retired)).toHaveLength(2);
    expect((await companies(local, strandedId)).every(company => !company.retired)).toBe(true);
    await mkdir(join(directory, strandedId), { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
    const recovery = await command(['--base-url', local.baseUrl, '--cleanup', strandedId, '--rate', '100', '--out-dir', directory]);
    expect(recovery.stdout, recovery.stderr).toContain('failures=0');
    expect(recovery.code).toBe(0);
    expect(await companies(local, strandedId)).toEqual([{ id: `zz-canary-${strandedId}-a`, retired: true }, { id: `zz-canary-${strandedId}-b`, retired: true }]);
    await expect(stat(statePath)).rejects.toThrow();
  }, 300_000);
});
