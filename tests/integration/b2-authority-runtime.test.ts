import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { requireDockerLab } from './b2-lab.js';
import { fileDigests, startRuntimeAuthority } from './b2-authority-runtime.helpers.js';

let database: TestDatabase; let current: EmptyTestDatabase;
let authority: Awaited<ReturnType<typeof startRuntimeAuthority>> | undefined;
beforeAll(async () => { await requireDockerLab(); database = await startTestDatabase(); }, 120_000);
beforeEach(async () => { current = await startTestCaseDatabase(database); authority = await startRuntimeAuthority(current.url); }, 120_000);
afterEach(async () => { await authority?.close(); authority = undefined; await current.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
function active() { if (!authority) throw new Error('isolated authority absent'); return authority; }

describe('B2 runtime provenance through the real standalone authority enclave', () => {
  it('resolves only an issued normal certificate to its host and runtime without changing private files', async () => {
    const enclave = active(); const before = await fileDigests(enclave.directory);
    const identity = await enclave.client().resolveRuntimeAuthority(enclave.fingerprint);
    expect(identity).toEqual({ tenant_id: 'B2Tenant', alias: 'b2-agent', host_id: 'zz-canary-b2-host',
      runtime_key: 'b2-runtime', expires_at: enclave.expiresAt });
    expect(await enclave.client().resolveRuntimeAuthority('0'.repeat(64))).toBeNull();
    expect(await fileDigests(enclave.directory)).toEqual(before);
    expect(enclave.diagnostic()).toBe('');
    console.info('B2_AUTHORITY_RUNTIME_REAL', JSON.stringify({ enclave_process: true, issuer_process: true,
      known_certificate_resolved: true, unknown_certificate_rejected: true, private_files_unchanged: true }));
  });
  it('fails closed when the pinned issuer policy changes instead of returning a runtime identity', async () => {
    const enclave = active();
    await writeFile(enclave.policy, '{}', { mode: 0o600 });
    await expect(enclave.client().resolveRuntimeAuthority(enclave.fingerprint)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE', statusCode: 503 });
    expect(enclave.child.exitCode).toBeNull();
    expect(enclave.diagnostic()).toBe('');
  });
});
