import { createHash } from 'node:crypto';
import type {
  ConfigMutation, ConsolePublishIntentRateLimited, PublishMessage, Tenant
} from '@cauce/protocol';
import { SYSTEM_PRINCIPAL_ALIASES } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import {
  ConfigurationError, ConfigurationRepository, type ConfigurationChangeResult
} from '../configuration.js';
import { OutboxRepository, objectRecord } from './outbox.js';
import { StoreError } from './quotas.js';

export type AgentTargetPermission = 'read' | 'control';

/** Registro mínimo del alias que quedó autorizado por su identidad canónica. */
export interface AuthorizedAgentTarget {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly harness_id: string | null;
  readonly home_directory: string | null;
  readonly enabled: boolean;
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

export function canonicallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export const reservedInternalMessageTypes = new Set([
  'agent.message',
  'agent.response',
  'agent.fanin',
  'agent.notify'
]);

export function sha256(value: unknown): string {
  const encoded = typeof value === 'string' ? value : JSON.stringify(canonical(value)) ?? 'undefined';
  return createHash('sha256').update(encoded).digest('hex');
}

export const MAX_OPEN_CONSOLE_PUBLISH_INTENTS = 32;

// Human-console abuse bounds. Every accepted nonce appends both prepare and head state, so the
// daily ceiling is deliberately much lower than a generic API quota; exact nonce retries append
// nothing and remain exempt.
export const MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_TEN_MINUTES = 60;

export const MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_DAY = 200;

export const CONSOLE_PUBLISH_PREPARE_ACTION = 'console.publish.prepare';

export const CONSOLE_PUBLISH_CONFIRM_ACTION = 'console.publish.confirm';

export const CONSOLE_PUBLISH_EXPIRE_ACTION = 'console.publish.expire';

export const CONSOLE_PUBLISH_HEAD_ACTION = 'console.publish.head';

export type PublishRouteCommand = Pick<
  PublishMessage,
  'tenant_id' | 'room_id' | 'actor_alias' | 'recipients'
>;

export interface ConsolePublishPrepareMetadata {
  readonly version: 1;
  readonly idempotency_key: string;
  readonly semantic_hash: string;
  readonly requested_hash: string;
  readonly conversation_hash: string;
  readonly intent_nonce_hash: string;
  readonly operator_scope_hash: string;
}

export interface ConsolePublishConfirmMetadata extends ConsolePublishPrepareMetadata {
  readonly causal_hash: string;
}

export interface ConsolePublishJournalPrepare extends ConsolePublishPrepareMetadata {
  readonly stale: boolean;
  readonly prepare_audit_id: string;
}

export interface ConsolePublishIntentKeyState {
  readonly prepared: ConsolePublishJournalPrepare | undefined;
  readonly confirmed: (ConsolePublishConfirmMetadata & { readonly message_id: string }) | undefined;
  readonly expired: boolean;
}

export interface ConsolePublishHeadIntent {
  readonly idempotency_key: string;
  readonly semantic_hash: string;
  readonly requested_hash: string;
  readonly intent_nonce_hash: string;
  readonly prepare_audit_id: string;
}

export interface ConsolePublishHeadMetadata {
  readonly version: 1;
  readonly operator_scope_hash: string;
  readonly conversation_hash: string;
  readonly sequence: number;
  readonly intents: readonly ConsolePublishHeadIntent[];
}

export interface ConsolePublishHeadState extends ConsolePublishHeadMetadata {
  readonly states: readonly ConsolePublishIntentKeyState[];
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

export function hasExactKeys(metadata: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(metadata);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(metadata, key));
}

export function consolePrepareMetadata(value: unknown): ConsolePublishPrepareMetadata | undefined {
  const metadata = objectRecord(value);
  if (metadata === undefined
      || !hasExactKeys(metadata, [
        'version', 'idempotency_key', 'semantic_hash', 'conversation_hash',
        'requested_hash', 'intent_nonce_hash', 'operator_scope_hash',
      ])
      || metadata.version !== 1
      || typeof metadata.idempotency_key !== 'string'
      || metadata.idempotency_key.length < 1
      || metadata.idempotency_key.length > 200
      || !isSha256(metadata.semantic_hash)
      || !isSha256(metadata.requested_hash)
      || !isSha256(metadata.conversation_hash)
      || !isSha256(metadata.intent_nonce_hash)
      || !isSha256(metadata.operator_scope_hash)) return undefined;
  return {
    version: 1,
    idempotency_key: metadata.idempotency_key,
    semantic_hash: metadata.semantic_hash,
    requested_hash: metadata.requested_hash,
    conversation_hash: metadata.conversation_hash,
    intent_nonce_hash: metadata.intent_nonce_hash,
    operator_scope_hash: metadata.operator_scope_hash,
  };
}

export function consoleConfirmMetadata(value: unknown): ConsolePublishConfirmMetadata | undefined {
  const metadata = objectRecord(value);
  if (metadata === undefined
      || !hasExactKeys(metadata, [
        'version', 'idempotency_key', 'semantic_hash', 'conversation_hash',
        'requested_hash', 'intent_nonce_hash', 'operator_scope_hash', 'causal_hash',
      ])) return undefined;
  const { causal_hash: causalHash, ...prepareValue } = metadata;
  const prepared = consolePrepareMetadata(prepareValue);
  if (prepared === undefined || !isSha256(causalHash)) return undefined;
  return { ...prepared, causal_hash: causalHash };
}

export function positiveAuditId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value);
}

