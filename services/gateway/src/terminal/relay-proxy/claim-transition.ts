import type { DatabaseClient } from '@cauce/store';
import { sessionWindowExpression } from '../helpers.js';
import type { RelayProcessIdentity } from '../registry.js';
import type { TerminalSessionRow } from '../types.js';

const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Fence epochs stay decimal strings on the wire and in node-postgres; Number is never involved. */
export function relayClaimEpoch(value: unknown): string | undefined {
  if (typeof value !== 'string' || !POSITIVE_BIGINT_PATTERN.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}

export function databaseClaimEpoch(value: string): string {
  const epoch = relayClaimEpoch(value);
  if (epoch === undefined) throw new Error('database terminal claim epoch is invalid');
  return epoch;
}

type ClaimEpochMode =
  | { readonly mode: 'stored_epoch' }
  | { readonly mode: 'presented_epoch'; readonly epoch: string | undefined };

interface ClaimStateRow {
  readonly relay_claim_sha256: Buffer | null;
  readonly relay_claim_epoch: string;
  readonly relay_claim_expires_at: Date | null;
  readonly relay_instance_id: string | null;
  readonly relay_boot_id: string | null;
  readonly database_now: Date;
}

export interface RelayClaimState {
  readonly exact: boolean;
  readonly live: boolean;
  readonly retryAfterMs: number | undefined;
}

export function relayClaimState(
  row: ClaimStateRow,
  claimSha256: Buffer,
  identity: RelayProcessIdentity,
  epochMode: ClaimEpochMode,
): RelayClaimState {
  const expectedEpoch = epochMode.mode === 'stored_epoch'
    ? relayClaimEpoch(row.relay_claim_epoch)
    : epochMode.epoch;
  const exact = expectedEpoch !== undefined
    && row.relay_claim_sha256 !== null
    && row.relay_claim_sha256.equals(claimSha256)
    && row.relay_claim_epoch === expectedEpoch
    && row.relay_instance_id === identity.relay_instance_id
    && row.relay_boot_id === identity.relay_boot_id;
  const claimExpiresAt = row.relay_claim_expires_at;
  const live = claimExpiresAt !== null
    && claimExpiresAt.getTime() > row.database_now.getTime();
  return {
    exact,
    live,
    retryAfterMs: live
      ? Math.max(1, Math.ceil(claimExpiresAt.getTime() - row.database_now.getTime()))
      : undefined,
  };
}

interface RelayClaimMutation {
  readonly sid: string;
  readonly claimSha256: Buffer;
  readonly identity: RelayProcessIdentity;
  readonly claimLeaseSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly sessionMaxTotalSeconds: number | null | undefined;
}

export interface RenewedRelayClaim extends TerminalSessionRow {
  readonly database_now: Date;
  readonly session_expires_at: Date;
}

export async function renewRelayClaim(
  client: DatabaseClient,
  input: RelayClaimMutation & { readonly claimEpoch: string },
): Promise<RenewedRelayClaim | undefined> {
  const result = await client.query<RenewedRelayClaim>(
    `UPDATE terminal_sessions
        SET relay_claim_expires_at=LEAST(
          ${sessionWindowExpression(4, 8)},
          now()+make_interval(secs => $3)
        )
      WHERE id=$1 AND relay_claim_sha256=$2 AND relay_claim_epoch=$5::bigint
        AND relay_claim_expires_at>now()
        AND relay_instance_id=$6 AND relay_boot_id=$7
        AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
        AND ${sessionWindowExpression(4, 8)}>now()
      RETURNING *,now() AS database_now,
                ${sessionWindowExpression(4, 8)} AS session_expires_at`,
    [
      input.sid,
      input.claimSha256,
      input.claimLeaseSeconds,
      input.sessionTtlSeconds,
      input.claimEpoch,
      input.identity.relay_instance_id,
      input.identity.relay_boot_id,
      input.sessionMaxTotalSeconds ?? null,
    ],
  );
  return result.rows[0];
}

export interface TakenOverRelayClaim extends TerminalSessionRow {
  readonly database_now: Date;
}

export async function takeOverExpiredRelayClaim(
  client: DatabaseClient,
  input: RelayClaimMutation,
): Promise<TakenOverRelayClaim | undefined> {
  const result = await client.query<TakenOverRelayClaim>(
    `UPDATE terminal_sessions
        SET relay_claim_sha256=$2,
            relay_claim_epoch=relay_claim_epoch+1,
            relay_claimed_at=now(),
            relay_instance_id=$5,
            relay_boot_id=$6,
            relay_claim_expires_at=LEAST(
              ${sessionWindowExpression(4, 7)},
              now()+make_interval(secs => $3)
            )
      WHERE id=$1 AND consumed_at IS NOT NULL
        AND revoked_at IS NULL AND closed_at IS NULL
        AND ${sessionWindowExpression(4, 7)}>now()
        AND (relay_claim_expires_at IS NULL OR relay_claim_expires_at<=now())
        AND relay_claim_epoch<9223372036854775807
      RETURNING *,now() AS database_now`,
    [
      input.sid,
      input.claimSha256,
      input.claimLeaseSeconds,
      input.sessionTtlSeconds,
      input.identity.relay_instance_id,
      input.identity.relay_boot_id,
      input.sessionMaxTotalSeconds ?? null,
    ],
  );
  return result.rows[0];
}
