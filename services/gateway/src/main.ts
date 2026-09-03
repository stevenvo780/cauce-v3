import { readFile } from 'node:fs/promises';
import { createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from './app.js';
import {
  configuredAckDeadlineMs, configuredDeliveryAdmission, configuredDeliveryLeaseCap,
} from './config.js';
import {
  DevOnlyAuthProvider, HashedMtlsIdentityFileProvider, HashedTokenFileAuthProvider,
  JwksJwtAuthProvider, MtlsAuthProvider, type AuthProvider
} from './auth.js';
import { buildLoopbackHealthProbe, probeAckPath } from './health.js';
import { OidcBffAuthProvider, PostgresOidcSessionStore } from './oidc-bff.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { PasswordAuthProvider } from './password-auth.js';
import { loadTerminalConfig, terminalCapabilityAnnouncement } from './terminal/config.js';
import { registerSecretHandoffPlane } from './secret-handoff/routes.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { WakePumpTelemetry } from './wake-pump-telemetry.js';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
assertPostgresTls(databaseUrl);
const ackDeadlineMs = configuredAckDeadlineMs();
const deliveryLeaseCap = configuredDeliveryLeaseCap();
const admission = configuredDeliveryAdmission();

function assertPostgresTls(connectionString: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  const mode = new URL(connectionString).searchParams.get('sslmode') ?? process.env.PGSSLMODE;
  if (mode !== 'verify-full') {
    throw new Error('production PostgreSQL requires sslmode=verify-full');
  }
}

async function readSessionKey(path: string): Promise<Buffer> {
  const value = await readFile(path);
  if (value.byteLength === 32) return value;
  const encoded = value.toString('utf8').trim();
  const decoded = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== 32) throw new Error('CAUCE_OIDC_SESSION_KEY_FILE must contain exactly 32 key bytes');
  return decoded;
}

async function optionalTextFile(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error('configured OIDC client secret file is empty');
  return value;
}

/**
 * Reads the console JWT signing key (accepts raw bytes, hex, or base64).
 */
async function readSigningKey(path: string): Promise<Buffer> {
  const raw = await readFile(path);
  const text = raw.toString('utf8').trim();
  if (/^[a-f0-9]{64,}$/i.test(text)) {
    const hex = Buffer.from(text, 'hex');
    if (hex.byteLength >= 32) return hex;
  }
  if (/^[A-Za-z0-9+/=_-]{44,}$/.test(text)) {
    const base64 = Buffer.from(text, 'base64');
    if (base64.byteLength >= 32) return base64;
  }
  if (raw.byteLength >= 32) return raw;
  throw new Error('CAUCE_CONSOLE_JWT_KEY_FILE debe contener al menos 32 bytes de clave');
}

/**
 * Configures the fallback auth provider for requests without a session cookie.
 */
async function configuredPasswordFallback(): Promise<AuthProvider | undefined> {
  const selected = process.env.CAUCE_CONSOLE_PASSWORD_FALLBACK ?? 'mtls';
  if (selected === 'none') return undefined;
  if (selected === 'mtls') {
    const path = process.env.CAUCE_MTLS_IDENTITY_FILE;
    if (!path) throw new Error('CAUCE_MTLS_IDENTITY_FILE is required for mTLS auth');
    return new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(path));
  }
  if (selected === 'token-file') {
    const path = process.env.CAUCE_TOKEN_HASH_FILE;
    if (!path) throw new Error('CAUCE_TOKEN_HASH_FILE is required for token-file auth');
    return new HashedTokenFileAuthProvider({ path });
  }
  throw new Error('CAUCE_CONSOLE_PASSWORD_FALLBACK must be mtls, token-file or none');
}

