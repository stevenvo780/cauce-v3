import { CONTEXT_ADOPTION_CAPABILITY, HarnessConsumptionEvidenceSchema, VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { lockContextTarget } from './context-version.js';

const WITNESS_HARNESSES = new Set<unknown>(HarnessConsumptionEvidenceSchema.shape.harness_id.options.map(id => `harness.${id}`));
/**
 * Claude and Codex witnessed every turn, headless or in a shared TUI, before `versioned_context_v1` existed, so an adapter that
 * predates `context_adoption_v1` is still trusted for them. Grok, Muse and OpenClaw depend on the runner and the release:
 * headless Muse never witnesses, Grok only since 25-oct and OpenClaw in a V4 profile only once it read `OPENCLAW_STATE_DIR`.
 */
const LEGACY_WITNESS_HARNESSES = new Set<unknown>(['harness.claude', 'harness.codex']);

export function supportsVersionedContextApplication(capabilities: unknown): boolean {
  if (!Array.isArray(capabilities) || !capabilities.includes(VERSIONED_CONTEXT_CAPABILITY)) return false;
  const witnessed = capabilities.includes(CONTEXT_ADOPTION_CAPABILITY) ? WITNESS_HARNESSES : LEGACY_WITNESS_HARNESSES;
  return capabilities.some(capability => witnessed.has(capability));
}

/**
 * Lease admission only schedules a fresh readiness check; it never requests a dedicated turn or proves adoption.
 * A refusal parked at `infinity` is re-armed when the live lease contradicts it: `offline` by any live lease, and
 * `unsupported` by one that now announces versioned context and a witnessed harness. The worker then measures the
 * lease again and either leaves the version to the agent's natural turn or records the refusal the lease still earns.
 * `context_runtime_attempts_exhausted` stays until the operator asks again: it spent the dedicated turns of a request.
 */
export async function reevaluateUnsupportedContext(client: DatabaseClient, tenant: string, alias: string,
  capabilities: unknown): Promise<void> {
  const refusals = supportsVersionedContextApplication(capabilities)
    ? ['context_runtime_unsupported', 'context_runtime_offline'] : ['context_runtime_offline'];
  const target = (await client.query<{ company_id: string; tenant_id: string; alias: string }>(`SELECT current.company_id,current.tenant_id,current.alias
    FROM agent_context_state current JOIN agent_context_outbox outbox USING(company_id,tenant_id,alias)
    WHERE current.tenant_id=$1 AND current.alias=$2 AND outbox.version=current.desired_version
      AND outbox.applied_at IS NULL AND outbox.apply_error=ANY($3::text[])
      AND outbox.apply_retry_at='infinity'`, [tenant, alias, refusals])).rows[0];
  if (!target) return;
  await lockContextTarget(client, target);
  await client.query(`UPDATE agent_context_outbox outbox SET apply_error=NULL,apply_retry_at=clock_timestamp()
    FROM agent_context_state current WHERE current.company_id=$1 AND current.tenant_id=$2 AND current.alias=$3
      AND (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)=
        (current.company_id,current.tenant_id,current.alias,current.desired_version)
      AND outbox.applied_at IS NULL AND outbox.apply_error=ANY($4::text[]) AND outbox.apply_retry_at='infinity'
      AND (outbox.apply_token IS NULL OR outbox.apply_lease_until<=clock_timestamp())`,
  [target.company_id, target.tenant_id, target.alias, refusals]);
}