export function consoleHeadMetadata(value: unknown): ConsolePublishHeadMetadata | undefined {
  const metadata = objectRecord(value);
  if (metadata === undefined
      || !hasExactKeys(metadata, [
        'version', 'operator_scope_hash', 'conversation_hash', 'sequence', 'intents',
      ])
      || metadata.version !== 1
      || !isSha256(metadata.operator_scope_hash)
      || !isSha256(metadata.conversation_hash)
      || !Number.isSafeInteger(metadata.sequence)
      || Number(metadata.sequence) < 1
      || !Array.isArray(metadata.intents)
      || metadata.intents.length > MAX_OPEN_CONSOLE_PUBLISH_INTENTS) return undefined;
  const intents: ConsolePublishHeadIntent[] = [];
  const keys = new Set<string>();
  const nonces = new Set<string>();
  let previousAuditId = 0n;
  for (const value of metadata.intents) {
    const intent = objectRecord(value);
    if (intent === undefined
        || !hasExactKeys(intent, [
          'idempotency_key', 'semantic_hash', 'intent_nonce_hash', 'prepare_audit_id',
          'requested_hash',
        ])
        || typeof intent.idempotency_key !== 'string'
        || intent.idempotency_key.length < 1
        || intent.idempotency_key.length > 200
        || !isSha256(intent.semantic_hash)
        || !isSha256(intent.requested_hash)
        || !isSha256(intent.intent_nonce_hash)
        || !positiveAuditId(intent.prepare_audit_id)
        || keys.has(intent.idempotency_key)
        || nonces.has(intent.intent_nonce_hash)) return undefined;
    const auditId = BigInt(intent.prepare_audit_id);
    if (auditId <= previousAuditId) return undefined;
    previousAuditId = auditId;
    keys.add(intent.idempotency_key);
    nonces.add(intent.intent_nonce_hash);
    intents.push({
      idempotency_key: intent.idempotency_key,
      semantic_hash: intent.semantic_hash,
      requested_hash: intent.requested_hash,
      intent_nonce_hash: intent.intent_nonce_hash,
      prepare_audit_id: intent.prepare_audit_id,
    });
  }
  return {
    version: 1,
    operator_scope_hash: metadata.operator_scope_hash,
    conversation_hash: metadata.conversation_hash,
    sequence: Number(metadata.sequence),
    intents,
  };
}

