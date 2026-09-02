import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { terminalAuditMetadata } from '../audit.js';
import { boundedInteger, exactObjectKeys } from '../helpers.js';
import { ticketSha256 } from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayCloseRoute(context: RelayProxyContext): void {
  const {
    app, pool, CLOSE_KEYS, CLOSE_WITH_CLAIM_KEYS,
    requestRelayIdentity, relayClaimToken, relayClaimEpoch,
    recordTransactionalTerminalAudit, counterValue, replyError,
  } = context;
  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/close', async (request, reply) => {
    try {
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      if (!exactObjectKeys(record, CLOSE_KEYS) && !exactObjectKeys(record, CLOSE_WITH_CLAIM_KEYS)) {
        throw new Error('terminal close report has unexpected or missing fields');
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) return await reply.code(401).send();
      const reason = typeof record.reason === 'string' && record.reason.length > 0
        ? record.reason.slice(0, 128) : 'relay_closed';
      const exitCode = typeof record.exit_code === 'number' && Number.isSafeInteger(record.exit_code)
        ? record.exit_code : null;
      const bytesIn = boundedInteger(record.bytes_in ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_in');
      const bytesOut = boundedInteger(record.bytes_out ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_out');
      const rawClaimToken = record.claim_token;
      const rawClaimEpoch = record.claim_epoch;
      const claimToken = rawClaimToken === undefined ? undefined : relayClaimToken(rawClaimToken);
      const claimEpoch = rawClaimEpoch === undefined ? undefined : relayClaimEpoch(rawClaimEpoch);
      const malformedClaim = (rawClaimToken !== undefined || rawClaimEpoch !== undefined)
        && (claimToken === undefined || claimEpoch === undefined);
      const claimSha256 = claimToken === undefined ? undefined : ticketSha256(claimToken);
      await withTransaction(pool, async (client) => {
        const locked = await client.query<TerminalSessionRow>(
          `SELECT * FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [request.params.sid],
        );
        const existing = locked.rows[0];
        if (existing?.closed_at === null) {
          const legacy = !malformedClaim && claimToken === undefined && claimEpoch === undefined
            && existing.relay_claim_sha256 === null && existing.relay_claim_epoch === '0'
            && existing.relay_instance_id === identity.relay_instance_id
            && existing.relay_boot_id === null;
          const exact = !malformedClaim && claimSha256 !== undefined && claimEpoch !== undefined
            && existing.relay_claim_sha256 !== null
            && existing.relay_claim_sha256.equals(claimSha256)
            && existing.relay_claim_epoch === claimEpoch
            && existing.relay_instance_id === identity.relay_instance_id
            && existing.relay_boot_id === identity.relay_boot_id;
          if (!legacy && !exact) {
            // A stale spooled close is terminally acknowledged so it does not retry forever, but
            // it is observable and can never mutate the current ownership generation.
            await recordTransactionalTerminalAudit(client, {
              tenant_id: existing.tenant_id,
              actor_alias: existing.alias,
              action: 'terminal.session.close',
              decision: 'deny',
              ...(existing.trace_id === null ? {} : { trace_id: existing.trace_id }),
              metadata: terminalAuditMetadata({
                operator_id: existing.operator_id,
                attributed: existing.attributed,
                target_tenant: existing.tenant_id,
                target_alias: existing.alias,
                container: existing.container,
                cohort: [],
                mode: existing.mode,
              }, {
                session_id: existing.id,
                reason: malformedClaim ? 'malformed_claim' : 'stale_claim',
                claim_epoch: existing.relay_claim_epoch,
              }),
            });
          } else {
            const closed = await client.query<TerminalSessionRow>(
              `UPDATE terminal_sessions
                  SET closed_at=now(), close_reason=$2, bytes_in=$3, bytes_out=$4
                WHERE id=$1 AND closed_at IS NULL
                  AND (
                    ($5::boolean AND relay_claim_sha256 IS NULL AND relay_claim_epoch=0)
                    OR
                    (NOT $5::boolean AND relay_claim_sha256=$6 AND relay_claim_epoch=$7::bigint)
                  )
                  AND relay_instance_id=$8
                  AND relay_boot_id IS NOT DISTINCT FROM $9::uuid
                RETURNING *`,
              [
                request.params.sid,
                reason,
                bytesIn,
                bytesOut,
                legacy,
                claimSha256 ?? null,
                claimEpoch ?? '0',
                identity.relay_instance_id,
                legacy ? null : identity.relay_boot_id,
              ],
            );
            const row = closed.rows[0];
            if (row !== undefined) {
              await recordTransactionalTerminalAudit(client, {
                tenant_id: row.tenant_id,
                actor_alias: row.alias,
                action: 'terminal.session.close',
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
                  image_id: row.image_id,
                  generation: row.generation,
                  operator_reason: row.reason,
                  close_reason: reason,
                  exit_code: exitCode,
                  bytes_in: counterValue(row.bytes_in),
                  bytes_out: counterValue(row.bytes_out),
                  claim_epoch: row.relay_claim_epoch,
                }),
              });
            }
          }
        }
      });
      return await reply.code(200).send({
        ok: true,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      });
    } catch (error) { replyError(reply, error); }
  });

}
