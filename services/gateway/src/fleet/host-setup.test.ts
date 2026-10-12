import { execFile } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stableHostJson } from '@cauce/store';
import { HostSetupConfigSchema, HostSetupPackager, configuredHostSetup } from './host-setup.js';
import { hostSetupConfig, setupBundle } from './host-setup.fixtures.js';

const scope = { company_id: 'acme', host_id: 'acme-laptop', harnesses: ['codex', 'openclaw'] };
function packager(overrides: Record<string, unknown> = {}) {
  return new HostSetupPackager(HostSetupConfigSchema.parse(hostSetupConfig(overrides)), generateKeyPairSync('ed25519').privateKey);
}
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('host setup packages', () => {
  it('signs the company default policy for exactly one computer, narrowed to the enabled harnesses', () => {
    const subject = packager(); const signed = subject.build(scope, 1_760_000_000_000);
    const key = createPublicKey({ key: Buffer.from(signed.signer_public_key, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(stableHostJson(signed.package)), key, Buffer.from(signed.signature, 'base64'))).toBe(true);
    expect(createHash('sha256').update(Buffer.from(signed.signer_public_key, 'base64')).digest('hex')).toBe(subject.signerFingerprint);
    const policy = signed.package.policy as Record<string, unknown>;
    expect(signed.package).toMatchObject({ version: 1, company_id: 'acme', host_id: 'acme-laptop', issued_at: 1_760_000_000_000,
      release_revision: 'a'.repeat(40), artifacts: [
        { name: 'release', kind: 'release', url: 'https://releases.example.test/executor.tar', sha256: 'b'.repeat(64), size: 4096 },
        { name: 'fleet-ca', kind: 'file', url: 'https://releases.example.test/ca.pem', sha256: 'c'.repeat(64), size: 1200 }] });
    expect(Object.keys(policy.bundles as object)).toEqual(['codex']);
    expect(policy.container_templates).toEqual([{ harness_id: 'codex', prefix: 'zz-canary-' }]);
    expect(policy.authority).toEqual({ identity_directory: '@identity@', host_id: 'acme-laptop', ca_certificate: '@install@/files/fleet-ca' });
    expect(policy.hooks).toEqual({ verify: { executable: '@release@/ops/cli/fleet-provider-hook.py', user: '@user@', argv: ['--company', 'acme'] } });
    expect((policy.transport as { network: string }).network).toBe('cauce-acme-laptop');
    const tampered = { ...signed.package, host_id: 'other-laptop' };
    expect(verify(null, Buffer.from(stableHostJson(tampered)), key, Buffer.from(signed.signature, 'base64'))).toBe(false);
  });

  it('keeps identity, roots, native runtimes and foreign identities out of the approved template', () => {
    const base = hostSetupConfig();
    const rejected: Record<string, unknown>[] = [
      { policy: { ...base.policy, executor_user: 'root' } }, { policy: { ...base.policy, signer: { certificate: '/x', key: '/y' } } },
      { policy: { ...base.policy, native: [{ runtime_user: 'root' }] } }, { policy: { ...base.policy, roots: {} } },
      { policy: { ...base.policy, authority: { ...base.policy.authority, identity_directory: '/home/other/identity' } } },
      { policy: { ...base.policy, bundles: { codex: setupBundle('/opt/adapter') } } },
      { policy: { ...base.policy, bundles: { codex: setupBundle('@release@/../adapter') } } },
      { policy: { ...base.policy, bundles: { codex: { ...setupBundle(), digest: 'd'.repeat(64) } } } },
      { release: { ...base.release, url: 'http://releases.example.test/executor.tar' } },
      { release: { ...base.release, url: 'https://user:secret@releases.example.test/executor.tar' } },
      { release: { ...base.release, revision: 'main' } },
      { files: [{ ...base.files[0], name: 'release' }] },
    ];
    for (const override of rejected) expect(HostSetupConfigSchema.safeParse(hostSetupConfig(override)).success, JSON.stringify(override)).toBe(false);
    expect(HostSetupConfigSchema.safeParse(hostSetupConfig({ release: { ...base.release, url: 'http://127.0.0.1:8080/r.tar' } })).success).toBe(true);
  });

  it('loads its configuration and key only from private files and the computer verifies the signature', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-host-setup-'));
    const keyFile = join(directory, 'signer.pem'); const configFile = join(directory, 'host-setup.json');
    const pair = generateKeyPairSync('ed25519');
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify(hostSetupConfig({ signing_key_file: keyFile })), { mode: 0o600 });
    const loaded = await configuredHostSetup({ CAUCE_FLEET_HOST_SETUP_CONFIG_FILE: configFile });
    if (!loaded) throw new Error('host setup configuration absent');
    expect(await configuredHostSetup({})).toBeUndefined();
    const signed = loaded.build(scope);
    const cli = fileURLToPath(new URL('../../../../ops/cli', import.meta.url));
    const check = `import json,sys\nsys.path.insert(0,${JSON.stringify(cli)})\nimport host_setup\nr=json.load(sys.stdin)\n`
      + 'host_setup.verify_signature(r["package"],r["signature"],r["signer_public_key"])\nprint("verified")\n';
    const run = (body: unknown) => new Promise<{ code: number; stdout: string }>(resolve => {
      const child = execFile('python3', ['-c', check], (error, stdout) => { resolve({ code: error ? 1 : 0, stdout }); });
      child.stdin?.end(JSON.stringify(body));
    });
    expect(await run(signed)).toEqual({ code: 0, stdout: 'verified\n' });
    expect((await run({ ...signed, package: { ...signed.package, company_id: 'other' } })).code).toBe(1);
    await chmod(configFile, 0o644);
    await expect(HostSetupPackager.load(configFile)).rejects.toThrow();
    await chmod(configFile, 0o600); await chmod(keyFile, 0o640);
    await expect(HostSetupPackager.load(configFile)).rejects.toThrow();
    await writeFile(keyFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await expect(HostSetupPackager.load(configFile)).rejects.toThrow('Ed25519');
  });
});
