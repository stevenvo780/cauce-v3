import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AliasSchema, CanonicalUuidV4Schema, MAX_SEALED_BYTES, SEALING_ALGORITHM, SEALING_NONCE_BYTES,
  SEALING_PUBLIC_KEY_BYTES, SEALING_TAG_BYTES, SECRET_HANDOFF_MAX_TTL_MS,
  SealingKeyPublicationSchema, SecretHandoffRequestSchema, TenantSchema, decodeCanonicalBase64,
} from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import {
  AuthError, AuthorizationError, requirePermission, type AuthProvider, type Principal,
} from '../auth.js';
import { driverErrorCode, principal, replyError } from '../routes/shared.js';
import { routingAuthority } from '../terminal/authority.js';
import {
  createDenialThrottle, handoffDigest, recordSecretAudit, secretAuditMetadata, shortDigest,
  type SecretAuditAction, type SecretAuditDecision, type SecretAuditFacts,
} from './audit.js';
import {
  MAX_HANDOFFS_PER_RECIPIENT, MAX_SEALING_KEYS_PER_ALIAS,
  activeSealingKey, claimHandoff, insertHandoff, pendingHandoffs, pruneSettledHandoffs,
  publishSealingKey, revokeHandoff,
  type HandoffPayloadRow, type HandoffRefRow, type PendingHandoffCursor, type PendingHandoffRow,
  type RevokeScope,
} from './store.js';

/**
 * Sealed credential hand-off plane: one agent gives another a credential that the gateway
 * transports without ever being able to read it. The routes live OUTSIDE /v3/console/ like the
 * terminal relay ones: the callers are agents with their own client certificate, not browsers.
 *
 * Four invariants hold every route together:
 *  - identity is the authenticated principal; a body naming the SUBJECT of the call is refused
 *    rather than ignored, so a misuse fails loudly instead of being silently reinterpreted.
 *  - no request or response field can carry a clear value: the secret exists sealed or not at all.
 *  - a stranger gets 404, never 403: an authorization error would confirm the hand-off exists.
 *  - nothing destructive answers a GET, and every mutation commits with its own audit row or with
 *    neither. A consumed hand-off nobody can prove was consumed is the hole this plane avoids.
 */

const HANDOFF_ID_KEY = 'id';
/** Body keys refused outright: they either restate identity or could smuggle a clear value. */
const REFUSED_REQUEST_KEYS = [
  'tenant_id', 'alias', 'from_tenant', 'from_alias', 'value', 'plaintext', 'secret',
  'credential', 'token', 'password',
] as const;
const CONSOLE_CHANNEL = 'console';
const UNIQUE_VIOLATION = '23505';
const CURSOR_SEPARATOR = '|';
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

interface SecretHandoffPlaneOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
}

class SecretPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretPlaneError';
  }
}

function invalid(message: string): SecretPlaneError {
  return new SecretPlaneError(400, 'invalid_request', message);
}

/**
 * Allowlist, not denylist. Every other plane may answer 400 with whatever text was thrown; here a
 * stranger must learn no fact, so only the errors this plane raises on purpose — plus the
 * authentication and authorization ones, whose text is about the caller and never about the
 * deployment — reach the client. A driver failure, a dead pool or a TypeError all collapse to one
 * opaque 500: a connection error carries the database host and port, and an internal fault is not
 * a client's mistake to be told to stop retrying.
 */
function replySecretError(reply: FastifyReply, error: unknown): void {
  if (error instanceof SecretPlaneError) {
    void reply.code(error.status).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AuthError || error instanceof AuthorizationError) {
    replyError(reply, error);
    return;
  }
  void reply.code(500).send({ error: 'internal_error', message: 'request could not be completed' });
}

interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/** Validation failures answer 400 by NAME of the field: the reason itself is the caller's own. */
function validated<T>(schema: Validator<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(`${name} is not valid for this plane`);
  return parsed.data;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('request body must be an object');
  }
  const body = value as Record<string, unknown>;
  for (const key of REFUSED_REQUEST_KEYS) {
    if (key in body) {
      throw invalid(`${key} is not accepted: identity and values never travel in the body`);
    }
  }
  return body;
}

function handoffId(request: FastifyRequest): string {
  const parsed = CanonicalUuidV4Schema.safeParse((request.params as Record<string, unknown>).id);
  if (!parsed.success) throw new SecretPlaneError(404, 'not_found', 'hand-off does not exist');
  return parsed.data;
}