async function configuredAuthProvider(pool: DatabasePool): Promise<AuthProvider> {
  const selected = process.env.CAUCE_AUTH_PROVIDER;
  const issuer = process.env.CAUCE_OIDC_ISSUER;
  const audience = process.env.CAUCE_OIDC_AUDIENCE;
  const jwksUrl = process.env.CAUCE_OIDC_JWKS_URL;
  if (selected === 'password') {
    const keyPath = process.env.CAUCE_CONSOLE_JWT_KEY_FILE;
    if (!keyPath) throw new Error('CAUCE_CONSOLE_JWT_KEY_FILE is required for password auth');
    const ttlSeconds = Number(process.env.CAUCE_CONSOLE_SESSION_TTL_SECONDS ?? 8 * 60 * 60);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
      throw new Error('CAUCE_CONSOLE_SESSION_TTL_SECONDS must be between 60 and 86400');
    }
    const fallback = await configuredPasswordFallback();
    const provider = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(pool),
      signingKey: await readSigningKey(keyPath),
      sessionTtlMs: ttlSeconds * 1_000,
      ...(fallback === undefined ? {} : { fallback })
    });
    // Fail boot if migration 023 did not run: a console that shows the login and returns 500
    // on the first attempt is worse than one that refuses to start.
    await provider.ready();
    return provider;
  }
  if (selected === 'token-file') {
    const path = process.env.CAUCE_TOKEN_HASH_FILE;
    if (!path) throw new Error('CAUCE_TOKEN_HASH_FILE is required for token-file auth');
    return new HashedTokenFileAuthProvider({ path });
  }
  if (selected === 'mtls') {
    const path = process.env.CAUCE_MTLS_IDENTITY_FILE;
    if (!path) throw new Error('CAUCE_MTLS_IDENTITY_FILE is required for mTLS auth');
    return new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(path));
  }
  if (selected === 'oidc' || (!selected && issuer && audience && jwksUrl)) {
    if (!issuer || !audience || !jwksUrl) throw new Error('complete OIDC configuration is required');
    const authorizationEndpoint = process.env.CAUCE_OIDC_AUTHORIZATION_URL;
    const tokenEndpoint = process.env.CAUCE_OIDC_TOKEN_URL;
    const clientId = process.env.CAUCE_OIDC_CLIENT_ID;
    const redirectUri = process.env.CAUCE_OIDC_REDIRECT_URI;
    const sessionKeyPath = process.env.CAUCE_OIDC_SESSION_KEY_FILE;
    if (!authorizationEndpoint || !tokenEndpoint || !clientId || !redirectUri || !sessionKeyPath) {
      throw new Error('OIDC BFF requires authorization/token URLs, client ID, redirect URI and session key file');
    }
    const store = new PostgresOidcSessionStore(
      pool,
      await readSessionKey(sessionKeyPath),
      process.env.CAUCE_OIDC_SESSION_TABLE ?? 'gateway_oidc_sessions'
    );
    const clientSecret = await optionalTextFile(process.env.CAUCE_OIDC_CLIENT_SECRET_FILE);
    const bearerProvider = new JwksJwtAuthProvider({ issuer, audience, jwksUrl });
    const provider = new OidcBffAuthProvider({
      issuer,
      jwksUrl,
      bearerProvider,
      authorizationEndpoint,
      tokenEndpoint,
      clientId,
      redirectUri,
      sessionStore: store,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(process.env.CAUCE_OIDC_POST_LOGIN_PATH === undefined ? {} : {
        postLoginPath: process.env.CAUCE_OIDC_POST_LOGIN_PATH
      })
    });
    await provider.ready();
    return provider;
  }
  if (process.env.CAUCE_DEV_AUTH === '1' && process.env.NODE_ENV !== 'production') {
    return new DevOnlyAuthProvider({
      enabled: true,
      environment: process.env.NODE_ENV === 'test' ? 'test' : 'development'
    });
  }
  throw new Error('No production AuthProvider configured; refusing to start');
}

async function configuredHttps(authProvider: AuthProvider): Promise<{
  key: Buffer; cert: Buffer; ca?: Buffer; requestCert?: boolean; rejectUnauthorized?: boolean;
} | undefined> {
  const certPath = process.env.CAUCE_TLS_CERT_FILE;
  const keyPath = process.env.CAUCE_TLS_KEY_FILE;
  if (!certPath || !keyPath) {
    if (process.env.NODE_ENV === 'production') throw new Error('production gateway TLS cert/key paths are required');
    return undefined;
  }
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  if (!usesMtls(authProvider)) return { cert, key };
  const caPath = process.env.CAUCE_TLS_CLIENT_CA_FILE;
  if (!caPath) throw new Error('CAUCE_TLS_CLIENT_CA_FILE is required for mTLS auth');
  return { cert, key, ca: await readFile(caPath), requestCert: true, rejectUnauthorized: true };
}

