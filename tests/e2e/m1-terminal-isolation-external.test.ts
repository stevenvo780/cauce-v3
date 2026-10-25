import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { isTerminalIsolationRoute, MATRIX_CASES, type ExternalReceipt } from '../../services/gateway/src/security/route-isolation-external.js';
import { OWNER, receipt, RECEIPTS, startTerminalIsolationFixture } from './m1-terminal-isolation-external.helpers.js';

const execute = promisify(execFile);
let fixture: Awaited<ReturnType<typeof startTerminalIsolationFixture>> | undefined;
beforeAll(async () => { fixture = await startTerminalIsolationFixture(); }, 1_200_000);
afterAll(async () => { await fixture?.close(); }, 180_000);

describe.sequential('external CLI isolation through the real gateway and terminal relay', () => {
  test('registers two owned companies and proves terminal isolation twice consecutively', async () => {
    assert.ok(fixture);
    const active = fixture;
    await mkdir(RECEIPTS, { recursive: true });
    const results: Record<string, unknown>[] = [];
    for (const round of [1, 2]) {
      const runId = `m1${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const path = join(RECEIPTS, `external-round-${String(round)}.json`);
      const args = ['verify:external', '--base-url', active.fixture.baseUrl, '--oauth-issuer', active.oauthIssuer,
        '--run-id', runId, '--rate', '100', '--max-requests', '6000',
        '--terminal-fixture-socket', active.socketPath, '--out-dir', join(active.fixture.directory, 'external-state'), '--receipt', path];
      let result: { code: number; stdout: string; stderr: string };
      try {
        const output = await execute('pnpm', args, { cwd: process.cwd(), timeout: 360_000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: join(active.fixture.directory, 'ca.crt') } });
        result = { code: 0, ...output };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        result = { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
      await writeFile(join(RECEIPTS, `external-round-${String(round)}.log`), result.stdout + result.stderr, { mode: 0o600 });
      const evidence = JSON.parse(await readFile(path, 'utf8')) as ExternalReceipt;
      const routes = evidence.cases.filter(item => isTerminalIsolationRoute(item.route) || item.route.startsWith('/v3/bootstrap/'));
      const requiredMatrix = MATRIX_CASES.filter(item => isTerminalIsolationRoute(item.url) || item.url.startsWith('/v3/bootstrap/'))
        .flatMap(item => [`${item.method} ${item.url}`, ...(item.method === 'GET' ? [`HEAD ${item.url}`] : [])]);
      const nominal = ['owner creates grant', 'owner lists grant', 'owner lists target', 'owner opens session',
        'real PTY nonce', 'owner lists active session', 'valid mTLS bearer claim'];
      const requiredAttacks = [
        ...['a', 'b'].flatMap(side => nominal.map(name => `terminal ${side} ${name}`)),
        ...['owner', 'control', 'extend', 'delete'].map(action => `terminal A uses B valid ${action} credentials`),
        ...['PATCH', 'DELETE'].map(method => `terminal A uses B real grant ${method}`),
        ...['without cookie', 'without CSRF', 'with B CSRF', 'with foreign Origin', 'with cross-site fetch']
          .map(label => `terminal own action ${label}`),
        ...['targets', 'grants', 'sessions'].map(route => `terminal forged headers without cookie /v3/console/terminal/${route}`),
        ...['consume', 'resume', 'authz', 'close'].map(action => `terminal valid relay A ${action} credential against B`),
        ...['consume', 'resume', 'authz'].map(action => `terminal valid relay A proof bound against B ${action}`),
        ...['no_certificate', 'wrong_certificate', 'wrong_bearer'].map(identity => `terminal relay ${identity}`),
      ];
      await receipt(`terminal-round-${String(round)}`, { owner: OWNER, runId, command: ['pnpm', ...args], exitCode: result.code,
        totals: evidence.totals, cases: routes, canaries: evidence.canaries });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(evidence.failures, []);
      assert.equal(evidence.totals.failures, 0);
      const passedIds = new Set(evidence.cases.filter(item => item.outcome === 'pass').map(item => item.id));
      assert.deepEqual([...requiredMatrix, ...requiredAttacks].filter(id => !passedIds.has(id)), []);
      assert.deepEqual(routes.filter(item => item.outcome !== 'pass'), []);
      assert.equal(evidence.canaries.length, 2);
      assert.ok(evidence.canaries.every(company => company.registered && company.retired));
      const rows = (await active.fixture.database.pool.query<{ id: string; retired: boolean }>(
        'SELECT id,retired_at IS NOT NULL AS retired FROM companies WHERE id=ANY($1::text[]) ORDER BY id',
        [evidence.canaries.map(company => company.company)])).rows;
      assert.equal(rows.length, 2);
      assert.ok(rows.every(company => company.retired));
      assert.equal(active.runtime.proofs.filter(proof => proof.runId === runId && proof.ptyNonceVerified === true).length, 2);
      results.push({ round, runId, exitCode: result.code, totals: evidence.totals, terminalAndBootstrapCases: routes.length,
        retiredCompanies: rows, realPtyNonceProofs: 2 });
    }
    await receipt('two-consecutive-runs', { result: 'PASS', owner: OWNER, runs: results });
  }, 900_000);
});