function requiredBytes(value: string, bytes: number, name: string): Buffer {
  const decoded = decodeCanonicalBase64(value, bytes);
  if (decoded?.byteLength !== bytes) {
    throw invalid(`${name} must be ${String(bytes)} canonical base64 bytes`);
  }
  return decoded;
}

function sealedBytes(value: string): Buffer {
  const decoded = decodeCanonicalBase64(value, MAX_SEALED_BYTES);
  if (decoded === undefined || decoded.byteLength <= SEALING_TAG_BYTES) {
    throw invalid('sealed secret is not canonical base64 within the protocol cap');
  }
  return decoded;
}

/**
 * The 24 hour ceiling is also a database CHECK; refusing here names the field instead of the row.
 * The FLOOR is this plane's own admission policy and lives here for that reason: a hand-off that
 * expires before the recipient can plausibly poll and claim it was never a hand-off, it was a way
 * to write a 64 KiB row that no count of live rows would ever see again.
 */
const MIN_HANDOFF_TTL_MS = 30_000;

function handoffExpiry(value: string): Date {
  const expiresAt = new Date(value);
  const lifetime = expiresAt.getTime() - Date.now();
  if (lifetime <= 0) throw invalid('expires_at is already in the past');
  if (lifetime < MIN_HANDOFF_TTL_MS) throw invalid('expires_at must be at least 30 seconds away');
  if (lifetime > SECRET_HANDOFF_MAX_TTL_MS) throw invalid('expires_at exceeds the 24 hour ceiling');
  return expiresAt;
}

/**
 * The cursor is the ordering key of the last row served, nothing else: it names no hand-off the
 * caller was not already given and carries no state the gateway has to keep.
 */
