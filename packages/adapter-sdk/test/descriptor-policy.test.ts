import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { packagedHarnessDescriptor, packagedHarnessIds } from '../src/context/harness-descriptor.js';
import type { HarnessId } from '../src/sdk/types.js';

test('every packaged descriptor accepts its byte digest and rejects a different approval', async () => {
  for (const name of await packagedHarnessIds()) {
    const raw = await readFile(new URL(`../descriptors/${name}.json`, import.meta.url));
    const pin = createHash('sha256').update(raw).digest('hex');
    assert.equal((await packagedHarnessDescriptor(name as HarnessId, pin)).harness, name);
    await assert.rejects(packagedHarnessDescriptor(name as HarnessId, '0'.repeat(64)), /descriptor_sha256/);
    await assert.rejects(packagedHarnessDescriptor(name as HarnessId, `sha256:${pin}`), /descriptor_sha256/);
  }
});

test('policy descriptor pin survives bundle reapproval and removes quota and fleet capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-descriptor-policy-'));
  try {
    const directory = join(root, 'packages/adapter-sdk/dist/descriptors');
    await mkdir(directory, { recursive: true });
    await cp(new URL('../descriptors/', import.meta.url), directory, { recursive: true });
    const cli = fileURLToPath(new URL('../../../../ops/cli/', import.meta.url));
    const script = `import hashlib,json,pathlib,sys\nsys.path.insert(0,sys.argv[1])
from fleet_executor_runtime import approved_bundle,bundle_digest
from fleet_executor_templates import fleet_harnesses,validate_login
from fleet_provider_identity import resolve_fleet_module
from harness_operations import HarnessOperationFailure,read_descriptor
from quota_runtime import SafeFailure,capabilities,perform
root=pathlib.Path(sys.argv[2]);target=root/'packages/adapter-sdk/dist/descriptors/codex.json'
pin=hashlib.sha256(target.read_bytes()).hexdigest()
bundle={'directory':str(root),'digest':bundle_digest(str(root)),'executable':'/usr/local/bin/codex',
        'executable_sha256':None,'argv':[],'descriptor_sha256':pin}
policy={'bundles':{'codex':bundle},'quota_environments':{'image':'sha256:'+'a'*64,'network':'fixture','providers':['codex']}}
login={'provider':'codex','command':'/usr/local/bin/codex','command_sha256':'a'*64,
       'login':{'method':'device','command':['/usr/local/bin/codex','login','--device-auth'],'sha256':'a'*64}}
legacy_policy={'bundles':{'codex':{key:value for key,value in bundle.items() if key!='descriptor_sha256'}}}
assert capabilities(policy)['actions']['codex']==['create','authenticate','query','update_cli','delete']
assert fleet_harnesses(policy)=={'codex':None}
validate_login(login,policy)
target.write_bytes(target.read_bytes()+b'\\n')
assert fleet_harnesses(legacy_policy)=={}
bundle['digest']=bundle_digest(str(root))
validate_login(login,policy)
assert capabilities(policy)=={'providers':[],'actions':{}}
assert fleet_harnesses(policy)=={}
for action in (lambda:read_descriptor(str(root),'codex',expected_sha256=pin),
               lambda:resolve_fleet_module(policy,'codex'),
               lambda:approved_bundle(policy,{'harness_id':'codex','runtime_mode':'container'})):
 try:action()
 except (HarnessOperationFailure,SafeFailure):pass
 else:raise AssertionError('altered descriptor remained approved')
document={'operation_id':'2c647dc7-e3f3-4287-af89-7a6597e5a40c','action':'query','consent':False,
          'environment':{'id':'1c647dc7-e3f3-4287-af89-7a6597e5a40c','company_id':'fixture',
          'account_id':'fixture-account','host_id':'fixture-host','provider':'codex',
          'container_name':'cauce-quota-1c647dc7e3f34287af897a6597e5a40c'}}
policy['host_id']='fixture-host'
import quota_runtime
from unittest.mock import patch
quota_runtime.inspect_container=lambda name: {'State': {'Running': True}}
quota_runtime.validate=lambda policy, environment, observed: None
with patch('subprocess.run', side_effect=AssertionError('unexpected physical quota call')):
 try:perform(policy,document)
 except SafeFailure as error:
  assert str(error)=='quota provider operation or pinned descriptor is unavailable',str(error)
  assert str(error.__cause__)=='approved harness descriptor changed',str(error.__cause__)
 else:raise AssertionError('altered descriptor allowed an effect')
for pin in (None,42,'a'*63,'A'*64):
 bundle['descriptor_sha256']=pin
 try:approved_bundle(policy,{'harness_id':'codex','runtime_mode':'container'})
 except SafeFailure:pass
 else:raise AssertionError('malformed pin accepted')
print('descriptor policy verified')
`;
    const result = spawnSync('python3', ['-c', script, cli, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'descriptor policy verified\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
