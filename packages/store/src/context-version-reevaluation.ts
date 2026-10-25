import { HarnessConsumptionEvidenceSchema, VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { lockContextTarget } from './context-version.js';

const WITNESS_HARNESSES = new Set<unknown>(HarnessConsumptionEvidenceSchema.shape.harness_id.options.map(id => `harness.${id}`));

export function supportsVersionedContextApplication(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(VERSIONED_CONTEXT_CAPABILITY)
    && capabilities.some(capability => WITNESS_HARNESSES.has(capability));
}

/** Lease admission only schedules a fresh readiness check; it never requests a dedicated turn or proves adoption. */
export async function reevaluateUnsupportedContext(client: DatabaseClient, tenant: string, alias: string,
  capabilities: unknown): Promise<void> {
  if (!supportsVersionedContextApplication(capabilities)) return;
  const target = (await client.query<{ company_id: string; tenant_id: string; alias: string }>(`SELECT current.company_id,current.tenant_id,current.alias
    FROM agent_context_state current JOIN agent_context_outbox outbox USING(company_id,tenant_id,alias)
    WHERE current.tenant_id=$1 AND current.alias=$2 AND outbox.version=current.desired_version
      AND outbox.applied_at IS NULL AND outbox.apply_error='context_runtime_unsupported'
      AND outbox.apply_retry_at='infinity'`, [tenant, alias])).rows[0];
  if (!target) return;
  await lockContextTarget(client, target);
  await client.query(`UPDATE agent_context_outbox outbox SET apply_error=NULL,apply_retry_at=clock_timestamp()
    FROM agent_context_state current WHERE current.company_id=$1 AND current.tenant_id=$2 AND current.alias=$3
      AND (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)=
        (current.company_id,current.tenant_id,current.alias,current.desired_version)
      AND outbox.applied_at IS NULL AND outbox.apply_error='context_runtime_unsupported' AND outbox.apply_retry_at='infinity'
      AND (outbox.apply_token IS NULL OR outbox.apply_lease_until<=clock_timestamp())`,
  [target.company_id, target.tenant_id, target.alias]);
}
