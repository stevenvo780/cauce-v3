import { recoverNativeAdmin } from './recovery.js';
import { discoverNativeAdmin } from './discovery.js';
import { NativeAdminError } from './error.js';
import { randomUUID } from 'node:crypto';
import {
  AliasSchema, TenantSchema, NativeAdminOutcomeSchema, NativeOperationIdSchema, NATIVE_ADMIN_FEATURE,
  type NativeAdminCommand, type NativePieceKind, type NativePieceMutation, type NativeRuntimeIdentity,
} from '@cauce/protocol';
import {
  authorizeAgentContextDispatch, reserveAgentContextWrite, resolveAgentContextWrite, canonicalProfileRuntimeContract, StoreError,
  withTransaction, type CauceRepository, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import type { AgentFactsProbe } from '../agent-documents.routes.js';
import type { AgentProfileDeps } from '../agent-profile.routes.js';

export interface NativeAdminActor {
  tenant_id: string; alias: string; subject: string; signal?: AbortSignal;
  humanAuthority(client: DatabaseClient): Promise<{ humanId: string; tenantId: string; actorAlias: string }>;
}
export interface NativeAdminServiceDeps {
  pool: DatabasePool; probe: AgentFactsProbe;
  repository: Pick<CauceRepository, 'authorizeAgentTarget' | 'assertPermission'>;
  readContext: NonNullable<AgentProfileDeps['readContext']>;
  readRuntimeExpectation: NonNullable<AgentProfileDeps['readWriteExpectation']>;
}
export { NativeAdminError } from './error.js';
export function nativeKinds(harness: string): NativePieceKind[] {
  return harness === 'claude' ? ['skill', 'subagent', 'mcp'] : harness === 'codex' ? ['skill', 'mcp'] : [];
}
export function createNativeAdminService(deps: NativeAdminServiceDeps) {
  async function authority(client: DatabaseClient, actor: NativeAdminActor, tenantId: string, alias: string, write: boolean) {
    const verified = await actor.humanAuthority(client);
    if (`console:${verified.humanId}` !== actor.subject || verified.tenantId !== actor.tenant_id || verified.actorAlias !== actor.alias) throw new NativeAdminError('forbidden');
    await deps.repository.assertPermission(TenantSchema.parse(actor.tenant_id), actor.alias, write ? 'control' : 'read', client, true);
    const target = await deps.repository.authorizeAgentTarget(TenantSchema.parse(actor.tenant_id), actor.alias,
      TenantSchema.parse(tenantId), AliasSchema.parse(alias), write ? 'control' : 'read', client);
    if (!target) throw new NativeAdminError('forbidden');
    if (write) {
      const result = await client.query(`SELECT 1 FROM console_users person JOIN human_tenant_memberships human ON human.human_id=person.id
        AND human.tenant_id=person.tenant_id AND human.actor_alias=person.alias WHERE person.id=$1 AND person.active AND person.role='operator'
        AND human.enabled AND human.revoked_at IS NULL AND human.role='operator' AND 'control'=ANY(human.permissions) FOR SHARE OF person,human`, [verified.humanId]);
      if (!result.rowCount) throw new NativeAdminError('forbidden');
    }
    actor.signal?.throwIfAborted();
  }
  async function runtime(tenantId: string, alias: string) {
    const measured = await deps.probe.factsFor(tenantId, alias); const facts = measured?.facts;
    if (measured?.source !== 'measured' || !facts?.generation || !facts.containerId || !facts.writerInstanceId
      || !facts.features?.includes(NATIVE_ADMIN_FEATURE) || !deps.probe.nativeAdmin) throw new NativeAdminError('unsupported');
    const root = facts.harness === 'claude' ? facts.claudeConfigDir : facts.harness === 'codex' ? facts.codexHome : undefined;
    if (!root?.startsWith(`${facts.home}/`) || root.includes('/../') || !nativeKinds(facts.harness).length) throw new NativeAdminError('unsupported');
    const identity: NativeRuntimeIdentity = { generation: facts.generation, container_id: facts.containerId, writer_instance_id: facts.writerInstanceId };
    return { facts, identity, root };
  }
  async function call(tenantId: string, alias: string, command: NativeAdminCommand, signal?: AbortSignal) {
    const parsed = NativeAdminOutcomeSchema.safeParse(await deps.probe.nativeAdmin?.(tenantId, alias, command, signal));
    if (!parsed.success) throw new NativeAdminError('unavailable');
    if (parsed.data.type === 'error') throw new NativeAdminError(parsed.data.error);
    return parsed.data;
  }
  async function read(actor: NativeAdminActor, tenantId: string, alias: string, kind: NativePieceKind, id?: string) {
    await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, false));
    const current = await runtime(tenantId, alias);
    const command: NativeAdminCommand = id === undefined ? { op: 'list', kind, request_id: randomUUID(), identity: current.identity }
      : { op: 'get', kind, id, request_id: randomUUID(), identity: current.identity };
    const outcome = await call(tenantId, alias, command, actor.signal);
    if (id === undefined ? outcome.type !== 'inventory' || outcome.kind !== kind
      : outcome.type !== 'piece' || outcome.piece.kind !== kind || outcome.piece.id !== id) throw new NativeAdminError('unavailable');
    let canWrite = false;
    try { await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, true)); canWrite = true; }
    catch (error) { if (!(error instanceof NativeAdminError && error.code === 'forbidden') && !(error instanceof StoreError && error.code === 'forbidden')) throw error; }
    return { tenant_id: tenantId, alias, identity: current.identity, harness: current.facts.harness,
      kinds: nativeKinds(current.facts.harness), can_write: canWrite, outcome };
  }
  async function write(actor: NativeAdminActor, tenantId: string, alias: string, mutation: NativePieceMutation, reason: string,
    expectedIdentity: NativeRuntimeIdentity, requestedOperationId?: string) {
    if (requestedOperationId !== undefined && !NativeOperationIdSchema.safeParse(requestedOperationId).success) throw new NativeAdminError('invalid_input');
    await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, true));
    const current = await runtime(tenantId, alias);
    if (JSON.stringify(current.identity) !== JSON.stringify(expectedIdentity)) throw new NativeAdminError('conflict');
    const plan = await call(tenantId, alias, { op: 'prepare', mutation, request_id: randomUUID(), identity: current.identity }, actor.signal);
    const path = mutation.kind === 'mcp' ? `${current.root}/${current.facts.harness === 'claude' ? '.claude.json' : 'config.toml'}`
      : mutation.kind === 'skill' ? `${current.root}/skills/${mutation.id}/SKILL.md`
        : mutation.kind === 'subagent' && current.facts.harness === 'claude' ? `${current.root}/agents/${mutation.id}.md` : undefined;
    if (plan.type !== 'plan' || plan.kind !== mutation.kind || plan.id !== mutation.id || plan.path !== path
      || plan.before_sha !== mutation.expected_sha) throw new NativeAdminError('unavailable');
    const context = await deps.readContext(tenantId, alias); const expectation = await deps.readRuntimeExpectation(tenantId, alias);
    const operationId = requestedOperationId ?? randomUUID();
    const documentName = `native:${mutation.kind}:${mutation.id}`;
    let didReserve = false;
    try {
      const reserved = await reserveAgentContextWrite(deps.pool, { operationId, token: randomUUID(), generation: randomUUID(),
        tenantId: TenantSchema.parse(tenantId), alias, expectedRevision: context.revision, expectedExpectation: expectation === undefined ? null : canonicalProfileRuntimeContract(expectation) ?? null,
        writer: { runtimeGeneration: current.identity.generation, containerId: current.identity.container_id, writerInstanceId: current.identity.writer_instance_id },
        documents: [{ name: documentName, path: plan.path, beforeSha: plan.before_sha, targetSha: plan.target_sha }],
        ...(actor.signal === undefined ? {} : { signal: actor.signal }), updateDesired: client => authority(client, actor, tenantId, alias, true),
      });
      didReserve = true;
      const authorized = await authorizeAgentContextDispatch(deps.pool, reserved, actor.signal);
      await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, true));
      const operation = { operation_id: operationId, operation_token: authorized.token, operation_generation: authorized.generation };
      const command: NativeAdminCommand = { op: 'mutate', mutation, operation, request_id: randomUUID(), identity: current.identity };
      const receipt = await call(tenantId, alias, command, actor.signal);
      if (receipt.type !== 'receipt' || receipt.path !== plan.path || receipt.sha !== plan.target_sha || receipt.bytes !== plan.bytes
        || receipt.kind !== mutation.kind || receipt.id !== mutation.id || receipt.operation_id !== operationId
        || receipt.operation_generation !== authorized.generation || JSON.stringify(receipt.identity) !== JSON.stringify(current.identity)) throw new NativeAdminError('unavailable');
      const resolution = await resolveAgentContextWrite(deps.pool, authorized, async () => {
        const proof = await call(tenantId, alias, { ...command, op: 'status', request_id: randomUUID() }, actor.signal);
        const after = await runtime(tenantId, alias);
        if (proof.type !== 'receipt' || JSON.stringify(proof) !== JSON.stringify(receipt)
          || JSON.stringify(after.identity) !== JSON.stringify(current.identity)) throw new NativeAdminError('conflict');
        return { operationId, token: authorized.token, generation: authorized.generation, writer: authorized.writer,
          state: 'quiescent', durability: 'post_fsync', documents: [{ name: documentName, path: receipt.path, sha: receipt.sha }] };
      }, async client => {
        await authority(client, actor, tenantId, alias, true);
        await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata) VALUES($1,$2,'agent_native_admin.write','allow',$3::jsonb)`,
          [actor.tenant_id, actor.alias, JSON.stringify({ target_tenant: tenantId, target_alias: alias, kind: mutation.kind, id: mutation.id,
            action: mutation.action, operation_id: operationId, sha: receipt.sha, bytes: receipt.bytes, backup_id: receipt.backup_id, reason })]);
      }, actor.signal);
      if (resolution !== 'target') throw new NativeAdminError('unavailable');
      return { tenant_id: tenantId, alias, state: 'written_pending_reload' as const, action: mutation.action, receipt };
    } catch (error) {
      if (!didReserve && error instanceof StoreError && error.recoveryReason !== 'context_write_commit_unverified') throw error;
      throw new NativeAdminError('unavailable', operationId);
    }
  }
  async function recognize(actor: NativeAdminActor, tenantId: string, alias: string, kind: NativePieceKind, id: string, expectedSha: string | null,
    expectedIdentity: NativeRuntimeIdentity) {
    await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, false));
    const current = await runtime(tenantId, alias);
    if (JSON.stringify(current.identity) !== JSON.stringify(expectedIdentity)) throw new NativeAdminError('conflict');
    const outcome = await call(tenantId, alias, { op: 'recognize', kind, id, expected_sha: expectedSha, request_id: randomUUID(), identity: current.identity }, actor.signal);
    const after = await runtime(tenantId, alias);
    if (outcome.type !== 'recognition' || outcome.kind !== kind || outcome.id !== id || outcome.sha !== expectedSha
      || JSON.stringify(current.identity) !== JSON.stringify(after.identity)) throw new NativeAdminError('unavailable');
    return { tenant_id: tenantId, alias, identity: current.identity, outcome };
  }
  async function recover(actor: NativeAdminActor, tenantId: string, alias: string, operationId: string, mutation: NativePieceMutation) {
    if (!NativeOperationIdSchema.safeParse(operationId).success) throw new NativeAdminError('invalid_input');
    await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, true));
    return recoverNativeAdmin(deps, actor, tenantId, alias, operationId, mutation,
      client => authority(client, actor, tenantId, alias, true), () => runtime(tenantId, alias));
  }
  async function discover(actor: NativeAdminActor, tenantId: string, alias: string, mutation: NativePieceMutation, identity: NativeRuntimeIdentity, operationId?: string) {
    if (operationId !== undefined && !NativeOperationIdSchema.safeParse(operationId).success) throw new NativeAdminError('invalid_input');
    await withTransaction(deps.pool, client => authority(client, actor, tenantId, alias, true));
    return discoverNativeAdmin(deps, actor, tenantId, alias, mutation, identity, operationId,
      client => authority(client, actor, tenantId, alias, true), () => runtime(tenantId, alias),
      command => call(tenantId, alias, command, actor.signal));
  }
  return { read, write, recognize, recover, discover };
}
export type NativeAdminService = ReturnType<typeof createNativeAdminService>;
