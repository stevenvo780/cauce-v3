import { readFile } from 'node:fs/promises';
import { createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from './app.js';
import { configuredAckDeadlineMs, configuredDeliveryAdmission } from './config.js';
import {
  DevOnlyAuthProvider, HashedMtlsIdentityFileProvider, HashedTokenFileAuthProvider,
  MtlsAuthProvider, type AuthProvider
} from './auth.js';
import { buildLoopbackHealthProbe } from './health.js';
import { OidcBffAuthProvider, PostgresOidcSessionStore } from './oidc-bff.js';
import { loadTerminalConfig, terminalCapabilityAnnouncement } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
assertPostgresTls(databaseUrl);
const ackDeadlineMs = configuredAckDeadlineMs();
// Se lee al arrancar a propósito: una configuración de admisión inválida tiene que impedir el
// boot, no descubrirse recién cuando un agente se conecta y no recibe nada.
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

async function configuredAuthProvider(pool: DatabasePool): Promise<AuthProvider> {
  const selected = process.env.CAUCE_AUTH_PROVIDER;
  const issuer = process.env.CAUCE_OIDC_ISSUER;
  const audience = process.env.CAUCE_OIDC_AUDIENCE;
  const jwksUrl = process.env.CAUCE_OIDC_JWKS_URL;
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
    const provider = new OidcBffAuthProvider({
      issuer,
      audience,
      jwksUrl,
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
  if (!(authProvider instanceof MtlsAuthProvider)) return { cert, key };
  const caPath = process.env.CAUCE_TLS_CLIENT_CA_FILE;
  if (!caPath) throw new Error('CAUCE_TLS_CLIENT_CA_FILE is required for mTLS auth');
  return { cert, key, ca: await readFile(caPath), requestCert: true, rejectUnauthorized: true };
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
const mtls = authProvider instanceof MtlsAuthProvider;
const isolatedHealth = mtls || process.env.NODE_ENV === 'production';
const https = await configuredHttps(authProvider);
// --- PTY control plane (module M1-gateway-control-plane) -------------------------------
// Undefined unless CAUCE_TERMINAL_ENABLED=1; in that case the gateway boots exactly as today.
const terminal = await loadTerminalConfig();
const app = await buildGateway({
  pool,
  authProvider,
  logger: true,
  ackDeadlineMs,
  admission,
  requireAckClaims: process.env.CAUCE_REQUIRE_ACK_CLAIMS !== '0',
  exposeHealthRoutes: !isolatedHealth,
  ...(consoleOrigins === undefined ? {} : { consoleOrigins }),
  // Announcing the capability is what makes /v3/console/access emit `ultimate-terminal.connect`
  // and /v3/console/terminal/capability stop answering 501.
  ...(terminal === undefined ? {} : { terminalCapability: terminalCapabilityAnnouncement(terminal) }),
  ...(https === undefined ? {} : { https })
});
// The routes live in a plugin registered after buildGateway so they inherit the console
// security hook, the Origin allowlist and the websocket support app.ts already installed.
if (terminal !== undefined) {
  await app.register(registerTerminalControlPlane, { pool, authProvider, config: terminal });
}
// --- end PTY control plane -------------------------------------------------------------
const health = isolatedHealth ? await buildLoopbackHealthProbe({
  pool,
  logger: true,
  requirePostgresTls: process.env.NODE_ENV === 'production'
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
  if (health) await health.listen({ host: '127.0.0.1', port: healthPort });
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  if (health) await health.close();
  await app.close();
  await pool.end();
  throw error;
}