function encodeCursor(row: PendingHandoffRow): string {
  return Buffer.from(`${row.cursor_at}${CURSOR_SEPARATOR}${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): PendingHandoffCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('cursor must be a single string');
  const parts = Buffer.from(value, 'base64url').toString('utf8').split(CURSOR_SEPARATOR);
  const id = CanonicalUuidV4Schema.safeParse(parts[1]);
  if (parts.length !== 2 || !id.success || !CURSOR_INSTANT.test(parts[0] ?? '')) {
    throw invalid('cursor is not one this plane issued');
  }
  return { at: parts[0] ?? '', id: id.data };
}

function handoffRef(row: HandoffRefRow): Record<string, unknown> {
  return {
    id: row.id,
    from_tenant: row.from_tenant,
    from_alias: row.from_alias,
    label: row.label,
    expires_at: row.expires_at.toISOString(),
  };
}

function handoffPayload(row: HandoffPayloadRow): Record<string, unknown> {
  return {
    ...handoffRef(row),
    to_tenant: row.to_tenant,
    to_alias: row.to_alias,
    sealing_key_id: row.sealing_key_id,
    ephemeral_public: row.ephemeral_public.toString('base64'),
    nonce: row.nonce.toString('base64'),
    sealed: row.sealed.toString('base64'),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * A colliding id must not answer with the driver's own words: `duplicate key value violates unique
 * constraint "secret_handoffs_pkey"` is an existence oracle plus free schema disclosure.
 */
function conflictOnDuplicate(error: unknown): never {
  if (driverErrorCode(error) === UNIQUE_VIOLATION) {
    throw new SecretPlaneError(409, 'conflict', 'that hand-off id is already taken');
  }
  throw error;
}

export async function registerSecretHandoffPlane(
  app: FastifyInstance, options: SecretHandoffPlaneOptions,
): Promise<void> {
  const { pool, authProvider } = options;
  const denialThrottle = createDenialThrottle();

  async function actorOf(request: FastifyRequest): Promise<Principal> {
    return principal(request, authProvider);
  }

  async function auditOn(
    database: DatabasePool | DatabaseClient,
    actor: Principal,
    action: SecretAuditAction,
    decision: SecretAuditDecision,
    facts: SecretAuditFacts,
  ): Promise<void> {
    await recordSecretAudit(database, {
      tenant_id: actor.tenant_id,
      actor_alias: actor.alias,
      action,
      decision,
      metadata: secretAuditMetadata(facts),
    });
  }

  /**
   * A refusal is written by the request that caused it, so the flood that the ceiling refuses must
   * not become a flood of audit rows. The window belongs to the authenticated SENDER and to
   * nothing the request names — a body that cycles the recipient must cost the same handful of
   * rows as one that repeats it. `denials_in_window` says how many refusals the row stands for;
   * the ladder that decides which ones are written lives in audit.ts.
   */
  async function auditDenial(
    database: DatabasePool | DatabaseClient,
    actor: Principal,
    reason: string,
    facts: SecretAuditFacts,
  ): Promise<void> {
    const sender = `${actor.tenant_id}/${actor.alias}@${actor.channel}`;
    const tally = denialThrottle(sender, reason);
    if (!tally.record) return;
    await auditOn(database, actor, 'secret.denied', 'deny', {
      ...facts, reason, denials_in_window: tally.count,
    });
  }

  /**
   * An agent publishes its OWN public half. The subject is the authenticated principal and the
   * body may not name anybody: publishing a key for another alias would let the publisher become
   * the addressee of every future hand-off aimed at that alias.
   *
   * `read` is the permission because this is the RECIPIENT half of the plane, the same authority
   * that lists and claims hand-offs: an alias that may not receive one has no business advertising
   * the key others would seal to. `route` is the sender half and does not belong here — it would
   * let an agent that can only send make itself addressable.
   *
   * Only a publication that CHANGES what the alias advertises is audited: a new `key_id`, or new
   * bytes. Moving `not_after` on the key already published is a touch, not an event, and auditing
   * it wrote 17363 permanent rows in 10 s from one row, measured. The row carries the `key_id` and
   * a fingerprint, never the bytes. Creating identities is bounded per alias for the same reason:
   * `key_id` is the caller's to choose and each new one is a durable row plus a durable audit row.
   */
  app.post('/v3/sealing-keys', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      requirePermission(actor, 'read');
      const publication = validated(
        SealingKeyPublicationSchema, objectBody(request.body), 'sealing key publication',
      );
      const notAfter = publication.not_after === undefined ? null : new Date(publication.not_after);
      if (notAfter !== null && notAfter.getTime() <= Date.now()) {
        throw invalid('not_after is already in the past');
      }
      const publicKey = requiredBytes(
        publication.public_key, SEALING_PUBLIC_KEY_BYTES, 'public_key',
      );
      const facts: SecretAuditFacts = {
        key_id: publication.key_id, key_fingerprint: shortDigest(publicKey),
      };
      const outcome = await withTransaction(pool, async (client) => {
        const decided = await publishSealingKey(client, {
          tenant_id: actor.tenant_id,
          alias: actor.alias,
          key_id: publication.key_id,
          public_key: publicKey,
          not_after: notAfter,
        });
        if (decided === 'published') {
          await auditOn(client, actor, 'secret.key_published', 'allow', facts);
        }
        return decided;
      });
      if (outcome === 'rebind_refused') {
        throw new SecretPlaneError(
          409, 'conflict', 'this key_id is already bound to different public key bytes',
        );
      }
      if (outcome === 'disabled_material') {
        throw new SecretPlaneError(
          409, 'conflict', 'this public key was disabled and cannot be published again',
        );
      }
      if (outcome === 'ceiling_refused') {
        // Outside the transaction, like the hand-off ceiling: a refusal has nothing to commit with.
        await auditDenial(pool, actor, 'sealing_key_ceiling', facts);
        throw new SecretPlaneError(
          429, 'too_many_sealing_keys',
          `this alias already published ${String(MAX_SEALING_KEYS_PER_ALIAS)} recent keys`,
        );
      }
      void reply.code(201).send({ key_id: publication.key_id, algorithm: publication.algorithm });
    } catch (error) {
      replySecretError(reply, error);
    }
  });

  /**
   * The public half a sender must seal against. Without this route the plane cannot be used at
   * all: `agent_sealing_keys.public_key` would be write-only and no sender could ever address a
   * recipient. It is gated by the same routing authority as the grant — an alias only learns the
   * key of somebody it is already allowed to hand a secret to.
   */
  app.get('/v3/sealing-keys/:tenant/:alias', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      requirePermission(actor, 'route');
      const params = request.params as Record<string, unknown>;
      const tenant = validated(TenantSchema, params.tenant, 'tenant');
      const alias = validated(AliasSchema, params.alias, 'alias');
      const authority = await routingAuthority(pool, actor.tenant_id, actor.alias, tenant, alias);
      if (!authority.allowed) {
        throw new SecretPlaneError(403, 'forbidden', 'no routing authority over that alias');
      }
      const key = await activeSealingKey(pool, tenant, alias);
      if (key === undefined) {
        throw new SecretPlaneError(404, 'not_found', 'that alias publishes no current sealing key');
      }
      void reply.code(200).send({
        tenant_id: tenant,
        alias,
        key_id: key.key_id,
        algorithm: SEALING_ALGORITHM,
        public_key: key.public_key.toString('base64'),
        not_after: key.not_after === null ? null : key.not_after.toISOString(),
      });
    } catch (error) {
      replySecretError(reply, error);
    }
  });

  /**
   * The sender seals in its own process and posts bytes this gateway cannot open.
   *
   * `id` is chosen by the SENDER because the sealing AAD binds it: the blob is cryptographically
   * tied to the hand-off it belongs to, so the id has to exist before the sealing does. It is an
   * opaque handle, not an identity claim — the identity half still comes from the principal, and a
   * colliding id is rejected by the primary key instead of overwriting anything.
   *
   * The row, the retention sweep and the `secret.granted` audit commit together: a hand-off that
   * exists without its audit row would be a claimable credential nobody knows was granted.
   */
  app.post('/v3/secrets', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      requirePermission(actor, 'route');
      const body = objectBody(request.body);
      const id = validated(CanonicalUuidV4Schema, body[HANDOFF_ID_KEY], 'id');
      const { [HANDOFF_ID_KEY]: _ignored, ...rest } = body;
      const handoff = validated(SecretHandoffRequestSchema, rest, 'hand-off request');
      const facts: SecretAuditFacts = {
        label: handoff.label,
        recipient_tenant: handoff.to_tenant,
        recipient_alias: handoff.to_alias,
        sealing_key_id: handoff.sealing_key_id,
        handoff_id_sha256: handoffDigest(id),
      };
      // The envelope is decided FIRST, in this process and against no table: a body this plane
      // would refuse anyway must not buy a routing query, and it must not buy the audit row that
      // a refusal writes. Whether the recipient exists is asked only of a request worth asking of.
      const sealed = sealedBytes(handoff.sealed);
      const expiresAt = handoffExpiry(handoff.expires_at);
      const ephemeralPublic = requiredBytes(
        handoff.ephemeral_public, SEALING_PUBLIC_KEY_BYTES, 'ephemeral_public',
      );
      const nonce = requiredBytes(handoff.nonce, SEALING_NONCE_BYTES, 'nonce');
      const authority = await routingAuthority(
        pool, actor.tenant_id, actor.alias, handoff.to_tenant, handoff.to_alias,
      );
      if (!authority.allowed) {
        await auditDenial(pool, actor, authority.reason, facts);
        throw new SecretPlaneError(403, 'forbidden', 'no routing authority over the recipient');
      }
      const key = await activeSealingKey(pool, handoff.to_tenant, handoff.to_alias);
      if (key?.key_id !== handoff.sealing_key_id) {
        throw new SecretPlaneError(
          409, 'conflict', 'the recipient has no such sealing key published as current',
        );
      }
      const inserted = await withTransaction(pool, async (client) => {
        // Swept BEFORE the ceiling counts: the recipient at the ceiling is precisely the one whose
        // settled debris is holding the slots, and a refusal that returns early never sweeps it.
        await pruneSettledHandoffs(client);
        const accepted = await insertHandoff(client, {
          id,
          from_tenant: actor.tenant_id,
          from_alias: actor.alias,
          to_tenant: handoff.to_tenant,
          to_alias: handoff.to_alias,
          label: handoff.label,
          sealed,
          sealing_key_id: handoff.sealing_key_id,
          ephemeral_public: ephemeralPublic,
          nonce,
          expires_at: expiresAt,
        }).catch(conflictOnDuplicate);
        if (!accepted) return false;
        await auditOn(client, actor, 'secret.granted', 'allow', {
          ...facts, sealed_sha256: shortDigest(sealed),
        });
        return true;
      });
      if (!inserted) {
        // Audited OUTSIDE the transaction on purpose: the refusal has nothing to commit with, and
        // a deny row rolled back with the grant it refused is a flood nobody can see afterwards.
        await auditDenial(pool, actor, 'recipient_handoff_ceiling', facts);
        throw new SecretPlaneError(
          429, 'too_many_handoffs',
          `the recipient already holds ${String(MAX_HANDOFFS_PER_RECIPIENT)} recent hand-offs`,
        );
      }
      void reply.code(201).send({
        id,
        from_tenant: actor.tenant_id,
        from_alias: actor.alias,
        label: handoff.label,
        expires_at: handoff.expires_at,
      });
    } catch (error) {
      replySecretError(reply, error);
    }
  });

  /**
   * What is waiting for the caller. Names them; carries none of them, and never more than one
   * page: the senders decide how many hand-offs exist, so the response size cannot be theirs to
   * decide either. `next_cursor` is null when the page is the last one.
   */
  app.get('/v3/secrets', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      requirePermission(actor, 'read');
      const after = decodeCursor((request.query as Record<string, unknown>).cursor);
      const page = await pendingHandoffs(pool, actor.tenant_id, actor.alias, after);
      const last = page.rows[page.rows.length - 1];
      void reply.code(200).send({
        handoffs: page.rows.map(handoffRef),
        next_cursor: page.more && last !== undefined ? encodeCursor(last) : null,
      });
    } catch (error) {
      replySecretError(reply, error);
    }
  });

  /**
   * The recipient reads once, and only through a POST. The claim destroys what it returns, so it
   * may never hang off a GET: a prefetch, a link preview, a monitoring probe, a retry or an
   * `<img src>` on an attacker page would burn the secret with no recovery and no way to tell it
   * apart from a legitimate read. As a POST both CSRF hooks of this gateway treat it as unsafe,
   * and a console-channel principal is refused outright: this hand-off is between agents, and a
   * browser session is exactly the credential a cross-site request can borrow.
   *
   * Anybody else gets 404 — a 403 would confirm the hand-off exists to somebody with no relation
   * to it. Claim and audit row commit together.
   */
  app.post('/v3/secrets/:id/claim', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      if (actor.channel === CONSOLE_CHANNEL) {
        throw new SecretPlaneError(403, 'forbidden', 'the console channel may not claim a secret');
      }
      requirePermission(actor, 'read');
      const id = handoffId(request);
      const outcome = await withTransaction(pool, async (client) => {
        const claimed = await claimHandoff(client, id, actor.tenant_id, actor.alias);
        if (claimed.payload !== undefined) {
          await auditOn(client, actor, 'secret.read', 'allow', {
            label: claimed.payload.label,
            recipient_tenant: claimed.payload.to_tenant,
            recipient_alias: claimed.payload.to_alias,
            sealing_key_id: claimed.payload.sealing_key_id,
            sealed_sha256: shortDigest(claimed.payload.sealed),
            handoff_id_sha256: handoffDigest(id),
          });
        } else if (claimed.visible) {
          await auditDenial(
            client, actor, 'read_revoked_or_expired', { handoff_id_sha256: handoffDigest(id) },
          );
        }
        return claimed;
      });
      if (!outcome.visible) {
        throw new SecretPlaneError(404, 'not_found', 'hand-off does not exist');
      }
      if (outcome.payload === undefined) {
        throw new SecretPlaneError(410, 'gone', 'hand-off was already read, revoked or expired');
      }
      void reply.code(200).send(handoffPayload(outcome.payload));
    } catch (error) {
      replySecretError(reply, error);
    }
  });

  /**
   * The sender withdraws what it gave, and only while there is something to withdraw: a hand-off
   * already read is gone, and answering 204 there would write `secret.revoked` after `secret.read`
   * and leave a trail claiming a delivered credential had been taken back.
   *
   * An operator with `control` may also withdraw, but only over an edge that touches its own
   * tenant: `control` is not a licence over other people's tenants. Everybody else needs `route`,
   * the same permission that let them create the hand-off.
   */
  app.delete('/v3/secrets/:id', async (request, reply) => {
    try {
      const actor = await actorOf(request);
      const asOperator = actor.roles.includes('operator') && actor.permissions.includes('control');
      if (!asOperator) requirePermission(actor, 'route');
      const id = handoffId(request);
      const scope: RevokeScope = asOperator
        ? { kind: 'operator', tenant: actor.tenant_id }
        : { kind: 'sender', tenant: actor.tenant_id, alias: actor.alias };
      const revoked = await withTransaction(pool, async (client) => {
        const outcome = await revokeHandoff(client, id, scope);
        if (outcome.kind === 'revoked') {
          await auditOn(client, actor, 'secret.revoked', 'allow', {
            label: outcome.row.label,
            recipient_tenant: outcome.row.to_tenant,
            recipient_alias: outcome.row.to_alias,
            sealing_key_id: outcome.row.sealing_key_id,
            sealed_sha256: outcome.row.sealed_sha256,
            handoff_id_sha256: handoffDigest(id),
          });
        }
        return outcome;
      });
      if (revoked.kind === 'already_read') {
        throw new SecretPlaneError(410, 'gone', 'hand-off was already read and cannot be revoked');
      }
      if (revoked.kind === 'absent') {
        throw new SecretPlaneError(404, 'not_found', 'hand-off does not exist');
      }
      void reply.code(204).send();
    } catch (error) {
      replySecretError(reply, error);
    }
  });
}
