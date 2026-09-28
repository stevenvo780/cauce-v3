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
import { AGENT_STALE_AFTER_MS, AgentRegistry } from './terminal/registry.js';
import { deriveAliasKey, verifyTicketSignature } from './terminal/tickets.js';
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
  fakeDatabase,
  presence,
  RELAY_BOOT_B,
  type FakeDatabase,
} from './terminal.plugin.shared.js';

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

  async function build(overrides: Partial<TerminalConfig> = {}, provider = consoleAuthProvider()): Promise<void> {
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
      session_expires_at: string;
      claim_token: string;
      claim_epoch: string;
    }>();
    return {
      sessionId: issued.session_id,
      ticket: issued.ticket,
      resumeToken: grant.resume_token,
      sessionExpiresAt: grant.session_expires_at,
      claimToken: grant.claim_token,
      claimEpoch: grant.claim_epoch,
    };
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

  it('lists only control-visible aliases with an explicit PTY state and never leaks another tenant', async () => {
    await report([presence()]);
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      websocket_path: string;
      items: Record<string, unknown>[];
    }>();
    expect(body.websocket_path).toBe('/v3/console/terminal/ws');
    // Steven plus the one ACL-visible tenant Miguel. Pablo/Isa/Jhon remain absent rather than
    // leaking their identities and shared-container cohorts as unauthorized rows.
    expect(body.items).toHaveLength(9);
    for (const item of body.items) {
      expect(['online', 'agent_offline', 'not_installed', 'unknown']).toContain(item.pty_state);
      expect(typeof item.reason).toBe('string');
      expect((item.reason as string).length).toBeGreaterThan(0);
    }
    const jarvis = body.items.find((item) => item.alias === 'jarvis');
    expect(jarvis).toMatchObject({
      pty_state: 'online', authorized: true, container: 'claw', runtime_user: 'claw',
      harness: 'openclaw', image: 'sha256:c0ffee', shares_container_with: [], modes: ['shell', 'harness'], writable_modes: ['shell']
    });
    const argos = body.items.find((item) => item.alias === 'argos');
    // argos shares ctrl-infra with kant and no agent was ever reported there.
    expect(argos).toMatchObject({
      pty_state: 'not_installed', authorized: false,
      shares_container_with: [{ tenant_id: 'Steven', alias: 'kant' }]
    });
    const iza = body.items.find((item) => item.alias === 'iza');
    // Miguel is visible through the test ACL; without operator attribution, opening is still
    // denied, but its cohort is legitimate read/control-visible metadata.
    expect(iza).toMatchObject({
      authorized: false, container: null, runtime_user: null, harness: null, image: null, modes: [], writable_modes: [],
      reason: 'attribution_required: sin identidad por persona para alcanzar Miguel:iza',
      shares_container_with: [
        { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' }
      ]
    });
    expect(body.items.some((item) => item.tenant_id === 'Pablo')).toBe(false);
    expect(body.items.some((item) => item.tenant_id === 'Isa')).toBe(false);
    expect(body.items.some((item) => item.tenant_id === 'Jhon')).toBe(false);
  });

  it('publishes a state-specific reason for every authorized PTY state', async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const jarvis = async (): Promise<Record<string, unknown>> => {
      const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
      expect(response.statusCode).toBe(200);
      const item = response.json<{ items: Record<string, unknown>[] }>().items.find(
        (candidate) => candidate.tenant_id === 'Steven' && candidate.alias === 'jarvis',
      );
      if (item === undefined) throw new Error('jarvis terminal target is unavailable');
      return item;
    };
    const expectAuthorizedState = (
      item: Record<string, unknown>,
      state: 'online' | 'agent_offline' | 'not_installed' | 'unknown',
      reason: string,
    ): void => {
      expect(item).toMatchObject({ authorized: true, pty_state: state, reason });
      if (state !== 'online') expect(item.reason).not.toBe('ok');
    };

    try {
      expectAuthorizedState(
        await jarvis(),
        'unknown',
        'El estado del agente PTY es desconocido: el terminal-relay todavía no publicó un snapshot verificable.',
      );

      await report([]);
      expectAuthorizedState(
        await jarvis(),
        'not_installed',
        'El agente PTY figura como no instalado: el terminal-relay nunca registró este destino en claw.',
      );

      await report([presence()]);
      expectAuthorizedState(
        await jarvis(),
        'online',
        'El agente PTY está conectado al terminal-relay.',
      );

      clock.mockReturnValue(now + AGENT_STALE_AFTER_MS + 1);
      expectAuthorizedState(
        await jarvis(),
        'agent_offline',
        'El agente PTY figura fuera de línea: no está conectado al terminal-relay.',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('redacts an entire shared cohort when any colocated identity is not control-visible', async () => {
    database.placements.push({
      tenant_id: 'Pablo', alias: 'oculto', container_name: 'claw', runtime_user: 'dev',
    });
    await report([presence()]);
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Record<string, unknown>[] }>().items;
    expect(items.some((item) => item.alias === 'oculto' || item.tenant_id === 'Pablo')).toBe(false);
    expect(items.find((item) => item.tenant_id === 'Steven' && item.alias === 'jarvis')).toMatchObject({
      authorized: false,
      container: null,
      shares_container_with: [],
      reason: 'no_routing_authority: sin autoridad de ruteo sobre Steven:jarvis',
    });
  });

  it('issues a verifiable ticket, records the operator reason and audits the allow', async () => {
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      session_id: string; ticket: string; websocket_path: string; ttl_seconds: number;
      target: Record<string, unknown>;
    }>();
    expect(body.ttl_seconds).toBe(30);
    expect(body.websocket_path).toBe(`/v3/console/terminal/relays/${RELAY_A}/ws`);
    expect(body.target).toEqual({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      mode: 'shell', shares_container_with: []
    });
    const payload = verifyTicketSignature(body.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    expect(payload).toMatchObject({
      v: 1, sid: body.session_id, op: UNATTRIBUTED_OPERATOR, sub: 'Steven:kant', mode: 'shell',
      tgt: { tenant: 'Steven', alias: 'jarvis', container: 'claw', generation: 'gen-7', uid: 1000, user: 'claw' }
    });
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant', decision: 'allow' });
    expect(allow?.metadata).toMatchObject({
      operator_id: UNATTRIBUTED_OPERATOR, attributed: false, target_alias: 'jarvis', container: 'claw',
      image_id: 'sha256:c0ffee', generation: 'gen-7', mode: 'shell',
      operator_reason: 'revisar el harness colgado', cols: 120, rows: 40
    });
    // Only the truncated digest of the ticket is ever persisted in the audit trail.
    expect(allow?.metadata.ticket_sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(allow?.metadata)).not.toContain(body.ticket);
  });

  it('reconstructs the exact issuance receipt after gateway restart and a lost 201', async () => {
    await report([presence()]);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const firstResponse = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json<{
      session_id: string; ticket: string; request_id: string; owner_generation: string;
      ttl_seconds: number;
    }>();
    expect(first).toMatchObject({
      request_id: requestId,
      owner_generation: '1',
      ttl_seconds: 30,
    });

    registry = new AgentRegistry();
    // A rollout can change the configured TTL between the lost response and its retry. The
    // recovered receipt must describe the historical ticket, not today's config.
    await build({ ticketTtlSeconds: 90 });
    await report([presence()]);
    const retriedResponse = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(retriedResponse.statusCode).toBe(201);
    expect(retriedResponse.json()).toMatchObject({
      session_id: first.session_id,
      ticket: first.ticket,
      receipt_recovered: true,
      request_id: requestId,
      owner_generation: '1',
      ttl_seconds: 30,
    });
    expect(database.sessions.size).toBe(1);
    expect(database.audit.filter((row) => row.action === 'terminal.session.request')).toEqual([
      expect.objectContaining({
        decision: 'allow', metadata: expect.objectContaining({ receipt_recovered: false }) as unknown,
      }),
      expect.objectContaining({
        decision: 'allow', metadata: expect.objectContaining({ receipt_recovered: true }) as unknown,
      }),
    ]);
  });

  it('never coalesces a new browser admission merely because every visible field is identical', async () => {
    await report([presence()]);
    const first = await openSession({});
    expect(first.statusCode).toBe(201);

    // A remount/reopen has a fresh request id even when the human entered the same reason and
    // dimensions. It must collide with the live container instead of adopting the first SID.
    const remount = await openSession({});
    expect(remount.statusCode).toBe(409);
    expect(remount.json()).toEqual({ error: 'conflict', reason: 'container_busy' });
    expect(database.sessions.size).toBe(1);
  });

  it('fails closed when a retry reuses request_id with another owner or altered semantics', async () => {
    await report([presence()]);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const first = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(first.statusCode).toBe(201);

    const otherOwner = await openSession({ request_id: requestId, owner_token: randomUUID() });
    expect(otherOwner.statusCode).toBe(409);
    expect(otherOwner.json()).toEqual({ error: 'conflict', reason: 'request_conflict' });

    const altered = await openSession({
      request_id: requestId,
      owner_token: ownerToken,
      reason: 'la misma solicitud con semantica alterada',
    });
    expect(altered.statusCode).toBe(409);
    expect(altered.json()).toEqual({ error: 'conflict', reason: 'request_conflict' });
    expect(database.sessions.size).toBe(1);
  });

  it('parses the exact admission shape and accepts the one-character AliasSchema boundary', async () => {
    await report([presence()]);
    const extra = await openSession({ unexpected: true });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: 'invalid_request' });
    expect(database.sessions.size).toBe(0);

    database.placements.push({
      tenant_id: 'Steven', alias: 'a', container_name: 'one-char', runtime_user: 'dev',
    });
    database.rooms['Steven:a'] = ['grp.steven'];
    await grant([{ tenant_id: 'Steven', alias: 'a', modes: ['shell'] }]);
    await report([presence({ alias: 'a', container_id: 'one-char', runtime_user: 'dev' })]);
    const boundary = await openSession({ alias: 'a' });
    expect(boundary.statusCode).toBe(201);
    expect(boundary.json()).toMatchObject({ target: { tenant_id: 'Steven', alias: 'a' } });
  });

  it('rolls issuance back when its audit insert fails and admits the retry cleanly', async () => {
    await report([presence()]);
    database.failNextAudit('terminal.session.request');

    const failed = await openSession({});
    expect(failed.statusCode).toBe(400);
    expect(database.sessions.size).toBe(0);
    expect(database.audit).toHaveLength(0);

    const retried = await openSession({});
    expect(retried.statusCode).toBe(201);
    expect(database.sessions.size).toBe(1);
  });

  it('makes hidden and absent POST targets indistinguishable without hidden cohort audit metadata', async () => {
    await report([presence()]);
    const hidden = await openSession({ tenant_id: 'Pablo', alias: 'dedalo' });
    const absent = await openSession({ tenant_id: 'Pablo', alias: 'no-existe' });
    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not_found' });
    expect(absent.json()).toEqual(hidden.json());
    for (const row of database.audit.slice(-2)) {
      expect(row.metadata).toMatchObject({ container: null, cohort: [], reason: 'target_unavailable' });
      expect(JSON.stringify(row.metadata)).not.toContain('ws-pablo');
      expect(JSON.stringify(row.metadata)).not.toContain('vulcano');
    }

    database.placements.push({
      tenant_id: 'Pablo', alias: 'oculto', container_name: 'claw', runtime_user: 'dev',
    });
    const hiddenCohort = await openSession({});
    expect(hiddenCohort.statusCode).toBe(404);
    expect(hiddenCohort.json()).toEqual({ error: 'not_found' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({
      container: null, cohort: [], reason: 'target_unavailable',
    });
    expect(JSON.stringify(database.audit.at(-1)?.metadata)).not.toContain('oculto');
  });

  it.each([
    { clockOffsetMs: -5_001, accepted: false },
    { clockOffsetMs: -5_000, accepted: true },
    { clockOffsetMs: 5_000, accepted: true },
    { clockOffsetMs: 5_001, accepted: false },
  ])(
    'applies the inclusive PostgreSQL clock boundary at $clockOffsetMs ms',
    async ({ clockOffsetMs, accepted }) => {
      await build({ ticketTtlSeconds: 3, sessionTtlSeconds: 3 });
      const gatewayNow = 1_800_000_000_000;
      const databaseNow = gatewayNow + clockOffsetMs;
      const localClock = vi.spyOn(Date, 'now').mockReturnValue(gatewayNow);
      try {
        database.clock.now = () => databaseNow;
        await report([presence()]);

        const opened = await openSession({});
        expect(opened.statusCode).toBe(accepted ? 201 : 503);
        if (!accepted) {
          expect(database.sessions.size).toBe(0);
          return;
        }
        const issued = opened.json<{ session_id: string; ticket: string; expires_at: string }>();
        const row = database.sessions.get(issued.session_id);
        expect(row?.issued_at.getTime()).toBe(databaseNow);
        expect(row?.expires_at.getTime()).toBe(databaseNow + 3_000);
        expect(issued.expires_at).toBe(new Date(databaseNow + 3_000).toISOString());
        expect(verifyTicketSignature(
          issued.ticket,
          deriveAliasKey(MASTER, 'Steven', 'jarvis'),
        )).toMatchObject({
          iat: Math.floor(databaseNow / 1_000),
          exp: Math.floor((databaseNow + 3_000) / 1_000),
        });
      } finally {
        localClock.mockRestore();
      }
    }
  );

  it('fails closed before insertion when PostgreSQL and the gateway exceed agent clock tolerance', async () => {
    database.clock.now = () => Date.now() + 60_000;
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'terminal_clock_skew',
      message: 'terminal issuance is unavailable until gateway and PostgreSQL clocks agree',
    });
    expect(database.sessions.size).toBe(0);
  });

  it('expires live authorization with the PostgreSQL clock, not the gateway wall clock', async () => {
    const databaseNow = Date.now();
    database.clock.now = () => databaseNow;
    const consumed = await issueAndConsume();
    database.clock.now = () => databaseNow + config.sessionTtlSeconds * 1_000 + 1;
    const response = await relaySessionRequest(consumed.sessionId, 'authz', {
      claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, reason: 'session_expired' });
  });

  it('refuses a reason shorter than eight characters', async () => {
    await report([presence()]);
    const response = await openSession({ reason: 'corto' });
    expect(response.statusCode).toBe(400);
    expect(database.audit).toHaveLength(0);
  });

  it('uses the tenant-qualified enabled registry and never resolves a bare alias across tenants', async () => {
    await report([presence()]);
    database.placements.push({
      tenant_id: 'Miguel', alias: 'jarvis', container_name: 'other-container', runtime_user: 'dev',
    });
    const wrongTenant = await openSession({ tenant_id: 'Miguel', alias: 'jarvis' });
    expect(wrongTenant.statusCode).toBe(403);
    expect(wrongTenant.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });

    const index = database.placements.findIndex((item) =>
      item.tenant_id === 'Steven' && item.alias === 'jarvis');
    expect(index).toBeGreaterThanOrEqual(0);
    database.placements.splice(index, 1); // models enabled=false because the SQL excludes it
    const disabled = await openSession({ tenant_id: 'Steven', alias: 'jarvis' });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.json()).toEqual({ error: 'not_found' });
  });

  it('HARD INVARIANT: an unattributed operator cannot reach another tenant, and the deny is audited', async () => {
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({ tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev' })]);
    const response = await openSession({ tenant_id: 'Miguel', alias: 'iza' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });
    expect(database.audit).toEqual([expect.objectContaining({
      action: 'terminal.session.request', decision: 'deny',
      metadata: expect.objectContaining({ reason: 'attribution_required', target_alias: 'iza' }) as unknown
    })]);
  });

  it('accepts a cross-tenant target once the console names an enrolled human operator', async () => {
    await build({ operators: new Set(['steven']) });
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{ target: Record<string, unknown> }>();
    // The dialog must be able to say out loud who else lives in that container.
    expect(body.target.shares_container_with).toEqual([
      { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' }
    ]);
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow?.metadata).toMatchObject({
      operator_id: 'steven', attributed: true,
      cohort: ['Miguel:atlas', 'Miguel:iza', 'Miguel:kratos']
    });
  });

  it('SET RULE: a grant on iza alone does not open the container shared with atlas and kratos', async () => {
    await build({ operators: new Set(['steven']) });
    await grant([{ tenant_id: 'Miguel', alias: 'iza', modes: ['shell'] }]);
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    expect(database.audit.at(-1)?.decision).toBe('deny');
  });

  it('denies every target when grants.json is missing, without restarting anything', async () => {
    await rm(grantsFile);
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    const targets = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(targets.json<{ items: { authorized: boolean }[] }>().items.every((item) => !item.authorized)).toBe(true);
  });

  it('refuses a target with no live pty-agent and reports why', async () => {
    const response = await openSession({});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'agent_offline' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({ reason: 'agent_offline', pty_state: 'unknown' });
  });

  it('fails closed when two authenticated relay instances advertise the same alias', async () => {
    await report([presence()]);
    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    await report([presence({ generation: 'gen-from-b' })]);

    const response = await openSession({});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'agent_offline' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({
      reason: 'agent_offline',
      routing_state: 'relay_ambiguous',
    });
    expect(database.sessions.size).toBe(0);
  });

  it('rejects a concurrent boot sharing one fresh certificate identity', async () => {
    await report([presence()]);
    relayBootId = RELAY_BOOT_B;
    const response = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { agents: [presence()] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, reason: 'relay_boot_conflict' });
    expect(registry.accepts({ relay_instance_id: RELAY_A, relay_boot_id: RELAY_BOOT_A })).toBe(true);
  });

  it('refuses when the database has withdrawn the control permission', async () => {
    await report([presence()]);
    controlPermission = () => Promise.reject(new Error('principal lacks control permission'));
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('revocar y robar un terminal pasan por la puerta de la BD, no solo por la de la sesion', async () => {
    // `requireOperatorPermission` mira la SESION; quien concede `control` es la base. Sin esta
    // comprobacion ambas rutas llegaban al CAS y contestaban 409, nunca 403.
    await report([presence()]);
    const abierta = (await openSession({})).json<{ session_id: string }>();
    controlPermission = () => Promise.reject(new Error('principal lacks control permission'));
    const prohibido = { error: 'forbidden', reason: 'control_permission_required' };
    const sid = abierta.session_id;
    const credencial = { owner_token: 'x'.repeat(43), request_id: randomUUID() };
    for (const [method, url, payload] of [
      ['POST', `/v3/console/terminal/sessions/${sid}/owner`, { expected_owner_generation: 1, ...credencial }],
      ['DELETE', `/v3/console/terminal/sessions/${sid}`, { owner_generation: 1, ...credencial }],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin: ORIGIN }, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(prohibido);
    }
  });

  it('caps concurrent sessions per operator', async () => {
    await build({ maxSessionsPerOperator: 1 });
    await report([presence()]);
    expect((await openSession({})).statusCode).toBe(201);
    const second = await openSession({ reason: 'una segunda tarea diferente' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'conflict', reason: 'session_limit' });
  });

  it('rejects a relay call without the shared token and says nothing about why', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: RELAY_TOKEN }]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/terminal/relay/agents', headers, payload: { agents: [] }
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe('');
    }
  });
});
