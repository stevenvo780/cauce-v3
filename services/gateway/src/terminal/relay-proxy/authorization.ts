import type { FastifyBaseLogger } from 'fastify';
import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { terminalAuditMetadata } from '../audit.js';
import type { TerminalConfig } from '../config.js';
import { exactObjectKeys } from '../helpers.js';
import { ticketSha256 } from '../tickets.js';
import { isWritableMode, type TerminalSessionRow } from '../types.js';
import {
  relayClaimState, renewRelayClaim, type RenewedRelayClaim,
} from './claim-transition.js';
import type { RelayProxyContext } from './context.js';

/**
 * The hard ceiling an extension may never push the window past, in seconds since `consumed_at`.
 * While the terminal configuration does not declare it the clamp binds NULL, which `LEAST`
 * ignores: the window is the plain TTL and an extension is bounded by nothing. That is a
 * degraded position, so it is announced once, when the route is registered.
 */
function sessionWindowCeiling(config: TerminalConfig, log: FastifyBaseLogger): number | null {
  const declared = config.sessionMaxTotalSeconds;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared;
  log.warn('terminal sessions have no hard ceiling: sessionMaxTotalSeconds is not configured');
  return null;
}

/** The wire reason terminal-relay maps to a 4410 close: the control was given back or expired. */
const CONTROL_RELEASED = 'control_released';

export function registerRelayAuthorizationRoute(context: RelayProxyContext): void {
  const {
    app, pool, config, AUTHZ_KEYS, requestRelayIdentity,
    relayClaimToken, relayClaimEpoch, currentSessionPolicy, recordTransactionalTerminalAudit,
    databaseClaimEpoch, boundedMilliseconds, replyError,
  } = context;
  const sessionMaxTotalSeconds = sessionWindowCeiling(config, app.log);
  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/authz', async (request, reply) => {
    try {
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined || !exactObjectKeys(record, AUTHZ_KEYS)) {
        await reply.code(403).send({ ok: false, reason: 'claim_fenced' });
        return;
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const claimToken = relayClaimToken(record.claim_token);
      const claimEpoch = relayClaimEpoch(record.claim_epoch);
      if (claimToken === undefined || claimEpoch === undefined) {
        await reply.code(403).send({ ok: false, reason: 'claim_fenced' });
        return;
      }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedAuthzSession extends TerminalSessionRow {
        database_now: Date;
        session_expires_at: Date | null;
        session_unexpired: boolean;
        control_ever_held: boolean;
        control_held: boolean;
      }
      let renewed: RenewedRelayClaim | undefined;
      let refusal = 'unknown_session';
      await withTransaction(pool, async (client) => {
        const locked = await client.query<LockedAuthzSession>(
          `SELECT terminal_sessions.*,now() AS database_now,
                  LEAST(GREATEST(consumed_at + make_interval(secs => $2), COALESCE(window_extended_to, 'epoch'::timestamptz)), consumed_at + make_interval(secs => $3)) AS session_expires_at,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND LEAST(GREATEST(consumed_at + make_interval(secs => $2), COALESCE(window_extended_to, 'epoch'::timestamptz)), consumed_at + make_interval(secs => $3))>now() AS session_unexpired,
                  EXISTS(SELECT 1 FROM terminal_control_holds h WHERE h.session_id=terminal_sessions.id) AS control_ever_held,
                  EXISTS(SELECT 1 FROM terminal_control_holds h WHERE h.session_id=terminal_sessions.id
                           AND h.released_at IS NULL AND h.expires_at>now()) AS control_held
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [request.params.sid, config.sessionTtlSeconds, sessionMaxTotalSeconds],
        );
        const row = locked.rows[0];
        if (row !== undefined) {
          if (row.consumed_at === null) refusal = 'not_consumed';
          else if (row.revoked_at !== null) refusal = 'revoked';
          else if (row.closed_at !== null) refusal = 'closed';
          else if (!row.session_unexpired) refusal = 'session_expired';
          else {
            const claim = relayClaimState(
              row, claimSha256, identity,
              { mode: 'presented_epoch', epoch: claimEpoch },
            );
            if (!claim.exact || !claim.live) {
              refusal = 'claim_fenced';
            } else if (isWritableMode(row.mode) && row.control_ever_held && !row.control_held) {
              // The operator gave the alias back: this writable session is over, and the relay
              // closes it as such. A session that never held the control is not touched by this.
              refusal = CONTROL_RELEASED;
            } else {
              const policy = await currentSessionPolicy(row, false, client);
              refusal = policy.reason;
              if (policy.allowed) {
                renewed = await renewRelayClaim(client, {
                  sid: request.params.sid,
                  claimSha256,
                  claimEpoch,
                  identity,
                  claimLeaseSeconds: config.claimLeaseSeconds,
                  sessionTtlSeconds: config.sessionTtlSeconds,
                  sessionMaxTotalSeconds,
                });
                if (renewed === undefined) refusal = 'claim_fenced';
              }
            }
          }
          if (renewed === undefined) {
            await recordTransactionalTerminalAudit(client, {
              tenant_id: row.tenant_id,
              actor_alias: row.alias,
              action: refusal === 'revoked' ? 'terminal.session.revoked' : 'terminal.session.authz_denied',
              decision: refusal === 'revoked' ? 'info' : 'deny',
              ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
              metadata: terminalAuditMetadata({
                operator_id: row.operator_id,
                attributed: row.attributed,
                target_tenant: row.tenant_id,
                target_alias: row.alias,
                container: row.container,
                cohort: [],
                mode: row.mode,
              }, {
                session_id: row.id,
                refusal,
                claim_epoch: row.relay_claim_epoch,
              }),
            });
          }
        }
      });
      if (renewed === undefined) {
        await reply.code(403).send(refusal === CONTROL_RELEASED
          ? { error: 'forbidden', reason: refusal }
          : { ok: false, reason: refusal });
        return;
      }
      const claimExpiresAt = renewed.relay_claim_expires_at;
      if (claimExpiresAt === null) throw new Error('database terminal claim lease is invalid');
      return {
        ok: true,
        expires_at: renewed.session_expires_at.toISOString(),
        claim_epoch: databaseClaimEpoch(renewed.relay_claim_epoch),
        claim_lease_ms: boundedMilliseconds(
          claimExpiresAt,
          renewed.database_now,
          config.claimLeaseSeconds * 1_000,
        ),
        claim_lease_ttl_ms: config.claimLeaseSeconds * 1_000,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      };
    } catch (error) { replyError(reply, error); }
  });

}
