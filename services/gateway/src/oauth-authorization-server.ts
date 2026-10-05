import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PasswordAuthProvider } from './password-auth.js';
import { constantTimeText, hostSessionCookie, uniqueCookieValue } from './http-auth-primitives.js';
import { createOAuthRequestContext, oauthSessionContext } from './oauth-request-context.js';
import type { OAuthClientMetadata, OAuthClients } from './oauth-client-metadata.js';
import { clientRegistration, isRegisteredClientId, OAuthRegistrationLimiter, registrationDocument } from './oauth-client-registration.js';
import { OAuthError, OAUTH_SCOPES, loopbackRedirect, redirectMatches, scopes, secretHash, type OAuthAuthorizationRequest,
  type OAuthPasswordSession, type OAuthScope, type OAuthStore, type OAuthTokenGrant } from './oauth-authorization-types.js';
import type { OAuthTokens } from './oauth-tokens.js';

const FLOW_COOKIE = '__Host-cauce_oauth';
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
// Sólo endpoints públicos sin cookie: nunca authorize, continue, login, consent ni grants.
const PUBLIC_CORS = ['/.well-known/oauth-authorization-server', '/oauth/jwks', '/oauth/token', '/oauth/register'];

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_request');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new OAuthError('invalid_request');
  return record;
}

function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /\p{C}/u.test(value)) {
    throw new OAuthError('invalid_request');
  }
  return value;
}

function form(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of new URLSearchParams(value)) {
    if (Object.hasOwn(result, key)) throw new OAuthError('invalid_request');
    result[key] = entry;
  }
  return result;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

// Lo que el humano debe mirar es dónde acaba el código y qué host respalda al cliente; el nombre es del cliente.
function clientFacts(flow: Pick<OAuthAuthorizationRequest, 'clientId' | 'clientName' | 'redirectUri'>): string {
  const redirect = new URL(flow.redirectUri);
  const destination = loopbackRedirect(redirect) ? `${redirect.host} (este equipo)` : redirect.origin;
  let identity = flow.clientId;
  if (isRegisteredClientId(flow.clientId)) identity = `registro dinámico ${flow.clientId}`;
  else { try { identity = new URL(flow.clientId).host; } catch { /* se muestra el identificador tal cual */ } }
  return `<p><strong>Cliente no verificado:</strong> Cauce no ha comprobado quién lo publica.</p><dl><dt>El acceso se entregará en</dt><dd><strong><code>${escape(destination)}</code></strong></dd><dt>Identidad del cliente</dt><dd><strong><code>${escape(identity)}</code></strong></dd><dt>Nombre declarado por el cliente (no verificado)</dt><dd>${escape(flow.clientName)}</dd></dl>`;
}

function page(reply: FastifyReply, body: string, script = '') {
  const nonce = randomBytes(24).toString('base64url');
  reply.header('Content-Security-Policy', `default-src 'none'; style-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar Cauce</title></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`);
}

function sameOrigin(request: FastifyRequest, issuer: string, continuation = false): void {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site' || (origin !== undefined && origin !== issuer)
      || (!continuation && origin !== issuer)
      || (continuation && origin !== issuer && site !== 'same-origin')) throw new OAuthError('access_denied');
}

function requestHashes(request: FastifyRequest, id: unknown) {
  const nonce = text(id, 43);
  const cookie = uniqueCookieValue(request.headers.cookie, FLOW_COOKIE);
  if (!NONCE.test(nonce) || !cookie || !NONCE.test(cookie)) throw new OAuthError('invalid_request');
  return { id: nonce, idHash: secretHash(nonce), browserHash: secretHash(cookie) };
}

function redirectResult(request: OAuthAuthorizationRequest, issuer: string, code?: string): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set(code === undefined ? 'error' : 'code', code ?? 'access_denied');
  if (request.state !== null) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', issuer);
  return url.href;
}

function tokenResponse(reply: FastifyReply, issued: OAuthTokenGrant) {
  return reply.send({ access_token: issued.token, token_type: 'Bearer', refresh_token: issued.refreshToken,
    expires_in: Math.max(0, issued.identity.expiresAt - Math.floor(Date.now() / 1000)), scope: issued.identity.scopes.join(' ') });
}

