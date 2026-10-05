import { randomBytes, randomUUID } from 'node:crypto';
import { lockHumanIdentity, lockConsoleHuman, withAbortableTransaction, StoreError, type ConsoleCredentialStampVerifier,
  type DatabasePool, type DatabaseClient, type HumanIdentitySnapshot } from '@cauce/store';
import { isAnyUuid } from '@cauce/protocol';
import { currentOAuthScopes, lockOAuthAccess, lockOAuthGrant, requireOAuthExpiry, type OAuthGrantRow } from './oauth-grant-authority.js';
import { oauthContextSignal } from './oauth-request-context.js';
import { constantTimeText } from './http-auth-primitives.js';
import type { OAuthClientMetadata } from './oauth-client-metadata.js';
import { clientRegistration, isRegisteredClientId, REGISTERED_CLIENT_PREFIX, UNNAMED_REGISTERED_CLIENT,
  type OAuthClientRegistration, type OAuthRegisteredClient } from './oauth-client-registration.js';
import { OAuthError, oauthOrigin, secretHash, scopes, type OAuthAccessIdentity, type OAuthAuthorizationRequest,
  type OAuthCodeExchange, type OAuthIssuedToken, type OAuthPasswordSession, type OAuthRefreshExchange, type OAuthScope,
  type OAuthStore, type OAuthTokenGrant, type OAuthTokenInput, type OAuthRequestContext } from './oauth-authorization-types.js';

interface RequestRow {
  id_hash: string; browser_hash: string; client_id: string; client_name: string;
  redirect_uri: string; resource: string; scopes: OAuthScope[]; challenge: string; state: string | null;
}

function asRequest(row: RequestRow): OAuthAuthorizationRequest {
  return Object.freeze({ idHash: row.id_hash, browserHash: row.browser_hash, clientId: row.client_id,
    clientName: row.client_name, redirectUri: row.redirect_uri, resource: row.resource,
    scopes: Object.freeze([...row.scopes]), challenge: row.challenge, state: row.state });
}

async function readRequest(client: Pick<DatabaseClient, 'query'>, id: string, browser: string, lock = false) {
  const row = (await client.query<RequestRow>(
    `SELECT id_hash, browser_hash, client_id, client_name, redirect_uri, resource, scopes, challenge, state
     FROM cauce_oauth_requests WHERE id_hash=$1 AND browser_hash=$2
       AND consumed_at IS NULL AND expires_at>clock_timestamp()${lock ? ' FOR UPDATE' : ''}`,
    [id, browser],
  )).rows[0];
  return row === undefined ? undefined : asRequest(row);
}

async function lockSession(client: DatabaseClient, session: OAuthPasswordSession,
  verifyCredentialStamp: ConsoleCredentialStampVerifier): Promise<void> {
  try {
    await lockConsoleHuman(client, session.userId, { credentialStamp: session.credentialStamp, verifyCredentialStamp });
    await requireOAuthExpiry(client, new Date(session.expiresAt * 1000));
  } catch { throw new OAuthError('access_denied'); }
}

// El vínculo local se da de alta al consentir: sujeto = id canónico de console_users, nunca un dato del
// cliente. Un vínculo revocado no se reabre aquí; la fila nueva cae con el ROLLBACK si algo falla después.
async function lockLocalBinding(client: DatabaseClient, issuer: string, userId: string): Promise<HumanIdentitySnapshot> {
  if (!isAnyUuid(userId)) throw new OAuthError('access_denied');
  await client.query(
    `INSERT INTO human_external_identities (human_id,provider,namespace,subject)
     SELECT id,'oauth',$2,id::text FROM console_users WHERE id=$1 AND active
     ON CONFLICT (provider,namespace,subject) DO NOTHING`, [userId, issuer],
  );
  try { return await lockHumanIdentity(client, { provider: 'oauth', namespace: issuer, subject: userId }, userId); }
  catch (error) { if (error instanceof StoreError) throw new OAuthError('access_denied'); throw error; }
}

