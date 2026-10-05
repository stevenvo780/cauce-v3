import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { terminalAuditMetadata, terminalSessionAuditContext } from '../audit.js';
import {
  CONTROL_HOLD_COLUMNS, CONTROL_RELEASED, cohortLabels, controlWasReleased, exactObjectKeys,
  sessionExpiry, sessionWindowExpression, type ControlHoldColumns,
} from '../helpers.js';
import {
  ticketSha256, verifyAuthorityResumeToken, TicketError,
} from '../tickets.js';
import { terminalDatabaseNow } from '../session-authority.js';
import type { TerminalSessionRow } from '../types.js';
import {
  relayClaimState, renewRelayClaim, takeOverExpiredRelayClaim,
} from './claim-transition.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayResumeRoute(context: RelayProxyContext): void {
  const {
    authority, repository, app, pool, config, RESUME_KEYS, RESUME_WITH_EPOCH_KEYS,
    requestRelayIdentity, relayClaimToken, relayClaimEpoch, currentSessionPolicy, sessionActor,
    recordTransactionalTerminalAudit, relayGrant, replyError,
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
      if (!UUID_ANY_PATTERN.test(sid)) { await refuse(401, 'resume_invalid'); return; }
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
      const continuity = authority.verify(record.authority_proof);
      if (continuity.sessionId !== sid) throw new Error('terminal authority is unavailable');
      const token = record.resume_token;
      const claimToken = relayClaimToken(record.claim_token);
      const rawClaimEpoch = record.claim_epoch;
      const presentedEpoch = rawClaimEpoch === undefined
        ? undefined : relayClaimEpoch(rawClaimEpoch);
      if (typeof token !== 'string' || token.length < 80 || Buffer.byteLength(token) > 8_192
          || claimToken === undefined
          || (rawClaimEpoch !== undefined && presentedEpoch === undefined)) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedResumeSession extends TerminalSessionRow, ControlHoldColumns {
        database_now: Date;
        session_unexpired: boolean;
      }
      let session: TerminalSessionRow | undefined;
      let databaseNow: Date | undefined;
      let takenOver = false;
      let refusal: { status: 401 | 403 | 409; reason: string; retry_after_ms?: number } | undefined;
      await withTransaction(pool, async (client) => {
        const authorityExpiresAt = await authority.lockSession(client, continuity, repository);
        const locked = await client.query<LockedResumeSession>(
          `SELECT terminal_sessions.*,clock_timestamp() AS database_now,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND ${sessionWindowExpression(2, 3)}>clock_timestamp() AS session_unexpired,
                  ${CONTROL_HOLD_COLUMNS}
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [sid, config.sessionTtlSeconds, config.sessionMaxTotalSeconds ?? null],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          refusal = { status: 401, reason: 'resume_invalid' };
        } else {
          let credential;
          try {
            credential = verifyAuthorityResumeToken(token, config.ticketKey, record.authority_proof as string);
          } catch (error) {
            if (!(error instanceof TicketError)) throw error;
          }
          const expiry = sessionExpiry(row, config.sessionTtlSeconds, config.sessionMaxTotalSeconds);
          if (credential?.sid !== sid || credential.op !== row.operator_id
              || expiry === undefined || credential.exp !== Math.min(Math.floor(expiry.getTime() / 1_000), continuity.origin.expiresAtSeconds)) {
            refusal = { status: 401, reason: 'resume_invalid' };
          } else if (row.consumed_at === null) {
            refusal = { status: 403, reason: 'not_consumed' };
          } else if (row.revoked_at !== null) {
            refusal = { status: 403, reason: 'revoked' };
          } else if (row.closed_at !== null) {
            refusal = { status: 403, reason: 'closed' };
          } else if (!row.session_unexpired) {
            refusal = { status: 403, reason: 'session_expired' };
          } else if (controlWasReleased(row)) {
            refusal = { status: 403, reason: CONTROL_RELEASED };
          } else {
            const policy = await currentSessionPolicy(row, false, client);
            const actor = sessionActor(row);
            const auditContext = terminalSessionAuditContext(
              row,
              policy.cohort === undefined ? [] : cohortLabels(policy.cohort),
            );
            if (!policy.allowed || actor === undefined) {
              const reason = policy.allowed ? 'unknown_session' : policy.reason;
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor?.tenant_id ?? row.tenant_id,
                actor_alias: actor?.alias ?? row.alias,
                action: 'terminal.session.resume',
                decision: 'deny',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(auditContext, { session_id: sid, reason }),
              });
              refusal = { status: 403, reason };
            } else {
              const claim = relayClaimState(
                row, claimSha256, identity,
                { mode: 'presented_epoch', epoch: presentedEpoch },
              );
              if (claim.exact && claim.live && presentedEpoch !== undefined) {
                const renewed = await renewRelayClaim(client, {
                  sid,
                  claimSha256,
                  claimEpoch: presentedEpoch,
                  identity,
                  claimLeaseSeconds: config.claimLeaseSeconds,
                  sessionTtlSeconds: config.sessionTtlSeconds,
                  sessionMaxTotalSeconds: config.sessionMaxTotalSeconds,
                  authorityExpiresAt,
                });
                session = renewed;
                databaseNow = renewed?.database_now;
              } else if (claim.live) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.resume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(auditContext, {
                    session_id: sid,
                    reason: 'claim_conflict',
                    claim_epoch: row.relay_claim_epoch,
                  }),
                });
                refusal = {
                  status: 409,
                  reason: 'claim_conflict',
                  ...(claim.retryAfterMs === undefined ? {} : { retry_after_ms: claim.retryAfterMs }),
                };
              } else {
                const takeover = await takeOverExpiredRelayClaim(client, {
                  sid,
                  claimSha256,
                  identity,
                  claimLeaseSeconds: config.claimLeaseSeconds,
                  sessionTtlSeconds: config.sessionTtlSeconds,
                  sessionMaxTotalSeconds: config.sessionMaxTotalSeconds,
                  authorityExpiresAt,
                });
                session = takeover;
                databaseNow = takeover?.database_now;
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
                  metadata: terminalAuditMetadata(auditContext, {
                    session_id: sid,
                    claim_epoch: session.relay_claim_epoch,

                  }),
                });
              }
            }
          }
        }
        await terminalDatabaseNow(client, authorityExpiresAt);
      });
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
        authority_proof: record.authority_proof,
        session_expires_at: new Date(Math.min((sessionExpiry(session, config.sessionTtlSeconds, config.sessionMaxTotalSeconds) ?? session.expires_at).getTime(), continuity.origin.expiresAtSeconds * 1000)).toISOString(),
        expires_at: new Date(Math.min((sessionExpiry(session, config.sessionTtlSeconds, config.sessionMaxTotalSeconds) ?? session.expires_at).getTime(), continuity.origin.expiresAtSeconds * 1000)).toISOString(),
        claim_taken_over: takenOver,
      });
    } catch (error) { replyError(reply, error); }
  });

}
