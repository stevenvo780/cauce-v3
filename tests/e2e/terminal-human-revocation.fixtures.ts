import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

const execute = promisify(execFile);

export interface TerminalHttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: import('node:http').IncomingHttpHeaders;
}

export interface HumanTerminal {
  userId: string;
  cookie: string;
  csrf: string;
  sessionId: string;
  requestId: string;
  ownerToken: string;
  ticket: string;
  claimToken: string;
  claimEpoch?: string;
}

export type HumanRevocation = 'disabled' | 'reader' | 'password';

export class TerminalHumanFixture {
  readonly tenant = 'Steven';
  readonly actorAlias = `tractor${randomBytes(4).toString('hex')}`;
  readonly targetAlias = `trtarget${randomBytes(4).toString('hex')}`;
  readonly relayBootId = randomUUID();
  readonly relayToken = randomBytes(32).toString('base64url');
  readonly users: string[] = [];
  database: TestDatabase | undefined;
  app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  directory = '';
  url = '';
  relayInstanceId = '';
  private tls?: ReturnType<typeof createSelfSignedCert>;
  private grantsFile = '';
  private passwordHash = '';
  private password = randomBytes(24).toString('base64url');
  private nextUser = 0;
  private readonly userIds: string[] = [];

  async start(): Promise<void> {
    if (process.env.CAUCE_TEST_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) {
      throw new Error('terminal human revocation requires an owned Testcontainers database');
    }
    try {
      this.directory = await mkdtemp(join(tmpdir(), 'tr-human-'));
      this.tls = createSelfSignedCert({ directory: this.directory });
      this.relayInstanceId = relayInstanceIdFromCertificate(this.tls.cert);
      this.database = await startTestDatabase();
      await this.inventory('before');
      const room = `tr-room-${randomUUID()}`;
      await this.database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, this.tenant]);
      await this.database.pool.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
         VALUES($1,$2,'openclaw',true,$4,'claw','/home/claw','/home/claw/.cauce'),
               ($1,$3,'openclaw',true,$5,'claw','/home/claw','/home/claw/.cauce')`,
        [this.tenant, this.actorAlias, this.targetAlias, `tr-actor-${randomUUID()}`, this.containerName],
      );
      await this.database.pool.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role)
         VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')`,
        [this.tenant, room, this.actorAlias, this.targetAlias],
      );
      this.passwordHash = await hashPassword(this.password);
      for (let index = 0; index < 5; index += 1) {
        const email = `terminal-${randomUUID()}@cauce.test`;
        const user = await maintainConsoleUser(this.database.pool, {
          email, name: 'Terminal QA', role: 'operator', tenant: this.tenant, alias: this.actorAlias,
          updateOnly: false, activate: true,
        }, this.passwordHash);
        this.users.push(email);
        this.userIds.push(user.id);
      }
      this.grantsFile = join(this.directory, 'grants.json');
      await this.writeGrants();
      const identities = join(this.directory, 'identities.json');
      await writeFile(identities, JSON.stringify({ version: 1, identities: [{
        certificate_sha256: this.relayInstanceId,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        principal: { tenant_id: this.tenant, alias: this.targetAlias, session_id: randomUUID(),
          channel: 'agent', roles: ['agent'], permissions: ['route', 'read'] },
      }] }), { mode: 0o600 });
      const authProvider = new PasswordAuthProvider({
        users: new PostgresConsoleUserStore(this.database.pool), signingKey: randomBytes(32),
        sessionTtlMs: 900_000,
        fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)),
      });
      await authProvider.ready();
      const config: TerminalConfig = {
        wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32), relayToken: this.relayToken,
        relayInstanceIds: new Set([this.relayInstanceId]), grantsFile: this.grantsFile,
        ticketTtlSeconds: 30, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 1_800,
        claimLeaseSeconds: 150, maxSessionsPerOperator: 2,
        operatorHeader: 'x-cauce-operator', operators: new Set(),
      };
      this.app = await buildGateway({ pool: this.database.pool, authProvider,
        https: { key: this.tls.key, cert: this.tls.cert, ca: this.tls.cert,
          requestCert: true, rejectUnauthorized: true },
        terminalCapability: terminalCapabilityAnnouncement(config), outboxPollMs: 60_000,
      });
      await this.app.register(registerTerminalControlPlane, {
        pool: this.database.pool, authProvider, config,
        measuredFacts: { factsFor: async () => undefined },
        governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'QA has no manuals' }) },
      });
      await this.app.listen({ host: '127.0.0.1', port: 0 });
      this.url = `https://127.0.0.1:${String((this.app.server.address() as AddressInfo).port)}`;
      const presence = await this.relay('/v3/terminal/relay/agents', { agents: [{
        tenant_id: this.tenant, alias: this.targetAlias, container_id: this.containerName,
        generation: 'qa-generation', image_id: `sha256:${'a'.repeat(64)}`,
        runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', modes: ['shell'],
        connected_since: new Date().toISOString(),
      }] });
      if (presence.status !== 200 || presence.body.ok !== true) throw new Error('authenticated relay presence failed');
    } catch (error) {
      try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'setup and cleanup failed'); }
      throw error;
    }
  }

  private get containerName(): string {
    return `tr-target-${this.targetAlias}`;
  }

  private async writeGrants(): Promise<void> {
    await writeFile(this.grantsFile, JSON.stringify({ version: 1, grants: this.users.map((email) => ({
      operator: email, tenant_id: this.tenant, alias: this.targetAlias, modes: ['shell'],
    })) }), { mode: 0o600 });
  }

  async issue(): Promise<HumanTerminal> {
    const email = this.users[this.nextUser];
    const userId = this.userIds[this.nextUser];
    this.nextUser += 1;
    if (email === undefined || userId === undefined) throw new Error('QA account budget exhausted');
    const login = await this.request('/v3/auth/login', { method: 'POST',
      body: { email, password: this.password }, headers: { origin: this.url } });
    if (login.status !== 200 || login.body.authenticated !== true) throw new Error('real password login failed');
    const csrf = login.body.csrf_token;
    const cookie = login.headers['set-cookie']?.[0]?.split(';', 1)[0];
    if (typeof csrf !== 'string' || !cookie?.startsWith('__Host-cauce_session=')) throw new Error('login omitted cookie or CSRF');
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const admitted = await this.request('/v3/console/terminal/sessions', { method: 'POST',
      headers: { cookie, origin: this.url, 'x-csrf-token': csrf },
      body: { tenant_id: this.tenant, alias: this.targetAlias, mode: 'shell', reason: 'Human revocation QA',
        cols: 80, rows: 24, request_id: requestId, owner_token: ownerToken },
    });
    if (admitted.status !== 201 || typeof admitted.body.session_id !== 'string' || typeof admitted.body.ticket !== 'string') {
      throw new Error(`terminal admission failed with status ${String(admitted.status)} reason ${String(admitted.body.reason)}`);
    }
    return { userId, cookie, csrf, sessionId: admitted.body.session_id,
      ticket: admitted.body.ticket, requestId, ownerToken, claimToken: randomUUID() };
  }

  async consume(terminal: HumanTerminal): Promise<TerminalHttpResult> {
    const result = await this.relay(`/v3/terminal/relay/sessions/${terminal.sessionId}/consume`, {
      ticket: terminal.ticket, claim_token: terminal.claimToken,
    });
    if (result.status === 200 && typeof result.body.claim_epoch === 'string') terminal.claimEpoch = result.body.claim_epoch;
    return result;
  }

  authorize(terminal: HumanTerminal): Promise<TerminalHttpResult> {
    if (terminal.claimEpoch === undefined) throw new Error('terminal has not been consumed');
    return this.relay(`/v3/terminal/relay/sessions/${terminal.sessionId}/authz`, {
      claim_token: terminal.claimToken, claim_epoch: terminal.claimEpoch,
    });
  }

  async revokeHuman(terminal: HumanTerminal, kind: HumanRevocation): Promise<void> {
    if (kind === 'password') {
      await this.requiredDatabase().pool.query(
        "UPDATE console_users SET password_hash=$2,password_changed_at=now()+interval '2 seconds' WHERE id=$1::uuid",
        [terminal.userId, await hashPassword(randomBytes(24).toString('base64url'))],
      );
      return;
    }
    const statements = {
      disabled: 'UPDATE console_users SET active=false WHERE id=$1::uuid',
      reader: "UPDATE console_users SET role='reader' WHERE id=$1::uuid",
      password: "UPDATE console_users SET password_changed_at=now()+interval '2 seconds' WHERE id=$1::uuid",
    };
    await this.requiredDatabase().pool.query(statements[kind], [terminal.userId]);
  }

  async revokeTerminal(terminal: HumanTerminal): Promise<TerminalHttpResult> {
    return this.request(`/v3/console/terminal/sessions/${terminal.sessionId}`, { method: 'DELETE',
      headers: { cookie: terminal.cookie, origin: this.url, 'x-csrf-token': terminal.csrf },
      body: { request_id: terminal.requestId, owner_generation: '1', owner_token: terminal.ownerToken },
    });
  }

  async removeGrants(): Promise<void> {
    await writeFile(this.grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
  }

  async claimExpiry(terminal: HumanTerminal): Promise<string> {
    const result = await this.requiredDatabase().pool.query<{ expiry: string }>(
      'SELECT relay_claim_expires_at::text AS expiry FROM terminal_sessions WHERE id=$1::uuid', [terminal.sessionId],
    );
    const expiry = result.rows[0]?.expiry;
    if (expiry === undefined) throw new Error('terminal claim expiry is missing');
    return expiry;
  }

  async technicalAuthorityHash(): Promise<string> {
    const result = await this.requiredDatabase().pool.query(
      `SELECT row_to_json(membership) AS membership,row_to_json(policy) AS policy
       FROM memberships membership JOIN role_policies policy ON policy.role=membership.role
       WHERE membership.tenant_id=$1 AND membership.alias IN ($2,$3)
       ORDER BY membership.alias,membership.room_id`, [this.tenant, this.actorAlias, this.targetAlias],
    );
    return createHash('sha256').update(JSON.stringify(result.rows))
      .update(await readFile(this.grantsFile)).digest('hex');
  }

  relay(path: string, body: Record<string, unknown>): Promise<TerminalHttpResult> {
    return this.request(path, { method: 'POST', headers: { authorization: `Bearer ${this.relayToken}` },
      body: { relay_instance_id: this.relayInstanceId, relay_boot_id: this.relayBootId, ...body } });
  }

  async request(path: string, options: {
    method?: string; headers?: Record<string, string>; body?: unknown;
  } = {}): Promise<TerminalHttpResult> {
    const tls = this.tls;
    if (tls === undefined) throw new Error('QA TLS is unavailable');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(`${this.url}${path}`, { method: options.method ?? 'GET',
        headers: { ...options.headers, ...(body === undefined ? {} : {
          'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
        }) }, cert: tls.cert, key: tls.key, ca: tls.cert, servername: 'localhost', rejectUnauthorized: true,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = raw.length === 0 ? {} : JSON.parse(raw); } catch { reject(new Error('QA HTTP returned invalid JSON')); return; }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error('QA HTTP returned non-object JSON'));
            return;
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed as Record<string, unknown> });
        });
      });
      request.setTimeout(5_000, () => request.destroy(new Error('QA HTTPS deadline elapsed')));
      request.once('error', reject);
      request.end(body);
    });
  }

  private requiredDatabase(): TestDatabase {
    if (this.database === undefined) throw new Error('owned database is unavailable');
    return this.database;
  }

  async inventory(stage: string): Promise<void> {
    const evidence = process.env.CAUCE_TERMINAL_REVOCATION_EVIDENCE_DIR;
    const database = this.database;
    if (evidence === undefined || database === undefined) return;
    const id = database.container.getId();
    const { stdout } = await execute('docker', ['inspect', '--format',
      '{{json .Id}} {{json .Mounts}} {{json .NetworkSettings.Ports}} {{json .Config.Labels}}', id], { timeout: 10_000 });
    await writeFile(join(evidence, `pg-${id}-${stage}.txt`), stdout, { mode: 0o600 });
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    if (this.app !== undefined) {
      try { await this.app.close(); } catch (error) { failures.push(error); }
      this.app = undefined;
    }
    const database = this.database;
    if (database !== undefined) {
      try { await this.inventory('before-cleanup'); } catch (error) { failures.push(error); }
      try { await database.pool.end(); } catch (error) { failures.push(error); }
      try { await database.container.stop(); } catch (error) { failures.push(error); }
      this.database = undefined;
    }
    if (this.directory.length > 0) {
      try { await rm(this.directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      this.directory = '';
    }
    if (failures.length > 0) throw new AggregateError(failures, 'owned terminal fixture cleanup failed');
  }
}
