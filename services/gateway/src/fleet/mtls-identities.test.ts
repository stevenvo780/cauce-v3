import { chmod, link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetMtlsIdentityProvider, FleetTokenProbeAuthProvider, fleetBaseRegistryOwners } from './mtls-identities.js';
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
  return { base, fleet, write, provider: (namespace: 'normal' | 'bootstrap') => new FleetMtlsIdentityProvider(base, fleet, namespace, (process.geteuid?.() ?? -1)) };
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

describe('base registry owner rule', () => {
  const uid = process.geteuid?.() ?? -1;
  const other = uid + 1;
  const build = (f: Awaited<ReturnType<typeof fixture>>, baseOwners: readonly number[], fleetOwner = uid) =>
    new FleetMtlsIdentityProvider(f.base, f.fleet, 'normal', fleetOwner, baseOwners);
  it('accepts a base registry owned by an allowed uid and rejects any other owner', async () => {
    const f = await fixture();
    expect((await build(f, [0, uid]).resolveFingerprintAuthority('a'.repeat(64))).principal).toEqual(normal);
    await expect(build(f, [0, other]).resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('unavailable');
  });
  it('keeps the fleet registry restricted to its own owner even when the base owner is allowed', async () => {
    const f = await fixture();
    await expect(build(f, [0, uid], other).resolveFingerprintAuthority('c'.repeat(64))).rejects.toThrow('unavailable');
  });
  it('rejects a group or world writable base registry and a hard-linked one', async () => {
    const f = await fixture();
    await chmod(f.base, 0o620);
    await expect(build(f, [uid]).resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('unavailable');
    await chmod(f.base, 0o602);
    await expect(build(f, [uid]).resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('unavailable');
    await chmod(f.base, 0o400);
    expect((await build(f, [uid]).resolveFingerprintAuthority('a'.repeat(64))).principal).toEqual(normal);
    await link(f.base, `${f.base}.alias`);
    await expect(build(f, [uid]).resolveFingerprintAuthority('a'.repeat(64))).rejects.toThrow('unavailable');
  });
  it('applies the same base rule to token probes', async () => {
    const f = await fixture();
    const hash = 'd'.repeat(64);
    await f.write(f.base, [{ token_sha256: hash, principal: normal, expires_at: new Date(Date.now() + 60_000).toISOString() }]);
    const request = { headers: { authorization: `Bearer ${'0'.repeat(64)}` } } as never;
    await expect(new FleetTokenProbeAuthProvider(f.fleet, uid, f.base, [other]).authenticateHttp(request)).rejects.toThrow('unavailable');
    await expect(new FleetTokenProbeAuthProvider(f.fleet, uid, f.base, [uid]).authenticateHttp(request)).rejects.toThrow('no longer provisioned');
  });
  it('derives the allowed base owners from root and the process uid', () => {
    expect(fleetBaseRegistryOwners(1000)).toEqual([0, 1000]);
    expect(fleetBaseRegistryOwners(0)).toEqual([0]);
  });
  it('never takes bootstrap authority from the base registry', async () => {
    const f = await fixture();
    await f.write(f.base, [entry('e'.repeat(64), restricted), entry('f'.repeat(64), restricted)]);
    await f.write(f.fleet, [entry('f'.repeat(64), restricted)]);
    const provider = new FleetMtlsIdentityProvider(f.base, f.fleet, 'bootstrap', uid, [0, uid]);
    await expect(provider.resolveFingerprintAuthority('e'.repeat(64))).rejects.toThrow('no longer provisioned');
    expect((await provider.resolveFingerprintAuthority('f'.repeat(64))).principal).toEqual(restricted);
    await chmod(f.base, 0o666);
    expect((await provider.resolveFingerprintAuthority('f'.repeat(64))).principal).toEqual(restricted);
    const normalProvider = new FleetMtlsIdentityProvider(f.base, f.fleet, 'normal', uid, [0, uid]);
    await expect(normalProvider.resolveFingerprintAuthority('f'.repeat(64))).rejects.toThrow('unavailable');
  });
});
