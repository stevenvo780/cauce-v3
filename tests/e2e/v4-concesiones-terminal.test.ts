import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGateway } from '../../services/gateway/src/app.js';
import { withTransaction } from '@cauce/store';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

interface HttpResult { status: number; body: Record<string, unknown>; headers: import('node:http').IncomingHttpHeaders }
interface Session { cookie: string; csrf: string }
interface OpenedTerminal { sessionId: string; ticket: string; authorityProof: string; claimToken: string; claimEpoch?: string }

/**
 * Database terminal grants end to end: the grants file stays empty the whole run, so every
 * admission below is accredited by `terminal_grants` alone (gateway + PostgreSQL real).
 */
class GrantsFixture {
  readonly tenantA = 'Steven';
  readonly tenantB = 'ZZCanaryB';
  readonly companyB = 'zzcanaryb';
  readonly actorA = `grantsactor${randomBytes(3).toString('hex')}`;
  readonly targetA = `grantstarget${randomBytes(3).toString('hex')}`;
  readonly actorB = `grantsactorb${randomBytes(3).toString('hex')}`;
  readonly targetB = `grantstargetb${randomBytes(3).toString('hex')}`;
  readonly relayBootId = randomUUID();
  readonly relayToken = randomBytes(32).toString('base64url');
  database: TestDatabase | undefined;
  app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  directory = '';
  url = '';
  relayInstanceId = '';
  adminAId = '';
  granteeAId = '';
  adminBId = '';
  adminAEmail = '';
  granteeAEmail = '';
  adminBEmail = '';
  private tls?: ReturnType<typeof createSelfSignedCert>;
  private readonly password = randomBytes(24).toString('base64url');
  private readonly ticketKey = randomBytes(32);

  private get containerA(): string { return `grants-target-${this.targetA}`; }
  private get containerB(): string { return `grants-target-${this.targetB}`; }

