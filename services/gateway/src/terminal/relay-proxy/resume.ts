import {
  terminalAuditMetadata, type TerminalAuditContext,
} from '../audit.js';
import {
  ticketSha256, verifyResumeTokenSignature, TicketError,
} from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayResumeRoute(context: RelayProxyContext): void {
  const {
    app, pool, config, UUID_PATTERN, exactObjectKeys, RESUME_KEYS, RESUME_WITH_EPOCH_KEYS,
    requestRelayIdentity, relayClaimToken, relayClaimEpoch, currentSessionPolicy, sessionActor,
    cohortLabels, recordTransactionalTerminalAudit, sessionExpiry, relayGrant, replyError,
  } = context;
  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/resume', async (request, reply) => {
    const sid = request.params.sid;
    const refuse = async (status: 401 | 403 | 409, reason: string, retryAfterMs?: number): Promise<void> => {
      // Authentication failures intentionally share the same small body. A caller on this route
      // already passed the relay bearer gate, but a stale/forged browser credential learns no row.
      await reply.code(status).send({
        ok: false,
        reason,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      });
    };
    try {
      if (!UUID_PATTERN.test(sid)) { await refuse(401, 'resume_invalid'); return; }
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined
          || (!exactObjectKeys(record, RESUME_KEYS) && !exactObjectKeys(record, RESUME_WITH_EPOCH_KEYS))) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const token = record?.resume_token;
      const claimToken = relayClaimToken(record?.claim_token);
      const presentedEpoch = record?.claim_epoch === undefined
        ? undefined : relayClaimEpoch(record.claim_epoch);
      if (typeof token !== 'string' || token.length < 80 || token.length > 1_024
          || claimToken === undefined
          || (record?.claim_epoch !== undefined && presentedEpoch === undefined)) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedResumeSession extends TerminalSessionRow {
        database_now: Date;
        session_unexpired: boolean;
      }
      interface ClaimedSession extends TerminalSessionRow { database_now: Date }
      const client = await pool.connect();
      let transactionOpen = false;
      let session: TerminalSessionRow | undefined;
      let databaseNow: Date | undefined;
      let takenOver = false;
      let refusal: { status: 401 | 403 | 409; reason: string; retry_after_ms?: number } | undefined;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<LockedResumeSession>(
          `SELECT terminal_sessions.*,now() AS database_now,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND consumed_at+make_interval(secs => $2)>now() AS session_unexpired
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [sid, config.sessionTtlSeconds],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          refusal = { status: 401, reason: 'resume_invalid' };
        } else {
          let credential;
          try {
            credential = verifyResumeTokenSignature(token, config.ticketKey);
          } catch (error) {
            if (!(error instanceof TicketError)) throw error;
          }
          const expiry = sessionExpiry(row);
          if (credential === undefined || credential.sid !== sid || credential.op !== row.operator_id
              || expiry === undefined || credential.exp !== Math.floor(expiry.getTime() / 1_000)) {
            refusal = { status: 401, reason: 'resume_invalid' };
          } else if (row.consumed_at === null) {
            refusal = { status: 403, reason: 'not_consumed' };
          } else if (row.revoked_at !== null) {
            refusal = { status: 403, reason: 'revoked' };
          } else if (row.closed_at !== null) {
            refusal = { status: 403, reason: 'closed' };
          } else if (!row.session_unexpired) {
            refusal = { status: 403, reason: 'session_expired' };
          } else {
            const policy = await currentSessionPolicy(row, false, client);
            const actor = sessionActor(row);
            const context: TerminalAuditContext = {
              operator_id: row.operator_id,
              attributed: row.attributed,
              target_tenant: row.tenant_id,
              target_alias: row.alias,
              container: row.container,
              cohort: policy.cohort === undefined ? [] : cohortLabels(policy.cohort),
              mode: row.mode,
            };
            if (!policy.allowed || actor === undefined) {
              const reason = policy.allowed ? 'unknown_session' : policy.reason;
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor?.tenant_id ?? row.tenant_id,
                actor_alias: actor?.alias ?? row.alias,
                action: 'terminal.session.resume',
                decision: 'deny',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(context, { session_id: sid, reason }),
              });
              refusal = { status: 403, reason };
            } else {
              const exactClaim = row.relay_claim_sha256 !== null
                && row.relay_claim_sha256.equals(claimSha256)
                && row.relay_instance_id === identity.relay_instance_id
                && row.relay_boot_id === identity.relay_boot_id;
              const liveClaim = row.relay_claim_expires_at !== null
                && row.relay_claim_expires_at.getTime() > row.database_now.getTime();
              if (exactClaim && liveClaim && presentedEpoch === row.relay_claim_epoch) {
                const renewed = await client.query<ClaimedSession>(
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
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    presentedEpoch, identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = renewed.rows[0];
                databaseNow = renewed.rows[0]?.database_now;
              } else if (liveClaim) {
                const retryAfterMs = Math.max(
                  1,
                  Math.ceil(row.relay_claim_expires_at!.getTime() - row.database_now.getTime()),
                );
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.resume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'claim_conflict',
                    claim_epoch: row.relay_claim_epoch,
                  }),
                });
                refusal = { status: 409, reason: 'claim_conflict', retry_after_ms: retryAfterMs };
              } else {
                const takeover = await client.query<ClaimedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_sha256=$2,
                          relay_claim_epoch=relay_claim_epoch+1,
                          relay_claimed_at=now(),
                          relay_instance_id=$5,
                          relay_boot_id=$6,
                          relay_claim_expires_at=LEAST(
                            consumed_at+make_interval(secs => $4),
                            now()+make_interval(secs => $3)
                          )
                    WHERE id=$1 AND consumed_at IS NOT NULL
                      AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                      AND (relay_claim_expires_at IS NULL OR relay_claim_expires_at<=now())
                      AND relay_claim_epoch<9223372036854775807
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = takeover.rows[0];
                databaseNow = takeover.rows[0]?.database_now;
                takenOver = session !== undefined;
                if (session === undefined) refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
              if (session !== undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.resume',
                  decision: 'info',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    claim_epoch: session.relay_claim_epoch,
                    claim_taken_over: takenOver,
                  }),
                });
              }
            }
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (session === undefined) {
        await refuse(
          refusal?.status ?? 409,
          refusal?.reason ?? 'lifecycle_conflict',
          refusal?.retry_after_ms,
        );
        return;
      }
      if (databaseNow === undefined) throw new Error('database omitted terminal claim clock');
      return await reply.code(200).send({
        ...relayGrant(session, token, claimToken, databaseNow, identity),
        claim_taken_over: takenOver,
      });
    } catch (error) { replyError(reply, error); }
  });

}
