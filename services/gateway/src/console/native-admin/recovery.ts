import { randomUUID } from 'node:crypto';
import { authorizeAgentContextDispatch, readAgentContextWrite, resolveAgentContextWrite, withTransaction, type DatabaseClient } from '@cauce/store';
import { NativeAdminOutcomeSchema, type NativeAdminCommand, type NativePieceMutation, type NativeRuntimeIdentity } from '@cauce/protocol';
import type { NativeAdminActor, NativeAdminServiceDeps } from './service.js';
import { NativeAdminError } from './error.js';

interface RecoveryRuntime { identity: NativeRuntimeIdentity; root: string; facts: { harness: string } }
export async function recoverNativeAdmin(deps: NativeAdminServiceDeps, actor: NativeAdminActor, tenantId: string, alias: string,
  operationId: string, mutation: NativePieceMutation,
  authority: (client: DatabaseClient) => Promise<void>, runtime: () => Promise<RecoveryRuntime>) {
  let expected = await readAgentContextWrite(deps.pool, tenantId, alias, operationId);
  const current = await runtime();
  const name = `native:${mutation.kind}:${mutation.id}`;
  const path = mutation.kind === 'mcp' ? `${current.root}/${current.facts.harness === 'claude' ? '.claude.json' : 'config.toml'}`
    : mutation.kind === 'skill' ? `${current.root}/skills/${mutation.id}/SKILL.md` : `${current.root}/agents/${mutation.id}.md`;
  const document = expected?.documents[0];
  if (expected?.version !== 1 || expected.documents.length !== 1 || document?.name !== name || document.path !== path
    || document.beforeSha !== mutation.expected_sha
    || expected.writer.runtimeGeneration !== current.identity.generation || expected.writer.containerId !== current.identity.container_id
    || expected.writer.writerInstanceId !== current.identity.writer_instance_id) throw new NativeAdminError('conflict', operationId);
  if (expected.dispatch === 'reserved') {
    if (expected.completion !== null) throw new NativeAdminError('conflict', operationId);
    expected = await authorizeAgentContextDispatch(deps.pool, expected, actor.signal);
  }
  const reservation = expected;
  const command: NativeAdminCommand = { op: 'status', request_id: randomUUID(), mutation, identity: current.identity,
    operation: { operation_id: operationId, operation_token: reservation.token, operation_generation: reservation.generation } };
  let receipt: Extract<import('@cauce/protocol').NativeAdminOutcome, { type: 'receipt' }> | undefined;
  async function proof(client: DatabaseClient) {
    await authority(client);
    const parsed = NativeAdminOutcomeSchema.safeParse(await deps.probe.nativeAdmin?.(tenantId, alias, command, actor.signal));
    const value = parsed.success ? parsed.data : undefined;
    const after = await runtime();
    if (value?.type !== 'receipt' || value.operation_id !== operationId || value.operation_generation !== reservation.generation
      || value.path !== path || value.kind !== mutation.kind || value.id !== mutation.id
      || JSON.stringify(value.identity) !== JSON.stringify(current.identity)
      || JSON.stringify(after.identity) !== JSON.stringify(current.identity)) throw new NativeAdminError('unavailable', operationId);
    receipt = value;
    return { operationId, token: reservation.token, generation: reservation.generation, writer: reservation.writer,
      state: 'quiescent' as const, durability: 'post_fsync' as const, documents: [{ name, path, sha: value.sha }] };
  }
  const completion = reservation.completion;
  const resolution = completion === null ? await resolveAgentContextWrite(deps.pool, reservation, proof, async client => {
    await authority(client);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata) VALUES($1,$2,'agent_native_admin.recover','allow',$3::jsonb)`,
      [actor.tenant_id, actor.alias, JSON.stringify({ target_tenant: tenantId, target_alias: alias, kind: mutation.kind, id: mutation.id, operation_id: operationId })]);
  }, actor.signal) : await withTransaction(deps.pool, async client => {
    const received = await proof(client);
    const sha = completion.resolution === 'target' ? document.targetSha : document.beforeSha;
    if (received.documents[0]?.sha !== sha) throw new NativeAdminError('conflict', operationId);
    return completion.resolution;
  });
  if (receipt?.type !== 'receipt') throw new NativeAdminError('unavailable', operationId);
  if (resolution !== 'target') return { tenant_id: tenantId, alias, state: 'not_applied' as const, operation_id: operationId };
  return { tenant_id: tenantId, alias, state: 'written_pending_reload' as const, action: mutation.action, receipt };
}
