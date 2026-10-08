import { randomUUID } from 'node:crypto';
import { TenantSchema, type NativeAdminCommand, type NativePieceMutation, type NativeRuntimeIdentity } from '@cauce/protocol';
import { canonicalProfileRuntimeContract, readAgentContextWrite, reserveAgentContextWrite, withTransaction,
  type DatabaseClient } from '@cauce/store';
import type { NativeAdminActor, NativeAdminServiceDeps } from './service.js';
import { NativeAdminError } from './error.js';

export interface NativeDiscoveryRuntime { identity: NativeRuntimeIdentity; root: string; facts: { harness: string } }
export async function discoverNativeAdmin(deps: NativeAdminServiceDeps, actor: NativeAdminActor, tenantId: string, alias: string,
  mutation: NativePieceMutation, expectedIdentity: NativeRuntimeIdentity, operationId: string | undefined,
  authority: (client: DatabaseClient) => Promise<void>, runtime: () => Promise<NativeDiscoveryRuntime>,
  call: (command: NativeAdminCommand) => Promise<import('@cauce/protocol').NativeAdminOutcome>) {
  const current = await runtime();
  if (JSON.stringify(current.identity) !== JSON.stringify(expectedIdentity)) throw new NativeAdminError('conflict');
  const name = `native:${mutation.kind}:${mutation.id}`;
  const path = mutation.kind === 'mcp' ? `${current.root}/${current.facts.harness === 'claude' ? '.claude.json' : 'config.toml'}`
    : mutation.kind === 'skill' ? `${current.root}/skills/${mutation.id}/SKILL.md`
      : mutation.kind === 'subagent' && current.facts.harness === 'claude' ? `${current.root}/agents/${mutation.id}.md` : undefined;
  if (path === undefined) throw new NativeAdminError('unsupported');
  const matches = await withTransaction(deps.pool, async client => {
    await authority(client);
    return await client.query<{ operation_id: string }>(`SELECT id::text AS operation_id FROM jobs
      WHERE tenant_id=$1 AND kind='system.context.write.quarantine.v1' AND status IN ('running','done')
      AND lease_until IS NULL AND claim_token::text=payload->>'token'
      AND payload->>'version'='1' AND payload->>'tenantId'=$1 AND payload->>'alias'=$2
      AND jsonb_array_length(payload->'documents')=1 AND payload#>>'{documents,0,name}'=$3
      AND payload#>>'{documents,0,path}'=$4 AND payload#>>'{documents,0,beforeSha}' IS NOT DISTINCT FROM $5::text
      AND payload#>>'{writer,runtimeGeneration}'=$6 AND payload#>>'{writer,containerId}'=$7
      AND payload#>>'{writer,writerInstanceId}'=$8 AND (($9::uuid IS NULL AND status='running') OR id=$9::uuid)
      ORDER BY created_at DESC,id LIMIT 2`, [tenantId, alias, name, path, mutation.expected_sha,
      current.identity.generation, current.identity.container_id, current.identity.writer_instance_id, operationId ?? null]);
  });
  if (matches.rows.length > 1) throw new NativeAdminError('conflict');
  let found = matches.rows[0]?.operation_id;
  if (found === undefined && operationId !== undefined) {
    const plan = await call({ op: 'prepare', mutation, request_id: randomUUID(), identity: current.identity });
    if (plan.type !== 'plan' || plan.kind !== mutation.kind || plan.id !== mutation.id || plan.path !== path
      || plan.before_sha !== mutation.expected_sha) throw new NativeAdminError('conflict');
    const context = await deps.readContext(tenantId, alias); const expectation = await deps.readRuntimeExpectation(tenantId, alias);
    try {
      await reserveAgentContextWrite(deps.pool, { operationId, token: randomUUID(), generation: randomUUID(), tenantId: TenantSchema.parse(tenantId), alias,
        expectedRevision: context.revision, expectedExpectation: expectation === undefined ? null : canonicalProfileRuntimeContract(expectation) ?? null,
        writer: { runtimeGeneration: current.identity.generation, containerId: current.identity.container_id, writerInstanceId: current.identity.writer_instance_id },
        documents: [{ name, path, beforeSha: plan.before_sha, targetSha: plan.target_sha }],
        updateDesired: authority, ...(actor.signal === undefined ? {} : { signal: actor.signal }) });
    } catch {
      if (!await readAgentContextWrite(deps.pool, TenantSchema.parse(tenantId), alias, operationId)) throw new NativeAdminError('unavailable', operationId);
    }
    found = operationId;
  }
  if (found === undefined) return { tenant_id: tenantId, alias, identity: current.identity, state: 'not_found' as const, operation_id: null };
  const descriptor = await readAgentContextWrite(deps.pool, TenantSchema.parse(tenantId), alias, found);
  const document = descriptor?.documents[0]; const after = await runtime();
  if (descriptor?.version !== 1 || descriptor.documents.length !== 1 || document?.name !== name || document.path !== path
    || document.beforeSha !== mutation.expected_sha || descriptor.writer.runtimeGeneration !== current.identity.generation
    || descriptor.writer.containerId !== current.identity.container_id || descriptor.writer.writerInstanceId !== current.identity.writer_instance_id
    || JSON.stringify(after.identity) !== JSON.stringify(current.identity)) throw new NativeAdminError('conflict');
  return { tenant_id: tenantId, alias, identity: current.identity, state: 'pending' as const, operation_id: found };
}
