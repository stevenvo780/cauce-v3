import type { DatabaseClient } from './db.js';

export async function expireQuotaAuthentication(client: DatabaseClient,
  scope: { companyId?: string; hostId?: string; operationId?: string }): Promise<void> {
  if (!scope.companyId && !scope.hostId && !scope.operationId) throw new Error('Quota authentication expiry scope is required');
  await client.query(`WITH expired AS (
    UPDATE quota_environment_operations operation SET status='failed',error_code='AUTH_EXPIRED',lease_until=NULL,updated_at=now()
    FROM quota_environments environment WHERE operation.environment_id=environment.id
      AND operation.action='authenticate' AND operation.status IN ('awaiting_auth','running')
      AND ($1::text IS NULL OR environment.company_id=$1) AND ($2::text IS NULL OR environment.host_id=$2)
      AND ($3::uuid IS NULL OR operation.id=$3)
      AND (operation.status='awaiting_auth' OR operation.result->>'expires_at' IS NOT NULL)
      AND COALESCE((operation.result->>'expires_at')::timestamptz,operation.updated_at+interval '15 minutes')<=now()
    RETURNING operation.environment_id
  ) UPDATE quota_environments SET status='failed',version=version+1,updated_at=now()
    WHERE id IN (SELECT environment_id FROM expired)`, [scope.companyId ?? null, scope.hostId ?? null, scope.operationId ?? null]);
}
