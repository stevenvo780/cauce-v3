import { FleetEvidenceSchema, sha256Hex, type FleetEvidence, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import { z } from 'zod';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, isRegistryDraft, type FleetOperationClaim, type FleetOperationRow, type FencedFleetTarget } from './fleet-operation-contracts.js';
import { isDeliverySourceOnly, runtimePrincipalScopeSql } from './system-principal-scope.js';

export type FleetHostStep = FleetStepName | 'compensate';
export interface FleetHostSlice {
  host_id: string;
  placement_role?: 'source' | 'destination' | undefined;
  targets: (FencedFleetTarget & { runtime_key: string })[];
  agents: Record<string, unknown>[];
  target_sha256: string;
}
export interface FleetHostReceipt {
  host_id: string; target_sha256: string; step: FleetHostStep;
  placement_role?: 'source' | 'destination' | undefined;
  epoch: number; claim_token: string; evidence: FleetEvidence;
}
const Host = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const SliceSchema = z.object({ host_id: Host, target_sha256: Digest,
  placement_role: z.enum(['source', 'destination']).optional(),
  targets: z.array(z.object({ resource: z.literal('agent'), tenant_id: z.string(), alias: z.string(), runtime_key: z.string() }).strict()).max(1000),
  agents: z.array(z.record(z.string(), z.unknown())).max(2000),
}).strict();
const ReceiptSchema = z.object({ host_id: Host, target_sha256: Digest, step: z.string(),
  placement_role: z.enum(['source', 'destination']).optional(),
  epoch: z.number().int().nonnegative(), claim_token: z.uuid(), evidence: FleetEvidenceSchema,
}).strict();
function conflict(message: string): never { throw new FleetOperationError('conflict', message); }
function absolute(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('/') && !/[\p{Cc}]/u.test(value)
    && !value.split('/').some(part => part === '..' || part === '.');
}
function identity(agent: Record<string, unknown>): string { return `${String(agent.tenant_id)}/${String(agent.alias)}`; }
function assertPlacement(agent: Record<string, unknown>, request: FleetOperationRequest): void {
  if (agent.tenant_id !== request.target.tenant_id || typeof agent.alias !== 'string'
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(agent.alias) || typeof agent.runtime_key !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(agent.runtime_key) || !Host.safeParse(agent.host_id).success
      || !['container', 'native'].includes(String(agent.runtime_mode))
      || typeof agent.harness_id !== 'string' || agent.harness_id.length === 0
      || ['container_name', 'runtime_user', 'systemd_user'].some(field => typeof agent[field] !== 'string' || agent[field] === '')
      || !absolute(agent.home_directory) || !absolute(agent.state_directory)
      || (request.target.resource === 'agent' && agent.alias !== request.target.alias)) {
    conflict('fleet host scope requires exact complete durable placement');
  }
}
export function usesFleetHostSlices(request: FleetOperationRequest): boolean { return request.target.resource !== 'agent'; }
export function isFleetRelocation(request: FleetOperationRequest, previous: readonly Record<string, unknown>[]): boolean {
  return request.kind === 'update' && previous.length === 1 && previous[0]?.host_id !== request.parameters.placement.host_id;
}
export function selectFleetHostSlices<T extends Pick<FleetHostSlice, 'host_id' | 'placement_role'>>(
  slices: readonly T[], step: FleetHostStep,
): T[] {
  if (!slices.some(slice => slice.placement_role !== undefined)) return [...slices];
  if (slices.length !== 2 || new Set(slices.map(slice => slice.host_id)).size !== 2
      || slices.filter(slice => slice.placement_role === 'source').length !== 1
      || slices.filter(slice => slice.placement_role === 'destination').length !== 1) conflict('relocation requires its exact source and destination');
  if (step === 'stop' || step === 'revoke') return slices.filter(slice => slice.placement_role === 'source');
  if (['credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission'].includes(step)) {
    return slices.filter(slice => slice.placement_role === 'destination');
  }
  if (step === 'compensate') return [...slices].sort((left, right) => Number(left.placement_role === 'source') - Number(right.placement_role === 'source'));
  return [...slices];
}

