import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetOperationRequestSchema, FleetOperationSchema } from '@cauce/protocol';
import { preparedState, withTransaction } from '@cauce/store';
import { expect, it } from 'vitest';
import { readFleetProviderAccounts, scopedFleetProviderAgents } from '../../services/gateway/src/fleet/accounts.js';
import { desiredFleetExtensions, fleetSharedHumans, trustedFleetBaseline } from '../../services/gateway/src/fleet/baseline.js';
import { COMPUTER_RUNTIME, command } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { EVIDENCE, KEY, PREFIX, confirmReplacement, createReplacementAgent, replacementUpdatePanel,
  reply, snapshot, startReplacementFixture, waitOperation } from './v4-contenedor-sustituido.fixtures.js';

const sources = ['.delegados/v4/retirar-sustituido.sh', '.delegados/v4/retirar-sustituido-driver.py'];
const evidenceDirectory = join(process.cwd(), '.delegados/v4/recibos/h9-contenedor-sustituido-1025');

it('retires only a committed replacement through the root wrapper and preserves both persistent volumes', async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  const fixture = await startReplacementFixture();
  const evidence: Record<string, unknown> = {};
  try {
    evidence.create = await createReplacementAgent(fixture);
    const oldName = `${PREFIX}-${KEY}`, newName = `${PREFIX}-n-${KEY}`;
    const before = await snapshot(oldName);
    expect(before).toMatchObject({ running: true });
    const sentinelName = `h9-retained-${randomUUID()}.txt`;
    const sentinelPath = `${COMPUTER_RUNTIME.stateRoot}/${KEY}/space/projects/${sentinelName}`;
    const sentinelBody = `Owned synthetic workspace marker ${randomUUID()}\n`;
    const sentinelHash = createHash('sha256').update(sentinelBody).digest('hex');
    const python = '/usr/local/bin/python3.12';
    const seeded = await command('docker', ['exec', '-i', '--user', COMPUTER_RUNTIME.user, oldName, python, '-I', '-B', '-c',
      'import pathlib,json,sys,hashlib;p=json.load(sys.stdin);f=pathlib.Path(p["path"]);f.write_text(p["body"]);f.chmod(384);print(hashlib.sha256(f.read_bytes()).hexdigest())'],
    JSON.stringify({ path: sentinelPath, body: sentinelBody }));
    expect(seeded.code, seeded.stderr).toBe(0); expect(seeded.stdout.trim()).toBe(sentinelHash);
    await confirmReplacement(await replacementUpdatePanel(fixture));
    const updated = await waitOperation(fixture, 'update');
    evidence.update = updated;
    const operation = FleetOperationSchema.pick({ id: true, kind: true, status: true, target: true }).strip().parse(updated);
    expect(operation.status).toBe('succeeded');
    expect(await snapshot(oldName)).toMatchObject({ id: before?.id, running: true });
    const readMarker = ['exec', '--user', COMPUTER_RUNTIME.user, oldName, python, '-I', '-B', '-c',
      'import pathlib,sys,hashlib;p=pathlib.Path(sys.argv[1]);print(hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "absent")', sentinelPath];
    const originalMarker = await command('docker', readMarker);
    expect(originalMarker.code).toBe(0); expect(originalMarker.stdout.trim()).toBe(sentinelHash);
    const newMarker = await command('docker', readMarker.map(value => value === oldName ? newName : value));
    expect(newMarker.code).toBe(0); expect(newMarker.stdout.trim()).toBe('absent');
    evidence.exclusive_old_workspace = { sha256: sentinelHash, previous_present: true, replacement_present: false };
    const query = await readFile(join(process.cwd(), 'ops/scripts/fleet-query.sql'), 'utf8');
    const context = await withTransaction(fixture.computer.pool, async client => {
      const row = (await client.query<{ request: unknown; company_id: string }>(
        'SELECT request,company_id FROM fleet_operations WHERE id=$1', [operation.id])).rows[0];
      if (!row) throw new Error('Canonical operation absent');
      const request = FleetOperationRequestSchema.parse(row.request);
      const prepared = await preparedState(client, operation.id);
      const source = (await client.query<{ jsonb_build_object: {
        agents: Record<string, unknown>[]; memberships: Record<string, unknown>[]; rolePolicies: Record<string, unknown>[];
      } }>(query)).rows[0]?.jsonb_build_object;
      if (!source) throw new Error('Canonical PostgreSQL snapshot absent');
      const tenants = new Set((await client.query<{ id: string }>('SELECT id FROM tenants WHERE company_id=$1', [row.company_id])).rows.map(value => value.id));
      source.agents = source.agents.filter(agent => typeof agent.tenant_id === 'string' && tenants.has(agent.tenant_id));
      const identities = new Set(source.agents.map(agent => JSON.stringify([agent.tenant_id, agent.alias])));
      source.memberships = source.memberships.filter(member => identities.has(JSON.stringify([member.tenant_id, member.alias])));
      source.agents = await fleetSharedHumans(client, row.company_id, await desiredFleetExtensions(client, await trustedFleetBaseline(client, source.agents)));
      prepared.previous_agents = await trustedFleetBaseline(client, prepared.previous_agents);
      const trusted = await readFleetProviderAccounts(client, scopedFleetProviderAgents(request, prepared.fenced_targets, prepared.previous_agents, source.agents));
      return { operation, operation_id: operation.id, request, ...prepared, snapshot: source, trusted_accounts: trusted };
    });
    const helperSources = await Promise.all(sources.map(async path => ({ name: path.split('/').at(-1), body: await readFile(join(process.cwd(), path), 'utf8') })));
    const setup = await fixture.computer.onComputer(['python3', '-I', '-B', '-c',
      'import json,pathlib,sys,os;p=json.load(sys.stdin);r=pathlib.Path(sys.argv[1]);files=list(r.glob("*/*/executor-policy.json"));'
      + 'assert len(files)==1;policy=files[0];cfg=json.loads(policy.read_text());state=pathlib.Path(cfg["roots"]["state"]);'
      + 'directory=state/"retirar-script";directory.mkdir(mode=448);'
      + '[(directory/x["name"]).write_text(x["body"]) for x in p["helpers"]];'
      + '[(directory/x["name"]).chmod(448) for x in p["helpers"]];'
      + 'context=directory/"context.json";context.write_text(json.dumps(p["context"]));context.chmod(384);'
      + 'bundle=pathlib.Path(cfg["bundles"][p["harness"]]["directory"]);'
      + 'print(json.dumps({"policy":str(policy),"ops":str(bundle.parent/"ops"),"context":str(context),'
      + '"wrapper":str(directory/"retirar-sustituido.sh"),"receipt":str(directory/"receipt.json"),"state":str(state)}))',
    fixture.computer.installRoot], JSON.stringify({ helpers: helperSources, context, harness: context.request.kind === 'update' ? context.request.parameters.harness_id : '' }));
    expect(setup.code, setup.stderr).toBe(0);
    const paths = JSON.parse(setup.stdout) as Record<'policy' | 'ops' | 'context' | 'wrapper' | 'receipt' | 'state', string>;
    const args = ['exec', '--user', '0', '--env', 'CAUCE_REQUIRE_TESTCONTAINERS=1', fixture.computer.container,
      paths.wrapper, '--ops-root', paths.ops, '--policy', paths.policy, '--context', paths.context,
      '--lab-prefix', PREFIX, '--recibo', paths.receipt];
    const oldBeforeSim = await snapshot(oldName), newBeforeSim = await snapshot(newName);
    const fingerprint = async (): Promise<string> => {
      const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c',
        'import pathlib,json,hashlib,sys;s=pathlib.Path(sys.argv[1]);r=pathlib.Path(sys.argv[2]);'
        + 'files=[s/"applied-fleet.json",s/"operations"/sys.argv[3]/"effects.json",*r.parent.iterdir()];'
        + 'print(json.dumps({str(p):[hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_uid,p.stat().st_gid,p.stat().st_mode,p.stat().st_ino]'
        + ' for p in files if p.is_file()},sort_keys=True))', paths.state, paths.receipt, operation.id]);
      expect(result.code).toBe(0); return result.stdout;
    };
    const beforeSim = await fingerprint();
    const simulate = await command('docker', [...args, '--simular']);
    evidence.simulate = { code: simulate.code, body: JSON.parse(simulate.stdout) as unknown };
    expect(simulate.code, simulate.stdout + simulate.stderr).toBe(0);
    expect(await fingerprint()).toBe(beforeSim);
    expect(await snapshot(oldName)).toEqual(oldBeforeSim);
    expect(await snapshot(newName)).toEqual(newBeforeSim);
    expect(await snapshot(oldName)).toMatchObject({ id: before?.id, running: true });
    const runningContext = await fixture.computer.onComputer(['python3', '-I', '-B', '-c',
      'import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);d=json.loads(p.read_text());d["operation"]["status"]="running";'
      + 'q=p.with_name("pending-context.json");q.write_text(json.dumps(d));q.chmod(384);print(q)', paths.context]);
    expect(runningContext.code).toBe(0);
    const rejected = await command('docker', [...args, '--context', runningContext.stdout.trim(), '--aplicar']);
    expect(rejected.code).toBe(1); evidence.pending_commit_rejected = true;
    expect(await snapshot(oldName)).toEqual(oldBeforeSim);
    const renamed = `${oldName}-conflict`;
    expect((await command('docker', ['rename', oldName, renamed])).code).toBe(0);
    try {
      const conflict = await command('docker', [...args, '--aplicar']);
      expect(conflict.code).toBe(1); evidence.identity_conflict_rejected = true;
      expect(await snapshot(renamed)).toMatchObject({ id: before?.id, running: true });
      expect(await snapshot(newName)).toEqual(newBeforeSim);
    } finally {
      expect((await command('docker', ['rename', renamed, oldName])).code).toBe(0);
    }
    const applied = await command('docker', [...args, '--aplicar']);
    evidence.apply = { code: applied.code, body: JSON.parse(applied.stdout) as unknown };
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(await snapshot(oldName)).toBeNull();
    expect(await snapshot(newName)).toMatchObject({ running: true });
    for (const volume of before?.volumes ?? []) {
      const inspected = await command('docker', ['volume', 'inspect', '--format', '{{.Name}}', volume]);
      expect(inspected.code).toBe(0); expect(inspected.stdout.trim()).toBe(volume);
    }
    const stateVolume = before?.volumes.find(name => name === oldName + '-state');
    if (!stateVolume) throw new Error('Previous state volume absent');
    const reader = `${PREFIX}-retained-state-reader`;
    try {
      const preserved = await command('docker', ['run', '--name', reader, '--label', 'cauce.e2e.owner=h9-contenedor-sustituido-1025',
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1500:1500',
        '--mount', `type=volume,source=${stateVolume},destination=/retained,readonly`, '--entrypoint', python, fixture.computer.agentImage,
        '-I', '-B', '-c', 'import hashlib,pathlib,sys;print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())',
        `/retained/${KEY}/space/projects/${sentinelName}`]);
      expect(preserved.code, preserved.stderr).toBe(0); expect(preserved.stdout.trim()).toBe(sentinelHash);
      evidence.retained_workspace_verified = { volume: stateVolume, sha256: preserved.stdout.trim(), readonly: true };
    } finally {
      expect((await command('docker', ['rm', '-f', reader])).code).toBe(0);
    }
    const repeated = await command('docker', [...args, '--aplicar']);
    evidence.idempotent = { code: repeated.code, body: JSON.parse(repeated.stdout) as unknown };
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0);
    evidence.reply = await reply(fixture, 'AFTER-EXPLICIT-RETIREMENT');
    evidence.before = before;
    evidence.replacement = await snapshot(newName);
    const receipt = await fixture.computer.onComputer(['cat', paths.receipt]);
    expect(receipt.code).toBe(0);
    await writeFile(join(evidenceDirectory, 'script-retirement-receipt.json'), receipt.stdout, { mode: 0o600 });
    evidence.hashes = Object.fromEntries(helperSources.map(item => [item.name, createHash('sha256').update(item.body).digest('hex')]));
    evidence.root_invocation = true;
    evidence.volumes_preserved = true;
    evidence.snapshot = EVIDENCE;
  } finally {
    await fixture.close();
    await writeFile(join(evidenceDirectory, 'script-retirement-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
}, 1_200_000);
