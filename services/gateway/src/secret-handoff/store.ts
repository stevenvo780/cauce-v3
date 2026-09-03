import type { DatabaseClient, DatabasePool } from '@cauce/store';

/**
 * Durable side of the sealed hand-off, parameterised SQL against the pool. `sealed` is opaque to
 * this gateway and to PostgreSQL alike. Full rationale: ./README.md
 */

type Database = DatabasePool | DatabaseClient;

export interface SealingKeyRow {
  readonly key_id: string;
  readonly public_key: Buffer;
  readonly not_after: Date | null;
}

export interface SealingKeyPublicationRow {
  readonly tenant_id: string;
  readonly alias: string;
  readonly key_id: string;
  readonly public_key: Buffer;
  readonly not_after: Date | null;
}

export interface HandoffRefRow {
  readonly id: string;
  readonly from_tenant: string;
  readonly from_alias: string;
  readonly label: string;
  readonly expires_at: Date;
}

/** `cursor_at` renders `created_at` to microsecond precision, past the driver's millisecond Date. */
export interface PendingHandoffRow extends HandoffRefRow {
  readonly cursor_at: string;
}

export interface PendingHandoffCursor {
  readonly at: string;
  readonly id: string;
}

export interface HandoffPayloadRow extends HandoffRefRow {
  readonly to_tenant: string;
  readonly to_alias: string;
  readonly sealing_key_id: string;
  readonly ephemeral_public: Buffer;
  readonly nonce: Buffer;
  readonly sealed: Buffer;
  readonly created_at: Date;
}

export interface HandoffInsert {
  readonly id: string;
  readonly from_tenant: string;
  readonly from_alias: string;
  readonly to_tenant: string;
  readonly to_alias: string;
  readonly label: string;
  readonly sealed: Buffer;
  readonly sealing_key_id: string;
  readonly ephemeral_public: Buffer;
  readonly nonce: Buffer;
  readonly expires_at: Date;
}

export interface RevokedHandoffRow {
  readonly label: string;
  readonly to_tenant: string;
  readonly to_alias: string;
  readonly sealing_key_id: string;
  readonly sealed_sha256: string;
}

/** `visible` answers "is the caller the recipient of an existing hand-off", nothing more. */
export interface ClaimOutcome {
  readonly visible: boolean;
  readonly payload?: HandoffPayloadRow;
}

/** A read hand-off is no longer revocable. `already_read` separates that from not visible at all. */
export type RevokeOutcome =
  | { readonly kind: 'revoked'; readonly row: RevokedHandoffRow }
  | { readonly kind: 'already_read' }
  | { readonly kind: 'absent' };

/** Who may revoke: the sender by identity, or an operator confined to a tenant of the edge. */
export type RevokeScope =
  | { readonly kind: 'sender'; readonly tenant: string; readonly alias: string }
  | { readonly kind: 'operator'; readonly tenant: string };

export type SealingKeyPublicationOutcome =
  | 'published'
  | 'refreshed'
  | 'rebind_refused'
  | 'disabled_material'
  | 'ceiling_refused';

/**
 * How many key_ids one alias may CREATE inside the window; refreshing one already published is
 * never refused by it. Full rationale: ./README.md
 */
export const MAX_SEALING_KEYS_PER_ALIAS = 8;
const SEALING_KEY_CEILING_WINDOW_HOURS = 24;

/**
 * Idempotent on identical bytes; re-binding a `key_id` to DIFFERENT bytes is refused INSIDE the
 * statement. `published` vs `refreshed` decides whether an audit row is due. Full rationale:
 * ./README.md
 */
