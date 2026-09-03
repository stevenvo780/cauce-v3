import type { DatabaseClient, DatabasePool } from '@cauce/store';

/**
 * Durable side of the sealed hand-off. Parameterised SQL straight against the pool, following the
 * precedent of services/gateway/src/terminal/: the CauceRepository chain stays untouched. The
 * gateway holds no private half of anything — `sealed` is opaque to it and to PostgreSQL alike.
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

/**
 * `cursor_at` is the row's `created_at` rendered by PostgreSQL to microsecond precision: the
 * driver hands back a JavaScript Date rounded to milliseconds, and a cursor built from that lands
 * BEFORE the row it came from and serves it twice.
 */
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

/**
 * A read hand-off is no longer revocable: withdrawing what was already delivered would write a
 * `secret.revoked` row after `secret.read` and leave a trail saying a credential was taken back
 * when it was not. `already_read` separates that from a hand-off the caller cannot see at all.
 */
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
 * How many key_ids one alias may CREATE inside the window. Rotation is make-before-break and rare,
 * so this is far above any honest cadence; it exists because `key_id` is the caller's to choose and
 * every new one is a permanent row here and a permanent `secret.key_published` row in the audit.
 * Refreshing a key_id the alias already published is never refused by it: the guard asks whether
 * the identity is NEW, so a rotation that is already advertised keeps working at the ceiling.
 */
export const MAX_SEALING_KEYS_PER_ALIAS = 8;
const SEALING_KEY_CEILING_WINDOW_HOURS = 24;

/**
 * Idempotent on identical bytes; re-binding a `key_id` to DIFFERENT bytes is refused INSIDE the
 * statement, so no race can slip a substituted public key past a read-then-write check.
 *
 * Two things a disable must survive, both decided here rather than by a read-then-write:
 *  - replaying the same bytes under the same `key_id` updates `not_after` and nothing else;
 *  - republishing the same bytes under a NEW `key_id` is refused, because that row would default
 *    to `enabled` and make the same key material address the alias again.
 *
 * `published` and `refreshed` are told apart because only the first is an event: `prior` reads the
 * state the statement started from — a WITH sees the snapshot, never the INSERT beside it — so a
 * caller moving `not_after` on the key it already advertises is a touch, not a new publication,
 * and must not write an audit row per request. What the alias advertises did not change.
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

/**
 * The one key a hand-off may be sealed against today: newest, enabled, unexpired. Rotation is
 * make-before-break, so hand-offs in flight stay readable but nothing NEW addresses an old key.
 */
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

/**
 * A recipient never receives an unbounded response: the sender chooses how many hand-offs exist,
 * so the page size cannot be the sender's to decide. Keyset on the same `(created_at,id)` order
 * the pending index already provides — an OFFSET would skip rows as claims settle underneath.
 */
export const MAX_PENDING_HANDOFF_PAGE = 20;

/**
 * What the recipient is told exists. It names each hand-off; it carries none of them. One row over
 * the page is read and thrown away: it is what tells a full page that is the LAST one apart from a
 * full page with more behind it, so the recipient is never sent back for an empty round trip.
 */
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
 * A hand-off is created by the SENDER against a recipient who never asked for it, and any agent
 * with `route` may address any alias it can route to. Without a ceiling one sender fills another
 * agent's inbox — and its disk, with 64 KiB blobs — as fast as it can POST.
 *
 * It counts what was CREATED for that recipient inside the window, NOT what is live. Counting
 * liveness bounded only the inbox: a sender that picked `expires_at` a few hundred milliseconds
 * out created rows that were invisible to the count the instant they landed and resident on disk
 * all the same — measured 2131 rows and 133 MiB in 20 s while the live count read 32 throughout.
 * Every row inside the window is either still on disk or already swept, so this count is the disk
 * figure; the database CHECK caps any lifetime at 24 h, so no row outlives its window.
 *
 * The count and the insert are ONE statement, so no read-then-write window exists; concurrent
 * senders still overshoot by what is in flight — measured 35 to 47 rows against a ceiling of 32
 * with 64 simultaneous POSTs, so up to a 47 % overshoot. That bounds a flood without pretending to
 * be an exact quota. Returns false when the ceiling refused the row.
 *
 * It counts per RECIPIENT because the recipient's inbox is what must stay bounded, and that means
 * a routable sender can occupy the slots of an honest one. That is not silent, but what the audit
 * bounds is the SENDER, not the edge: the refusals go on that sender's doubling ladder in
 * audit.ts, so a flood writes a handful of rows a minute naming who was refused, how many refusals
 * each row stands for and what for — not one row per recipient it managed to name. A slot comes
 * back as soon as the sweep takes the settled row holding it.
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
 * Retention keyed on SETTLEMENT, and on nothing else: a row read, revoked or expired longer ago
 * than the grace is up to 64 KiB of ciphertext nobody can ever open. Keying it on AGE instead left
 * a hand-off that expired in 300 ms resident for a week; keying it on settlement means the debris
 * of a flood is gone minutes after it lands. The grace is short because ciphertext at rest is a
 * liability, and not zero so a row does not vanish from under whoever is looking at what happened.
 *
 * `read_at` and `revoked_at` exclude each other by construction — a claim refuses a revoked row and
 * a revocation refuses a read one — so COALESCE names the instant the row settled, falling through
 * to `expires_at` for one nobody ever touched.
 *
 * It runs in a batch so a grant never becomes an unbounded delete, and it runs BEFORE the ceiling
 * decides: the recipient sitting at the ceiling is exactly the one whose debris has to be swept for
 * the slots it holds to come back.
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
 * One-time read, in ONE statement. Under READ COMMITTED a second reader blocks on the row,
 * re-evaluates the predicate with `read_at` already written and returns nothing; reading first and
 * writing after would leave the window this statement does not have. The `visible` sub-select runs
 * on the same snapshot, so it reports the state BEFORE the claim: that is what separates "you are
 * not the recipient" (404) from "it is gone" (410) without confirming anything to a stranger.
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

/**
 * Conditional for the same reason the claim is: predicate and write are one statement, and the
 * `already_read` sub-select carries the same scope so a stranger still learns nothing. The digest
 * is computed in PostgreSQL so the ciphertext never leaves the database for the audit row.
 */
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