export function consolePublishConversationHash(input: PublishRouteCommand): string {
  const recipients = [...input.recipients].sort((left, right) => (
    `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
  ));
  return sha256({
    version: 1,
    tenant_id: input.tenant_id,
    actor_alias: input.actor_alias,
    room_id: input.room_id,
    recipients,
  });
}

export function consolePublishIntentNonceHash(nonce: string): string {
  return sha256(`cauce-v3:console-publish-intent-nonce:v1\n${nonce}`);
}

export function validConsoleOperatorScope(scope: string): boolean {
  return isSha256(scope);
}

export async function lockConsolePublishIntents(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `console-publish-intents:${tenantId}:${actorAlias}`,
  ]);
}

export function sameConsoleIntentBinding(
  prepared: ConsolePublishPrepareMetadata,
  closure: ConsolePublishPrepareMetadata,
): boolean {
  return prepared.idempotency_key === closure.idempotency_key
    && prepared.semantic_hash === closure.semantic_hash
    && prepared.requested_hash === closure.requested_hash
    && prepared.conversation_hash === closure.conversation_hash
    && prepared.intent_nonce_hash === closure.intent_nonce_hash
    && prepared.operator_scope_hash === closure.operator_scope_hash;
}

export async function loadConsolePublishIntentByKey(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  idempotencyKey: string,
): Promise<ConsolePublishIntentKeyState> {
  const result = await client.query<{
    audit_id: string;
    action: string;
    decision: string;
    metadata: unknown;
    message_id: string | null;
    stale: boolean;
  }>(
    `SELECT id::text AS audit_id,action,decision,metadata,message_id,
            (created_at <= now()-interval '15 minutes') AS stale
      FROM audit_events
      WHERE tenant_id=$1 AND actor_alias=$2
        AND metadata->>'idempotency_key'=$3
        AND action IN (
          'console.publish.prepare','console.publish.confirm','console.publish.expire'
        )
      ORDER BY id
      LIMIT 4`,
    [tenantId, actorAlias, idempotencyKey],
  );
  if ((result.rowCount ?? 0) > 3) {
    throw new StoreError('conflict', 'durable console publish journal has duplicate key state');
  }
  let prepared: ConsolePublishJournalPrepare | undefined;
  let confirmed: (ConsolePublishConfirmMetadata & { readonly message_id: string }) | undefined;
  let expiration: ConsolePublishPrepareMetadata | undefined;

  for (const row of result.rows) {
    if (row.decision !== 'allow') {
      throw new StoreError('conflict', 'durable console publish journal decision is invalid');
    }
    if (row.action === CONSOLE_PUBLISH_PREPARE_ACTION) {
      const metadata = consolePrepareMetadata(row.metadata);
      if (metadata === undefined || metadata.idempotency_key !== idempotencyKey
          || row.message_id !== null || prepared !== undefined) {
        throw new StoreError('conflict', 'durable console publish prepare journal is invalid');
      }
      prepared = { ...metadata, stale: row.stale, prepare_audit_id: row.audit_id };
      continue;
    }
    if (row.action === CONSOLE_PUBLISH_CONFIRM_ACTION) {
      const metadata = consoleConfirmMetadata(row.metadata);
      if (metadata === undefined || metadata.idempotency_key !== idempotencyKey
          || row.message_id === null || confirmed !== undefined) {
        throw new StoreError('conflict', 'durable console publish confirm journal is invalid');
      }
      confirmed = { ...metadata, message_id: row.message_id };
      continue;
    }
    const metadata = consolePrepareMetadata(row.metadata);
    if (metadata === undefined || metadata.idempotency_key !== idempotencyKey
        || row.message_id !== null || expiration !== undefined) {
      throw new StoreError('conflict', 'durable console publish expiration journal is invalid');
    }
    expiration = metadata;
  }
  if ((confirmed !== undefined || expiration !== undefined)
      && (prepared === undefined
        || (confirmed !== undefined && !sameConsoleIntentBinding(prepared, confirmed))
        || (expiration !== undefined && !sameConsoleIntentBinding(prepared, expiration))
        || (confirmed !== undefined && expiration !== undefined))) {
    throw new StoreError('conflict', 'durable console publish journal closure is inconsistent');
  }
  return { prepared, confirmed, expired: expiration !== undefined };
}

export async function loadConsolePublishIntentByNonce(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  operatorScopeHash: string,
  intentNonceHash: string,
): Promise<ConsolePublishIntentKeyState | undefined> {
  const result = await client.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_events
      WHERE tenant_id=$1 AND actor_alias=$2
        AND action='console.publish.prepare'
        AND metadata->>'operator_scope_hash'=$3
        AND metadata->>'intent_nonce_hash'=$4
      ORDER BY id DESC
      LIMIT 2`,
    [
      tenantId,
      actorAlias,
      operatorScopeHash,
      intentNonceHash,
    ],
  );
  if ((result.rowCount ?? 0) > 1) {
    throw new StoreError('conflict', 'console publish intent nonce has duplicate durable state');
  }
  if (result.rowCount === 0) return undefined;
  const metadata = consolePrepareMetadata(result.rows[0]?.metadata);
  if (metadata === undefined
      || metadata.operator_scope_hash !== operatorScopeHash
      || metadata.intent_nonce_hash !== intentNonceHash) {
    throw new StoreError('conflict', 'console publish intent nonce state is invalid');
  }
  const state = await loadConsolePublishIntentByKey(
    client, tenantId, actorAlias, metadata.idempotency_key,
  );
  if (state.prepared === undefined || !sameConsoleIntentBinding(metadata, state.prepared)) {
    throw new StoreError('conflict', 'console publish intent nonce state is inconsistent');
  }
  return state;
}

export async function loadConsolePublishHead(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  operatorScopeHash: string,
  conversationHash: string,
): Promise<ConsolePublishHeadState> {
  const result = await client.query<{
    audit_id: string;
    decision: string;
    message_id: string | null;
    metadata: unknown;
  }>(
    `SELECT id::text AS audit_id,decision,message_id,metadata
       FROM audit_events
      WHERE tenant_id=$1 AND actor_alias=$2
        AND action='console.publish.head'
        AND metadata->>'operator_scope_hash'=$3
        AND metadata->>'conversation_hash'=$4
      ORDER BY id DESC
      LIMIT 2`,
    [tenantId, actorAlias, operatorScopeHash, conversationHash],
  );
  if (result.rowCount === 0) {
    return {
      version: 1,
      operator_scope_hash: operatorScopeHash,
      conversation_hash: conversationHash,
      sequence: 0,
      intents: [],
      states: [],
    };
  }
  const parsed = result.rows.map((row) => {
    const metadata = consoleHeadMetadata(row.metadata);
    if (row.decision !== 'allow' || row.message_id !== null || metadata === undefined
        || metadata.operator_scope_hash !== operatorScopeHash
        || metadata.conversation_hash !== conversationHash) {
      throw new StoreError('conflict', 'durable console publish head is invalid');
    }
    return metadata;
  });
  const latest = parsed[0];
  if (latest === undefined) {
    throw new StoreError('conflict', 'durable console publish head is unavailable');
  }
  const previous = parsed[1];
  if ((previous === undefined && latest.sequence !== 1)
      || (previous !== undefined && latest.sequence !== previous.sequence + 1)) {
    throw new StoreError('conflict', 'durable console publish head sequence is invalid');
  }
  const states: ConsolePublishIntentKeyState[] = [];
  for (const intent of latest.intents) {
    const state = await loadConsolePublishIntentByKey(
      client, tenantId, actorAlias, intent.idempotency_key,
    );
    const prepared = state.prepared;
    if (prepared === undefined
        || prepared.operator_scope_hash !== operatorScopeHash
        || prepared.conversation_hash !== conversationHash
        || prepared.semantic_hash !== intent.semantic_hash
        || prepared.requested_hash !== intent.requested_hash
        || prepared.intent_nonce_hash !== intent.intent_nonce_hash
        || prepared.prepare_audit_id !== intent.prepare_audit_id
        || state.confirmed !== undefined || state.expired) {
      throw new StoreError('conflict', 'durable console publish head binding is inconsistent');
    }
    states.push(state);
  }
  return { ...latest, states };
}

export async function appendConsolePublishHead(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  current: ConsolePublishHeadState,
  intents: readonly ConsolePublishHeadIntent[],
): Promise<void> {
  if (current.sequence >= Number.MAX_SAFE_INTEGER) {
    throw new StoreError('conflict', 'durable console publish head sequence is exhausted');
  }
  const metadata: ConsolePublishHeadMetadata = {
    version: 1,
    operator_scope_hash: current.operator_scope_hash,
    conversation_hash: current.conversation_hash,
    sequence: current.sequence + 1,
    intents,
  };
  if (consoleHeadMetadata(metadata) === undefined) {
    throw new StoreError('conflict', 'durable console publish head transition is invalid');
  }
  await client.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     VALUES($1,$2,$3,'allow',$4::jsonb)`,
    [tenantId, actorAlias, CONSOLE_PUBLISH_HEAD_ACTION, JSON.stringify(metadata)],
  );
}

export async function assertConsolePublishIntentWriteRate(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  operatorScopeHash: string,
): Promise<void> {
  const result = await client.query<{ retry_after_seconds: number }>(
    `WITH recent AS MATERIALIZED (
       SELECT created_at
         FROM audit_events
        WHERE tenant_id=$1 AND actor_alias=$2
          AND action='console.publish.prepare'
          AND metadata->>'operator_scope_hash'=$3
          AND created_at>now()-interval '24 hours'
        ORDER BY created_at DESC,id DESC
        LIMIT $5
     ), boundaries AS (
       SELECT (
                SELECT created_at FROM recent
                 WHERE created_at>now()-interval '10 minutes'
                 OFFSET $4 LIMIT 1
              ) AS short_boundary,
              (
                SELECT created_at FROM recent OFFSET ($5-1) LIMIT 1
              ) AS daily_boundary
     )
     SELECT GREATEST(
              1,
              LEAST(
                86400,
                ceil(extract(epoch FROM (
                  GREATEST(
                    short_boundary+interval '10 minutes',
                    daily_boundary+interval '24 hours'
                  )-now()
                )))::integer
              )
            ) AS retry_after_seconds
       FROM boundaries
      WHERE short_boundary IS NOT NULL OR daily_boundary IS NOT NULL`,
    [
      tenantId,
      actorAlias,
      operatorScopeHash,
      MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_TEN_MINUTES - 1,
      MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_DAY,
    ],
  );
  const retryAfterSeconds = result.rows[0]?.retry_after_seconds;
  if (retryAfterSeconds !== undefined) {
    throw new PublishIntentRateLimitedError(retryAfterSeconds);
  }
}

export async function expireStaleConsolePublishIntent(
  client: DatabaseClient,
  tenantId: Tenant,
  actorAlias: string,
  state: ConsolePublishIntentKeyState,
  forceUneffected = false,
): Promise<ConsolePublishIntentKeyState> {
  const prepared = state.prepared;
  if (prepared === undefined || (!prepared.stale && !forceUneffected)
      || state.confirmed !== undefined || state.expired) {
    return state;
  }
  const durable = await client.query(
    `SELECT 1 FROM idempotency_keys
      WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR SHARE`,
    [tenantId, actorAlias, prepared.idempotency_key],
  );
  if (durable.rowCount !== 0) return state;
  const head = await loadConsolePublishHead(
    client,
    tenantId,
    actorAlias,
    prepared.operator_scope_hash,
    prepared.conversation_hash,
  );
  const headIndex = head.intents.findIndex(
    (intent) => intent.idempotency_key === prepared.idempotency_key,
  );
  if (headIndex < 0) {
    throw new StoreError('conflict', 'console publish expiration is absent from its durable head');
  }
  const metadata: ConsolePublishPrepareMetadata = {
    version: 1,
    idempotency_key: prepared.idempotency_key,
    semantic_hash: prepared.semantic_hash,
    requested_hash: prepared.requested_hash,
    conversation_hash: prepared.conversation_hash,
    intent_nonce_hash: prepared.intent_nonce_hash,
    operator_scope_hash: prepared.operator_scope_hash,
  };
  await client.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     VALUES($1,$2,$3,'allow',$4::jsonb)`,
    [tenantId, actorAlias, CONSOLE_PUBLISH_EXPIRE_ACTION, JSON.stringify(metadata)],
  );
  await appendConsolePublishHead(
    client,
    tenantId,
    actorAlias,
    head,
    head.intents.filter((_, index) => index !== headIndex),
  );
  return { ...state, expired: true };
}

