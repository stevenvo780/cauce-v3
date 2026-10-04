import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';

const execute = promisify(execFile);

export interface AccountsAssignmentsFixture extends RealPtyFixture {
  readonly runId: string;
  readonly readerEmail: string;
  readonly readerPassword: string;
  readonly readerAlias: string;
  readonly foreignPoolAccountId: string;
  readonly foreignPrivateAccountId: string;
  readonly foreignExternalMarker: string;
  readonly foreignCredentialLocator: string;
  loginReader(): Promise<{ cookie: string; csrf: string }>;
}

export async function startAccountsAssignmentsFixture(): Promise<AccountsAssignmentsFixture> {
  const fixture = await startRealPtyFixture();
  const runId = randomUUID();
  const suffix = runId.replaceAll('-', '').slice(0, 18);
  const readerEmail = `reader-${suffix}@cauce.test`;
  const readerPassword = randomBytes(24).toString('base64url');
  const readerAlias = `e2ereader-${suffix}`;
  const foreignPoolAccountId = `e2e-pool-${suffix}`;
  const foreignPrivateAccountId = `e2e-private-${suffix}`;
  const foreignExternalMarker = `external-fixture-${runId}`;
  const foreignCredentialLocator = `CAUCE_E2E_FOREIGN_${suffix.toUpperCase()}_PATH`;
  const foreignRoom = `e2e-accounts-${suffix}`;

  try {
    await fixture.database.pool.query(
      `INSERT INTO rooms(id,tenant_id) VALUES($1,'Isa')`, [foreignRoom],
    );
    await fixture.database.pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
       VALUES('Isa',$1,'pty-e2e',$1,true,$2,'node','/home/node','/home/node/.cauce-e2e')`,
      [readerAlias, `accounts-reader-${runId}`],
    );
    await fixture.database.pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Isa',$1,$2,'operator')`,
      [foreignRoom, readerAlias],
    );
    await fixture.database.pool.query(
      `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
         credential_ref_kind,credential_ref,shared_with_pool,enabled)
       VALUES($1,'codex',$2,'Jhon','Cuenta compartida de fixture','env_path',$3,true,true),
             ($4,'codex',$5,'Jhon','Cuenta privada de fixture','env_path','CAUCE_E2E_PRIVATE_PATH',false,true)`,
      [
        foreignPoolAccountId,
        foreignExternalMarker,
        foreignCredentialLocator,
        foreignPrivateAccountId,
        `private-${runId}`,
      ],
    );

    const provision = await execute(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs', 'services/gateway/src/console-user-cli.ts',
        '--email', readerEmail, '--name', 'Accounts reader E2E', '--role', 'reader',
        '--tenant', 'Isa', '--alias', readerAlias,
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_ENV: 'test',
          DATABASE_URL: fixture.database.url,
          CAUCE_CONSOLE_USER_PASSWORD: readerPassword,
        },
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (!provision.stdout.includes('cuenta guardada') || provision.stdout.includes(readerPassword)) {
      throw new Error('reader fixture provisioning did not safely confirm its synthetic user');
    }

    return {
      ...fixture,
      runId,
      readerEmail,
      readerPassword,
      readerAlias,
      foreignPoolAccountId,
      foreignPrivateAccountId,
      foreignExternalMarker,
      foreignCredentialLocator,
      loginReader: async () => {
        const response = await fixture.request('/v3/auth/login', {
          method: 'POST',
          headers: { origin: fixture.gatewayUrl },
          body: { email: readerEmail, password: readerPassword },
        });
        if (response.status !== 200) throw new Error(`synthetic reader login failed with HTTP ${String(response.status)}`);
        const cookie = response.headers['set-cookie']?.find((value) => value.startsWith('__Host-cauce_session='));
        if (!cookie) throw new Error('synthetic reader login omitted its secure session cookie');
        const body = JSON.parse(response.body) as { csrf_token?: unknown };
        if (typeof body.csrf_token !== 'string') throw new Error('synthetic reader login omitted CSRF token');
        return { cookie: cookie.split(';', 1)[0] ?? '', csrf: body.csrf_token };
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
