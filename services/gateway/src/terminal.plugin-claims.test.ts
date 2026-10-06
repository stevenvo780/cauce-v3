import type { AuthProvider } from './auth.js';
import { createHash, randomUUID } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RelayFileRead, RuntimeFacts } from './console/agent-documents.js';
import type { FactsSource, GovernanceReadError } from './console/agent-documents.routes.js';
import { createConsoleSecurityHook } from './console-security.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { AgentRegistry } from './terminal/registry.js';
import { deriveAliasKey, emitAuthorityResumeToken, verifyTicketSignature } from './terminal/tickets.js';
import { UNATTRIBUTED_OPERATOR, type AgentPresence } from './terminal/types.js';
import {
  CLAIM_A,
  MASTER,
  ORIGIN,
  RELAY_A,
  RELAY_B,
  RELAY_BOOT_A,
  RELAY_TOKEN,
  consoleAuthProvider,
  installAuthorityCarrier,
  fakeDatabase,
  presence,
  CLAIM_B,
  RELAY_BOOT_B,
  type FakeDatabase,
} from './terminal.plugin.fixtures.js';

describe('terminal control plane', () => {
  let directory: string;
  let grantsFile: string;
  let database: FakeDatabase;
  let registry: AgentRegistry;
  let app: FastifyInstance;
  let config: TerminalConfig;
  let controlPermission: () => Promise<void>;
  /** MEASURED facts per alias. Empty = nobody measured that container, which is today's state. */
  let hechos: Map<string, { facts: RuntimeFacts; source: FactsSource }>;
  /** Everything the gateway asked the terminal-relay, in order. */
  let pedidas: { tenant_id: string; alias: string; path: string }[];
  let leer: (path: string) => RelayFileRead | GovernanceReadError;
  let relayPeerInstanceId: string;
  let relayBootId: string;

  async function build(overrides: Partial<TerminalConfig> = {}, provider: AuthProvider = consoleAuthProvider()): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The first beforeEach call reaches this helper before app is initialized at runtime.
    if (app !== undefined) await app.close();
    config = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: MASTER,
      relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([RELAY_A, RELAY_B]),
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set<string>(),
      ...overrides
    };
    app = Fastify({ logger: false });
    installAuthorityCarrier(app, database, provider);
    // app.inject has no TLS socket. This test harness supplies the independently authenticated
    // peer identity and envelopes legacy test calls exactly as the real relay client does.
    app.addHook('preValidation', async (request) => {
      if (!request.url.startsWith('/v3/terminal/relay/')) return;
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return;
      const body = request.body as Record<string, unknown>;
      body.relay_instance_id ??= relayPeerInstanceId;
      body.relay_boot_id ??= relayBootId;
    });
    // Same hook app.ts installs before the plugin; it must cover the console routes and must
    // NOT cover the relay routes, which is exactly why those live outside /v3/console/.
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [ORIGIN] }));
    await app.register(registerTerminalControlPlane, {
      pool: database.pool,
      authProvider: provider,
      config,
      registry,
      repository: {
        assertPermission: async () => { await controlPermission(); },
        authorizeAgentTarget: async (actorTenant, _actorAlias, targetTenant, targetAlias) => {
          const visible = targetTenant === actorTenant || database.edges.includes(`${actorTenant}->${targetTenant}`);
          const target = database.placements.find((row) =>
            row.tenant_id === targetTenant && row.alias === targetAlias);
          return !visible || !target ? undefined : {
            tenant_id: targetTenant,
            alias: targetAlias,
            harness_id: null,
            home_directory: null,
            enabled: true,
          };
        },
      },
      measuredFacts: { factsFor: async (tenantId, alias) => hechos.get(`${tenantId}:${alias}`) },
      // The terminal-relay is the only thing substituted: mounting the whole relay here would
      // test the relay, not the plugin. What is recorded is WHICH routes get asked for, which
      // is the part the gateway decides.
      governanceRelay: {
        readFile: async (tenantId, alias, path) => {
          pedidas.push({ tenant_id: tenantId, alias, path });
          return leer(path);
        }
      },
      relayPeerInstanceId: () => relayPeerInstanceId,
    });
    await app.ready();
  }

  async function report(agents: readonly AgentPresence[]): Promise<void> {
    const response = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { agents }
    });
    expect(response.statusCode).toBe(200);
  }

  async function grant(entries: { operator?: string; tenant_id: string; alias: string; modes: string[] }[]): Promise<void> {
    await writeFile(grantsFile, JSON.stringify({
      version: 1,
      grants: entries.flatMap((entry) => [UNATTRIBUTED_OPERATOR, 'steven'].map((operator) => ({ operator, ...entry })))
    }));
  }

  async function openSession(
    body: Record<string, unknown>, headers: Record<string, string> = {}
  ): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
    return app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      headers: { origin: ORIGIN, ...headers },
      payload: {
        tenant_id: 'Steven', alias: 'jarvis', mode: 'shell',
        reason: 'revisar el harness colgado', cols: 120, rows: 40,
        request_id: randomUUID(), owner_token: randomUUID(), ...body
      }
    });
  }

  function relaySessionRequest(
    sessionId: string,
    action: 'consume' | 'resume' | 'authz' | 'close',
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${sessionId}/${action}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload,
    });
  }

  async function issueAndConsume(): Promise<{
    sessionId: string;
    ticket: string;
    resumeToken: string;
    authorityProof: string;
    sessionExpiresAt: string;
    claimToken: string;
    claimEpoch: string;
  }> {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const consumed = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(consumed.statusCode).toBe(200);
    const grant = consumed.json<{
      resume_token: string;
      authority_proof: string;
      session_expires_at: string;
      claim_token: string;
      claim_epoch: string;
    }>();
    return {
      sessionId: issued.session_id,
      ticket: issued.ticket,
      resumeToken: grant.resume_token,
      authorityProof: grant.authority_proof,
      sessionExpiresAt: grant.session_expires_at,
      claimToken: grant.claim_token,
      claimEpoch: grant.claim_epoch,
    };
  }

  async function resumeSession(
    sessionId: string,
    resumeToken: string,
    claimToken = CLAIM_A,
    claimEpoch: string | undefined = '1',
    authorityProof = database.authorityProofs.get(sessionId),
  ) {
    return relaySessionRequest(sessionId, 'resume', {
      resume_token: resumeToken,
      authority_proof: authorityProof,
      claim_token: claimToken,
      claim_epoch: claimEpoch,
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-'));
    grantsFile = join(directory, 'grants.json');
    database = fakeDatabase();
    registry = new AgentRegistry();
    controlPermission = async () => undefined;
    hechos = new Map();
    pedidas = [];
    leer = (path) => ({
      path, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z',
      sha: createHash('sha256').update('# Manual\n').digest('hex'), content: '# Manual\n'
    });
    relayPeerInstanceId = RELAY_A;
    relayBootId = RELAY_BOOT_A;
    await grant([{ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }]);
    await build();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('recovers an exact consume receipt after a lost 200 without mutating twice', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const issuedTicket = database.sessions.get(issued.session_id);
    if (issuedTicket === undefined) throw new Error('issued session is missing');
    const consume = async () => relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    const first = await consume();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true, tenant_id: 'Steven', alias: 'jarvis', mode: 'shell', cols: 120, rows: 40,
      operator_id: UNATTRIBUTED_OPERATOR, container: 'claw', runtime_user: 'claw'
    });
    const consumed = first.json<{ expires_at: string; session_expires_at: string }>();
    expect(Date.parse(consumed.session_expires_at) - issuedTicket.expires_at.getTime())
      .toBeGreaterThan((config.sessionTtlSeconds - config.ticketTtlSeconds - 5) * 1_000);
    const replay = await consume();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, receipt_recovered: true });
    expect(replay.json<{ resume_token: string }>().resume_token).not.toBe(
      first.json<{ resume_token: string }>().resume_token,
    );
    expect(database.audit.filter((row) => row.action === 'terminal.session.consume')).toEqual([
      expect.objectContaining({
        decision: 'info', metadata: expect.objectContaining({ receipt_recovered: false }) as unknown,
      }),
      expect.objectContaining({
        decision: 'info', metadata: expect.objectContaining({ receipt_recovered: true }) as unknown,
      }),
    ]);
  });

  it('never renews a live claim without the presented epoch and exact digest', async () => {
    const consumed = await issueAndConsume();
    const row = database.sessions.get(consumed.sessionId);
    const claimExpiresAt = row?.relay_claim_expires_at;
    if (claimExpiresAt === undefined || claimExpiresAt === null) throw new Error('claim unavailable');
    const leaseBefore = claimExpiresAt.toISOString();
    const missingEpoch = await relaySessionRequest(consumed.sessionId, 'resume', {
      resume_token: consumed.resumeToken, claim_token: consumed.claimToken,
    });
    expect(missingEpoch.statusCode).toBe(409);
    expect(missingEpoch.json()).toMatchObject({ ok: false, reason: 'claim_conflict' });

    const wrongDigest = await resumeSession(
      consumed.sessionId, consumed.resumeToken, CLAIM_B, consumed.claimEpoch,
    );
    expect(wrongDigest.statusCode).toBe(409);
    expect(wrongDigest.json()).toMatchObject({ ok: false, reason: 'claim_conflict' });

    const wrongAuthzEpoch = await relaySessionRequest(consumed.sessionId, 'authz', {
      claim_token: consumed.claimToken, claim_epoch: '2',
    });
    expect(wrongAuthzEpoch.statusCode).toBe(403);
    expect(wrongAuthzEpoch.json()).toEqual({ ok: false, reason: 'claim_fenced' });
    expect(database.sessions.get(consumed.sessionId)).toMatchObject({
      relay_claim_epoch: consumed.claimEpoch,
      relay_claim_expires_at: new Date(leaseBefore),
    });
  });

  it('reuses one checked-out client for consume, resume and authz policy reads', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    database.failNestedPoolQueries();
    const consumed = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(consumed.statusCode).toBe(200);
    const grant = consumed.json<{ resume_token: string; claim_epoch: string }>();

    const resumed = await resumeSession(issued.session_id, grant.resume_token, CLAIM_A, grant.claim_epoch);
    expect(resumed.statusCode).toBe(200);
    const authz = await relaySessionRequest(issued.session_id, 'authz', {
      claim_token: CLAIM_A, claim_epoch: grant.claim_epoch,
    });
    expect(authz.statusCode).toBe(200);
  });

  it('rotates relay instance and boot only after the PostgreSQL lease expires', async () => {
    const consumed = await issueAndConsume();
    const issuedRow = database.sessions.get(consumed.sessionId);
    if (issuedRow === undefined) throw new Error('issued terminal session is unavailable');
    expect(issuedRow.relay_instance_id).toBe(RELAY_A);
    expect(issuedRow.relay_boot_id).toBe(RELAY_BOOT_A);

    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    await report([presence()]);
    const stillLeased = await resumeSession(
      consumed.sessionId, consumed.resumeToken, CLAIM_B, consumed.claimEpoch,
    );
    expect(stillLeased.statusCode).toBe(409);
    expect(stillLeased.json()).toMatchObject({ ok: false, reason: 'claim_conflict' });

    if (issuedRow.relay_claim_expires_at === null) throw new Error('terminal claim lease is unavailable');
    const afterLease = issuedRow.relay_claim_expires_at.getTime() + 1;
    database.clock.now = () => afterLease;
    const takeover = await resumeSession(
      consumed.sessionId, consumed.resumeToken, CLAIM_B, consumed.claimEpoch,
    );
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({
      ok: true,
      claim_epoch: '2',
      claim_taken_over: true,
      relay_instance_id: RELAY_B,
      relay_boot_id: RELAY_BOOT_B,
    });
    expect(database.sessions.get(consumed.sessionId)).toMatchObject({
      relay_instance_id: RELAY_B,
      relay_boot_id: RELAY_BOOT_B,
      relay_claim_epoch: '2',
    });

    relayPeerInstanceId = RELAY_A;
    relayBootId = RELAY_BOOT_A;
    const fenced = await relaySessionRequest(consumed.sessionId, 'authz', {
      claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch,
    });
    expect(fenced.statusCode).toBe(403);
    expect(fenced.json()).toEqual({ ok: false, reason: 'claim_fenced' });

    const staleClose = await relaySessionRequest(consumed.sessionId, 'close', {
      reason: 'stale a', exit_code: null, bytes_in: 1, bytes_out: 1,
      claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch,
    });
    expect(staleClose.statusCode).toBe(200);
    expect(database.sessions.get(consumed.sessionId)?.closed_at).toBeNull();

    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    const exactClose = await relaySessionRequest(consumed.sessionId, 'close', {
      reason: 'winner b', exit_code: 0, bytes_in: 2, bytes_out: 3,
      claim_token: CLAIM_B, claim_epoch: '2',
    });
    expect(exactClose.statusCode).toBe(200);
    expect(database.sessions.get(consumed.sessionId)?.closed_at).not.toBeNull();
  });

  it('rejects a ticket signed with another alias key', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const payload = verifyTicketSignature(issued.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    const { issueTicket } = await import('./terminal/tickets.js');
    const forged = issueTicket(payload, deriveAliasKey(MASTER, 'Steven', 'argos'));
    const response = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: forged, claim_token: CLAIM_A,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, reason: 'ticket_invalid' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('rejects non-canonical claim capabilities before touching terminal lifecycle state', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    for (const claimToken of [
      'abcdefab-cdef-4def-8def-abcdefabcdef'.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const response = await relaySessionRequest(issued.session_id, 'consume', {
        ticket: issued.ticket, claim_token: claimToken,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, reason: 'ticket_invalid' });
    }
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('rolls consume back when audit fails and recovers on the exact ticket retry', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    database.failNextAudit('terminal.session.consume');

    const failed = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(failed.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
    expect(database.audit.some((row) => row.action === 'terminal.session.consume')).toBe(false);

    const retried = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, receipt_recovered: false });
  });

  it('revalidates grants immediately before consume with no authz-loop window', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await grant([]);

    const refused = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ ok: false, reason: 'no_grant' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
    expect(database.audit.at(-1)).toMatchObject({
      action: 'terminal.session.consume', decision: 'deny',
      metadata: expect.objectContaining({ reason: 'no_grant' }) as unknown,
    });
  });

  it('revalidates canonical cross-tenant ACL and current cohort before consume', async () => {
    await build({ operators: new Set(['steven']) });
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({
      tenant_id: 'Miguel', alias, modes: ['shell'],
    })));
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev',
      modes: ['shell'],
    })]);
    const issuedResponse = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' },
    );
    expect(issuedResponse.statusCode).toBe(201);
    const issued = issuedResponse.json<{ session_id: string; ticket: string }>();
    database.edges.splice(0);

    const refused = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'forbidden', message: 'insufficient permissions' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('never consumes a ticket whose session was closed before its closed-aware CAS', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const row = database.sessions.get(issued.session_id);
    expect(row).toBeDefined();
    if (row === undefined) return;
    row.closed_at = new Date();

    const refused = await relaySessionRequest(issued.session_id, 'consume', {
      ticket: issued.ticket, claim_token: CLAIM_A,
    });
    expect(refused.statusCode).toBe(401);
    expect(row.consumed_at).toBeNull();
  });

  it('resume binds signature, sid, operator and the exact consumed-session TTL', async () => {
    const consumed = await issueAndConsume();
    const resumed = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      ok: true, tenant_id: 'Steven', alias: 'jarvis', operator_id: UNATTRIBUTED_OPERATOR,
      resume_token: consumed.resumeToken,
    });
    expect(database.audit.at(-1)).toMatchObject({ action: 'terminal.session.resume', decision: 'info' });

    const otherSid = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
    expect((await resumeSession(otherSid, consumed.resumeToken, CLAIM_A, '1', consumed.authorityProof)).statusCode).toBe(400);

    const expiry = Math.floor(Date.parse(consumed.sessionExpiresAt) / 1_000);
    const wrongSid = emitAuthorityResumeToken(otherSid, UNATTRIBUTED_OPERATOR, expiry, MASTER,
      Math.floor(Date.now() / 1_000), consumed.authorityProof);
    expect((await resumeSession(consumed.sessionId, wrongSid)).statusCode).toBe(401);
    const wrongOperator = emitAuthorityResumeToken(
      consumed.sessionId, 'another-operator', expiry, MASTER, Math.floor(Date.now() / 1_000), consumed.authorityProof,
    );
    expect((await resumeSession(consumed.sessionId, wrongOperator)).statusCode).toBe(401);

    const wrongTtl = emitAuthorityResumeToken(
      consumed.sessionId, UNATTRIBUTED_OPERATOR, expiry + 1, MASTER, Math.floor(Date.now() / 1_000), consumed.authorityProof,
    );
    expect((await resumeSession(consumed.sessionId, wrongTtl)).statusCode).toBe(401);

    const tampered = `${consumed.resumeToken.slice(0, -1)}${consumed.resumeToken.endsWith('A') ? 'B' : 'A'}`;
    expect((await resumeSession(consumed.sessionId, tampered)).statusCode).toBe(401);
    const expired = emitAuthorityResumeToken(
      consumed.sessionId, UNATTRIBUTED_OPERATOR, Math.floor(Date.now() / 1_000) - 1,
      MASTER, Math.floor(Date.now() / 1_000) - 10, consumed.authorityProof,
    );
    expect((await resumeSession(consumed.sessionId, expired)).statusCode).toBe(401);
  });

  it('resume revalidates revoked, closed, routing authority and grants on every call', async () => {
    const consumed = await issueAndConsume();
    const row = database.sessions.get(consumed.sessionId);
    if (row === undefined) throw new Error('consumed terminal session is unavailable');

    row.revoked_at = new Date();
    expect((await resumeSession(consumed.sessionId, consumed.resumeToken)).json())
      .toEqual({ ok: false, reason: 'revoked' });
    row.revoked_at = null;

    row.closed_at = new Date();
    expect((await resumeSession(consumed.sessionId, consumed.resumeToken)).json())
      .toEqual({ ok: false, reason: 'closed' });
    row.closed_at = null;

    database.rooms['Steven:kant'] = [];
    const noAuthority = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(noAuthority.statusCode).toBe(403);
    expect(noAuthority.json()).toEqual({ error: 'forbidden', message: 'insufficient permissions' });
    database.rooms['Steven:kant'] = ['grp.steven'];

    await grant([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const noGrant = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(noGrant.statusCode).toBe(403);
    expect(noGrant.json()).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('revalidates a live session and cuts it as soon as grants.json is emptied', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A }
    });
    const authz = async (): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> =>
      app.inject({
        method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        payload: { claim_token: CLAIM_A, claim_epoch: '1' },
      });
    expect((await authz()).statusCode).toBe(200);
    await grant([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const cut = await authz();
    expect(cut.statusCode).toBe(403);
    expect(cut.json()).toEqual({ ok: false, reason: 'no_grant' });
    expect(database.audit.at(-1)).toMatchObject({
      action: 'terminal.session.authz_denied', decision: 'deny',
      metadata: expect.objectContaining({ refusal: 'no_grant' }) as unknown
    });
  });

  it('lets the operator revoke a session and stops answering authz for it', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const revoked = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_token: ownerToken,
        owner_generation: issued.owner_generation,
      },
    });
    expect(revoked.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
    const authz = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { claim_token: CLAIM_A, claim_epoch: '1' },
    });
    expect(authz.json()).toEqual({ ok: false, reason: 'not_consumed' });
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json<{ items: { state: string }[] }>().items).toEqual([
      expect.objectContaining({ alias: 'jarvis', mode: 'shell', state: 'closed' })
    ]);
  });

  it('fences a delayed DELETE after explicit takeover and makes the winning DELETE idempotent', async () => {
    await report([presence()]);
    const oldOwnerToken = randomUUID();
    const issued = (await openSession({ owner_token: oldOwnerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const newOwnerToken = randomUUID();

    const rotated = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: newOwnerToken,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      session_id: issued.session_id,
      request_id: issued.request_id,
      owner_generation: '2',
    });
    expect(rotated.body).not.toContain(newOwnerToken);

    const staleDelete = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: issued.owner_generation,
        owner_token: oldOwnerToken,
      },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();

    const winningPayload = {
      request_id: issued.request_id,
      owner_generation: '2',
      owner_token: newOwnerToken,
    };
    const winningDelete = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: winningPayload,
    });
    expect(winningDelete.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();

    const lost204Retry = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: winningPayload,
    });
    expect(lost204Retry.statusCode).toBe(204);
    expect(database.audit.filter((row) => row.action === 'terminal.session.revoked')).toHaveLength(1);
    expect(database.audit.filter((row) => row.action === 'terminal.session.owner_rotated')).toHaveLength(1);
  });

  it('reuses the checked-out transaction client for owner and DELETE audit cohort reads', async () => {
    await report([presence()]);
    const firstOwner = randomUUID();
    const issued = (await openSession({ owner_token: firstOwner })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const nextOwner = randomUUID();
    database.failNestedPoolQueries();

    const takeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: nextOwner,
      },
    });
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({ owner_generation: '2' });

    const released = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: '2',
        owner_token: nextOwner,
      },
    });
    expect(released.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
  });

  it('rejects extra ownership and DELETE fields before lifecycle mutation', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const rotate = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: randomUUID(),
        extra: true,
      },
    });
    expect(rotate.statusCode).toBe(400);

    const release = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: issued.owner_generation,
        owner_token: ownerToken,
        extra: true,
      },
    });
    expect(release.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();
  });

  it('rolls owner rotation and revocation back with their audit row', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const nextOwnerToken = randomUUID();
    const ownerPayload = {
      request_id: issued.request_id,
      expected_owner_generation: issued.owner_generation,
      owner_token: nextOwnerToken,
    };

    database.failNextAudit('terminal.session.owner_rotated');
    const failedTakeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: ownerPayload,
    });
    expect(failedTakeover.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.browser_owner_generation).toBe('1');
    expect(database.audit.some((row) => row.action === 'terminal.session.owner_rotated')).toBe(false);

    const takeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: ownerPayload,
    });
    expect(takeover.statusCode).toBe(200);

    const releasePayload = {
      request_id: issued.request_id,
      owner_generation: '2',
      owner_token: nextOwnerToken,
    };
    database.failNextAudit('terminal.session.revoked');
    const failedRelease = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: releasePayload,
    });
    expect(failedRelease.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();
    expect(database.audit.some((row) => row.action === 'terminal.session.revoked')).toBe(false);

    const release = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: releasePayload,
    });
    expect(release.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
    expect(database.audit.filter((row) => row.action === 'terminal.session.revoked')).toHaveLength(1);
  });
});