// Purga oportunista y acotada de filas vencidas, que el trigger ya permite borrar; los grants no se tocan.
const PURGE_EXPIRED = Object.freeze({
  requests: `DELETE FROM cauce_oauth_requests WHERE id_hash IN (SELECT id_hash FROM cauce_oauth_requests
    WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
  codes: `DELETE FROM cauce_oauth_codes WHERE code_hash IN (SELECT code_hash FROM cauce_oauth_codes
    WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
  tokens: `DELETE FROM cauce_oauth_tokens WHERE id IN (SELECT id FROM cauce_oauth_tokens
    WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
  refresh: `DELETE FROM cauce_oauth_refresh_tokens WHERE token_hash IN (SELECT token_hash FROM cauce_oauth_refresh_tokens
    WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
});

function signedAccess(grant: OAuthGrantRow, issuer: string, resource: string,
  issue: (input: OAuthTokenInput) => OAuthIssuedToken): OAuthIssuedToken {
  const issued = issue({ grantId: grant.id, userId: grant.human_id, scopes: grant.scopes,
    expiresAt: grant.expires_at.getTime() / 1000 });
  if (issued.identity.grantId !== grant.id || issued.identity.subject !== grant.human_id
      || issued.identity.issuer !== issuer || issued.identity.audience !== resource
      || !isAnyUuid(issued.identity.tokenId) || !Number.isSafeInteger(issued.identity.expiresAt)
      || issued.identity.expiresAt * 1000 > grant.expires_at.getTime()) throw new OAuthError('invalid_grant');
  return issued;
}

async function recordAccess(client: DatabaseClient, grant: OAuthGrantRow, issued: OAuthIssuedToken): Promise<OAuthTokenGrant> {
  await client.query(
    'INSERT INTO cauce_oauth_tokens (id,grant_id,expires_at) VALUES ($1,$2,$3)',
    [issued.identity.tokenId, grant.id, new Date(issued.identity.expiresAt * 1000)],
  );
  // El refresh token vive lo mismo que el grant y sólo se guarda su hash; rota en cada uso.
  const refreshToken = randomBytes(32).toString('base64url');
  const stored = await client.query(
    `INSERT INTO cauce_oauth_refresh_tokens (token_hash,grant_id,expires_at)
     SELECT $1,$2,$3 WHERE $3::timestamptz>clock_timestamp()`, [secretHash(refreshToken), grant.id, grant.expires_at],
  );
  if (stored.rowCount !== 1) throw new OAuthError('invalid_grant');
  await client.query(PURGE_EXPIRED.tokens);
  await client.query(PURGE_EXPIRED.refresh);
  await requireOAuthExpiry(client, new Date(Math.min(grant.expires_at.getTime(), issued.identity.expiresAt * 1000)));
  return Object.freeze({ ...issued, refreshToken });
}

// INSERT y no UPDATE: sólo toma FOR KEY SHARE del grant, así que no espera al FOR SHARE de las llamadas MCP en vuelo.
async function revokeGrant(client: DatabaseClient, grantId: string): Promise<void> {
  await client.query('INSERT INTO cauce_oauth_grant_revocations (grant_id) VALUES ($1) ON CONFLICT (grant_id) DO NOTHING', [grantId]);
}

// Un refresh recién rotado que vuelve dentro de esta ventana es el SDK MCP refrescando en paralelo o reintentando
// una respuesta perdida: se rechaza sin revocar. Pasada la ventana, la reutilización revoca el grant entero.
const REFRESH_REUSE_GRACE = "interval '60 seconds'";

/** Vida del grant desde el consentimiento; el refresh nunca la alarga. */
export const OAUTH_GRANT_TTL_SECONDS = Object.freeze({ default: 28_800, min: 300, max: 2_592_000 });

export class PostgresOAuthStore implements OAuthStore {
  readonly issuer: string;
  readonly resource: string;
  private readonly grantTtlSeconds: number;

  constructor(private readonly pool: DatabasePool, issuer: string, private readonly verifyCredentialStamp: ConsoleCredentialStampVerifier,
    options: { grantTtlSeconds?: number } = {}) {
    this.issuer = oauthOrigin(issuer);
    this.resource = `${this.issuer}/mcp`;
    this.grantTtlSeconds = options.grantTtlSeconds ?? OAUTH_GRANT_TTL_SECONDS.default;
    if (!Number.isSafeInteger(this.grantTtlSeconds) || this.grantTtlSeconds < OAUTH_GRANT_TTL_SECONDS.min
        || this.grantTtlSeconds > OAUTH_GRANT_TTL_SECONDS.max) throw new Error('OAuth grant lifetime is invalid');
  }

  async ready(): Promise<void> {
    await this.pool.query(`SELECT r.id_hash,r.browser_hash,r.scopes,r.challenge,r.expires_at,r.consumed_at,
      g.id,g.human_id,g.issuer,g.resource,g.binding_id,g.binding_revision,g.membership_revision,
      g.tenant_id,g.actor_alias,g.credential_stamp,v.grant_id,v.revoked_at,c.code_hash,c.grant_id,c.challenge,
      c.expires_at,c.consumed_at,t.id,t.grant_id,t.expires_at,t.revoked_at,k.id,k.client_id,k.metadata,k.created_at,
      f.token_hash,f.grant_id,f.expires_at,f.consumed_at
      FROM cauce_oauth_requests r,cauce_oauth_grants g,cauce_oauth_grant_revocations v,cauce_oauth_codes c,
        cauce_oauth_tokens t,cauce_oauth_clients k,cauce_oauth_refresh_tokens f LIMIT 0`);
  }

  private async transaction<T>(context: OAuthRequestContext, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const signal = oauthContextSignal(context);
    return withAbortableTransaction(this.pool, signal, async (client) => {
      await client.query("SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='3000ms'");
      signal.throwIfAborted();
      const result = await operation(client);
      signal.throwIfAborted();
      if (Date.now() >= context.deadlineMs) throw new DOMException('OAuth request expired', 'AbortError');
      return result;
    });
  }

  async createRequest(request: OAuthAuthorizationRequest, context: OAuthRequestContext): Promise<void> {
    if (request.resource !== this.resource) throw new OAuthError('invalid_request');
    await this.transaction(context, async (client) => { await client.query(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO cauce_oauth_requests
       (id_hash, browser_hash, client_id, client_name, redirect_uri, resource, scopes, challenge, state, created_at, expires_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,at,at+interval '5 minutes' FROM instant`,
      [request.idHash, request.browserHash, request.clientId, request.clientName, request.redirectUri,
        request.resource, [...request.scopes], request.challenge, request.state],
    ); await client.query(PURGE_EXPIRED.requests); });
  }

  async request(idHash: string, browserHash: string, context: OAuthRequestContext): Promise<OAuthAuthorizationRequest | undefined> {
    return this.transaction(context, client => readRequest(client, idHash, browserHash));
  }

  async consent(idHash: string, browserHash: string, session: OAuthPasswordSession, selected: readonly OAuthScope[] | undefined, context: OAuthRequestContext) {
    return this.transaction({ ...context, deadlineMs: Math.min(context.deadlineMs, session.expiresAt * 1000) }, async (client) => {
      const snapshot = selected === undefined ? undefined : await lockLocalBinding(client, this.issuer, session.userId);
      await lockSession(client, session, this.verifyCredentialStamp);
      const request = await readRequest(client, idHash, browserHash, true);
      if (request?.resource !== this.resource) throw new OAuthError('invalid_request');
      const granted = selected === undefined ? undefined : scopes(selected.join(' '));
      if (granted !== undefined) {
        if (!snapshot || granted.some((scope) => !request.scopes.includes(scope)
            || !currentOAuthScopes(snapshot).includes(scope))) throw new OAuthError('invalid_scope');
      }
      const consumed = await client.query(
        `UPDATE cauce_oauth_requests SET consumed_at=clock_timestamp() WHERE id_hash=$1 AND browser_hash=$2
         AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id_hash`, [idHash, browserHash],
      );
      if (consumed.rowCount !== 1) throw new OAuthError('invalid_request');
      if (granted === undefined || !snapshot) return { request };
      const grantId = randomUUID();
      const code = randomBytes(32).toString('base64url');
      // Plazo fijo desde el consentimiento, no lo que le quede a la cookie de consola: la autoridad se
      // revalida en cada uso (sello de credencial, cuenta, vínculo y membresía). En segundos enteros, como el
      // exp del JWT, para que el refresh token copie la expiración exacta al volver de JavaScript.
      await client.query(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO cauce_oauth_grants
         (id,human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,
          membership_revision,tenant_id,actor_alias,credential_stamp,created_at,expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,at,
           date_trunc('second',at)+make_interval(secs=>$14) FROM instant`,
        [grantId, session.userId, this.issuer, this.resource, request.clientId, request.redirectUri, [...granted],
          snapshot.bindingId, snapshot.bindingRevision, snapshot.membership.revision,
          snapshot.membership.tenantId, snapshot.membership.actorAlias, session.credentialStamp, this.grantTtlSeconds],
      );
      await client.query(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO cauce_oauth_codes (code_hash,grant_id,challenge,created_at,expires_at)
         SELECT $1,$2,$3,at,at+interval '60 seconds' FROM instant`, [secretHash(code), grantId, request.challenge],
      );
      await client.query(PURGE_EXPIRED.codes);
      await requireOAuthExpiry(client, new Date(session.expiresAt * 1000));
      return { code, request };
    });
  }

  // Un code ya canjeado que vuelve a aparecer revoca el grant y todo lo emitido con él (OAuth 2.1 §4.1.3);
  // la revocación se confirma antes de responder invalid_grant, igual que la reutilización de un refresh.
  async exchange(input: OAuthCodeExchange, issue: (input: OAuthTokenInput) => OAuthIssuedToken, context: OAuthRequestContext): Promise<OAuthTokenGrant> {
    const result = await this.transaction(context, async (client): Promise<OAuthTokenGrant | undefined> => {
      const lookup = (await client.query<{ grant_id: string; human_id: string; consumed: boolean }>(
        `SELECT c.grant_id,g.human_id,c.consumed_at IS NOT NULL AS consumed
         FROM cauce_oauth_codes c JOIN cauce_oauth_grants g ON g.id=c.grant_id
         WHERE c.code_hash=$1 AND (c.consumed_at IS NOT NULL OR c.expires_at>clock_timestamp())`, [input.codeHash],
      )).rows[0];
      if (!lookup || input.resource !== this.resource) throw new OAuthError('invalid_grant');
      if (lookup.consumed) { await revokeGrant(client, lookup.grant_id); return undefined; }
      const grant = await lockOAuthGrant(client, lookup.grant_id, this.issuer, this.resource, lookup.human_id, this.verifyCredentialStamp);
      const code = (await client.query<{ challenge: string; consumed: boolean }>(
        `SELECT challenge,consumed_at IS NOT NULL AS consumed FROM cauce_oauth_codes WHERE code_hash=$1 AND grant_id=$2
         AND (consumed_at IS NOT NULL OR expires_at>clock_timestamp()) FOR UPDATE`, [input.codeHash, grant.id],
      )).rows[0];
      if (code?.consumed) { await revokeGrant(client, grant.id); return undefined; }
      if (!code || !constantTimeText(code.challenge, input.challenge)
          || grant.client_id !== input.clientId || grant.redirect_uri !== input.redirectUri) {
        throw new OAuthError('invalid_grant');
      }
      const issued = signedAccess(grant, this.issuer, this.resource, issue);
      const consumed = await client.query(
        `UPDATE cauce_oauth_codes SET consumed_at=clock_timestamp() WHERE code_hash=$1
         AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING code_hash`, [input.codeHash],
      );
      if (consumed.rowCount !== 1) throw new OAuthError('invalid_grant');
      return recordAccess(client, grant, issued);
    });
    if (!result) throw new OAuthError('invalid_grant');
    return result;
  }

  // Un refresh ya rotado que vuelve a aparecer pasada la gracia revoca el grant entero (OAuth 2.1 §4.3.1) y la
  // revocación se confirma antes de responder invalid_grant; todo lo demás pasa por los mismos bloqueos que el código.
  async refresh(input: OAuthRefreshExchange, issue: (input: OAuthTokenInput) => OAuthIssuedToken, context: OAuthRequestContext): Promise<OAuthTokenGrant> {
    const result = await this.transaction(context, async (client): Promise<OAuthTokenGrant | undefined> => {
      const lookup = (await client.query<{ grant_id: string; human_id: string; client_id: string; consumed: boolean; recent: boolean }>(
        `SELECT r.grant_id,g.human_id,g.client_id,r.consumed_at IS NOT NULL AS consumed,
           COALESCE(r.consumed_at>clock_timestamp()-${REFRESH_REUSE_GRACE},false) AS recent
         FROM cauce_oauth_refresh_tokens r JOIN cauce_oauth_grants g ON g.id=r.grant_id
         WHERE r.token_hash=$1 AND g.issuer=$2 AND g.resource=$3`, [input.tokenHash, this.issuer, this.resource],
      )).rows[0];
      if (!lookup || input.resource !== this.resource || lookup.client_id !== input.clientId) throw new OAuthError('invalid_grant');
      if (lookup.consumed) {
        if (lookup.recent) throw new OAuthError('invalid_grant');
        await revokeGrant(client, lookup.grant_id); return undefined;
      }
      const grant = await lockOAuthGrant(client, lookup.grant_id, this.issuer, this.resource, lookup.human_id, this.verifyCredentialStamp);
      const token = (await client.query<{ consumed: boolean; recent: boolean; live: boolean }>(
        `SELECT consumed_at IS NOT NULL AS consumed,COALESCE(consumed_at>clock_timestamp()-${REFRESH_REUSE_GRACE},false) AS recent,
           expires_at>clock_timestamp() AS live
         FROM cauce_oauth_refresh_tokens WHERE token_hash=$1 AND grant_id=$2 FOR UPDATE`, [input.tokenHash, grant.id],
      )).rows[0];
      // Quien esperaba este FOR UPDATE tras el COMMIT del ganador es el refresh concurrente: dentro de la gracia.
      if (token?.consumed) {
        if (token.recent) throw new OAuthError('invalid_grant');
        await revokeGrant(client, grant.id); return undefined;
      }
      if (!token?.live) throw new OAuthError('invalid_grant');
      if (input.scopes !== undefined && (input.scopes.length !== grant.scopes.length
          || input.scopes.some((scope) => !grant.scopes.includes(scope)))) throw new OAuthError('invalid_scope');
      const issued = signedAccess(grant, this.issuer, this.resource, issue);
      const consumed = await client.query(
        `UPDATE cauce_oauth_refresh_tokens SET consumed_at=clock_timestamp() WHERE token_hash=$1
         AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash`, [input.tokenHash],
      );
      if (consumed.rowCount !== 1) throw new OAuthError('invalid_grant');
      return recordAccess(client, grant, issued);
    });
    if (!result) throw new OAuthError('invalid_grant');
    return result;
  }

  async validate(identity: OAuthAccessIdentity): Promise<boolean> {
    try {
      await this.transaction({ signal: AbortSignal.timeout(3000),
        deadlineMs: Math.min(Date.now() + 3000, identity.expiresAt * 1000) }, async (client) => { await lockOAuthAccess(client, identity, this.issuer, this.resource, this.verifyCredentialStamp); });
      return true;
    } catch { return false; }
  }

  async revoke(grantId: string, session: OAuthPasswordSession, context: OAuthRequestContext): Promise<void> {
    if (!isAnyUuid(grantId)) throw new OAuthError('invalid_request');
    await this.transaction({ ...context, deadlineMs: Math.min(context.deadlineMs, session.expiresAt * 1000) }, async (client) => {
      await lockSession(client, session, this.verifyCredentialStamp);
      await client.query(
        `INSERT INTO cauce_oauth_grant_revocations (grant_id)
         SELECT id FROM cauce_oauth_grants WHERE id=$1 AND human_id=$2 AND issuer=$3 AND resource=$4
         ON CONFLICT (grant_id) DO NOTHING`,
        [grantId, session.userId, this.issuer, this.resource],
      );
    });
  }

  // Purga oportunista: sólo con más de 1000 registros y sólo clientes de más de un día que nunca
  // obtuvieron un grant; el tope duro acota el crecimiento si el limitador por dirección no basta.
  async registerClient(registration: OAuthClientRegistration, context: OAuthRequestContext): Promise<OAuthRegisteredClient> {
    const clientId = `${REGISTERED_CLIENT_PREFIX}${randomUUID()}`;
    return this.transaction(context, async (client) => {
      let total = Number((await client.query<{ total: string }>('SELECT count(*)::text AS total FROM cauce_oauth_clients')).rows[0]?.total);
      if (total >= 1000) {
        total -= (await client.query(`DELETE FROM cauce_oauth_clients WHERE id IN (SELECT k.id FROM cauce_oauth_clients k
          WHERE k.created_at<clock_timestamp()-interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM cauce_oauth_grants g WHERE g.client_id=k.client_id)
          ORDER BY k.created_at LIMIT 100 FOR UPDATE SKIP LOCKED)`)).rowCount ?? 0;
      }
      if (!Number.isSafeInteger(total) || total >= 10_000) throw new OAuthError('temporarily_unavailable');
      const metadata = { ...(registration.clientName === null ? {} : { client_name: registration.clientName }),
        redirect_uris: registration.redirectUris, grant_types: registration.grantTypes,
        response_types: ['code'], token_endpoint_auth_method: 'none' };
      const created = (await client.query<{ issued_at: string }>(
        `INSERT INTO cauce_oauth_clients (id,client_id,metadata) VALUES ($1,$2,$3::jsonb)
         RETURNING floor(extract(epoch FROM created_at))::text AS issued_at`, [randomUUID(), clientId, JSON.stringify(metadata)],
      )).rows[0];
      return Object.freeze({ ...registration, clientId, issuedAt: Number(created?.issued_at) });
    });
  }

  async registeredClient(clientId: string, context: OAuthRequestContext): Promise<OAuthClientMetadata | undefined> {
    if (!isRegisteredClientId(clientId)) return undefined;
    const row = await this.transaction(context, async client => (await client.query<{ metadata: unknown }>(
      'SELECT metadata FROM cauce_oauth_clients WHERE client_id=$1', [clientId])).rows[0]);
    if (!row) return undefined;
    const registration = clientRegistration(row.metadata);
    return Object.freeze({ clientId, clientName: registration.clientName ?? UNNAMED_REGISTERED_CLIENT,
      redirectUris: registration.redirectUris });
  }

  async grants(session: OAuthPasswordSession, context: OAuthRequestContext) {
    return this.transaction({ ...context, deadlineMs: Math.min(context.deadlineMs, session.expiresAt * 1000) }, async (client) => {
      await lockSession(client, session, this.verifyCredentialStamp);
      const result = await client.query<{ id: string; client_id: string; scopes: OAuthScope[]; expires_at: Date; revoked: boolean }>(
        `SELECT g.id,g.client_id,g.scopes,g.expires_at,
           EXISTS (SELECT 1 FROM cauce_oauth_grant_revocations v WHERE v.grant_id=g.id) AS revoked
         FROM cauce_oauth_grants g
         WHERE g.human_id=$1 AND g.issuer=$2 AND g.resource=$3 ORDER BY g.created_at DESC,g.id DESC LIMIT 100`,
        [session.userId, this.issuer, this.resource],
      );
      return result.rows.map((row) => ({ id: row.id, clientId: row.client_id, scopes: row.scopes,
        expiresAt: row.expires_at.toISOString(), revoked: row.revoked }));
    });
  }
}
