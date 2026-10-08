import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetMtlsIdentityProvider } from './mtls-identities.js';
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const normal = { tenant_id: 'Steven', alias: 'new_agent', session_id: 'adapter-new-agent', channel: 'adapter', roles: ['adapter'], permissions: ['read', 'route'] };
const restricted = { ...normal, channel: 'bootstrap', roles: [], permissions: [] };
const entry = (fingerprint: string, principal: unknown) => ({ certificate_sha256: fingerprint, principal, expires_at: new Date(Date.now() + 60_000).toISOString() });
async function fixture() {
  const directory = await mkdtemp('/var/tmp/cauce-fleet-identities-'); directories.push(directory);
  const base = join(directory, 'base.json'); const fleet = join(directory, 'fleet.json');
  const write = async (path: string, identities: unknown[]) => writeFile(path, JSON.stringify({ version: 1, identities }), { mode: 0o600 });
  await write(base, [entry('a'.repeat(64), normal)]);
  await write(fleet, [entry('b'.repeat(64), restricted), entry('c'.repeat(64), normal)]);
  return { base, fleet, write, provider: (namespace: 'normal' | 'bootstrap') => new FleetMtlsIdentityProvider(base, fleet, namespace, process.geteuid!()) };
}
describe('additional fleet mTLS identities', () => {
  it('preserves the existing registry and separates bootstrap certificates from normal admission', async () => {
    const f = await fixture();
    expect((await f.provider('normal').resolveFingerprintAuthority('a'.repeat(64))).principal).toEqual(normal);
    expect((await f.provider('normal').resolveFingerprintAuthority('c'.repeat(64))).principal).toEqual(normal);
    expect((await f.provider('bootstrap').resolveFingerprintAuthority('b'.repeat(64))).principal).toEqual(restricted);
    await expect(f.provider('normal').resolveFingerprintAuthority('b'.repeat(64))).rejects.toThrow('namespace');
    await expect(f.provider('bootstrap').resolveFingerprintAuthority('c'.repeat(64))).rejects.toThrow('namespace');
  });
  it('denies duplicate fingerprints, missing registries and revocation without falling back', async () => {
    const f = await fixture();
    await f.write(f.fleet, [entry('a'.repeat(64), restricted)]);
    await expect(f.provider('normal').resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('ambiguous');
    await f.write(f.fleet, []);
    await expect(f.provider('normal').resolveFingerprintAuthority('c'.repeat(64))).rejects.toThrow('no longer provisioned');
    expect((await f.provider('normal').resolveFingerprintAuthority('a'.repeat(64))).principal).toEqual(normal);
    await rm(f.fleet);
    await expect(f.provider('normal').resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('unavailable');
  });
});
