import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_PROVIDER_IDENTITY, type ComputerHarness, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { stageSharedAdapter, standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

async function provider(name: string): Promise<string> {
  const source = await readFile(join(process.cwd(), 'tests/e2e', name), 'utf8');
  return source.replace('fixture-owner@example.invalid', FIXTURE_PROVIDER_IDENTITY);
}

export const policyRecoveryBundle: ComputerRuntimeBundle = {
  ...standardRecoveryBundle,
  providerCli: await provider('h6d-reinicio-politica.provider.py'),
};

export const claudePolicyRecoveryBundle: ComputerRuntimeBundle = {
  providerCli: await provider('h6d-reinicio-politica-claude.provider.py'),
  sharedTui: true,
  harness: 'claude',
  stage: directory => stageSharedAdapter(directory, 'claude'),
};

export async function setCanarySharedTui(computer: ComputerHarness, policy: string, enabled: boolean, harness = 'codex') {
  const script = `import hashlib,json,os,pathlib,stat,sys,tempfile
path=pathlib.Path(sys.argv[1]);before=path.read_bytes();metadata=path.stat();value=json.loads(before)
assert metadata.st_uid==os.geteuid(), 'canary policy owner differs'
assert stat.S_IMODE(metadata.st_mode)&0o022==0, 'canary policy is writable by another user'
bundle=value['bundles'][sys.argv[3]];original={'present':'shared_tui' in bundle,'value':bundle.get('shared_tui')}
if sys.argv[2]=='true': bundle['shared_tui']=True
else: bundle.pop('shared_tui',None)
after=(json.dumps(value,sort_keys=True,indent=2)+'\\n').encode()
fd,name=tempfile.mkstemp(prefix='.h6d-policy-',dir=path.parent)
try:
 os.fchmod(fd,stat.S_IMODE(metadata.st_mode))
 with os.fdopen(fd,'wb') as stream: stream.write(after);stream.flush();os.fsync(stream.fileno())
 os.replace(name,path)
finally:
 if os.path.exists(name): os.unlink(name)
current=path.stat()
assert current.st_uid==metadata.st_uid and current.st_gid==metadata.st_gid and stat.S_IMODE(current.st_mode)==stat.S_IMODE(metadata.st_mode)
print(json.dumps({'before':original,'after':{'present':'shared_tui' in bundle,'value':bundle.get('shared_tui')},'before_sha256':hashlib.sha256(before).hexdigest(),'after_sha256':hashlib.sha256(after).hexdigest(),'uid':current.st_uid,'gid':current.st_gid,'mode':oct(stat.S_IMODE(current.st_mode))}))
`;
  const result = await computer.onComputer(['python3', '-B', '-c', script, policy, String(enabled), harness]);
  if (result.code !== 0) throw new Error(`private canary policy change failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { before: { present: boolean; value: boolean | null }; after: { present: boolean; value: boolean | null };
    before_sha256: string; after_sha256: string; uid: number; gid: number; mode: string };
}
