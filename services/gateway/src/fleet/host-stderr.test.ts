import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedTail, MAX_STDERR_BYTES, redactExecutorStderr } from './host-stderr.js';
import { performHostCommand } from './host-command.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetExecution } from './executor.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const execution = { request: { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' },
  expected_revision: 0, idempotency_key: 'stop-one-safe', parameters: {} }, operation: { id: '71000000-0000-4000-8000-000000000001' }, fenced_targets: [] } as unknown as FleetExecution;

describe('executor stderr diagnostics', () => {
  it('redacts PEM blocks, bearer tokens, key=value secrets and long encoded runs', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';
    const text = `boom ${pem} Authorization: Bearer abc.def-ghi password=hunter2 token: "s3cret value" api_key=xyz `
      + `${'A'.repeat(40)} ${'0123456789abcdef'.repeat(3)} ssl: certificate verify failed for /var/lib/cauce-v3/pki`;
    const output = redactExecutorStderr(text);
    for (const secret of ['MIIEvQ', 'abc.def-ghi', 'hunter2', 's3cret', 'xyz', 'AAAAAAAA', '0123456789abcdef0123']) expect(output).not.toContain(secret);
    expect(output).toContain('certificate verify failed for /var/lib/cauce-v3/pki');
    expect(output).not.toContain('\n');
  });
  it('redacts a PEM block whose end was cut by the tail bound', () => {
    expect(redactExecutorStderr('error -----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegPjMC')).toBe('error [redacted]');
  });
  it('keeps only the last bytes of a noisy stream', () => {
    const tail = new BoundedTail();
    tail.push(Buffer.from('x'.repeat(MAX_STDERR_BYTES))); tail.push(Buffer.from('END'));
    expect(tail.text().length).toBe(MAX_STDERR_BYTES);
    expect(tail.text().endsWith('xEND')).toBe(true);
  });
  it('logs one redacted line on failure without leaking stderr into the returned error', async () => {
    const directory = await mkdtemp('/var/tmp/cauce-host-stderr-'); directories.push(directory);
    const executable = join(directory, 'host.py');
    await writeFile(executable, "import sys; print('token=TOPSECRET-VALUE tls handshake failed', file=sys.stderr); sys.exit(3)");
    const config = { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 1000 };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure: unknown = await performHostCommand(config, 'stop', execution, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Host effect could not be verified');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('TOPSECRET');
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('step=stop'); expect(line).toContain('exit=3'); expect(line).toContain('tls handshake failed');
    expect(line).not.toContain('TOPSECRET'); expect(line).not.toContain('\n');
  });
});
