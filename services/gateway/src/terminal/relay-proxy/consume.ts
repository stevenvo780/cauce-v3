import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import {
  terminalAuditMetadata, type TerminalAuditContext,
} from '../audit.js';
import {
  cohortLabels, exactObjectKeys, sessionExpiry, sessionWindowExpression,
} from '../helpers.js';
import {
  deriveAliasKey, issueResumeToken, ticketDigest, ticketSha256,
  verifyTicketSignature, TicketError, type TicketPayload,
} from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';
import {
  relayClaimState, renewRelayClaim, takeOverExpiredRelayClaim,
} from './claim-transition.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayConsumeRoute(context: RelayProxyContext): void {
  const {
    app, pool, config, CONSUME_KEYS, requestRelayIdentity,
    relayClaimToken, relayClaimEpoch, currentSessionPolicy, sessionActor,
    recordTransactionalTerminalAudit, relayGrant, replyError,
  } = context;
  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/consume', async (request, reply) => {
    const sid = request.params.sid;
    const invalid = async (): Promise<void> => {
      await reply.code(401).send({ ok: false, reason: 'ticket_invalid' });
    };
    try {
      if (!UUID_ANY_PATTERN.test(sid)) { await invalid(); return; }
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined || !exactObjectKeys(record, CONSUME_KEYS)) { await invalid(); return; }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const ticket = record.ticket;
      const claimToken = relayClaimToken(record.claim_token);
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4_096
          || claimToken === undefined) { await invalid(); return; }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedSession extends TerminalSessionRow {
        ticket_redeemable: boolean;
        session_recoverable: boolean;
        database_now: Date;
      }
      interface ClaimedSession extends TerminalSessionRow { database_now: Date }
      let session: TerminalSessionRow | undefined;
      let databaseNow: Date | undefined;
      let recovered = false;
      let takenOver = false;
      let refusal: { status: 401 | 403 | 409; reason: string; retry_after_ms?: number } | undefined;
      await withTransaction(pool, async (client) => {
        const locked = await client.query<LockedSession>(
          `SELECT terminal_sessions.*,
                  consumed_at IS NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND expires_at > now() AS ticket_redeemable,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND ${sessionWindowExpression(2, 3)} > now() AS session_recoverable,
                  now() AS database_now
             FROM terminal_sessions
            WHERE id=$1
            FOR UPDATE`,
          [sid, config.sessionTtlSeconds, config.sessionMaxTotalSeconds ?? null],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          refusal = { status: 401, reason: 'ticket_invalid' };
        } else {
          let payload: TicketPayload | undefined;
          try {
            payload = verifyTicketSignature(
              ticket,
              deriveAliasKey(config.ticketKey, row.tenant_id, row.alias),
            );
          } catch (error) {
            if (!(error instanceof TicketError)) throw error;
          }
          if (payload?.sid !== sid
              || payload.iat !== Math.floor(row.issued_at.getTime() / 1_000)
              || payload.exp !== Math.floor(row.expires_at.getTime() / 1_000)
              || !ticketSha256(ticket).equals(row.ticket_sha256)) {
            refusal = { status: 401, reason: 'ticket_invalid' };
          } else if (row.consumed_at === null && row.relay_instance_id !== identity.relay_instance_id) {
            refusal = { status: 403, reason: 'relay_fenced' };
          } else if (!row.ticket_redeemable && !row.session_recoverable) {
            refusal = { status: 401, reason: 'ticket_invalid' };
          } else {
            // This is a synchronous re-check immediately before the state transition/grant. It
            // includes canonical target visibility, the whole current container cohort, ACL and
            // routing authority, attribution, and a cache-free grants-file read.
            const policy = await currentSessionPolicy(row, true, client);
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
                action: 'terminal.session.consume',
                decision: 'deny',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(context, {
                  session_id: sid,
                  reason,
                  ticket_sha256: ticketDigest(ticket),
                }),
              });
              refusal = { status: 403, reason };
            } else if (row.ticket_redeemable) {
              const claimed = await client.query<ClaimedSession>(
                `UPDATE terminal_sessions
                    SET consumed_at=now(), relay_claim_sha256=$2, relay_claim_epoch=1,
                        relay_claimed_at=now(),
                        relay_claim_expires_at=LEAST(
                          now()+make_interval(secs => $3),
                          now()+make_interval(secs => $4)
                        ), relay_boot_id=$5
                  WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL
                    AND closed_at IS NULL AND expires_at > now()
                    AND relay_instance_id=$6
                  RETURNING *,now() AS database_now`,
                [
                  sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                  identity.relay_boot_id, identity.relay_instance_id,
                ],
              );
              session = claimed.rows[0];
              databaseNow = claimed.rows[0]?.database_now;
              if (session === undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'lifecycle_conflict',
                    ticket_sha256: ticketDigest(ticket),
                  }),
                });
                refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
            } else {
              const currentEpoch = relayClaimEpoch(row.relay_claim_epoch);
              const claim = relayClaimState(
                row, claimSha256, identity, { mode: 'stored_epoch' },
              );
              if (claim.exact && claim.live && currentEpoch !== undefined) {
                const renewed = await renewRelayClaim(client, {
                  sid,
                  claimSha256,
                  claimEpoch: currentEpoch,
                  identity,
                  claimLeaseSeconds: config.claimLeaseSeconds,
                  sessionTtlSeconds: config.sessionTtlSeconds,
                  sessionMaxTotalSeconds: config.sessionMaxTotalSeconds,
                });
                session = renewed;
                databaseNow = renewed?.database_now;
                recovered = session !== undefined;
              } else if (!claim.live) {
                const takeover = await takeOverExpiredRelayClaim(client, {
                  sid,
                  claimSha256,
                  identity,
                  claimLeaseSeconds: config.claimLeaseSeconds,
                  sessionTtlSeconds: config.sessionTtlSeconds,
                  sessionMaxTotalSeconds: config.sessionMaxTotalSeconds,
                });
                session = takeover;
                databaseNow = takeover?.database_now;
                takenOver = session !== undefined;
              } else {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'claim_conflict',
                    ticket_sha256: ticketDigest(ticket),
                    claim_epoch: row.relay_claim_epoch,
                  }),
                });
                refusal = {
                  status: 409,
                  reason: 'claim_conflict',
                  ...(claim.retryAfterMs === undefined ? {} : { retry_after_ms: claim.retryAfterMs }),
                };
              }
              if (session === undefined && refusal === undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'lifecycle_conflict',
                    ticket_sha256: ticketDigest(ticket),
                  }),
                });
                refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
            }
            if (session !== undefined && actor !== undefined) {
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor.tenant_id,
                actor_alias: actor.alias,
                action: 'terminal.session.consume',
                decision: 'info',
                ...(session.trace_id === null ? {} : { trace_id: session.trace_id }),
                metadata: terminalAuditMetadata(context, {
                  session_id: sid,
                  image_id: session.image_id,
                  generation: session.generation,
                  operator_reason: session.reason,
                  cols: session.cols,
                  rows: session.rows,
                  ticket_sha256: ticketDigest(ticket),
                  receipt_recovered: recovered,
                  claim_taken_over: takenOver,
                  claim_epoch: session.relay_claim_epoch,
                  source_room_ids: policy.source_room_ids ?? [],
                }),
              });
            }
          }
        }
      });
      if (session === undefined) {
        if (refusal?.status === 403) {
          await reply.code(403).send({ ok: false, reason: refusal.reason });
        } else if (refusal?.status === 409) {
          await reply.code(409).send({
            ok: false,
            reason: refusal.reason,
            ...(refusal.retry_after_ms === undefined ? {} : { retry_after_ms: refusal.retry_after_ms }),
          });
        } else {
          await invalid();
        }
        return;
      }
      const expiry = sessionExpiry(session, config.sessionTtlSeconds, config.sessionMaxTotalSeconds)
        ?? session.expires_at;
      if (session.consumed_at === null) {
        throw new Error('database consumed a terminal session without a consumed_at timestamp');
      }
      if (databaseNow === undefined) throw new Error('database omitted terminal claim clock');
      const resumeToken = issueResumeToken(
        session.id,
        session.operator_id,
        Math.floor(expiry.getTime() / 1_000),
        config.ticketKey,
        Math.floor(session.consumed_at.getTime() / 1_000)
      );
      return await reply.code(200).send({
        ...relayGrant(session, resumeToken, claimToken, databaseNow, identity),
        receipt_recovered: recovered,
        claim_taken_over: takenOver,
      });
    } catch (error) { replyError(reply, error); }
  });

}
