import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

export async function materializeDisabledCancelDeploy(computer: ComputerHarness, tenant: string, alias: string,
  runtime: string, release: string): Promise<unknown> {
  const agent = (await computer.pool.query<{ enabled: boolean; lifecycle_state: string; host_id: string; company_id: string }>(
    'SELECT enabled,lifecycle_state,host_id,company_id FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows;
  expect(agent).toHaveLength(1); expect(agent[0]).toMatchObject({ enabled: false, lifecycle_state: 'failed' });
  const query = await readFile(join(process.cwd(), 'ops/scripts/fleet-query.sql'), 'utf8');
  const rows = (await computer.pool.query<{ jsonb_build_object: unknown }>(`WITH source AS (${query.trim().replace(/;$/u, '')}),
    scoped AS (SELECT COALESCE(jsonb_agg(candidate.agent),'[]'::jsonb) AS agents FROM source,
      jsonb_array_elements(source.jsonb_build_object->'agents') candidate(agent)
      WHERE candidate.agent->>'host_id'=$1 AND candidate.agent->>'tenant_id' IN (SELECT id FROM tenants WHERE company_id=$2))
    SELECT source.jsonb_build_object || jsonb_build_object('agents',scoped.agents,'memberships',COALESCE((
      SELECT jsonb_agg(candidate.member) FROM jsonb_array_elements(source.jsonb_build_object->'memberships') candidate(member)
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(scoped.agents) target(agent)
        WHERE target.agent->>'tenant_id'=candidate.member->>'tenant_id' AND target.agent->>'alias'=candidate.member->>'alias')
    ),'[]'::jsonb),'purgedRuntimeKeys',COALESCE((SELECT jsonb_agg(DISTINCT runtime_key) FROM agents
      WHERE company_id=$2 AND host_id=$1 AND purged_at IS NOT NULL AND runtime_key IS NOT NULL),'[]'::jsonb)) AS jsonb_build_object
    FROM source CROSS JOIN scoped`, [agent[0]?.host_id, agent[0]?.company_id])).rows;
  expect(rows).toHaveLength(1);
  const script = `import json,pathlib,sys
release=pathlib.Path(sys.argv[1]);key=sys.argv[2]
sys.path[:0]=[str(release/'ops/cli'),str(release/'ops/scripts')]
from fleet_executor_policy import load_policy
from fleet_runtime_materialization import materialize,load_desired_fleet
from fleet_executor_runtime import sdk_environment
from fleet_executor_policy import SafeFailure
policy=load_policy(release.parent.parent/'executor-policy.json')
state=pathlib.Path(policy['roots']['state'])
source=json.load(sys.stdin)
agent=next(row for row in source['agents'] if row.get('runtime_key')==key)
receipt=materialize(source,{},state)
assert load_desired_fleet(state)==receipt
snapshot=json.loads((state/'generations'/receipt['generation']/'flota.json').read_bytes())
assert key not in snapshot.get('fleet',{}) and key not in snapshot.get('bootstrap',{})
try:sdk_environment(policy,agent,False,None)
except SafeFailure as error:
 rejection=str(error)
 assert rejection=='SDK identity differs from its durable materialized fleet'
else:raise AssertionError('the normal SDK admitted an absent materialized identity')
print(json.dumps({'generation':receipt['generation'],'snapshot_sha256':receipt['snapshotSha256'],'fleet_present':False,'bootstrap_present':False,
 'retired_present':key in snapshot.get('retired',{}),'normal_sdk_rejection':rejection}))
`;
  const result = await computer.onComputer(['python3', '-I', '-B', '-c', script, release, runtime],
    JSON.stringify(rows[0]?.jsonb_build_object));
  if (result.code !== 0) throw new Error(`canonical disabled fleet materialization failed: ${result.stderr}`);
  return { agent: agent[0], ...JSON.parse(result.stdout) as Record<string, unknown> };
}

export async function observeAdmittedCancelDeploy(computer: ComputerHarness, release: string, runtime: string): Promise<unknown> {
  const script = `import json,pathlib,sys
release=pathlib.Path(sys.argv[1]);key=sys.argv[2]
sys.path[:0]=[str(release/'ops/cli'),str(release/'ops/scripts')]
from fleet_executor_policy import load_policy
from fleet_runtime_materialization import load_desired_fleet
policy=load_policy(release.parent.parent/'executor-policy.json');state=pathlib.Path(policy['roots']['state'])
receipt=load_desired_fleet(state)
snapshot=json.loads((state/'generations'/receipt['generation']/'flota.json').read_bytes())
assert snapshot.get('fleet',{}).get(key,{}).get('enabled') is True and key not in snapshot.get('bootstrap',{})
print(json.dumps({'generation':receipt['generation'],'snapshot_sha256':receipt['snapshotSha256'],'fleet_enabled':True,'bootstrap_present':False}))
`;
  const result = await computer.onComputer(['python3', '-I', '-B', '-c', script, release, runtime]);
  if (result.code !== 0) throw new Error(`canonical admitted fleet observation failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}