export interface OAuthAuthorizationServerOptions {
  readonly clients: OAuthClients;
  readonly tokens: OAuthTokens;
  readonly store: OAuthStore;
  readonly session: (request: FastifyRequest) => Promise<OAuthPasswordSession>;
  readonly passwordAuth: Pick<PasswordAuthProvider, 'login' | 'verifyCredentialStamp'>;
  readonly registrationLimiter?: OAuthRegistrationLimiter;
}

export async function registerOAuthAuthorizationServer(app: FastifyInstance, options: OAuthAuthorizationServerOptions): Promise<void> {
  await app.register(async (app) => {
    const { clients, tokens, store, session } = options;
    const limiter = options.registrationLimiter ?? new OAuthRegistrationLimiter();
    const lifetimes = new WeakMap<FastifyRequest, ReturnType<typeof createOAuthRequestContext>>();
    function context(request: FastifyRequest, authenticated?: OAuthPasswordSession) {
      const lifetime = lifetimes.get(request);
      if (!lifetime) throw new OAuthError('access_denied');
      return authenticated ? oauthSessionContext(lifetime.context, authenticated) : lifetime.context;
    }
    async function client(request: FastifyRequest, clientId: string): Promise<OAuthClientMetadata> {
      if (!isRegisteredClientId(clientId)) return clients.resolve(clientId);
      const registered = await store.registeredClient(clientId, context(request));
      if (!registered) throw new OAuthError('invalid_client');
      return registered;
    }
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_request, body, done) => {
      try { done(null, form(String(body))); } catch { done(new OAuthError('invalid_request')); }
    });
    app.addHook('onRequest', async (request, reply) => {
      lifetimes.set(request, createOAuthRequestContext(request, reply));
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY');
      if (request.routeOptions.url !== undefined && PUBLIC_CORS.includes(request.routeOptions.url)) {
        reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          .header('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version').header('Access-Control-Max-Age', '600');
      }
    });
    app.addHook('onResponse', async request => { lifetimes.get(request)?.close(); });
    app.setErrorHandler(async (error, _request, reply) => {
      const code = error instanceof OAuthError ? error.error : 'server_error';
      const unavailable = code === 'server_error' || code === 'temporarily_unavailable';
      await reply.code(code === 'invalid_client' ? 401 : code === 'access_denied' ? 403
        : unavailable ? (reply.getHeader('retry-after') === undefined ? 503 : 429) : 400)
        .send({ error: code, iss: tokens.issuer });
    });

    app.get('/.well-known/oauth-authorization-server', async () => ({
      issuer: tokens.issuer, authorization_endpoint: `${tokens.issuer}/oauth/authorize`,
      token_endpoint: `${tokens.issuer}/oauth/token`, jwks_uri: `${tokens.issuer}/oauth/jwks`,
      registration_endpoint: `${tokens.issuer}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: [...OAUTH_SCOPES], client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }));
    app.get('/oauth/jwks', async () => tokens.jwks());
    for (const path of PUBLIC_CORS) app.options(path, async (_request, reply) => reply.code(204).send());

    app.post('/oauth/register', { bodyLimit: 8192 }, async (request, reply) => {
      if (request.headers.authorization !== undefined
          || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        throw new OAuthError('invalid_client_metadata');
      }
      if (!limiter.take(request.ip)) {
        reply.header('Retry-After', String(limiter.retryAfterSeconds));
        throw new OAuthError('temporarily_unavailable');
      }
      const registered = await store.registerClient(clientRegistration(request.body), context(request));
      return reply.code(201).send(registrationDocument(registered));
    });

    app.get('/oauth/authorize', async (request, reply) => {
      const query = fields(form((request.raw.url ?? '').split('?')[1] ?? ''), [
        'response_type', 'client_id', 'redirect_uri', 'resource', 'scope', 'state', 'code_challenge', 'code_challenge_method',
      ]);
      if (query.response_type !== 'code' || query.code_challenge_method !== 'S256'
          || query.resource !== tokens.resource || !NONCE.test(text(query.code_challenge, 43))) {
        throw new OAuthError('invalid_request');
      }
      const resolved = await client(request, text(query.client_id));
      const redirectUri = text(query.redirect_uri);
      if (!redirectMatches(resolved.redirectUris, redirectUri)) throw new OAuthError('invalid_request');
      const id = randomBytes(32).toString('base64url');
      const browser = randomBytes(32).toString('base64url');
      await store.createRequest({ idHash: secretHash(id), browserHash: secretHash(browser),
        clientId: resolved.clientId, clientName: resolved.clientName, redirectUri, resource: tokens.resource,
        scopes: scopes(query.scope), challenge: text(query.code_challenge),
        state: query.state === undefined ? null : text(query.state, 512) }, context(request));
      reply.header('Set-Cookie', hostSessionCookie(FLOW_COOKIE, browser, 300, 'Strict'));
      return page(reply, `<h1>Conectar un cliente MCP con Cauce</h1>${clientFacts({ ...resolved, redirectUri })}<a href="/oauth/continue?request_id=${id}">Continuar en Cauce</a>`);
    });

    async function pending(request: FastifyRequest, id: unknown) {
      const hashes = requestHashes(request, id);
      const flow = await store.request(hashes.idHash, hashes.browserHash, context(request));
      if (flow?.resource !== tokens.resource) throw new OAuthError('invalid_request');
      return { ...hashes, flow };
    }

    app.get('/oauth/continue', async (request, reply) => {
      sameOrigin(request, tokens.issuer, true);
      const query = fields(request.query, ['request_id']);
      const flow = await pending(request, query.request_id);
      let authenticated: OAuthPasswordSession;
      try { authenticated = await session(request); } catch (error) {
        if (!(error instanceof OAuthError) || error.error !== 'access_denied') throw error;
        return page(reply, `<h1>Iniciar sesión en Cauce</h1><form id="login"><label>Correo <input name="email" type="email" autocomplete="username" required></label><label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label><input name="request_id" type="hidden" value="${flow.id}"><button>Iniciar sesión</button></form><p id="result" role="status"></p>`,
          `document.getElementById('login').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);const r=await fetch('/oauth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});if(r.ok){location.assign('/oauth/continue?request_id='+encodeURIComponent(f.get('request_id')))}else{document.getElementById('result').textContent='No se pudo iniciar sesión. Comprueba tus datos y vuelve a intentarlo.'}});`);
      }
      const choices = flow.flow.scopes.map((scope) => `<label><input type="checkbox" name="${scope === 'cauce.read' ? 'read' : 'publish'}" value="yes">${scope === 'cauce.read' ? 'Leer tus mensajes y respuestas' : 'Publicar mensajes como tú'}</label>`).join('');
      return page(reply, `<h1>Permisos para un cliente MCP no verificado</h1>${clientFacts(flow.flow)}<p>Estos permisos siguen sujetos a tu cuenta, membresía y ACL de Cauce.</p><form id="consent" method="post" action="/oauth/consent"><input type="hidden" name="request_id" value="${flow.id}"><input type="hidden" name="csrf" value="${escape(authenticated.csrf)}">${choices}<button name="decision" value="approve">Autorizar los permisos seleccionados</button><button name="decision" value="deny">Cancelar</button></form><p id="result" role="status"></p><a href="/oauth/grants">Ver y revocar autorizaciones</a>`,
        `document.getElementById('consent').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);if(e.submitter){f.set('decision',e.submitter.value)}try{const r=await fetch('/oauth/consent',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f)});if(!r.ok){throw new Error()}const result=await r.json();location.assign(result.redirect_uri)}catch{document.getElementById('result').textContent='No se pudo completar la autorización. Vuelve a iniciarla desde el cliente.'}});`);
    });

    app.post('/oauth/login', { bodyLimit: 8192 }, async (request, reply) => {
      sameOrigin(request, tokens.issuer);
      const body = fields(request.body, ['email', 'password', 'request_id']);
      await pending(request, body.request_id);
      await options.passwordAuth.login(request, reply);
    });

    async function csrfSession(request: FastifyRequest, value: unknown) {
      sameOrigin(request, tokens.issuer);
      const authenticated = await session(request);
      if (typeof value !== 'string' || !constantTimeText(value, authenticated.csrf)) throw new OAuthError('access_denied');
      return authenticated;
    }

    app.post('/oauth/consent', { bodyLimit: 8192 }, async (request, reply) => {
      const body = fields(request.body, ['request_id', 'csrf', 'decision', 'read', 'publish']);
      const authenticated = await csrfSession(request, body.csrf);
      const flow = await pending(request, body.request_id);
      if (!['approve', 'deny'].includes(text(body.decision))
          || (body.read !== undefined && body.read !== 'yes') || (body.publish !== undefined && body.publish !== 'yes')) {
        throw new OAuthError('invalid_request');
      }
      const selected: OAuthScope[] = [];
      if (body.read === 'yes') selected.push('cauce.read');
      if (body.publish === 'yes') selected.push('cauce.publish');
      const result = await store.consent(flow.idHash, flow.browserHash, authenticated,
        body.decision === 'deny' ? undefined : selected, context(request, authenticated));
      return reply.send({ redirect_uri: redirectResult(result.request, tokens.issuer, result.code) });
    });

    app.post('/oauth/token', { bodyLimit: 8192 }, async (request, reply) => {
      if (request.headers.authorization !== undefined
          || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
        throw new OAuthError('invalid_client');
      }
      const body = fields(request.body, ['grant_type', 'code', 'client_id', 'redirect_uri', 'resource', 'code_verifier', 'refresh_token', 'scope']);
      if (body.grant_type === 'refresh_token') {
        if (body.code !== undefined || body.code_verifier !== undefined || body.redirect_uri !== undefined) throw new OAuthError('invalid_request');
        if (body.resource !== undefined && body.resource !== tokens.resource) throw new OAuthError('invalid_target');
        const refresh = text(body.refresh_token, 43);
        if (!NONCE.test(refresh)) throw new OAuthError('invalid_grant');
        const refreshed = await store.refresh({ tokenHash: secretHash(refresh), clientId: text(body.client_id), resource: tokens.resource,
          scopes: body.scope === undefined ? undefined : scopes(body.scope) }, (input) => tokens.issue(input), context(request));
        return tokenResponse(reply, refreshed);
      }
      if (body.grant_type !== 'authorization_code') throw new OAuthError('unsupported_grant_type');
      if (body.refresh_token !== undefined || body.scope !== undefined) throw new OAuthError('invalid_request');
      const verifier = text(body.code_verifier, 128);
      if (body.resource !== tokens.resource || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || !NONCE.test(text(body.code, 43))) {
        throw new OAuthError('invalid_grant');
      }
      const resolved = await client(request, text(body.client_id));
      const redirectUri = text(body.redirect_uri);
      if (!redirectMatches(resolved.redirectUris, redirectUri)) throw new OAuthError('invalid_grant');
      const issued = await store.exchange({ codeHash: secretHash(text(body.code)), clientId: resolved.clientId,
        redirectUri, resource: tokens.resource, challenge: createHash('sha256').update(verifier).digest('base64url') },
      (input) => tokens.issue(input), context(request));
      return tokenResponse(reply, issued);
    });

    app.get('/oauth/grants', async (request, reply) => {
      sameOrigin(request, tokens.issuer, true);
      const authenticated = await session(request);
      const grants = await store.grants(authenticated, context(request, authenticated));
      const items = grants.map((grant) => `<li><p>${escape(grant.clientId)} — ${escape(grant.scopes.join(', '))} — ${escape(grant.expiresAt)}${grant.revoked ? ' — revocada' : ''}</p><form method="post" action="/oauth/grants/${escape(grant.id)}/revoke"><input type="hidden" name="csrf" value="${escape(authenticated.csrf)}"><button>Revocar autorización</button></form></li>`).join('');
      return page(reply, `<h1>Tus autorizaciones de Cauce</h1><ul>${items}</ul>`);
    });
    app.post('/oauth/grants/:id/revoke', { bodyLimit: 8192 }, async (request, reply) => {
      const body = fields(request.body, ['csrf']);
      const authenticated = await csrfSession(request, body.csrf);
      const params = fields(request.params, ['id']);
      await store.revoke(text(params.id, 36), authenticated, context(request, authenticated));
      return reply.code(303).header('Location', '/oauth/grants').send();
    });
  });
}
