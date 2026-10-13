import { execFile } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreError, stableHostJson } from '@cauce/store';
import { HostSetupConfigSchema, HostSetupPackager, configuredHostSetup, openHostSetupArtifact, resolveHostSetup } from './host-setup.js';
import { hostSetupConfig, setupBundle } from './host-setup.fixtures.js';

const scope = { company_id: 'acme', host_id: 'acme-laptop', harnesses: ['codex', 'openclaw'] };
function packager(overrides: Record<string, unknown> = {}) {
  return new HostSetupPackager(HostSetupConfigSchema.parse(hostSetupConfig(overrides)), generateKeyPairSync('ed25519').privateKey);
}
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const IMAGE_ID = `sha256:${'e'.repeat(64)}`;
/** A deployed release directory as host-release.py writes it, plus the small CA file the config names. */
async function deployedRelease(withImage = false) {
  directory = await mkdtemp(join(tmpdir(), 'cauce-host-setup-'));
  const release = join(directory, 'release'); await mkdir(release, { mode: 0o755 });
  const tar = Buffer.from('release archive bytes for the computer');
  await writeFile(join(release, 'release.tar'), tar, { mode: 0o644 });
  const manifest: Record<string, unknown> = { version: 1, revision: 'a'.repeat(40), release: { file: 'release.tar', sha256: sha256(tar), size: tar.length },
    pins: { adapter_digest: `sha256:${'d'.repeat(64)}`, hook_sha256: '9'.repeat(64), ...(withImage ? { image: IMAGE_ID } : {}) } };
  const image = Buffer.from('docker save | gzip -n of the agent image');
  if (withImage) {
    await writeFile(join(release, 'agent-image.tar.gz'), image, { mode: 0o644 });
    manifest.image = { file: 'agent-image.tar.gz', sha256: sha256(image), size: image.length, id: IMAGE_ID, reference: 'cauce-agent-runtime:fixture' };
  }
  await writeFile(join(release, 'host-release.json'), JSON.stringify(manifest), { mode: 0o644 });
  const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');
  await writeFile(join(directory, 'fleet-ca.pem'), ca, { mode: 0o600 });
  const base = hostSetupConfig().policy;
  const policy = { ...base, bundles: { codex: { ...setupBundle(), digest: '@pin:adapter_digest@' } },
    hooks: { verify: { ...base.hooks.verify, sha256: '@pin:hook_sha256@' } },
    container_templates: [{ harness_id: 'codex', prefix: 'zz-canary-', ...(withImage ? { image: '@pin:image@' } : {}) }] };
  const template = { version: 1, signing_key_file: join(directory, 'signer.pem'), release_directory: release,
    files: [{ name: 'fleet-ca', path: join(directory, 'fleet-ca.pem') }], policy };
  return { root: directory, release, tar, image, ca, template };
}