export async function readFleetGroupAgents(client: DatabaseClient, request: FleetOperationRequest): Promise<Record<string, unknown>[]> {
  const target = request.target;
  return (await client.query<Record<string, unknown>>(`SELECT agent.tenant_id,agent.alias,agent.runtime_key,agent.harness_id,
    agent.host_id,agent.runtime_mode,agent.container_name,agent.runtime_user,agent.home_directory,agent.state_directory,
    agent.systemd_user,agent.primary_room_id,agent.primary_account_id,agent.model_id,agent.reasoning_effort,
    COALESCE(to_jsonb(agent)->'extensions','[]'::jsonb) AS extensions,agent.enabled,agent.lifecycle_state
    FROM agents agent WHERE agent.tenant_id=$1 AND agent.purged_at IS NULL
      AND ${runtimePrincipalScopeSql('agent.tenant_id', 'agent.alias')}
      AND ($2::text IS NULL OR agent.alias=$2)
      AND ($3::text IS NULL OR agent.primary_room_id=$3 OR EXISTS(SELECT 1 FROM memberships member
        WHERE member.tenant_id=agent.tenant_id AND member.alias=agent.alias AND member.room_id=$3))
    ORDER BY agent.host_id,agent.alias FOR SHARE OF agent`,
  [target.tenant_id, target.resource === 'agent' ? target.alias : null, target.resource === 'room' ? target.room_id : null])).rows;
}
export async function assertFleetHostAccess(
  client: DatabaseClient, request: FleetOperationRequest, controllerHost: string | undefined, coordinatorEnabled: boolean,
  coordinatorHosts?: readonly string[],
): Promise<void> {
  if (request.target.resource === 'agent' && await isDeliverySourceOnly(client, request.target.tenant_id, request.target.alias)) {
    throw new FleetOperationError('forbidden', 'delivery source principal has no physical runtime');
  }
  const grouped = usesFleetHostSlices(request);
  if ((grouped || coordinatorEnabled) && !Host.safeParse(controllerHost).success) conflict('fleet controller host is unavailable');
  const registered = new Set(coordinatorHosts);
  if (coordinatorEnabled && (!coordinatorHosts || coordinatorHosts.length === 0 || coordinatorHosts.length > 100
      || registered.size !== coordinatorHosts.length || coordinatorHosts.some(host => !Host.safeParse(host).success)
      || !registered.has(controllerHost ?? ''))) conflict('fleet coordinator requires its exact registered host transports');
  if (coordinatorEnabled && (request.kind === 'create' || request.kind === 'update')
      && !registered.has(request.parameters.placement.host_id)) conflict('desired fleet placement has no registered host transport');
  const agents = await readFleetGroupAgents(client, request);
  if (agents.length > 1000) conflict('fleet host scope exceeds its bound');
  const groupLifecycle = request.target.resource !== 'agent' && ['retire', 'purge', 'restore'].includes(request.kind);
  for (const agent of agents) {
    // A team member registered without a fleet runtime has no host effect to verify: retiring the group disables it by configuration.
    if (groupLifecycle && !agent.runtime_key && !agent.host_id) continue;
    if (request.kind === 'create' && isRegistryDraft({ runtime_key: agent.runtime_key as string | null,
      runtime_mode: agent.runtime_mode as string | null, primary_room_id: agent.primary_room_id as string | null, retired_at: null,
      enabled: agent.enabled === true, lifecycle_state: String(agent.lifecycle_state) })) continue;
    assertPlacement(agent, request);
    if (coordinatorEnabled && !registered.has(String(agent.host_id))) conflict('fleet host scope has no registered host transport');
    if (grouped && !coordinatorEnabled && agent.host_id !== controllerHost) conflict('group lifecycle requires its configured host coordinator');
  }
}
function scopeDigest(row: FleetOperationRow, host: string, agents: Record<string, unknown>[], targets: FleetHostSlice['targets'], previous: Record<string, unknown>[], role?: FleetHostSlice['placement_role']): string {
  return sha256Hex({ operation_id: row.id, request_sha256: row.request_hash, prepared_revision: row.desired_revision,
    host_id: host, ...(role === undefined ? {} : { placement_role: role }), agents, targets, previous_agents: previous.filter(agent => agent.host_id === host) });
}
export function planFleetHostSlices(row: FleetOperationRow, agents: Record<string, unknown>[], previous: Record<string, unknown>[] = []): FleetHostSlice[] {
  if (row.desired_revision === null || !Host.safeParse(row.executor_host).success || agents.length > 1000) {
    conflict('fleet host scope has no durable prepared revision');
  }
  if (isFleetRelocation(row.request, previous)) {
    const source = previous[0]; const destination = agents[0];
    if (row.request.kind !== 'update' || !source || !destination || agents.length !== 1
        || identity(source) !== identity(destination) || identity(source) !== identity(row.request.target)
        || source.runtime_key !== destination.runtime_key || source.runtime_key !== row.request.parameters.runtime_key
        || destination.host_id !== row.request.parameters.placement.host_id) conflict('relocation changes its immutable durable identity');
    return ([['source', source], ['destination', destination]] as const).map(([placement_role, agent]) => {
      assertPlacement(agent, row.request);
      const host_id = String(agent.host_id); const members = [structuredClone(agent)];
      const targets = [{ resource: 'agent' as const, tenant_id: String(agent.tenant_id), alias: String(agent.alias), runtime_key: String(agent.runtime_key) }];
      return { host_id, placement_role, agents: members, targets,
        target_sha256: scopeDigest(row, host_id, members, targets, previous, placement_role) };
    }).sort((left, right) => left.host_id.localeCompare(right.host_id));
  }
  const hosts = new Map<string, Record<string, unknown>[]>();
  const seen = new Set<string>();
  const groupLifecycle = row.target.resource !== 'agent' && ['retire', 'purge', 'restore'].includes(row.kind);
  for (const agent of agents) {
    if (groupLifecycle && !agent.runtime_key && !agent.host_id) continue;
    assertPlacement(agent, row.request);
    if (seen.has(identity(agent))) conflict('fleet host scope repeats a durable agent identity');
    seen.add(identity(agent));
    const host = String(agent.host_id);
    const members = hosts.get(host) ?? [];
    members.push(structuredClone(agent)); hosts.set(host, members);
  }
  if (hosts.size === 0) hosts.set(row.executor_host, []);
  if (hosts.size > 100) conflict('fleet host scope exceeds its host bound');
  return [...hosts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host_id, members]) => {
    const ordered = members.sort((left, right) => identity(left).localeCompare(identity(right)));
    const targets = ordered.map(agent => ({ resource: 'agent' as const, tenant_id: String(agent.tenant_id),
      alias: String(agent.alias), runtime_key: String(agent.runtime_key) }));
    return { host_id, agents: ordered, targets, target_sha256: scopeDigest(row, host_id, ordered, targets, previous) };
  });
}
function adoptedDraft(agent: Record<string, unknown>): boolean {
  return isRegistryDraft({ runtime_key: agent.runtime_key as string | null,
    runtime_mode: agent.runtime_mode as string | null, primary_room_id: agent.primary_room_id as string | null, retired_at: null,
    enabled: agent.enabled === true, lifecycle_state: String(agent.lifecycle_state) });
}
export async function loadFleetHostSlices(client: DatabaseClient, row: FleetOperationRow): Promise<FleetHostSlice[]> {
  const event = (await client.query<{ metadata: unknown }>(`SELECT metadata FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step' IN ('prepare','fence') ORDER BY id LIMIT 1`, [row.id])).rows[0];
  const metadata = z.object({ host_slices: z.array(SliceSchema).min(1).max(100),
    fenced_targets: z.array(z.object({ resource: z.literal('agent'), tenant_id: z.string(), alias: z.string() }).strict()).max(1000),
    previous_agents: z.array(z.record(z.string(), z.unknown())).max(1000),
    prepared_revision: z.number().int().nonnegative(),
  }).loose().safeParse(event?.metadata);
  if (!metadata.success) conflict('fleet operation has no sealed host scope');
  const slices = metadata.data.host_slices;
  const create = row.request.kind === 'create';
  const groupLifecycle = row.request.target.resource !== 'agent' && ['retire', 'purge', 'restore'].includes(row.request.kind);
  for (const agent of metadata.data.previous_agents) {
    if (groupLifecycle && !agent.runtime_key && !agent.host_id) continue;
    if (!(create && adoptedDraft(agent))) assertPlacement(agent, row.request);
  }
  const expected = planFleetHostSlices({ ...row, desired_revision: String(metadata.data.prepared_revision) },
    slices.filter(slice => slice.placement_role !== 'source').flatMap(slice => slice.agents), metadata.data.previous_agents);
  if (sha256Hex(expected) !== sha256Hex(slices)) conflict('fleet host scope digest differs from its prepared placements');
  const identities = [...new Set(slices.flatMap(slice => slice.targets).map(identity))].sort();
  const fenced = metadata.data.fenced_targets.map(identity).sort();
  const previousByIdentity = new Map(metadata.data.previous_agents.map(agent => [identity(agent), agent]));
  const placedFenced = groupLifecycle
    ? fenced.filter(id => { const agent = previousByIdentity.get(id); return agent !== undefined && typeof agent.runtime_key === 'string' && agent.runtime_key !== ''; })
    : fenced;
  const targetIdentity = identity(row.request.target);
  const previous = metadata.data.previous_agents;
  const adopting = previous.length === 1 && previous[0] !== undefined && adoptedDraft(previous[0])
    && identity(previous[0]) === targetIdentity && fenced.length === 1 && fenced[0] === targetIdentity;
  const creation = create && (fenced.length === 0 || adopting)
    && identities.length === 1 && identities[0] === targetIdentity;
  if ((row.request.kind === 'create' ? !creation : sha256Hex(identities) !== sha256Hex(placedFenced))
      || sha256Hex(metadata.data.previous_agents.map(identity).sort()) !== sha256Hex(fenced)) {
    conflict('fleet host scope differs from its exact durable fence');
  }
  return slices;
}
export async function loadFleetHostScope(client: DatabaseClient, row: FleetOperationRow, host: string): Promise<FleetHostSlice> {
  const slice = (await loadFleetHostSlices(client, row)).find(slice => slice.host_id === host);
  if (!slice) conflict('host is outside the sealed fleet scope');
  return slice;
}
export function hostStepEvidence(name: FleetHostStep, input: FleetEvidence): FleetEvidence {
  const parsed = FleetEvidenceSchema.safeParse(input);
  if (!parsed.success) conflict('host receipt contains unsupported evidence');
  const proof = parsed.data;
  const valid = name === 'compensate' ? proof.recovery_compensated === true || (proof.stopped_verified === true || !!proof.runtime_digest) && proof.revocation_verified === true
    : name === 'purge' ? proof.stopped_verified === true && proof.revocation_verified === true
    : name === 'artifacts' ? !!proof.artifact_sha256 : name === 'credentials' ? !!proof.certificate_fingerprint
      : name === 'runtime' ? !!proof.runtime_digest : name === 'authenticate' ? proof.provider_verified === true
        : name === 'profile' ? proof.profile_verified === true : name === 'verify' ? !!proof.recovery && !!proof.runtime_digest || proof.bootstrap_verified === true && proof.roundtrip_verified === true
          : name === 'stop' ? proof.stopped_verified === true : name === 'revoke' ? proof.revocation_verified === true
            : name === 'admission' ? proof.authority_verified === true && !!proof.artifact_sha256 : false;
  if (!valid || (proof.removed?.length ?? 0) > 512) conflict('host receipt has not demonstrated its declared physical effect');
  return proof;
}
export async function readFleetHostReceipts(
  client: DatabaseClient, row: FleetOperationRow, claim: FleetOperationClaim, name: FleetHostStep,
): Promise<FleetHostReceipt[]> {
  const events = (await client.query<{ receipt: unknown }>(`SELECT metadata->'host_receipt' AS receipt FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step'=$2
      AND metadata ? 'host_receipt' ORDER BY id`, [row.id, name])).rows;
  const slices = selectFleetHostSlices(await loadFleetHostSlices(client, row), name);
  const receipts = new Map<string, FleetHostReceipt>();
  for (const event of events) {
    const parsed = ReceiptSchema.safeParse(event.receipt);
    if (!parsed.success) conflict('durable host receipt has an invalid shape');
    const receipt = parsed.data;
    if (receipt.epoch !== claim.epoch || receipt.claim_token !== claim.claim_token) continue;
    const slice = slices.find(slice => slice.host_id === receipt.host_id);
    if (receipt.target_sha256 !== slice?.target_sha256 || receipt.placement_role !== slice.placement_role || receipt.step !== name) conflict('durable host receipt scope differs');
    const proof = hostStepEvidence(name, receipt.evidence);
    const entry = { ...receipt, step: name, evidence: proof };
    const prior = receipts.get(receipt.host_id);
    if (prior && sha256Hex(prior) !== sha256Hex(entry)) conflict('durable host evidence cannot be replaced');
    receipts.set(receipt.host_id, entry);
  }
  return [...receipts.values()].sort((left, right) => left.host_id.localeCompare(right.host_id));
}
export function aggregateHostEvidence(name: FleetHostStep, receipts: Pick<FleetHostReceipt, 'host_id' | 'target_sha256' | 'evidence' | 'placement_role'>[]): FleetEvidence {
  if (receipts.length === 0 || new Set(receipts.map(receipt => receipt.host_id)).size !== receipts.length) {
    conflict('a fleet host barrier requires explicit unique host receipts');
  }
  for (const receipt of receipts) hostStepEvidence(name, receipt.evidence);
  const relocationArtifacts = name === 'artifacts' && receipts.length === 2
    && receipts.some(receipt => receipt.placement_role === 'source') && receipts.some(receipt => receipt.placement_role === 'destination');
  if (['artifacts', 'admission'].includes(name) && !relocationArtifacts && new Set(receipts.map(receipt => receipt.evidence.artifact_sha256)).size !== 1) {
    conflict('fleet host artifacts must describe the same global desired image');
  }
  const evidence = sha256Hex([...receipts].sort((left, right) => left.host_id.localeCompare(right.host_id))
    .map(({ host_id, target_sha256, evidence, placement_role }) => ({ host_id, target_sha256, evidence,
      ...(placement_role === undefined ? {} : { placement_role }) })));
  if (name === 'artifacts') return { artifact_sha256: evidence };
  if (name === 'admission') {
    const verified = receipts.filter(receipt => receipt.evidence.replacement_verified !== undefined);
    if (verified.length && (receipts.length !== 1 || verified.length !== 1)) conflict('replacement admission requires one exact host');
    return { authority_verified: true, artifact_sha256: evidence,
      ...(verified[0]?.evidence.replacement_verified === undefined ? {} : { replacement_verified: verified[0].evidence.replacement_verified }) };
  }
  if (name === 'purge') return { stopped_verified: true, revocation_verified: true,
    ...(receipts.some(receipt => receipt.evidence.removed !== undefined)
      ? { removed: [...receipts].sort((left, right) => left.host_id.localeCompare(right.host_id)).flatMap(receipt => receipt.evidence.removed ?? []) } : {}),
    ...(receipts.some(receipt => receipt.evidence.native_decommissioned === true) ? { native_decommissioned: true } : {}) };
  if (name === 'compensate') {
    if (receipts.every(receipt => receipt.evidence.recovery_compensated === true)) return { recovery_compensated: true };
    if (receipts.some(receipt => receipt.evidence.replacement_restored !== undefined)) {
      const first = receipts[0];
      if (receipts.length !== 1 || first?.evidence.replacement_restored === undefined
          || first.evidence.stopped_verified !== true || first.evidence.revocation_verified !== true
          || first.evidence.runtime_digest !== first.evidence.replacement_restored.runtime_digest) {
        conflict('replacement restoration requires one exact runtime and authority receipt');
      }
      return first.evidence;
    }
    if (receipts.some(receipt => !!receipt.evidence.runtime_digest)) {
      if (receipts.length !== 1) conflict('previous runtime restoration requires one exact host');
      return { runtime_digest: evidence, revocation_verified: true };
    }
    return { stopped_verified: true, revocation_verified: true };
  }
  if (name === 'stop') return { stopped_verified: true };
  if (name === 'revoke') return { revocation_verified: true };
  if (receipts.length !== 1) conflict('agent activation requires one exact host receipt');
  const first = receipts[0]; if (!first) conflict('host receipt is unavailable');
  return first.evidence;
}
export async function assertFleetHostBarrier(
  client: DatabaseClient, row: FleetOperationRow, claim: FleetOperationClaim, name: FleetHostStep, proof: FleetEvidence,
): Promise<FleetHostReceipt[]> {
  const slices = selectFleetHostSlices(await loadFleetHostSlices(client, row), name);
  const receipts = await readFleetHostReceipts(client, row, claim, name);
  if (receipts.length !== slices.length || slices.some(slice => !receipts.some(receipt => receipt.host_id === slice.host_id))) {
    conflict('fleet effect requires every sealed host receipt under the current claim');
  }
  if (sha256Hex(aggregateHostEvidence(name, receipts)) !== sha256Hex(proof)) conflict('fleet aggregate evidence differs from its host receipts');
  return receipts;
}
export async function assertFleetSealedHostBarrier(
  client: DatabaseClient, row: FleetOperationRow, name: FleetStepName, proof: FleetEvidence,
): Promise<void> {
  const events = (await client.query<{ metadata: unknown }>(`SELECT metadata FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step'=$2 AND metadata ? 'host_barrier' ORDER BY id`,
  [row.id, name])).rows;
  if (events.length !== 1) conflict('completed fleet step requires one immutable host barrier');
  const seal = z.object({ host_barrier: z.object({ epoch: z.number().int().nonnegative(), claim_token: z.uuid(), direct: z.boolean(),
    receipts: z.array(ReceiptSchema).min(1).max(100) }).strict() }).loose().safeParse(events[0]?.metadata);
  if (!seal.success) conflict('completed fleet host barrier has an invalid shape');
  const barrier = seal.data.host_barrier;
  const slices = selectFleetHostSlices(await loadFleetHostSlices(client, row), name);
  if (barrier.receipts.length !== slices.length || new Set(barrier.receipts.map(receipt => receipt.host_id)).size !== slices.length) {
    conflict('completed fleet host barrier does not cover every exact host');
  }
  for (const receipt of barrier.receipts) {
    const slice = slices.find(slice => slice.host_id === receipt.host_id);
    if (receipt.target_sha256 !== slice?.target_sha256 || receipt.placement_role !== slice.placement_role || receipt.step !== name
      || receipt.epoch !== barrier.epoch || receipt.claim_token !== barrier.claim_token) conflict('completed host receipt differs from its sealed claim scope');
    hostStepEvidence(name, receipt.evidence);
  }
  if (barrier.direct && (row.target.resource !== 'agent' || slices.length !== 1 || barrier.receipts[0]?.host_id !== row.executor_host)) {
    conflict('direct fleet barrier requires one exact durable agent host');
  }
  if (barrier.direct && slices.some(slice => slice.placement_role !== undefined)) conflict('relocation cannot use a direct host barrier');
  const completed = barrier.direct ? barrier.receipts[0]?.evidence : aggregateHostEvidence(name, barrier.receipts);
  if (sha256Hex(completed) !== sha256Hex(proof)) conflict('completed fleet aggregate differs from its immutable barrier');
}
export async function assertFleetRelocationSourceBarrier(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (!(await loadFleetHostSlices(client, row)).some(slice => slice.placement_role !== undefined)) return;
  for (const name of ['stop', 'revoke'] as const) {
    const step = row.steps.find(step => step.name === name);
    if (step?.status !== 'succeeded') conflict('relocation destination requires the completed source stop and revocation');
    await assertFleetSealedHostBarrier(client, row, name, step.evidence ?? {});
  }
}