export async function publishSealingKey(
  database: Database, publication: SealingKeyPublicationRow,
): Promise<SealingKeyPublicationOutcome> {
  const result = await database.query<{
    published: number; disabled: number; prior: number; same_bytes: number;
  }>(
    `WITH disabled AS (
       SELECT 1 FROM agent_sealing_keys
        WHERE tenant_id=$1 AND alias=$2 AND public_key=$4 AND key_id<>$3 AND NOT enabled
     ), prior AS (
       SELECT (public_key=$4::bytea) AS same_bytes FROM agent_sealing_keys
        WHERE tenant_id=$1 AND alias=$2 AND key_id=$3
     ), published AS (
       INSERT INTO agent_sealing_keys(tenant_id,alias,key_id,algorithm,public_key,not_after)
       SELECT $1::text,$2::text,$3::text,'x25519',$4::bytea,$5::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM disabled)
          AND (EXISTS (SELECT 1 FROM prior)
               OR (SELECT count(*) FROM agent_sealing_keys
                    WHERE tenant_id=$1 AND alias=$2
                      AND created_at > now() - make_interval(hours => $7::int)) < $6::int)
       ON CONFLICT (tenant_id,alias,key_id) DO UPDATE
         SET not_after=EXCLUDED.not_after
         WHERE agent_sealing_keys.public_key=EXCLUDED.public_key
       RETURNING key_id
     )
     SELECT (SELECT count(*) FROM published)::int AS published,
            (SELECT count(*) FROM disabled)::int AS disabled,
            (SELECT count(*) FROM prior)::int AS prior,
            (SELECT count(*) FROM prior WHERE same_bytes)::int AS same_bytes`,
    [
      publication.tenant_id, publication.alias, publication.key_id,
      publication.public_key, publication.not_after,
      MAX_SEALING_KEYS_PER_ALIAS, SEALING_KEY_CEILING_WINDOW_HOURS,
    ],
  );
  const counts = result.rows[0];
  if (counts === undefined) return 'rebind_refused';
  if (counts.published === 1) return counts.same_bytes > 0 ? 'refreshed' : 'published';
  if (counts.disabled > 0) return 'disabled_material';
  return counts.prior > 0 ? 'rebind_refused' : 'ceiling_refused';
}

/** The one key a hand-off may be sealed against today: newest, enabled, unexpired. */
export async function activeSealingKey(
  database: Database, tenant: string, alias: string,
): Promise<SealingKeyRow | undefined> {
  const result = await database.query<SealingKeyRow>(
    `SELECT key_id,public_key,not_after FROM agent_sealing_keys
      WHERE tenant_id=$1 AND alias=$2 AND enabled
        AND (not_after IS NULL OR not_after > now())
      ORDER BY created_at DESC, key_id DESC LIMIT 1`,
    [tenant, alias],
  );
  return result.rows[0];
}

/** Keyset on `(created_at,id)`, never OFFSET: claims settling underneath would skip rows. */
export const MAX_PENDING_HANDOFF_PAGE = 20;

/** What the recipient is told exists: names each hand-off, carries none. Full rationale: ./README.md */
export interface PendingHandoffPage {
  readonly rows: PendingHandoffRow[];
  readonly more: boolean;
}

export async function pendingHandoffs(
  database: Database, toTenant: string, toAlias: string, after?: PendingHandoffCursor,
): Promise<PendingHandoffPage> {
  const result = await database.query<PendingHandoffRow>(
    `SELECT id,from_tenant,from_alias,label,expires_at,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.USZ') AS cursor_at
       FROM secret_handoffs
      WHERE to_tenant=$1 AND to_alias=$2
        AND read_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::uuid))
      ORDER BY created_at, id
      LIMIT $5::int`,
    [toTenant, toAlias, after?.at ?? null, after?.id ?? null, MAX_PENDING_HANDOFF_PAGE + 1],
  );
  return {
    rows: result.rows.slice(0, MAX_PENDING_HANDOFF_PAGE),
    more: result.rows.length > MAX_PENDING_HANDOFF_PAGE,
  };
}

/**
 * Ceiling by CREATED_AT window per RECIPIENT, not by what is live: counting liveness let a sender
 * pick a near-immediate `expires_at` and flood the disk invisibly to the count. Count and insert are
 * ONE statement, so concurrent senders can still overshoot by what is in flight. Full rationale:
 * ./README.md
 */
export const MAX_HANDOFFS_PER_RECIPIENT = 32;
const HANDOFF_CEILING_WINDOW_HOURS = 24;

export async function insertHandoff(database: Database, handoff: HandoffInsert): Promise<boolean> {
  const result = await database.query(
    `INSERT INTO secret_handoffs(
       id,from_tenant,from_alias,to_tenant,to_alias,label,sealed,sealing_key_id,
       ephemeral_public,nonce,expires_at
     )
     SELECT $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::bytea,$8::text,
            $9::bytea,$10::bytea,$11::timestamptz
      WHERE (SELECT count(*) FROM secret_handoffs
              WHERE to_tenant=$4 AND to_alias=$5
                AND created_at > now() - make_interval(hours => $13::int)) < $12::int`,
    [
      handoff.id, handoff.from_tenant, handoff.from_alias, handoff.to_tenant, handoff.to_alias,
      handoff.label, handoff.sealed, handoff.sealing_key_id, handoff.ephemeral_public,
      handoff.nonce, handoff.expires_at, MAX_HANDOFFS_PER_RECIPIENT,
      HANDOFF_CEILING_WINDOW_HOURS,
    ],
  );
  return result.rowCount === 1;
}

