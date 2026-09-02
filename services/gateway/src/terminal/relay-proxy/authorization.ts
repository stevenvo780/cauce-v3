import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { terminalAuditMetadata } from '../audit.js';
import { exactObjectKeys } from '../helpers.js';
import { ticketSha256 } from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayAuthorizationRoute(context: RelayProxyContext): void {
  const {
    app, pool, config, AUTHZ_KEYS, requestRelayIdentity,
    relayClaimToken, relayClaimEpoch, currentSessionPolicy, recordTransactionalTerminalAudit,
    databaseClaimEpoch, boundedMilliseconds, replyError,
  } = context;
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
      }
      interface RenewedSession extends TerminalSessionRow {
        database_now: Date;
        session_expires_at: Date;
      }
      let renewed: RenewedSession | undefined;
      let refusal = 'unknown_session';
      await withTransaction(pool, async (client) => {
        const locked = await client.query<LockedAuthzSession>(
          `SELECT terminal_sessions.*,now() AS database_now,
                  consumed_at+make_interval(secs => $2) AS session_expires_at,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND consumed_at+make_interval(secs => $2)>now() AS session_unexpired
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [request.params.sid, config.sessionTtlSeconds],
        );
        const row = locked.rows[0];
        if (row !== undefined) {
          if (row.consumed_at === null) refusal = 'not_consumed';
          else if (row.revoked_at !== null) refusal = 'revoked';
          else if (row.closed_at !== null) refusal = 'closed';
          else if (!row.session_unexpired) refusal = 'session_expired';
          else {
            const exactClaim = row.relay_claim_sha256 !== null
              && row.relay_claim_sha256.equals(claimSha256)
              && row.relay_claim_epoch === claimEpoch
              && row.relay_instance_id === identity.relay_instance_id
              && row.relay_boot_id === identity.relay_boot_id
              && row.relay_claim_expires_at !== null
              && row.relay_claim_expires_at.getTime() > row.database_now.getTime();
            if (!exactClaim) {
              refusal = 'claim_fenced';
            } else {
              const policy = await currentSessionPolicy(row, false, client);
              refusal = policy.reason;
              if (policy.allowed) {
                const result = await client.query<RenewedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_expires_at=LEAST(
                        consumed_at+make_interval(secs => $4),
                        now()+make_interval(secs => $3)
                      )
                    WHERE id=$1 AND relay_claim_sha256=$2 AND relay_claim_epoch=$5::bigint
                      AND relay_claim_expires_at>now()
                      AND relay_instance_id=$6 AND relay_boot_id=$7
                      AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                    RETURNING *,now() AS database_now,
                              consumed_at+make_interval(secs => $4) AS session_expires_at`,
                  [
                    request.params.sid,
                    claimSha256,
                    config.claimLeaseSeconds,
                    config.sessionTtlSeconds,
                    claimEpoch,
                    identity.relay_instance_id,
                    identity.relay_boot_id,
                  ],
                );
                renewed = result.rows[0];
                if (renewed === undefined) refusal = 'claim_fenced';
              }
            }
          }
          if (renewed === undefined) {
            await recordTransactionalTerminalAudit(client, {
              tenant_id: row.tenant_id,
              actor_alias: row.alias,
              action: 'terminal.session.revoked',
              decision: 'info',
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
                reason: refusal,
                claim_epoch: row.relay_claim_epoch,
              }),
            });
          }
        }
      });
      if (renewed === undefined) {
        await reply.code(403).send({ ok: false, reason: refusal });
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