export async function assertPublishRoute(
  client: DatabaseClient,
  input: PublishRouteCommand,
): Promise<void> {
  const actor = await client.query(
    `SELECT 1 FROM memberships m JOIN role_policies p ON p.role=m.role
     JOIN tenants t ON t.id=m.tenant_id JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
     WHERE m.tenant_id=$1 AND m.room_id=$2 AND m.alias=$3 AND m.enabled
       AND t.enabled AND r.enabled AND p.allow_route`,
    [input.tenant_id, input.room_id, input.actor_alias],
  );
  if (actor.rowCount !== 1) {
    throw new StoreError('invalid_actor', 'actor lacks route permission in the source room');
  }

  for (const recipient of input.recipients) {
    const member = await client.query(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
       JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND t.enabled AND r.enabled
         AND NOT (m.alias=ANY($3::text[])) LIMIT 1`,
      [recipient.tenant_id, recipient.alias, SYSTEM_PRINCIPAL_ALIASES],
    );
    if (member.rowCount !== 1) {
      throw new StoreError('no_route', `recipient ${recipient.alias} is not routable`);
    }
    if (recipient.tenant_id !== input.tenant_id) {
      const edge = await client.query(
        `SELECT 1 FROM acl_edges edge
         JOIN tenants source ON source.id=edge.from_tenant
         JOIN tenants target ON target.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
           AND edge.enabled AND edge.allow_route AND (source.is_hub OR target.is_hub)`,
        [input.tenant_id, recipient.tenant_id],
      );
      if (edge.rowCount !== 1) {
        throw new StoreError('forbidden', 'cross-tenant route denied by default');
      }
    }
  }
}

export class PublishIntentRateLimitedError extends StoreError {
  readonly rateLimit: ConsolePublishIntentRateLimited;

  constructor(retryAfterSeconds: number) {
    super('rate_limited', 'console publish intent creation is rate limited');
    this.name = 'PublishIntentRateLimitedError';
    this.rateLimit = {
      version: 1,
      error: 'publish_intent_rate_limited',
      retry_after_seconds: retryAfterSeconds,
      safe_to_retry: true,
    };
  }
}

export abstract class ConfigRepository extends OutboxRepository {
protected async assertRuntimeRoute(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
    const memberships = await client.query<{ allow_route: boolean }>(
      `SELECT policy.allow_route FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       FOR SHARE OF membership,policy,tenant,room`,
      [tenantId, alias]
    );
    if (memberships.rowCount === 0) {
      throw new StoreError('invalid_actor', 'consumer alias is not an enabled member');
    }
    if (!memberships.rows.some((membership) => membership.allow_route)) {
      throw new StoreError('forbidden', 'consumer route permission has been revoked');
    }
  }

async assertPrincipal(tenantId: Tenant, alias: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
       JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND t.enabled AND r.enabled LIMIT 1`,
      [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
  }

override async assertPermission(
    tenantId: Tenant, alias: string, permission: 'route' | 'read' | 'control' | 'notify'
  ): Promise<void> {
    const column = permission === 'route'
      ? 'allow_route'
      : permission === 'read'
        ? 'allow_read'
        : permission === 'control' ? 'allow_control' : 'allow_notify';
    const result = await this.pool.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.${column} LIMIT 1`, [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('forbidden', `principal lacks ${permission} permission`);
  }

/**
   * Autoriza un actor contra UN destino canónico `(tenant, alias)` y devuelve esa misma fila.
   *
   * No acepta sólo `alias`: el mismo nombre puede existir en varios tenants y elegir el primero
   * por orden convierte una URL en una fuga entre clientes. Primero se exige el permiso efectivo
   * del actor; después, para otro tenant, la arista ACL del MISMO permiso. Cualquier ausencia deja
   * el resultado en `undefined`, igual para «no existe» y «no lo puedes ver».
   */
  async authorizeAgentTarget(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: AgentTargetPermission
  ): Promise<AuthorizedAgentTarget | undefined> {
    const permissionColumn = permission === 'read' ? 'allow_read' : 'allow_control';
    const result = await this.pool.query<AuthorizedAgentTarget>(
      `SELECT agent.tenant_id,agent.alias,agent.harness_id,agent.home_directory,agent.enabled
         FROM agents agent
         JOIN tenants target_tenant ON target_tenant.id=agent.tenant_id
        WHERE agent.tenant_id=$3 AND agent.alias=$4 AND target_tenant.enabled
          AND ($5::text='read' OR agent.enabled)
          AND EXISTS (
            SELECT 1
              FROM memberships actor_membership
              JOIN role_policies actor_role ON actor_role.role=actor_membership.role
              JOIN tenants actor_tenant ON actor_tenant.id=actor_membership.tenant_id
              JOIN rooms actor_room
                ON actor_room.id=actor_membership.room_id
               AND actor_room.tenant_id=actor_membership.tenant_id
             WHERE actor_membership.tenant_id=$1 AND actor_membership.alias=$2
               AND actor_membership.enabled AND actor_role.${permissionColumn}
               AND actor_tenant.enabled AND actor_room.enabled
          )
          AND (
            $1=$3
            OR EXISTS (
              SELECT 1
                FROM acl_edges edge
                JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
               WHERE edge.from_tenant=$1 AND edge.to_tenant=$3
                 AND edge.enabled AND edge.${permissionColumn}
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
        LIMIT 1`,
      [actorTenant, actorAlias, targetTenant, targetAlias, permission]
    );
    return result.rows[0];
  }

async principalAccess(tenantId: Tenant, alias: string): Promise<{
    roles: string[]; permissions: Array<'route' | 'read' | 'control' | 'notify'>;
  }> {
    const result = await this.pool.query<{
      roles: string[]; allow_route: boolean; allow_read: boolean; allow_control: boolean;
      allow_notify: boolean;
    }>(
      `SELECT array_agg(DISTINCT membership.role ORDER BY membership.role) AS roles,
              bool_or(role.allow_route) AS allow_route,bool_or(role.allow_read) AS allow_read,
              bool_or(role.allow_control) AS allow_control,bool_or(role.allow_notify) AS allow_notify
       FROM memberships membership JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled`, [tenantId, alias]
    );
    const row = result.rows[0];
    if (!row?.roles?.length) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
    return {
      roles: row.roles,
      permissions: [
        ...(row.allow_route ? ['route' as const] : []),
        ...(row.allow_read ? ['read' as const] : []),
        ...(row.allow_control ? ['control' as const] : []),
        ...(row.allow_notify ? ['notify' as const] : [])
      ]
    };
  }

async getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    try {
      return await new ConfigurationRepository(this.pool).get(actorTenant, actorAlias);
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

async applyConfigurationChange(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).apply(
        actorTenant, actorAlias, mutation, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

async rollbackConfiguration(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).rollback(
        actorTenant, actorAlias, revisionId, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

private rethrowConfigurationError(error: unknown): never {
    if (error instanceof ConfigurationError) {
      throw new StoreError(error.code, error.message);
    }
    throw error;
  }

async topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const [tenants, edges] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT t.id,COALESCE(t.display_name,t.id) AS label,t.is_hub,t.enabled,COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
              'id',r.id,'label',COALESCE(r.display_name,r.id),'enabled',r.enabled,'members',COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'alias',m.alias,
                  'role',m.role,
                  'enabled',m.enabled,
                  'registered',(agent.tenant_id IS NOT NULL),
                  'agent_enabled',agent.enabled,
                  'harness_id',agent.harness_id,
                  'display_name',agent.display_name,
                  'off_reason',CASE
                    WHEN agent.tenant_id IS NULL THEN 'not_registered'
                    WHEN NOT agent.enabled AND NOT m.enabled THEN 'agent_and_membership_disabled'
                    WHEN NOT agent.enabled THEN 'agent_disabled'
                    WHEN NOT m.enabled THEN 'membership_disabled'
                    ELSE NULL END
                ) ORDER BY m.alias)
               FROM memberships m
               LEFT JOIN agents agent
                 ON agent.tenant_id=m.tenant_id AND agent.alias=m.alias
               WHERE m.tenant_id=t.id AND m.room_id=r.id
             ),'[]'::jsonb)
           ) ORDER BY r.id) FROM rooms r WHERE r.tenant_id=t.id
         ),'[]'::jsonb) AS rooms
          FROM tenants t WHERE t.id=$1 OR EXISTS (
            SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=t.id
              AND a.enabled AND a.allow_read
          ) ORDER BY t.id`, [actorTenant]
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,
                'explicit'::text AS policy FROM acl_edges
         WHERE (from_tenant=$1 OR to_tenant=$1) AND allow_read
         ORDER BY from_tenant,to_tenant`, [actorTenant]
      )
    ]);
    return { observed_at: new Date().toISOString(), tenants: tenants.rows, acl_edges: edges.rows };
  }
}
