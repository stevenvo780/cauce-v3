import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { terminalAuditMetadata, terminalSessionAuditContext } from '../audit.js';
import { boundedInteger, exactObjectKeys } from '../helpers.js';
import { releaseHeldControl } from '../session-control/control.js';
import { ticketSha256 } from '../tickets.js';
import { isWritableMode, type TerminalSessionRow } from '../types.js';
import type { RelayProxyContext } from './context.js';

interface SessionRecording {
  readonly input_batches: number;
  readonly recording_sha256: string;
  readonly recording_capped: boolean;
}

function sessionRecording(record: Record<string, unknown>): SessionRecording {
  const digest = record.recording_sha256;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('recording_sha256 must be 64 lowercase hexadecimal characters');
  }
  if (typeof record.recording_capped !== 'boolean') {
    throw new Error('recording_capped must be a boolean');
  }
  return {
    input_batches: boundedInteger(record.input_batches, 0, Number.MAX_SAFE_INTEGER, 'input_batches'),
    recording_sha256: digest,
    recording_capped: record.recording_capped,
  };
}

export function registerRelayCloseRoute(context: RelayProxyContext): void {
  const {
    app, pool, CLOSE_KEYS, CLOSE_WITH_CLAIM_KEYS, CLOSE_WITH_RECORDING_KEYS,
    CLOSE_WITH_CLAIM_AND_RECORDING_KEYS,
    requestRelayIdentity, relayClaimToken, relayClaimEpoch,
    recordTransactionalTerminalAudit, counterValue, replyError,
  } = context;
  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/close', async (request, reply) => {
    try {
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      const recorded = exactObjectKeys(record, CLOSE_WITH_RECORDING_KEYS)
        || exactObjectKeys(record, CLOSE_WITH_CLAIM_AND_RECORDING_KEYS);
      if (!recorded && !exactObjectKeys(record, CLOSE_KEYS)
          && !exactObjectKeys(record, CLOSE_WITH_CLAIM_KEYS)) {
        throw new Error('terminal close report has unexpected or missing fields');
      }
      const recording = recorded ? sessionRecording(record) : undefined;
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
              metadata: terminalAuditMetadata(terminalSessionAuditContext(existing, []), {
                session_id: existing.id,
                reason: malformedClaim ? 'malformed_claim' : 'stale_claim',
                claim_epoch: existing.relay_claim_epoch,
              }),
            });
          } else {
            const settled = await client.query<TerminalSessionRow>(
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
            const row = settled.rows[0];
            if (row !== undefined) {
              await recordTransactionalTerminalAudit(client, {
                tenant_id: row.tenant_id,
                actor_alias: row.alias,
                action: 'terminal.session.close',
                decision: 'info',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(terminalSessionAuditContext(row, []), {
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
              if (recording !== undefined && isWritableMode(row.mode)) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: row.tenant_id,
                  actor_alias: row.alias,
                  action: 'terminal.session.input',
                  decision: 'info',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(terminalSessionAuditContext(row, []), {
                    session_id: row.id,
                    bytes_in: counterValue(row.bytes_in),
                    input_batches: recording.input_batches,
                    recording_sha256: recording.recording_sha256,
                    recording_capped: recording.recording_capped,
                  }),
                });
              }
              await releaseHeldControl({
                client,
                row,
                reason: 'session_closed',
                log: app.log,
                recordAudit: recordTransactionalTerminalAudit,
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
