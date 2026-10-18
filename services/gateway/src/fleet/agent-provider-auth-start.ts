import { isDeepStrictEqual } from 'node:util';
import type { DatabasePool } from '@cauce/store';
import { ProviderAuthError, ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthDependencies, ProviderAuthRequest, ProviderAuthService, ProviderAuthSnapshot } from '../console/provider-auth.types.js';

interface Reservation { session_id: string; actor_subject: string; state: string; expires_at: string }
interface Prior { version: string; reservation: Reservation; status: string | null; bound: boolean }

export function recoverableAgentAuthStart(pool: DatabasePool, manager: ProviderAuthService,
  authorize: ProviderAuthDependencies['authorize'], resolve: (actor: ProviderAuthActor, id: string) => Promise<ProviderAuthRequest>): ProviderAuthService['start'] {
  const start = manager.start.bind(manager);
  const attempts = new Map<string, { request: ProviderAuthRequest; result: Promise<ProviderAuthSnapshot> }>();
  const open = async (actor: ProviderAuthActor, request: ProviderAuthRequest) => {
    await authorize(actor, request);
    const prior = (await pool.query<Prior>(`SELECT operation.version, reservation.value AS reservation,
      audit.value->>'status' AS status, EXISTS(SELECT 1 FROM fleet_operation_events binding
        WHERE binding.operation_id=operation.id
        AND binding.metadata->'agent_provider_auth_scope'->'fence'->>'session_id'=reservation.value->>'session_id') AS bound
      FROM fleet_operations operation
      JOIN LATERAL (SELECT metadata->'provider_auth' AS value FROM fleet_operation_events
        WHERE operation_id=operation.id AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1) reservation ON true
      LEFT JOIN LATERAL (SELECT metadata->'provider_auth_status' AS value FROM fleet_operation_events
        WHERE operation_id=operation.id AND metadata->'provider_auth_status'->>'session_id'=reservation.value->>'session_id'
        ORDER BY id DESC LIMIT 1) audit ON true WHERE operation.id=$1`, [request.operation_id])).rows[0];
    if (prior?.reservation.state !== 'reserved' || !prior.bound
        || !['failed','expired','cancelled'].includes(prior.status ?? '') && Date.parse(prior.reservation.expires_at) > Date.now()) return start(actor, request);
    if (prior.reservation.actor_subject !== actor.subject || Number(prior.version) !== request.expected_operation_version) {
      return start(actor, request);
    }
    const stopped = await manager.cancel(actor, prior.reservation.session_id);
    if (stopped.cleanup_pending) return stopped;
    const refreshed = { ...await resolve(actor, request.operation_id), request_id: request.request_id };
    if (refreshed.expected_operation_version !== request.expected_operation_version + 1) throw new ProviderAuthError('SESSION_CONFLICT');
    if (!isDeepStrictEqual({ ...request, expected_operation_version: refreshed.expected_operation_version }, refreshed)) {
      throw new ProviderAuthError('AUTHORITY_REVOKED');
    }
    return start(actor, refreshed);
  };
  return async (actor, input) => {
    const parsed = ProviderAuthRequestSchema.safeParse(input);
    if (!parsed.success) throw new ProviderAuthError('INVALID_REQUEST');
    const request = parsed.data;
    const key = JSON.stringify([actor.subject, actor.tenant_id, actor.alias, actor.requestedCompany, request.request_id]);
    const previous = attempts.get(key);
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new ProviderAuthError('SESSION_CONFLICT');
      const session = await previous.result;
      return manager.get(actor, session.session_id);
    }
    if (attempts.size >= 1000) attempts.delete(attempts.keys().next().value ?? '');
    const result = open(actor, request);
    attempts.set(key, { request, result });
    try { return await result; } catch (error) { attempts.delete(key); throw error; }
  };
}
