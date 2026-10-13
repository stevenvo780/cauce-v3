import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { stableHostJson } from '@cauce/store';
import { HostSetupConfigSchema, HostSetupPackager } from './host-setup.js';
import { hostSetupConfig, setupBundle } from './host-setup.fixtures.js';

it('preserves distinct approved pins through signed narrowing and rejects swapped pins in the host installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-host-approved-'));
  try {
    const release = join(root, 'release'); const descriptors = join(release, 'adapter/packages/adapter-sdk/dist/descriptors');
    await mkdir(descriptors, { recursive: true });
    const pins: Record<string, string> = {};
    for (const harness of ['codex', 'claude']) {
      const raw = JSON.stringify({ schema_version: 1, harness, operations: { execute: 'native-execution' },
        context: { native_document: 'none', max_bytes: 1024 } });
      await writeFile(join(descriptors, `${harness}.json`), raw);
      pins[harness] = createHash('sha256').update(raw).digest('hex');
    }
    const base = hostSetupConfig(); const subject = new HostSetupPackager(HostSetupConfigSchema.parse(hostSetupConfig({
      policy: { ...base.policy, bundles: Object.fromEntries(Object.entries(pins).map(([harness, pin]) =>
        [harness, { ...setupBundle(), descriptor_sha256: pin }])) } })), generateKeyPairSync('ed25519').privateKey);
    const signed = subject.build({ company_id: 'fixture', host_id: 'fixture-host', harnesses: ['codex', 'claude'] });
    const key = createPublicKey({ key: Buffer.from(signed.signer_public_key, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(stableHostJson(signed.package)), key, Buffer.from(signed.signature, 'base64'))).toBe(true);
    for (const harness of Object.keys(pins)) {
      const policy = signed.package.policy as { bundles: Record<string, { descriptor_sha256: string }> };
      expect(policy.bundles[harness]?.descriptor_sha256).toBe(pins[harness]);
    }
    const tampered = structuredClone(signed.package);
    const changed = (tampered.policy as { bundles: Record<string, { descriptor_sha256: string }> }).bundles.codex;
    if (!changed) throw new Error('codex bundle missing');
    changed.descriptor_sha256 = pins.claude ?? '';
    expect(verify(null, Buffer.from(stableHostJson(tampered)), key, Buffer.from(signed.signature, 'base64'))).toBe(false);
    const cli = fileURLToPath(new URL('../../../../ops/cli/', import.meta.url));
    const runtime = fileURLToPath(new URL('../../../../ops/container-runtime/', import.meta.url));
    const script = `import json,pathlib,sys\nsys.path[:0]=[sys.argv[1],sys.argv[2]]\nimport host_setup\nfrom cauce_container_base import bundle_digest\nfrom host_channel_client import HostFailure\nroot=pathlib.Path(sys.argv[3]);release=root/'release'\npackage=json.load(sys.stdin)\npolicy=host_setup.compose_policy(package,'fixture-host',root,release,root/'identity')\nfor bundle in policy['bundles'].values():bundle['digest']=bundle_digest(bundle['directory'])\nhost_setup.verify_bundles(policy,release)\nassert {h:b['descriptor_sha256'] for h,b in policy['bundles'].items()}==${JSON.stringify(pins)}\noriginal=policy['bundles']['codex']['descriptor_sha256']\npolicy['bundles']['codex']['descriptor_sha256']=policy['bundles']['claude']['descriptor_sha256']\ntry:host_setup.verify_bundles(policy,release)\nexcept HostFailure as error:assert 'codex' in str(error) and 'nothing was activated' in str(error)\nelse:raise AssertionError('swapped pin accepted')\npolicy['bundles']['codex']['descriptor_sha256']=original\ntarget=release/'adapter/packages/adapter-sdk/dist/descriptors/codex.json'\ntarget.write_bytes(target.read_bytes()+b'\\n')\nfor bundle in policy['bundles'].values():bundle['digest']=bundle_digest(bundle['directory'])\ntry:host_setup.verify_bundles(policy,release)\nexcept HostFailure as error:assert 'codex' in str(error)\nelse:raise AssertionError('bundle reapproval approved altered descriptor')\nprint('approved pins verified')\n`;
    const result = spawnSync('python3', ['-c', script, cli, runtime, root], { input: JSON.stringify(signed.package), encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('approved pins verified\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
