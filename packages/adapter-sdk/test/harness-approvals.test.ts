import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approvedHarnessDescriptors } from '../src/context/harness-descriptor.js';

function fixture(harness: string, quota = true) {
  return JSON.stringify({ schema_version: 1, harness,
    operations: { execute: 'native-execution', ...(quota ? { quota: 'quota-collector' } : {}) },
    context: { native_document: 'none', max_bytes: 1024 },
    ...(quota ? { provider: { quota_argv: ['/usr/local/bin/fixture', 'usage'] } } : {}) });
}
const pin = (raw: string) => createHash('sha256').update(raw).digest('hex');

test('an approved catalog changes with new descriptors, withdrawal and byte corruption without caching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-approved-catalog-'));
  try {
    const url = pathToFileURL(`${directory}/`); const raw = fixture('fixture');
    await writeFile(join(directory, 'fixture.json'), raw);
    assert.deepEqual(await approvedHarnessDescriptors(url, {}), []);
    const approvals = { fixture: pin(raw) };
    assert.deepEqual((await approvedHarnessDescriptors(url, approvals)).map(row => row.harness), ['fixture']);
    const added = fixture('another'); await writeFile(join(directory, 'another.json'), added);
    assert.deepEqual((await approvedHarnessDescriptors(url, { ...approvals, another: pin(added) })).map(row => row.harness), ['another', 'fixture']);
    await writeFile(join(directory, 'fixture.json'), `${raw}\n`);
    assert.deepEqual((await approvedHarnessDescriptors(url, { ...approvals, another: pin(added) })).map(row => row.harness), ['another']);
    const retired = fixture('fixture', false); await writeFile(join(directory, 'fixture.json'), retired);
    assert.equal((await approvedHarnessDescriptors(url, { fixture: pin(retired) }))[0]?.operations.quota, undefined);
    await rm(join(directory, 'fixture.json'));
    assert.deepEqual(await approvedHarnessDescriptors(url, approvals), []);
    for (const digest of ['A'.repeat(64), 'a'.repeat(63), 'sha256:' + 'a'.repeat(64)]) {
      assert.deepEqual(await approvedHarnessDescriptors(url, { another: digest }), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('release packaging preserves only explicit approvals and rejects swapped or stale pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-approved-release-'));
  try {
    const sdk = join(root, 'packages/adapter-sdk/dist');
    await mkdir(join(sdk, 'descriptors'), { recursive: true }); await mkdir(join(sdk, 'src/bin'), { recursive: true });
    const first = fixture('fixture'); const second = fixture('another');
    for (const [name, raw] of [['fixture', first], ['another', second]]) {
      await writeFile(join(sdk, `descriptors/${name ?? ''}.json`), raw ?? '');
      await writeFile(join(sdk, `src/bin/${name ?? ''}.js`), '', { mode: 0o755 });
    }
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const script = await readFile(join(repo, 'ops/scripts/build-adapter-release.sh'), 'utf8');
    const body = /python3 - "\$release_target" "\$descriptor_approvals" "\$repo_root" <<'PY'\n([\s\S]+?)\nPY/u.exec(script)?.[1];
    assert.ok(body, 'the release verifier must be present');
    const approvals = join(root, 'approvals.json');
    const run = async (value: unknown) => {
      await writeFile(approvals, JSON.stringify(value));
      return spawnSync('python3', ['-c', body, root, approvals, repo], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    };
    const accepted = await run({ fixture: pin(first), another: pin(second) });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(sdk, 'descriptor-approvals.json'), 'utf8')),
      { fixture: pin(first), another: pin(second) });
    assert.notEqual((await run({ fixture: pin(second), another: pin(first) })).status, 0);
    await writeFile(join(sdk, 'descriptors/fixture.json'), `${first}\n`);
    assert.notEqual((await run({ fixture: pin(first) })).status, 0);
    assert.notEqual((await run({ unknown: pin(first) })).status, 0);
    assert.notEqual((await run([])).status, 0);
    assert.equal((await run({})).status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(sdk, 'descriptor-approvals.json'), 'utf8')), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