/**
 * mTLS can be direct OR behind the password login (which only handles requests with a cookie
 * and delegates the rest). The listener needs `requestCert` in both cases: if only the type
 * above were checked, turning the human login on would silently switch off the client
 * certificate and agents would be locked out. That is exactly the "do not break mTLS" rule.
 */
function usesMtls(provider: AuthProvider): boolean {
  if (provider instanceof MtlsAuthProvider) return true;
  return provider instanceof PasswordAuthProvider && provider.fallback instanceof MtlsAuthProvider;
}

function configuredConsoleOrigins(): string[] | undefined {
  const value = process.env.CAUCE_CONSOLE_ORIGINS;
  if (!value) return undefined;
  const origins = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  return origins.length === 0 ? undefined : origins;
}

const pool = createPool(databaseUrl);
const consoleOrigins = configuredConsoleOrigins();
const authProvider = await configuredAuthProvider(pool);
const mtls = usesMtls(authProvider);
const isolatedHealth = mtls || process.env.NODE_ENV === 'production';
const https = await configuredHttps(authProvider);
// --- PTY control plane (module M1-gateway-control-plane) -------------------------------
// Undefined unless CAUCE_TERMINAL_ENABLED=1; in that case the gateway boots exactly as today.
const terminal = await loadTerminalConfig();
const wakePumpTelemetry = new WakePumpTelemetry();
const consolePublishTelemetry = new ConsolePublishTelemetry();
const app = await buildGateway({
  pool,
  authProvider,
  logger: true,
  ackDeadlineMs,
  deliveryLeaseCap,
  admission,
  wakePumpTelemetry,
  consolePublishTelemetry,
  requireAckClaims: process.env.CAUCE_REQUIRE_ACK_CLAIMS !== '0',
  exposeHealthRoutes: !isolatedHealth,
  ...(consoleOrigins === undefined ? {} : { consoleOrigins }),
  // Announcing the capability is what makes /v3/console/access emit `ultimate-terminal.connect`
  // and /v3/console/terminal/capability stop answering 501.
  ...(terminal === undefined ? {} : {
    terminalCapability: terminalCapabilityAnnouncement(terminal),
    operatorResolution: { operatorHeader: terminal.operatorHeader, operators: terminal.operators },
  }),
  ...(https === undefined ? {} : { https })
});
// The routes live in a plugin registered after buildGateway so they inherit the console
// security hook, the Origin allowlist and the websocket support app.ts already installed.
if (terminal !== undefined) {
  await app.register(registerTerminalControlPlane, { pool, authProvider, config: terminal });
}
// --- end PTY control plane -------------------------------------------------------------
await app.register(registerSecretHandoffPlane, { pool, authProvider });
const health = isolatedHealth ? await buildLoopbackHealthProbe({
  pool,
  dataApp: app,
  ackProbe: async () => probeAckPath(pool),
  logger: true,
  requirePostgresTls: process.env.NODE_ENV === 'production',
  wakePumpTelemetry,
  consolePublishTelemetry,
}) : undefined;
const port = Number(process.env.PORT ?? 8080);
const healthPort = Number(process.env.CAUCE_HEALTH_PORT ?? 8081);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
if (isolatedHealth && (!Number.isSafeInteger(healthPort) || healthPort < 1 || healthPort > 65_535 || healthPort === port)) {
  throw new Error('CAUCE_HEALTH_PORT is invalid or conflicts with PORT');
}
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  if (health) await health.close();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  // 8081 is not published on the host. Binding the identity-free health/metrics listener to the
  // container networks lets Prometheus observe a live-but-stalled pump instead of trusting Docker
  // process health. The data API remains the only host-published gateway listener.
  if (health) await health.listen({ host: '0.0.0.0', port: healthPort });
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  if (health) await health.close();
  await app.close();
  await pool.end();
  throw error;
}
