import type { ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

interface PolicyReceipt { original_sha256: string; injected_sha256: string; original_digest: string; uid: number; gid: number; mode: number }

const SCRIPT = `import hashlib,json,os,pathlib,re,stat,sys,tempfile
path=pathlib.Path(sys.argv[1]);suffix=sys.argv[2];action=sys.argv[3]
assert re.fullmatch('[a-f0-9]{8}',suffix), 'invalid canary suffix'
assert not path.is_symlink(), 'canary policy is a symlink'
metadata=path.stat();current=path.read_bytes();mode=stat.S_IMODE(metadata.st_mode)
assert metadata.st_uid==os.geteuid() and metadata.st_nlink==1 and mode&0o022==0, 'canary policy authority differs'
backup=path.with_name('.h6d-bundle-'+suffix)
def replace(data):
 fd,name=tempfile.mkstemp(prefix='.h6d-restore-',dir=path.parent)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb') as stream: stream.write(data);stream.flush();os.fsync(stream.fileno())
  os.replace(name,path)
 finally:
  if os.path.exists(name): os.unlink(name)
 after=path.stat()
 assert (after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode))==(metadata.st_uid,metadata.st_gid,mode), 'canary policy metadata changed'
if action=='inject':
 value=json.loads(current);original=value['bundles']['codex']['digest']
 fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 os.fchmod(fd,mode)
 with os.fdopen(fd,'wb') as stream: stream.write(current);stream.flush();os.fsync(stream.fileno())
 value['bundles']['codex']['digest']='sha256:'+'0'*64
 updated=(json.dumps(value,sort_keys=True,indent=2)+'\\n').encode();replace(updated)
 print(json.dumps({'original_sha256':hashlib.sha256(current).hexdigest(),'injected_sha256':hashlib.sha256(updated).hexdigest(),'original_digest':original,'uid':metadata.st_uid,'gid':metadata.st_gid,'mode':mode}))
else:
 expected=json.loads(sys.argv[4]);saved=backup.stat()
 assert (metadata.st_uid,metadata.st_gid,mode)==(expected['uid'],expected['gid'],expected['mode']), 'canary policy metadata changed after injection'
 assert not backup.is_symlink() and saved.st_uid==os.geteuid() and saved.st_nlink==1 and stat.S_IMODE(saved.st_mode)==mode, 'canary backup authority differs'
 assert hashlib.sha256(current).hexdigest()==expected['injected_sha256'], 'canary policy changed after injection'
 original=backup.read_bytes();assert hashlib.sha256(original).hexdigest()==expected['original_sha256'], 'canary policy backup changed'
 replace(original);assert path.read_bytes()==original, 'canary policy restore bytes differ'
 backup.unlink();print(json.dumps({'restored_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'uid':metadata.st_uid,'gid':metadata.st_gid,'mode':mode,'backup_absent':not backup.exists()}))
`;

export async function invalidateCanaryBundle(computer: ComputerHarness, policy: string, suffix: string) {
  const injected = await computer.onComputer(['python3', '-B', '-c', SCRIPT, policy, suffix, 'inject']);
  if (injected.code !== 0) throw new Error(`canary bundle injection failed: ${injected.stderr}`);
  const receipt = JSON.parse(injected.stdout) as PolicyReceipt;
  return { receipt, async restore() {
    const restored = await computer.onComputer(['python3', '-B', '-c', SCRIPT, policy, suffix, 'restore', JSON.stringify(receipt)]);
    if (restored.code !== 0) throw new Error(`canary bundle restoration failed: ${restored.stderr}`);
    return JSON.parse(restored.stdout) as { restored_sha256: string; uid: number; gid: number; mode: number; backup_absent: boolean };
  } };
}
