import { expect } from 'vitest';
import { docker, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';
import { HarnessConsumptionEvidenceSchema } from '../../packages/protocol/src/harness-consumption.js';
import { createCancelDeployActor, enqueueCancelDeploy, observeCancelDeployActor, openCancelDeployPanel,
  type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { cancelDeployCapture, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { observeAdmittedCancelDeploy } from './v4-fleet-cancel-deploy.materialize.js';
import { deployCancelRelease } from './v4-fleet-cancel-deploy.release.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { IDLE_PLACEHOLDER } from './s2d-provider.js';

const provider = `#!/usr/local/bin/python3
import json,os,pathlib,re,sys,tty,uuid
if not sys.stdin.isatty() or 'app-server' in sys.argv or '--json' in sys.argv:
 exec(${JSON.stringify(cancelDeployRuntime.providerCli)})
 sys.exit(0)
native=sys.argv[sys.argv.index('resume')+1] if 'resume' in sys.argv else str(uuid.uuid4())
uuid.UUID(native)
directory=pathlib.Path(os.environ['CODEX_HOME'])/'sessions'
directory.mkdir(parents=True,exist_ok=True,mode=0o700)
transcript=directory/('rollout-now-'+native+'.jsonl')
def append(kind,payload):
 with transcript.open('a') as stream:
  stream.write(json.dumps({'type':kind,'payload':payload})+'\\n');stream.flush();os.fsync(stream.fileno())
if not transcript.exists():append('session_meta',{'id':native,'source':'cli','cwd':os.getcwd()})
tty.setraw(sys.stdin.fileno())
pending='';skip_lf=False
def render_idle():
 if pending:raise RuntimeError('a draft cannot be rendered as an idle composer')
 sys.stdout.write('\\r\\n› \\x1b[2m'+${JSON.stringify(IDLE_PLACEHOLDER)}+'\\x1b[22m\\r\\x1b[2C');sys.stdout.flush()
def render_composer():
 if not pending:render_idle();return
 visible=pending.replace('\\x1b[200~','').replace('\\x1b[201~','').replace('\\r\\n','\\n').replace('\\r','\\n')
 sys.stdout.write('\\r\\x1b[2K› '+visible.replace('\\n','\\r\\n'));sys.stdout.flush()
sys.stdout.write('\\x1b[?2004h');sys.stdout.flush();render_idle()
while True:
 chunk=os.read(sys.stdin.fileno(),65536).decode(errors='replace')
 if not chunk:break
 if skip_lf:
  if chunk.startswith('\\n'):chunk=chunk[1:]
  skip_lf=False
  if not chunk:continue
 pending+=chunk
 if len(pending.encode())>1048576:raise RuntimeError('native terminal input exceeds its bound')
 while True:
  first=pending.find('\\x1b[200~');last=pending.find('\\x1b[201~',first+6)
  ending=re.search(r'[\\r\\n]',pending[last+6:]) if last>=0 else None
  if first!=0 or last<first or ending is None:break
  text=pending[first+6:last].replace('\\r\\n','\\n').replace('\\r','\\n');pending=pending[last+6+ending.end():]
  if ending.group(0)=='\\r':
   if pending.startswith('\\n'):pending=pending[1:]
   elif not pending:skip_lf=True
  nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',text)
  if nonce:answer=nonce.group(0)
  else:
   marker=re.search(r'FLEET-DEPLOY-DELIVERY-[a-f0-9-]+',text)
   correlation=re.search(r'"cauce_correlation_id"\\s*:\\s*"([a-f0-9]{64})"',text)
   if marker is None or correlation is None:raise RuntimeError('native delivery lacks its marker or correlation')
   answer=json.dumps({'reply':'DELIVERED:'+marker.group(0),'messages':[],'status':'done','retryable':False,
     'artifacts':[],'cauce_correlation_id':correlation.group(1)})
  turn=str(uuid.uuid4())
  append('event_msg',{'type':'task_started','turn_id':turn})
  append('response_item',{'type':'message','role':'user','content':[{'type':'input_text','text':text}],
    'internal_chat_message_metadata_passthrough':{'turn_id':turn}})
  append('event_msg',{'type':'task_complete','turn_id':turn,'last_agent_message':answer})
  sys.stdout.write('\\r\\n'+answer+'\\r\\n');sys.stdout.flush()
 render_composer()
`;

export const cancelDeployTuiRuntime: ComputerRuntimeBundle = { ...cancelDeployRuntime, providerCli: provider, sharedTui: true };

async function observeSharedEnvironment(actor: CancelDeployActor): Promise<unknown> {
  const script = `import json,pathlib,sys
runtime=sys.argv[1]
metadata=json.loads((pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json').read_bytes())
proc=pathlib.Path('/proc')/str(metadata['pid'])
def verify():
 stat=proc.joinpath('stat').read_text().rsplit(')',1)[1].split()
 assert stat[0]!='Z' and int(stat[19])==metadata['starttime']
verify()
values=dict(item.split(b'=',1) for item in proc.joinpath('environ').read_bytes().split(b'\\0') if b'=' in item)
verify()
print(json.dumps({name:values.get(name.encode(),b'').decode() or None for name in
 ('CAUCE_SHARED_SESSION','CAUCE_SHARED_SESSION_WORKSPACE','TMUX_TMPDIR')}))
`;
  return JSON.parse(await docker(['exec', '--user', '0', actor.container, 'python3', '-I', '-B', '-c', script, actor.runtime])) as unknown;
}

async function observeNativeTurn(actor: CancelDeployActor, deliveryId: string): Promise<unknown> {
  const state = `/home/cauce/.cauce/${actor.runtime}`;
  const format = '#{@cauce_alias}|#{@cauce_harness}|#{window_name}|#{pane_dead}|#{pane_current_path}';
  const markers = (await docker(['exec', '--user', 'cauce', '--env', `TMUX_TMPDIR=${state}`, actor.container,
    '/usr/bin/tmux', '-L', TMUX_SOCKET, 'display-message', '-p', '-t', `cauce-${actor.runtime}:agente`, format])).split('|');
  expect(markers).toEqual([actor.runtime, 'codex', 'agente', '0', `${state}/space/projects`]);
  const rows = (await actor.fixture.computer.pool.query<{ delivery_id: string; witness: unknown }>(`SELECT delivery.id AS delivery_id,
    ack.payload->'result'->'harness_consumption_v1' AS witness
    FROM delivery_acks ack JOIN deliveries delivery ON delivery.id=ack.delivery_id
    WHERE delivery.recipient_tenant=$1 AND delivery.recipient_alias=$2 AND delivery.id=$3 AND ack.status='done' AND ack.applied`,
  [actor.fixture.tenantId, actor.alias, deliveryId])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.delivery_id).toBe(deliveryId);
  const witness = HarnessConsumptionEvidenceSchema.parse(rows[0]?.witness);
  expect(witness.harness_id).toBe('codex'); expect(witness.native_session_id).toMatch(/^[a-f0-9-]{36}$/u);
  expect(witness.native_turn_id).toMatch(/^[a-f0-9-]{36}$/u);
  return { deliveryId, markers, witness };
}

export async function runSharedPolicyDeployScenario(fixture: CancelDeployFixture, evidence: Record<string, unknown>,
  assertLive: (actor: CancelDeployActor, phase: string) => Promise<string>): Promise<void> {
  expect(fixture.setup.approvedConfiguration().policy.bundles.codex?.shared_tui).toBe(false);
  const { actor, operation, observed: before } = await createCancelDeployActor(fixture, 't');
  evidence.created = operation; evidence.before = before;
  expect(before.adapterAlive).toBe(true);
  expect(before.pid).not.toBeNull(); expect(before.starttime).not.toBeNull();
  evidence.environmentBefore = await observeSharedEnvironment(actor);
  expect(evidence.environmentBefore).toEqual({ CAUCE_SHARED_SESSION: null, CAUCE_SHARED_SESSION_WORKSPACE: null, TMUX_TMPDIR: null });
  await assertLive(actor, 'policy-initial');
  const deployment = await deployCancelRelease(fixture, fixture.setup, 'shared-policy', { image: before.image, newImage: false, sharedTui: true });
  evidence.deployment = deployment;
  expect(deployment.signer).toBe(fixture.setup.signerFingerprint); expect(deployment.image).toBe(before.image);
  const prior = await observeCancelDeployActor(actor);
  evidence.afterDeployment = prior;
  expect(prior.adapterAlive).toBe(true); expect(prior.id).toBe(before.id); expect(prior.bundleDigest).toBe(before.bundleDigest);
  expect(prior.pid).toBe(before.pid); expect(prior.starttime).toBe(before.starttime);
  expect(prior.bundleDigest).not.toBe(deployment.bundleDigest);
  evidence.environmentAfterDeployment = await observeSharedEnvironment(actor);
  expect(evidence.environmentAfterDeployment).toEqual({ CAUCE_SHARED_SESSION: null, CAUCE_SHARED_SESSION_WORKSPACE: null, TMUX_TMPDIR: null });
  expect(fixture.setup.approvedConfiguration().policy.bundles.codex?.shared_tui).toBe(true);
  const panel = await openCancelDeployPanel(actor);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await panel.getByLabel('Nombre visible operativo').fill('Política de TUI compartida aprobada');
  evidence.updated = await enqueueCancelDeploy(actor, panel, 'update');
  const current = await observeCancelDeployActor(actor);
  evidence.afterUpdate = current;
  expect(current.image).toBe(before.image); expect(current.volumes).toEqual(before.volumes);
  expect(current.bundleDigest).toBe(deployment.bundleDigest); expect(current.adapterAlive).toBe(true);
  evidence.environmentAfter = await observeSharedEnvironment(actor);
  const state = `/home/cauce/.cauce/${actor.runtime}`;
  expect(evidence.environmentAfter).toEqual({ CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: `${state}/space/projects`, TMUX_TMPDIR: state });
  evidence.materializedAdmitted = await observeAdmittedCancelDeploy(fixture.computer, deployment.release, actor.runtime);
  const deliveryId = await assertLive(actor, 'policy-updated');
  evidence.nativeTurn = await observeNativeTurn(actor, deliveryId);
  await cancelDeployCapture(fixture.page, 'shared-policy-updated');
}