describe('host setup packages', () => {
  it('signs the company default policy for exactly one computer, narrowed to the enabled harnesses', () => {
    const subject = packager(); const signed = subject.build(scope, 1_760_000_000_000);
    const key = createPublicKey({ key: Buffer.from(signed.signer_public_key, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(stableHostJson(signed.package)), key, Buffer.from(signed.signature, 'base64'))).toBe(true);
    expect(createHash('sha256').update(Buffer.from(signed.signer_public_key, 'base64')).digest('hex')).toBe(subject.signerFingerprint);
    const policy = signed.package.policy as Record<string, unknown>;
    expect(signed.package).toMatchObject({ version: 1, company_id: 'acme', host_id: 'acme-laptop', issued_at: 1_760_000_000_000,
      release_revision: 'a'.repeat(40), artifacts: [
        { name: 'release', kind: 'release', sha256: 'b'.repeat(64), size: 4096 },
        { name: 'fleet-ca', kind: 'file', sha256: 'c'.repeat(64), size: 1200 }] });
    expect(JSON.stringify(signed.package)).not.toContain('/run/');
    expect(Object.keys(policy.bundles as object)).toEqual(['codex']);
    expect(policy.container_templates).toEqual([{ harness_id: 'codex', prefix: 'zz-canary-' }]);
    expect(policy.authority).toEqual({ identity_directory: '@identity@', host_id: 'acme-laptop', ca_certificate: '@install@/files/fleet-ca' });
    expect(policy.hooks).toEqual({ verify: { executable: '@release@/ops/cli/fleet-provider-hook.py', user: '@user@', argv: ['--company', 'acme'] } });
    expect((policy.transport as { network: string }).network).toBe('cauce-acme-laptop');
    const tampered = { ...signed.package, host_id: 'other-laptop' };
    expect(verify(null, Buffer.from(stableHostJson(tampered)), key, Buffer.from(signed.signature, 'base64'))).toBe(false);
  });

  it('drops a template whose harness only exists on the object prototype', () => {
    const base = hostSetupConfig();
    const subject = packager({ policy: { ...base.policy, container_templates: [...base.policy.container_templates, { harness_id: 'constructor', prefix: 'x-' }] } });
    const policy = subject.build({ ...scope, harnesses: ['codex', 'constructor'] }).package.policy as { container_templates: { harness_id: string }[] };
    expect(policy.container_templates.map(row => row.harness_id)).toEqual(['codex']);
  });

  it('signs the explicitly approved descriptor digest and rejects malformed pins', () => {
    const base = hostSetupConfig();
    const bundle = { ...setupBundle(), descriptor_sha256: 'e'.repeat(64) };
    const signed = packager({ policy: { ...base.policy, bundles: { codex: bundle } } }).build(scope);
    expect(signed.package.policy).toMatchObject({ bundles: { codex: { descriptor_sha256: bundle.descriptor_sha256 } } });
    const key = createPublicKey({ key: Buffer.from(signed.signer_public_key, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(stableHostJson(signed.package)), key, Buffer.from(signed.signature, 'base64'))).toBe(true);
    const tampered = JSON.parse(JSON.stringify(signed.package)) as typeof signed.package;
    (tampered.policy as { bundles: { codex: { descriptor_sha256: string } } }).bundles.codex.descriptor_sha256 = 'f'.repeat(64);
    expect(verify(null, Buffer.from(stableHostJson(tampered)), key, Buffer.from(signed.signature, 'base64'))).toBe(false);
    for (const pin of [null, 'SHA256:' + 'e'.repeat(64), 'e'.repeat(63), 'E'.repeat(64)]) {
      expect(HostSetupConfigSchema.safeParse(hostSetupConfig({ policy: { ...base.policy,
        bundles: { codex: { ...bundle, descriptor_sha256: pin } } } })).success).toBe(false);
    }
  });

  it('keeps identity, roots, native runtimes and foreign identities out of the approved template', () => {
    const base = hostSetupConfig();
    const image = { name: 'agent-image', id: `sha256:${'e'.repeat(64)}`, path: '/run/cauce-host-release/agent-image.tar.gz',
      sha256: 'f'.repeat(64), size: 3 * 1024 * 1024 * 1024 };
    const rejected: Record<string, unknown>[] = [
      { policy: { ...base.policy, executor_user: 'root' } }, { policy: { ...base.policy, signer: { certificate: '/x', key: '/y' } } },
      { policy: { ...base.policy, native: [{ runtime_user: 'root' }] } }, { policy: { ...base.policy, roots: {} } },
      { policy: { ...base.policy, authority: { ...base.policy.authority, identity_directory: '/home/other/identity' } } },
      { policy: { ...base.policy, bundles: { codex: setupBundle('/opt/adapter') } } },
      { policy: { ...base.policy, bundles: { codex: setupBundle('@release@/../adapter') } } },
      { policy: { ...base.policy, bundles: { codex: { ...setupBundle(), digest: 'd'.repeat(64) } } } },
      { release: { ...base.release, path: 'release.tar' } },
      { release: { ...base.release, path: '/run/cauce-host-release/../release.tar' } },
      { release: { ...base.release, url: 'https://releases.example.test/executor.tar' } },
      { release: { ...base.release, revision: 'main' } },
      { files: [{ ...base.files[0], name: 'release' }] },
      { files: [{ ...base.files[0], name: 'agent-image' }] },
      { image: { ...image, id: 'e'.repeat(64) } },
      { image, policy: { ...base.policy, container_templates: [{ harness_id: 'codex', image: `sha256:${'f'.repeat(64)}` }] } },
    ];
    for (const override of rejected) expect(HostSetupConfigSchema.safeParse(hostSetupConfig(override)).success, JSON.stringify(override)).toBe(false);
    expect(HostSetupConfigSchema.safeParse(hostSetupConfig({ image,
      policy: { ...base.policy, container_templates: [{ harness_id: 'codex', image: image.id }] } })).success).toBe(true);
  });

  it('loads its configuration and key only from private files and the computer verifies the signature', async () => {
    const { root, tar, ca, template } = await deployedRelease();
    const keyFile = template.signing_key_file; const configFile = join(root, 'host-setup.json');
    await writeFile(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify(template), { mode: 0o600 });
    const loaded = await configuredHostSetup({ CAUCE_FLEET_HOST_SETUP_CONFIG_FILE: configFile });
    if (!loaded) throw new Error('host setup configuration absent');
    expect(await configuredHostSetup({})).toBeUndefined();
    const signed = loaded.build(scope);
    expect(signed.package).toMatchObject({ release_revision: 'a'.repeat(40), artifacts: [
      { name: 'release', kind: 'release', sha256: sha256(tar), size: tar.length }, { name: 'fleet-ca', kind: 'file', sha256: sha256(ca), size: ca.length }],
      policy: { bundles: { codex: { digest: `sha256:${'d'.repeat(64)}` } }, hooks: { verify: { sha256: '9'.repeat(64) } } } });
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

  it('fills the pins of the deployed release and refuses a pin it lacks or a file that is not the one it declares', async () => {
    const { release, image, template } = await deployedRelease(true);
    const config = await resolveHostSetup(template);
    expect(config.image).toMatchObject({ name: 'agent-image', id: IMAGE_ID, sha256: sha256(image), size: image.length });
    const signed = new HostSetupPackager(config, generateKeyPairSync('ed25519').privateKey).build(scope);
    expect(signed.package.artifacts).toContainEqual({ name: 'agent-image', kind: 'image', sha256: sha256(image), size: image.length, image_id: IMAGE_ID });
    expect(signed.package.policy).toMatchObject({ container_templates: [{ harness_id: 'codex', image: IMAGE_ID }] });
    await expect(resolveHostSetup({ ...template, policy: { ...template.policy,
      transport: { network: '@pin:absent_pin@' } } })).rejects.toThrow('absent_pin');
    await expect(resolveHostSetup({ ...template, policy: { ...template.policy,
      container_templates: [{ harness_id: 'codex', image: `sha256:${'f'.repeat(64)}` }] } })).rejects.toThrow();
    await chmod(join(release, 'agent-image.tar.gz'), 0o666);
    await expect(resolveHostSetup(template)).rejects.toThrow('not the declared regular file');
    await chmod(join(release, 'agent-image.tar.gz'), 0o644);
    await writeFile(join(release, 'release.tar'), 'another candidate', { mode: 0o644 });
    await expect(resolveHostSetup(template)).rejects.toThrow('not the declared regular file');
  });

  it('serves an artifact from the signed offset and refuses names, digests and offsets the package does not sign', async () => {
    const { release, tar, template } = await deployedRelease();
    const subject = new HostSetupPackager(await resolveHostSetup(template), generateKeyPairSync('ed25519').privateKey);
    const wanted = { action: 'artifact' as const, name: 'release', sha256: sha256(tar), offset: 7 };
    const served = subject.artifact(wanted);
    const opened = await openHostSetupArtifact(served);
    const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    expect([opened.length, Buffer.concat(chunks)]).toEqual([tar.length - 7, tar.subarray(7)]);
    const refusal = (value: typeof wanted) => { try { subject.artifact(value); return 'served'; } catch (error) { return (error as StoreError).code; } };
    expect([refusal({ ...wanted, name: 'agent-image' }), refusal({ ...wanted, sha256: 'f'.repeat(64) }), refusal({ ...wanted, offset: tar.length })])
      .toEqual(['not_found', 'conflict', 'invalid_input']);
    await writeFile(join(release, 'release.tar'), Buffer.concat([tar, Buffer.from('x')]), { mode: 0o644 });
    await expect(openHostSetupArtifact(served)).rejects.toThrow('not the declared regular file');
  });

  it('reaches the production gateway through the fleet overlay, and its empty default keeps setup off', async () => {
    const overlay = await readFile(fileURLToPath(new URL('../../../../deploy/compose.fleet.yaml', import.meta.url)), 'utf8');
    expect(overlay).toMatch(/^ {6}CAUCE_FLEET_HOST_SETUP_CONFIG_FILE: \$\{CAUCE_FLEET_HOST_SETUP_CONFIG_FILE:-\}$/mu);
    expect(overlay).toContain('target: /run/cauce-fleet/config');
    expect(overlay).toMatch(/^ {8}source: \$\{CAUCE_FLEET_HOST_RELEASE_DIR:-\/dev\/null\}\n {8}target: \/run\/cauce-host-release\n {8}read_only: true$/mu);
    expect(await configuredHostSetup({ CAUCE_FLEET_HOST_SETUP_CONFIG_FILE: '' })).toBeUndefined();
    await expect(configuredHostSetup({ CAUCE_FLEET_HOST_SETUP_CONFIG_FILE: '/run/cauce-fleet/config/absent.json' })).rejects.toThrow();
  });
});
