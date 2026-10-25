import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { HarnessConsumptionEvidenceSchema, type HarnessConsumptionEvidence } from '../../packages/protocol/src/harness-consumption.js';
import { cancelDeployReceipts, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { observeCancelDeployActor, type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';

interface ExecutorObservation { mainPid: number; invocationId: string; execStart: string; activeState: string; starttime: string }
interface SessionObservation {
  actor: Awaited<ReturnType<typeof observeCancelDeployActor>>;
  runtime: { metadata: Record<string, unknown> | null; environment: Record<string, string | null>;
    tmux: { code: number; panes: string; stderr: string }; sockets: { path: string; uid: number; dev: number; ino: number }[];
    quarantine: string[]; transcripts: Record<string, string>; context: Record<string, string> };
}

export async function sessionReceipt(name: string, value: unknown): Promise<void> {
  await writeFile(join(cancelDeployReceipts, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function observeSessionExecutor(fixture: CancelDeployFixture): Promise<ExecutorObservation> {
  const result = await fixture.computer.onComputer(['systemctl', '--user', 'show', fixture.unit,
    '--property=MainPID,InvocationID,ExecStart,ActiveState']);
  if (result.code !== 0) throw new Error('the executor unit could not be observed: ' + result.stderr);
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  const mainPid = Number(fields.MainPID);
  if (!Number.isSafeInteger(mainPid) || mainPid < 1) throw new Error('the executor does not have one live MainPID');
  const process = await fixture.computer.onComputer(['python3', '-I', '-B', '-c',
    'import pathlib,sys;print(pathlib.Path("/proc",sys.argv[1],"stat").read_text().rsplit(")",1)[1].split()[19])', String(mainPid)]);
  if (process.code !== 0) throw new Error('the executor MainPID disappeared: ' + process.stderr);
  return { mainPid, invocationId: fields.InvocationID ?? '', execStart: fields.ExecStart ?? '',
    activeState: fields.ActiveState ?? '', starttime: process.stdout.trim() };
}

const runtimeProbe = String.raw`import hashlib,json,pathlib,pwd,stat,subprocess,sys
runtime=sys.argv[1];state=pathlib.Path('/home/cauce/.cauce')/runtime
control=pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json'
document=json.loads(control.read_bytes()) if control.exists() else None
metadata={key:document.get(key) for key in ('alias','wireAlias','tenantId','pid','starttime','controllerPid','controllerStarttime',
 'containerId','containerGeneration','stateDirectory','controlDirectory','bundleDigest','phase')} if document else None
public={};native=None
if document:
 try:
  raw=dict(row.split(b'=',1) for row in pathlib.Path('/proc',str(document['pid']),'environ').read_bytes().split(b'\0') if b'=' in row)
  public={key:raw.get(key.encode(),b'').decode() or None for key in
   ('CAUCE_SHARED_SESSION','CAUCE_SHARED_SESSION_WORKSPACE','TMUX_TMPDIR','CAUCE_BOOTSTRAP')}
  native=raw.get(b'CODEX_HOME',b'').decode()
 except FileNotFoundError:pass
account=pwd.getpwnam('cauce')
result=subprocess.run(['/usr/bin/tmux','-N','-L','cauce','list-panes','-a','-F',
 '#{session_name}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{socket_path}'],
 env={'PATH':'/usr/bin:/bin','TMUX_TMPDIR':str(state)},user=account.pw_uid,group=account.pw_gid,
 capture_output=True,text=True,timeout=5,check=False)
sockets=[]
for candidate in sorted(state.glob('tmux-*/*')):
 details=candidate.lstat()
 if stat.S_ISSOCK(details.st_mode):sockets.append({'path':str(candidate),'uid':details.st_uid,'dev':details.st_dev,'ino':details.st_ino})
transcripts={}
if native:
 for transcript in sorted((pathlib.Path(native)/'sessions').rglob('*.jsonl')):
  transcripts[str(transcript)]=hashlib.sha256(transcript.read_bytes()).hexdigest()
context={}
for filename in ('AGENTS.md','CLAUDE.md','GEMINI.md','h13-continuity.txt'):
 for candidate in (state/filename,state/'space'/filename,state/'space/projects'/filename):
  if candidate.is_file():context[str(candidate)]=hashlib.sha256(candidate.read_bytes()).hexdigest()
print(json.dumps({'metadata':metadata,'environment':public,
 'tmux':{'code':result.returncode,'panes':result.stdout.strip(),'stderr':result.stderr.strip()},
 'sockets':sockets,'quarantine':sorted(path.name for path in state.glob('.shared-session-quarantine*')),
 'transcripts':transcripts,'context':context}))
`;

export async function observeDeploymentSession(actor: CancelDeployActor): Promise<SessionObservation> {
  const observed = await observeCancelDeployActor(actor);
  const runtime = JSON.parse(await docker(['exec', '--user', '0', actor.container, 'python3', '-I', '-B', '-c',
    runtimeProbe, actor.runtime])) as SessionObservation['runtime'];
  return { actor: observed, runtime };
}

export async function seedSessionContext(actor: CancelDeployActor): Promise<{ path: string; sha256: string }> {
  const path = '/home/cauce/.cauce/' + actor.runtime + '/space/projects/h13-continuity.txt';
  const marker = 'Owned workspace continuity ' + actor.runtime + '\n';
  await docker(['exec', '--user', 'cauce', actor.container, 'python3', '-I', '-B', '-c',
    'import os,pathlib,sys;p=pathlib.Path(sys.argv[1]);fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,sys.argv[2].encode());os.fsync(fd);os.close(fd)',
    path, marker]);
  return { path, sha256: createHash('sha256').update(marker).digest('hex') };
}

export async function assertNativeSessionTurn(actor: CancelDeployActor, live: Record<string, unknown>): Promise<{
  deliveryId: string; witness: HarnessConsumptionEvidence;
}> {
  const delivery = live.delivery;
  if (!Array.isArray(delivery) || delivery.length !== 1) throw new Error('the shared turn lacks one durable delivery');
  const row: unknown = delivery[0];
  if (typeof row !== 'object' || !row || !('id' in row) || typeof row.id !== 'string') throw new Error('the delivery ID is absent');
  const rows = (await actor.fixture.computer.pool.query<{ witness: unknown }>(
    "SELECT ack.payload->'result'->'harness_consumption_v1' AS witness FROM delivery_acks ack "
    + 'JOIN deliveries delivery ON delivery.id=ack.delivery_id WHERE delivery.id=$1 AND delivery.recipient_tenant=$2 '
    + "AND delivery.recipient_alias=$3 AND ack.status='done' AND ack.applied", [row.id, actor.fixture.tenantId, actor.alias])).rows;
  expect(rows).toHaveLength(1);
  const witness = HarnessConsumptionEvidenceSchema.parse(rows[0]?.witness);
  expect(witness.harness_id).toBe('codex');
  return { deliveryId: row.id, witness };
}

export async function collectSessionFailure(fixture: CancelDeployFixture, actor: CancelDeployActor | undefined, label = ''): Promise<void> {
  if (label && !/^[a-z0-9-]+$/u.test(label)) throw new Error('the diagnostic label is unsupported');
  const prefix = label ? label + '-' : '';
  const journal = await fixture.computer.onComputer(['journalctl', '--user', '-u', fixture.unit, '--no-pager', '-n', '250']);
  await writeFile(join(cancelDeployReceipts, prefix + 'executor-journal.log'), journal.stdout + journal.stderr, { mode: 0o600 });
  if (actor) {
    const log = await docker(['exec', '--user', '0', actor.container, 'python3', '-I', '-B', '-c',
      'import pathlib,sys;p=pathlib.Path("/home/cauce/.cauce")/sys.argv[1]/".cauce-adapter.log";print(p.read_text()[-262144:] if p.exists() else "")',
      actor.runtime]);
    await writeFile(join(cancelDeployReceipts, prefix + 'adapter.log'), log, { mode: 0o600 });
  }
  const fixturePath = join(process.cwd(), 'tests/e2e/v4-fleet-cancel-deploy.helpers.ts');
  await sessionReceipt('harness-overlay', { path: 'tests/e2e/v4-fleet-cancel-deploy.helpers.ts',
    sha256: createHash('sha256').update(await readFile(fixturePath)).digest('hex'),
    adaptation: 'the isolated launcher accepts the h13 owner in HOME' });
}
