import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { OWNER, PREFIX, runCleanup, type OrphansFixture, type OrphansPlan, type TestVolumePlanItem } from './v4-huerfanos.fixtures.js';

export interface ResourceResult {
  status: string; external_mutations: false | 'possible';
  items: { id: string; status: string; reason_code: string; volume_sha256?: string; resource_sha256?: string;
    preview_sha256?: string; head?: string; idempotent_replay?: boolean;
    context_receipt?: { operation_id: string; commit: string; before_head: string; tree_oid: string; pushed: boolean } }[];
}
export type Capture = (name: string) => Promise<unknown>;

export async function checkedResource(fixture: OrphansFixture, plan: OrphansPlan, name: string, apply = false, code = 0): Promise<ResourceResult> {
  const result = await runCleanup(fixture, plan, name, apply ? '--aplicar' : undefined);
  expect(result.code, result.stdout + result.stderr).toBe(code);
  return JSON.parse(result.stdout) as ResourceResult;
}

async function volume(name: string, alias: string): Promise<string> {
  return docker(['volume', 'create', '--label', `cauce.e2e.owner=${OWNER}`, '--label', `cauce.fleet.alias=${alias}`, name]);
}

async function identity(name: string): Promise<string> {
  return docker(['volume', 'inspect', '--format', '{{.Name}} {{.CreatedAt}} {{json .Labels}}', name]);
}

export async function exerciseOrphanVolumes(fixture: OrphansFixture, capture: Capture): Promise<Record<string, unknown>> {
  const daemon = JSON.parse(await docker(['info', '--format', '{{json .ID}}'])) as string;
  const empty = await volume(`${PREFIX}-orphan-empty`, `${PREFIX}-purged`);
  const changed = await volume(`${PREFIX}-inventory-changed`, `${PREFIX}-old`);
  const real = await volume(`${PREFIX}-real-agent-guard`, 'retained-live-agent');
  const campaign = await volume(`${PREFIX}-campaign-guard`, 'zz-canary-active-campaign');
  const item = (id: string, name: string): TestVolumePlanItem => ({ id, kind: 'test_volume', name,
    scope: { company_id: fixture.company }, location: { kind: 'lab_socket' },
    pin: { daemon_id: daemon, volume_sha256: null, preview_sha256: null } });
  const plan = (items: TestVolumePlanItem[]): OrphansPlan => ({ version: 1, company_id: fixture.company, expected_revision: 0, items });
  const pin = async (candidate: TestVolumePlanItem, name: string) => {
    const discovery = await checkedResource(fixture, plan([candidate]), `${name}-discovery`);
    expect(discovery.items[0]).toMatchObject({ id: candidate.id, status: 'retained', reason_code: 'preview_review_required' });
    const observed = discovery.items[0];
    if (!observed?.volume_sha256 || !observed.preview_sha256) throw new Error('volume discovery lacks identity or preview pin');
    candidate.pin.volume_sha256 = observed.volume_sha256;
    candidate.pin.preview_sha256 = observed.preview_sha256;
    await capture(`${name}-discovery`);
    return plan([candidate]);
  };
  const emptyBefore = await identity(empty);
  const emptyPlan = await pin(item('empty', empty), 'volume-empty');
  const stale = structuredClone(emptyPlan);
  const staleItem = stale.items[0];
  if (staleItem?.kind !== 'test_volume') throw new Error('volume plan has another kind');
  staleItem.pin.preview_sha256 = 'f'.repeat(64);
  const staleResult = await checkedResource(fixture, stale, 'volume-stale-pin', true, 1);
  expect(staleResult.items[0]).toMatchObject({ status: 'blocked', reason_code: 'preview_changed' });
  expect(await identity(empty)).toBe(emptyBefore);
  await capture('volume-stale-pin');
  const simulated = await checkedResource(fixture, emptyPlan, 'volume-empty');
  expect(simulated.items[0]).toMatchObject({ status: 'would_remove', reason_code: 'ready' });
  expect(simulated.external_mutations).toBe(false);
  expect(await identity(empty)).toBe(emptyBefore);
  const removed = await checkedResource(fixture, emptyPlan, 'volume-empty', true);
  expect(removed.items[0]).toMatchObject({ status: 'removed', reason_code: 'volume_removed' });
  expect((await docker(['volume', 'ls', '--filter', `name=^${empty}$`, '--format', '{{.Name}}']))).toBe('');
  const replay = await checkedResource(fixture, emptyPlan, 'volume-empty', true);
  expect(replay.items[0]).toMatchObject({ status: 'removed', reason_code: 'volume_removed', idempotent_replay: true });
  await capture('volume-empty');
  const changedPlan = await pin(item('changed', changed), 'volume-changed');
  expect((await checkedResource(fixture, changedPlan, 'volume-changed')).items[0]?.status).toBe('would_remove');
  const image = await docker(['inspect', '--format', '{{.Image}}', fixture.liveContainer]);
  const holder = await docker(['create', '--name', `${PREFIX}-inventory-holder`, '--label', `cauce.e2e.owner=${OWNER}`,
    '--network', 'none', '--mount', `type=volume,src=${changed},dst=/canary`, image, '/bin/true']);
  const changedResult = await checkedResource(fixture, changedPlan, 'volume-changed', true);
  expect(changedResult.items[0]).toMatchObject({ status: 'retained', reason_code: 'volume_mounted' });
  expect(await docker(['ps', '-a', '--no-trunc', '--filter', `volume=${changed}`, '--format', '{{.ID}}'])).toBe(holder);
  await identity(changed);
  await capture('volume-changed');
  const protectedNames = [real, campaign, fixture.retainedVolume];
  const protectedBefore = await Promise.all(protectedNames.map(identity));
  const protectedPlan = plan([item('real', real), item('campaign144', campaign), item('protected', fixture.retainedVolume)]);
  const protectedResult = await checkedResource(fixture, protectedPlan, 'volume-protected', true);
  expect(protectedResult.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'real', status: 'retained', reason_code: 'real_agent_volume' }),
    expect.objectContaining({ id: 'campaign144', status: 'retained', reason_code: 'active_campaign_144' }),
    expect.objectContaining({ id: 'protected', status: 'retained', reason_code: 'praxis_inventory_only' }),
  ]));
  expect(await Promise.all(protectedNames.map(identity))).toEqual(protectedBefore);
  await capture('volume-protected');
  return { daemon, empty, empty_before: emptyBefore, removed, replay, stale: staleResult,
    changed: { name: changed, holder, result: changedResult }, protected: protectedResult };
}
