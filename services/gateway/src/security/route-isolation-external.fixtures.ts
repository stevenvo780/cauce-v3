import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CauceRepository, FleetOperationsRepository, type LegacyAdoptionProbe } from '@cauce/store';
import { startTestCaseDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { OAuthClients } from '../oauth-client-metadata.js';
import { PostgresOAuthStore } from '../oauth-authorization-store.js';
import { OAuthTokens } from '../oauth-tokens.js';
import { registerOAuthAuthorizationServer } from '../oauth-authorization-server.js';
import { createOAuthPasswordSession } from '../oauth-password-session.js';
import { registerClientDelegationRoutes } from '../routes/mcp-client-delegations.js';
import { SignedFleetAuthorityClient } from '../fleet/authority/signed-client.js';
import { createLegacyFleetAdoptionService } from '../fleet/adoption.js';
import { providerAuthService } from './route-isolation-provider.js';
import { ISOLATION_OAUTH_ISSUER } from './route-isolation-probe.js';

export interface LocalDeployment { baseUrl: string; oauthIssuer: string; database: EmptyTestDatabase; close: () => Promise<void> }

const unavailableLegacyProbe: LegacyAdoptionProbe = {
  withSupervisorFence: async (_targets, work) => work({
    measure: async () => { throw new Error('legacy measurement unavailable in the local rehearsal'); },
    assertHeld: async () => undefined,
  }),
};

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => { if (address !== null && typeof address === 'object') resolve(address.port); else reject(new Error('no port')); });
    });
  });
}

/**
 * The real gateway on a loopback HTTP listener over a disposable PostgreSQL, wired like production
 * password login with the OAuth server, MCP delegations, provider auth and space backups mounted.
 * Planes that need host material (terminal relay, context repository, bootstrap mTLS) stay off and
 * the runner reports their routes as not mounted, as it would against a deployment without them.
 */
export async function startLocalDeployment(server: TestDatabase): Promise<LocalDeployment> {
  const database = await startTestCaseDatabase(server);
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  await mkdir(join(projectRoot, '.test-state'), { recursive: true });
  const directory = await mkdtemp(join(projectRoot, '.test-state/verify-external-'));
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(database.pool), signingKey: Buffer.alloc(32, 59) });
  const app = await buildGateway({ pool: database.pool, repository: new CauceRepository(database.pool), authProvider: provider,
    consoleOrigins: [baseUrl], logger: false, exposeHealthRoutes: true,
    providerAuthService: providerAuthService(database.pool),
    fleetOperationsRepository: new FleetOperationsRepository(database.pool),
    spaceBackups: { directory, projectRoot, python: '/usr/bin/python3' },
    blobs: { directory: join(directory, 'blobs'), maxBytes: 1_048_576 },
    signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(directory, 'authority.sock'), { ownerUid: 0, peerUid: 0 }),
    legacyFleetAdoptionService: createLegacyFleetAdoptionService(database.pool, unavailableLegacyProbe) });
  const issuer = ISOLATION_OAUTH_ISSUER;
  const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'verify-external',
    signingKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  const store = new PostgresOAuthStore(database.pool, issuer, provider.verifyCredentialStamp.bind(provider));
  await registerOAuthAuthorizationServer(app, { tokens, store, clients: new OAuthClients(), passwordAuth: provider,
    session: createOAuthPasswordSession({ provider }) });
  registerClientDelegationRoutes(app, database.pool, provider, { issuer, resource: tokens.resource,
    verifyCredentialStamp: provider.verifyCredentialStamp.bind(provider) });
  await app.listen({ host: '127.0.0.1', port });
  return { baseUrl, oauthIssuer: issuer, database, close: async () => {
    await app.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  } };
}
