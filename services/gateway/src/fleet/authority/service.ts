import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertFleetOperationAuthority, FleetOperationError, loadFleetHostScope, lockFleetRevision, withTransaction,
  type DatabaseClient, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { runAuthorityCommand, type AuthorityCommand } from './command.js';
import { AuthorityHostSchema, AuthorityInventorySchema, AuthorityIssuedSchema, AuthorityRequestSchema,
  FleetAuthorityError, type AuthorityRequest, type AuthorityScope } from './schemas.js';

const Agent = z.object({ tenant_id: z.string(), alias: z.string(), runtime_key: z.string(), host_id: z.string() }).loose();
export interface FleetAuthorityOptions { host_id: string; command: AuthorityCommand }
export interface FleetAuthorityService { execute(input: unknown): Promise<unknown> }
async function resolveAuthority(client: DatabaseClient, scope: AuthorityScope, request: AuthorityRequest, host: string) {
  if (scope.host_id !== host) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  await lockFleetRevision(client);
  const row = (await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations
    WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND epoch=$4 AND lease_expires_at>clock_timestamp()
      AND status IN ('running','cancelling') FOR UPDATE`,
  [scope.operation_id, scope.worker_id, scope.claim_token, scope.claim_epoch])).rows[0];
  if (row?.desired_revision == null || Number(row.desired_revision) !== scope.prepared_revision) {
    throw new FleetAuthorityError('AUTHORITY_REVOKED');
  }
  await assertFleetOperationAuthority(client, row);
  if (row.actor_subject === undefined) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  await lockFleetRevision(client, row.status === 'cancelling' ? undefined : Number(row.desired_revision));
  const slice = await loadFleetHostScope(client, row, host);
  if (slice.target_sha256 !== scope.scope_sha256) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  const candidates = slice.agents.filter(value => value.runtime_key === scope.runtime_key);
  const parsedAgent = Agent.safeParse(candidates.length === 1 ? candidates[0] : undefined);
  if (!parsedAgent.success) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  const agent = parsedAgent.data;
  if (agent.host_id !== host || !slice.targets.some(target => target.runtime_key === agent.runtime_key
      && target.alias === agent.alias && target.tenant_id === agent.tenant_id)) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  const reserved = (await client.query(`SELECT 1 FROM fleet_runtime_identities
    WHERE runtime_key=$1 AND tenant_id=$2 AND alias=$3`, [agent.runtime_key, agent.tenant_id, agent.alias])).rowCount;
  if (reserved !== 1) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  if (request.action === 'issue') {
    if (row.status !== 'running' || row.cancel_requested || row.target.resource !== 'agent'
        || !['create', 'update', 'start', 'restore'].includes(row.kind)) throw new FleetAuthorityError('AUTHORITY_REVOKED');
    const admitted = request.phase === 'normal';
    if (admitted ? !row.steps.some(step => step.name === 'verify' && step.status === 'succeeded')
        || !row.steps.some(step => step.name === 'admission' && step.status === 'running')
      : !row.steps.some(step => ['credentials', 'runtime'].includes(step.name) && step.status === 'running')) {
      throw new FleetAuthorityError('AUTHORITY_REVOKED');
    }
    const consent = (await client.query(`SELECT 1 FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
      JOIN rooms room ON room.tenant_id=agent.tenant_id AND room.id=agent.primary_room_id
      JOIN provider_accounts account ON account.id=agent.primary_account_id
      WHERE agent.runtime_key=$1 AND agent.tenant_id=$2 AND agent.alias=$3 AND agent.host_id=$4
        AND NOT agent.enabled AND agent.retired_at IS NULL AND agent.purged_at IS NULL
        AND tenant.enabled AND tenant.retired_at IS NULL AND room.enabled AND room.retired_at IS NULL
        AND account.enabled AND (account.payer_tenant_id=agent.tenant_id OR account.shared_with_pool)
      FOR SHARE OF agent,tenant,room,account`, [agent.runtime_key, agent.tenant_id, agent.alias, host])).rowCount;
    if (consent !== 1) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  } else if (request.action === 'revoke' && !(row.status === 'cancelling' || row.cancel_requested
      || row.steps.some(step => step.name === 'revoke' && step.status === 'running'))) {
    throw new FleetAuthorityError('AUTHORITY_REVOKED');
  }
  return { row, agent };
}
async function authority(client: DatabaseClient, scope: AuthorityScope, request: AuthorityRequest, host: string) {
  try { return await resolveAuthority(client, scope, request, host); }
  catch (error) {
    if (error instanceof FleetAuthorityError) throw error;
    throw new FleetAuthorityError(error instanceof FleetOperationError ? 'AUTHORITY_REVOKED' : 'AUTHORITY_UNAVAILABLE');
  }
}
export function createFleetAuthorityService(pool: DatabasePool, options: FleetAuthorityOptions): FleetAuthorityService {
  const host = AuthorityHostSchema.parse(options.host_id);
  return { execute: async input => {
    const parsed = AuthorityRequestSchema.safeParse(input);
    if (!parsed.success) throw new FleetAuthorityError('INVALID_REQUEST');
    const request = parsed.data;
    if (request.action === 'issue' && createHash('sha256').update(request.csr_pem).digest('hex') !== request.csr_sha256) {
      throw new FleetAuthorityError('INVALID_REQUEST');
    }
    return withTransaction(pool, async client => {
      const { agent } = await authority(client, request.scope, request, host);
      const { scope, ...action } = request;
      const packet = { ...action, scope: { operation_id: scope.operation_id, host_id: host,
        scope_sha256: scope.scope_sha256, runtime_key: scope.runtime_key },
      agent: { tenant_id: agent.tenant_id, alias: agent.alias } };
      const output = await runAuthorityCommand(options.command, packet);
      await authority(client, scope, request, host);
      const result = request.action === 'issue' ? AuthorityIssuedSchema.parse(output) : AuthorityInventorySchema.parse(output);
      if (request.action === 'issue' && 'token' in result
          && createHash('sha256').update(result.token).digest('hex') !== result.token_sha256) throw new FleetAuthorityError('AUTHORITY_UNAVAILABLE');
      if (request.action === 'verify_absent' || request.action === 'revoke') {
        if (!('authorities' in result) || result.authorities.some(row => row.matching_records.length > 0)) {
          throw new FleetAuthorityError('AUTHORITY_UNAVAILABLE');
        }
      }
      return result;
    });
  } };
}