/**
 * Retention keyed on SETTLEMENT (read, revoked or expired), never on age, and swept BEFORE the
 * ceiling decides: the recipient at the ceiling is the one whose debris frees its own slots. Full
 * rationale: ./README.md
 */
const SETTLED_HANDOFF_GRACE_MINUTES = 15;
const PRUNE_BATCH_SIZE = 200;

export async function pruneSettledHandoffs(database: Database): Promise<number> {
  const result = await database.query(
    `DELETE FROM secret_handoffs
      WHERE id IN (
        SELECT id FROM secret_handoffs
         WHERE COALESCE(read_at,revoked_at,expires_at) < now() - make_interval(mins => $1::int)
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )`,
    [SETTLED_HANDOFF_GRACE_MINUTES, PRUNE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

/**
 * One-time read in ONE statement: `visible` reports the state BEFORE the claim, which is what
 * separates 404 from 410 without confirming anything to a stranger. Full rationale: ./README.md
 */
type ClaimRow = { visible: boolean } & { [K in keyof HandoffPayloadRow]: HandoffPayloadRow[K] | null };

export async function claimHandoff(
  database: Database, id: string, toTenant: string, toAlias: string,
): Promise<ClaimOutcome> {
  const result = await database.query<ClaimRow>(
    `WITH claimed AS (
       UPDATE secret_handoffs SET read_at=now()
        WHERE id=$1 AND to_tenant=$2 AND to_alias=$3
          AND read_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING id,from_tenant,from_alias,to_tenant,to_alias,label,sealing_key_id,
                ephemeral_public,nonce,sealed,expires_at,created_at
     )
     SELECT EXISTS (
              SELECT 1 FROM secret_handoffs WHERE id=$1 AND to_tenant=$2 AND to_alias=$3
            ) AS visible,
            claimed.*
       FROM (SELECT 1) AS anchor LEFT JOIN claimed ON true`,
    [id, toTenant, toAlias],
  );
  const row = result.rows[0];
  if (row === undefined) return { visible: false };
  const { visible, ...claimed } = row;
  if (claimed.id === null) return { visible };
  return { visible: true, payload: claimed as HandoffPayloadRow };
}

type RevokeRow = { already_read: boolean } & {
  [K in keyof RevokedHandoffRow]: RevokedHandoffRow[K] | null
};

const REVOKE_SCOPE_PREDICATE = `CASE WHEN $2::boolean
       THEN from_tenant=$3 OR to_tenant=$3
       ELSE from_tenant=$3 AND from_alias=$4::text END`;

/** Conditional like the claim: predicate and write are one statement. Full rationale: ./README.md */
export async function revokeHandoff(
  database: Database, id: string, scope: RevokeScope,
): Promise<RevokeOutcome> {
  const operator = scope.kind === 'operator';
  const result = await database.query<RevokeRow>(
    `WITH revoked AS (
       UPDATE secret_handoffs SET revoked_at=now()
        WHERE id=$1 AND revoked_at IS NULL AND read_at IS NULL AND ${REVOKE_SCOPE_PREDICATE}
      RETURNING label,to_tenant,to_alias,sealing_key_id,
                left(encode(sha256(sealed),'hex'),16) AS sealed_sha256
     )
     SELECT EXISTS (
              SELECT 1 FROM secret_handoffs
               WHERE id=$1 AND read_at IS NOT NULL AND ${REVOKE_SCOPE_PREDICATE}
            ) AS already_read,
            revoked.*
       FROM (SELECT 1) AS anchor LEFT JOIN revoked ON true`,
    [id, operator, scope.tenant, operator ? null : scope.alias],
  );
  const row = result.rows[0];
  if (row === undefined) return { kind: 'absent' };
  const { already_read: alreadyRead, ...revoked } = row;
  if (revoked.label === null) return alreadyRead ? { kind: 'already_read' } : { kind: 'absent' };
  return { kind: 'revoked', row: revoked as RevokedHandoffRow };
}
