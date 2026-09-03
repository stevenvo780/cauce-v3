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
 * Sealed credential hand-off plane: agent-to-agent, outside /v3/console/. Identity is always the
 * authenticated principal, never a body field; no field ever carries a clear value; a stranger gets
 * 404, never 403; every mutation commits with its own audit row or with neither. Full rationale:
 * ./README.md
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
 * Allowlist, not denylist: only errors this plane raises on purpose (plus auth ones) reach the
 * client; anything else collapses to one opaque 500. Full rationale: ./README.md
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
 * TTL floor: below it a hand-off could never plausibly be polled and claimed. Full rationale:
 * ./README.md
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

/** The cursor is the ordering key of the last row served, nothing else. Full rationale: ./README.md */
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

/** A colliding id must not answer with the driver's own words. Full rationale: ./README.md */
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
   * The window belongs to the authenticated SENDER, never a request-chosen field. Full rationale:
   * ./README.md
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
   * An agent publishes its OWN public half; the body may not name anybody else. `read` gates it,
   * not `route`: this is the RECIPIENT half of the plane. Only a publication that CHANGES what the
   * alias advertises is audited. Full rationale: ./README.md
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
   * The public half a sender must seal against, gated by the same routing authority as the grant.
   * Full rationale: ./README.md
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
   * The sender seals in its own process and posts bytes this gateway cannot open. `id` is chosen by
   * the SENDER because the sealing AAD binds it. Full rationale: ./README.md
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
      // Envelope decided FIRST, against no table: a refused body must not buy a routing query.
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
        // Swept BEFORE the ceiling counts. Full rationale: ./README.md
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
        // Audited OUTSIDE the transaction on purpose: the refusal has nothing to commit with.
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
   * What is waiting for the caller: names each one, carries none. `next_cursor` is null on the
   * last page. Full rationale: ./README.md
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
   * The recipient reads once, only through a POST: the claim destroys what it returns, so it must
   * never hang off a GET. A console-channel principal is refused outright. Full rationale:
   * ./README.md
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
   * The sender withdraws what it gave, only while there is something to withdraw: an already-read
   * hand-off cannot be revoked. An operator's `control` is confined to its own tenant. Full
   * rationale: ./README.md
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