  async start(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'v4-grants-'));
    this.tls = createSelfSignedCert({ directory: this.directory });
    this.relayInstanceId = relayInstanceIdFromCertificate(this.tls.cert);
    this.database = await startTestDatabase();
    const pool = this.database.pool;
    const roomA = `grants-room-${randomUUID()}`;
    const roomB = `grants-room-${randomUUID()}`;
    const passwordHash = await hashPassword(this.password);
    // One transaction: the deferred owner-continuity guard only passes when the new company
    // and its active owner land together.
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO companies(id,name) VALUES($1,'ZZ Canary B')", [this.companyB]);
      await client.query('INSERT INTO tenants(id,company_id) VALUES($1,$2)', [this.tenantB, this.companyB]);
      await client.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2),($3,$4)',
        [roomA, this.tenantA, roomB, this.tenantB]);
      await client.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
         VALUES($1,$2,'openclaw',true,$3,'claw','/home/claw','/home/claw/.cauce'),
               ($4,$5,'openclaw',true,$6,'claw','/home/claw','/home/claw/.cauce'),
               ($7,$8,'openclaw',true,$9,'claw','/home/claw','/home/claw/.cauce'),
               ($10,$11,'openclaw',true,$12,'claw','/home/claw','/home/claw/.cauce')`,
        [this.tenantA, this.actorA, `grants-actor-${this.actorA}`,
          this.tenantA, this.targetA, this.containerA,
          this.tenantB, this.actorB, `grants-actor-${this.actorB}`,
          this.tenantB, this.targetB, this.containerB]);
      await client.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role)
         VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent'),($5,$6,$7,'operator'),($5,$6,$8,'agent')`,
        [this.tenantA, roomA, this.actorA, this.targetA, this.tenantB, roomB, this.actorB, this.targetB]);
      const makeUser = async (tenant: string, alias: string): Promise<{ id: string; email: string }> => {
        const email = `grants-${randomUUID()}@cauce.test`;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
           VALUES($1,$2,$3,'Grants QA','operator',$4,$5,true) RETURNING id`,
          [email, email.toLowerCase(), passwordHash, tenant, alias]);
        const id = inserted.rows[0]?.id;
        if (id === undefined) throw new Error('console user insert lost its row');
        await client.query(
          `INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,enabled)
           VALUES($1,$2,$3,'operator',ARRAY['read','route','control'],true)`,
          [id, tenant, alias]);
        return { id, email };
      };
      const adminA = await makeUser(this.tenantA, this.actorA);
      const granteeA = await makeUser(this.tenantA, this.actorA);
      const adminB = await makeUser(this.tenantB, this.actorB);
      this.adminAId = adminA.id; this.adminAEmail = adminA.email;
      this.granteeAId = granteeA.id; this.granteeAEmail = granteeA.email;
      this.adminBId = adminB.id; this.adminBEmail = adminB.email;
      await client.query(
        `INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
         VALUES('humanizar',$1,'owner','platform',$1),($2,$3,'owner','platform',$3)`,
        [this.adminAId, this.companyB, this.adminBId]);
    });
    const grantsFile = join(this.directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
    const identities = join(this.directory, 'identities.json');
    await writeFile(identities, JSON.stringify({ version: 1, identities: [{
      certificate_sha256: this.relayInstanceId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      principal: { tenant_id: this.tenantA, alias: this.targetA, session_id: randomUUID(),
        channel: 'agent', roles: ['agent'], permissions: ['route', 'read'] },
    }] }), { mode: 0o600 });
    const authProvider = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32), sessionTtlMs: 900_000,
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)),
    });
    await authProvider.ready();
    const config: TerminalConfig = {
      wsPath: '/v3/console/terminal/ws', ticketKey: this.ticketKey, relayToken: this.relayToken,
      relayInstanceIds: new Set([this.relayInstanceId]), grantsFile,
      ticketTtlSeconds: 30, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 1_800,
      claimLeaseSeconds: 150, maxSessionsPerOperator: 10,
      operatorHeader: 'x-cauce-operator', operators: new Set(),
    };
    this.app = await buildGateway({ pool, authProvider,
      https: { key: this.tls.key, cert: this.tls.cert, ca: this.tls.cert,
        requestCert: true, rejectUnauthorized: true },
      terminalCapability: terminalCapabilityAnnouncement(config), outboxPollMs: 60_000,
    });
    await this.app.register(registerTerminalControlPlane, {
      pool, authProvider, config,
      measuredFacts: { factsFor: async () => undefined },
      governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'QA has no manuals' }) },
    });
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    this.url = `https://127.0.0.1:${String((this.app.server.address() as AddressInfo).port)}`;
    for (const [tenant, alias, container] of [
      [this.tenantA, this.targetA, this.containerA], [this.tenantB, this.targetB, this.containerB],
    ] as const) {
      const presence = await this.relay('/v3/terminal/relay/agents', { agents: [{
        tenant_id: tenant, alias, container_id: container,
        generation: 'qa-generation', image_id: `sha256:${'a'.repeat(64)}`,
        runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', modes: ['shell'],
        connected_since: new Date().toISOString(),
      }] });
      if (presence.status !== 200) throw new Error('authenticated relay presence failed');
    }
  }

  async login(email: string): Promise<Session> {
    const login = await this.request('/v3/auth/login', { method: 'POST',
      body: { email, password: this.password }, headers: { origin: this.url } });
    if (login.status !== 200) throw new Error(`login failed with ${String(login.status)}`);
    const cookie = login.headers['set-cookie']?.[0]?.split(';', 1)[0];
    const csrf = login.body.csrf_token;
    if (typeof csrf !== 'string' || !cookie) throw new Error('login omitted cookie or CSRF');
    return { cookie, csrf };
  }

  grants(session: Session, method: string, path: string, body?: unknown): Promise<HttpResult> {
    return this.request(path, { method, headers: { cookie: session.cookie, origin: this.url, 'x-csrf-token': session.csrf },
      ...(body === undefined ? {} : { body }) });
  }

  async openTerminal(session: Session): Promise<HttpResult & { opened?: OpenedTerminal }> {
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const admitted = await this.request('/v3/console/terminal/sessions', { method: 'POST',
      headers: { cookie: session.cookie, origin: this.url, 'x-csrf-token': session.csrf },
      body: { tenant_id: this.tenantA, alias: this.targetA, mode: 'shell',
        cols: 80, rows: 24, request_id: requestId, owner_token: ownerToken } });
    if (admitted.status !== 201) return admitted;
    const opened: OpenedTerminal = {
      sessionId: String(admitted.body.session_id), ticket: String(admitted.body.ticket),
      authorityProof: String(admitted.body.authority_proof), claimToken: randomUUID(),
    };
    return { ...admitted, opened };
  }

  async consume(opened: OpenedTerminal): Promise<HttpResult> {
    const result = await this.relay(`/v3/terminal/relay/sessions/${opened.sessionId}/consume`, {
      ticket: opened.ticket, claim_token: opened.claimToken, authority_proof: opened.authorityProof,
    });
    if (result.status === 200) opened.claimEpoch = String(result.body.claim_epoch);
    return result;
  }

  authorize(opened: OpenedTerminal): Promise<HttpResult> {
    return this.relay(`/v3/terminal/relay/sessions/${opened.sessionId}/authz`, {
      claim_token: opened.claimToken, claim_epoch: opened.claimEpoch ?? '', authority_proof: opened.authorityProof,
    });
  }

  relay(path: string, body: Record<string, unknown>): Promise<HttpResult> {
    return this.request(path, { method: 'POST', headers: { authorization: `Bearer ${this.relayToken}` },
      body: { relay_instance_id: this.relayInstanceId, relay_boot_id: this.relayBootId, ...body } });
  }

  async request(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
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
            reject(new Error('QA HTTP returned non-object JSON')); return;
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed as Record<string, unknown> });
        });
      });
      request.setTimeout(5_000, () => request.destroy(new Error('QA HTTPS deadline elapsed')));
      request.once('error', reject);
      request.end(body);
    });
  }

  async close(): Promise<void> {
    if (this.app !== undefined) { await this.app.close(); this.app = undefined; }
    if (this.database !== undefined) {
      await this.database.pool.end();
      await this.database.container.stop();
      this.database = undefined;
    }
    if (this.directory.length > 0) await rm(this.directory, { recursive: true, force: true });
  }
}

describe('concesiones de terminal en PostgreSQL', () => {
  let fixture: GrantsFixture;
  beforeEach(async () => { fixture = new GrantsFixture(); await fixture.start(); }, 120_000);
  afterEach(async () => fixture.close(), 30_000);

  it('conceder abre la terminal, revocar la cierra y ya no puede abrirla', async () => {
    const admin = await fixture.login(fixture.adminAEmail);
    const grantee = await fixture.login(fixture.granteeAEmail);
    const deniedBefore = await fixture.openTerminal(grantee);
    expect(deniedBefore.status).toBe(403);

    const created = await fixture.grants(admin, 'POST', '/v3/console/terminal/grants', {
      tenant_id: fixture.tenantA, alias: fixture.targetA, grantee_human_id: fixture.granteeAId, modes: ['shell'],
    });
    expect(created.status).toBe(201);
    const grantId = String(created.body.id);
    const audit = await fixture.database?.pool.query(
      "SELECT action FROM audit_events WHERE action='terminal.grant.create' AND metadata->>'grant_id'=$1", [grantId]);
    expect(audit?.rows).toHaveLength(1);

    const opened = await fixture.openTerminal(grantee);
    expect(opened.status).toBe(201);
    if (opened.opened === undefined) throw new Error('terminal admission omitted its session');
    expect((await fixture.consume(opened.opened)).status).toBe(200);
    expect((await fixture.authorize(opened.opened)).status).toBe(200);

    const revoked = await fixture.grants(admin, 'DELETE',
      `/v3/console/terminal/grants/${grantId}?expected_version=1`);
    expect(revoked.status).toBe(200);
    const deniedAfter = await fixture.authorize(opened.opened);
    expect(deniedAfter.status).toBe(403);
    expect(deniedAfter.body.reason).toBe('revoked');
    expect((await fixture.openTerminal(grantee)).status).toBe(403);
  });

  it('otra empresa no ve ni toca las concesiones ajenas', async () => {
    const admin = await fixture.login(fixture.adminAEmail);
    const foreign = await fixture.login(fixture.adminBEmail);
    const created = await fixture.grants(admin, 'POST', '/v3/console/terminal/grants', {
      tenant_id: fixture.tenantA, alias: fixture.targetA, grantee_human_id: fixture.granteeAId, modes: ['shell'],
    });
    expect(created.status).toBe(201);
    const grantId = String(created.body.id);

    const foreignList = await fixture.grants(foreign, 'GET', '/v3/console/terminal/grants');
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.items).toEqual([]);
    const foreignCreate = await fixture.grants(foreign, 'POST', '/v3/console/terminal/grants', {
      tenant_id: fixture.tenantA, alias: fixture.targetA, grantee_human_id: fixture.granteeAId, modes: ['shell'],
    });
    expect([403, 404]).toContain(foreignCreate.status);
    const foreignPatch = await fixture.grants(foreign, 'PATCH', `/v3/console/terminal/grants/${grantId}`, {
      expected_version: 1, modes: ['harness'],
    });
    expect([403, 404]).toContain(foreignPatch.status);
    const foreignDelete = await fixture.grants(foreign, 'DELETE',
      `/v3/console/terminal/grants/${grantId}?expected_version=1`);
    expect([403, 404]).toContain(foreignDelete.status);
    const stillThere = await fixture.grants(admin, 'GET', '/v3/console/terminal/grants');
    expect((stillThere.body.items as unknown[]).length).toBe(1);
  });

  it('una persona sin autoridad de empresa no concede ni lista', async () => {
    const grantee = await fixture.login(fixture.granteeAEmail);
    const created = await fixture.grants(grantee, 'POST', '/v3/console/terminal/grants', {
      tenant_id: fixture.tenantA, alias: fixture.targetA, grantee_human_id: fixture.granteeAId, modes: ['shell'],
    });
    expect(created.status).toBe(403);
    expect((await fixture.grants(grantee, 'GET', '/v3/console/terminal/grants')).status).toBe(403);
  });
});
