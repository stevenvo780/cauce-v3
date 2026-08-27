import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentRegistry } from './agent-leg.js';
import { parseAttachRequest } from './browser-leg.js';
import { loadRelayConfig } from './config.js';
import { parseSessionGrant } from './gateway-client.js';
import {
  CLOSE_CODES, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS
} from './sessions.js';
import {
  AGENT_FINGERPRINT,
  CLAIM_TOKEN,
  FakePtyAgent,
  grant,
  RELAY_INSTANCE_ID,
  SESSION_ID,
  TEST_AGENT_CERTIFICATE,
  TEST_AGENT_PRIVATE_KEY,
  TEST_CONSOLE_CERTIFICATE,
  TEST_CONSOLE_PRIVATE_KEY,
  TEST_INTRUDER_CERTIFICATE,
  TEST_INTRUDER_PRIVATE_KEY,
  attach,
  connectConsole,
  harnesses,
  resume,
  startHarness,
  wait,
  waitFor,
} from './relay-test-fixtures.js';


afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close();
});

describe('relay configuration and identity registry', () => {
  it('fills the documented defaults and refuses a gateway URL that is not plain HTTPS', () => {
    const environment: NodeJS.ProcessEnv = {
      CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: '/run/tls/cert.pem',
      CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: '/run/tls/key.pem',
      CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: '/run/tls/console-ca.pem',
      CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: '/run/tls/agent-ca.pem',
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: '/run/secrets/relay-token',
      CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: '/run/tls/gateway-client.pem',
      CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: '/run/tls/gateway-client-key.pem',
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: RELAY_INSTANCE_ID,
    };
    const config = loadRelayConfig(environment);
    expect(config).toMatchObject({
      browserPort: 8446,
      agentPort: 8445,
      healthPort: 8085,
      consoleCommonNames: ['console'],
      agentRegistryFile: '/run/cauce-terminal/pty_agent_identities.json',
      gatewayUrl: 'https://gateway:8443',
      idleTimeoutMs: 600_000,
      authzIntervalMs: 30_000,
      authzGraceMs: 90_000,
      presenceMaxStaleMs: 30_000,
      expectedClaimLeaseMs: 150_000,
      maxSessions: 16
    });

    expect(loadRelayConfig({
      ...environment,
      CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console-client,gateway-client',
    }).consoleCommonNames).toEqual(['console-client', 'gateway-client']);
    for (const commonNames of [
      '', ',console', 'console,', 'console,,gateway', 'console,console',
      'console\nclient', `console-${'x'.repeat(128)}`, 'cónsola',
    ]) {
      expect(() => loadRelayConfig({
        ...environment, CAUCE_TERMINAL_RELAY_CONSOLE_CN: commonNames,
      })).toThrow();
    }
    expect(() => loadRelayConfig({ ...environment, CAUCE_TERMINAL_GATEWAY_URL: 'http://gateway:8443' })).toThrow();
    expect(() => loadRelayConfig({ ...environment, CAUCE_TERMINAL_GATEWAY_URL: 'https://user:pw@gateway:8443' })).toThrow();
    expect(() => loadRelayConfig({ ...environment, CAUCE_TERMINAL_RELAY_TOKEN_FILE: '' })).toThrow();
    expect(() => loadRelayConfig({ ...environment, CAUCE_TERMINAL_RELAY_INSTANCE_ID: '' })).toThrow();
    expect(() => loadRelayConfig({
      ...environment, CAUCE_TERMINAL_RELAY_INSTANCE_ID: RELAY_INSTANCE_ID.toUpperCase(),
    })).toThrow(/64 lowercase hexadecimal/u);
    expect(() => loadRelayConfig({
      ...environment, CAUCE_TERMINAL_RELAY_HEALTH_PORT: '8445',
    })).toThrow(/ports must be distinct/u);
    expect(() => loadRelayConfig({
      ...environment, CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '130',
    })).toThrow(/strictly exceed authz interval/u);
    expect(() => loadRelayConfig({
      ...environment,
      CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '60',
      CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '90',
    })).toThrow(/strictly exceed authz interval/u);
    expect(() => loadRelayConfig({
      ...environment, CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '301',
    })).toThrow(/strictly exceed authz interval/u);
  });

  it('acota la geometría del attach igual que un resize y rechaza valores no enteros', () => {
    const request = (cols: unknown, rows: unknown) => Buffer.from(JSON.stringify({
      type: 'attach', session_id: SESSION_ID, ticket: 'opaque-ticket', cols, rows
    }));
    expect(parseAttachRequest(request(1, 1), false)).toMatchObject({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(parseAttachRequest(request(9_999, 9_999), false)).toMatchObject({ cols: MAX_COLS, rows: MAX_ROWS });
    expect(parseAttachRequest(request(80.5, 24), false)).toBeUndefined();
    expect(parseAttachRequest(request('80', 24), false)).toBeUndefined();
  });

  it('requires a complete canonical prior fence on resume and keeps bigint epochs as text', () => {
    const request = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
      type: 'resume', session_id: SESSION_ID, resume_token: 'r'.repeat(100),
      prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '9007199254740994',
      after_bytes: 0, cols: 80, rows: 24, ...overrides,
    }));
    expect(parseAttachRequest(request(), false)).toMatchObject({
      prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '9007199254740994',
    });
    expect(parseAttachRequest(request({ prior_claim_token: undefined }), false)).toBeUndefined();
    expect(parseAttachRequest(request({ prior_claim_token: CLAIM_TOKEN.toUpperCase() }), false)).toBeUndefined();
    expect(parseAttachRequest(request({ prior_claim_epoch: 1 }), false)).toBeUndefined();
    expect(parseAttachRequest(request({ prior_claim_epoch: '9223372036854775808' }), false)).toBeUndefined();
  });

  it('admits nobody when the identity registry cannot be read or parsed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-relay-registry-'));
    try {
      expect((await loadAgentRegistry(join(directory, 'absent.json'))).size).toBe(0);
      const malformed = join(directory, 'malformed.json');
      await writeFile(malformed, '{"version":2,"agents":[]}', 'utf8');
      expect((await loadAgentRegistry(malformed)).size).toBe(0);
      const partial = join(directory, 'partial.json');
      await writeFile(partial, JSON.stringify({ version: 1, agents: [{ tenant_id: 'Steven', alias: 'jarvis' }] }), 'utf8');
      expect((await loadAgentRegistry(partial)).size).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats a grant it cannot fully understand as no grant at all', () => {
    const valid = {
      ...grant(), ok: true, expires_at: new Date(Date.now() + 30_000).toISOString(),
      claim_taken_over: false,
    };
    expect(parseSessionGrant(JSON.stringify(valid))).toMatchObject({ alias: 'jarvis', container: 'claw' });
    expect(parseSessionGrant(JSON.stringify({ ...valid, runtime_user: undefined }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, mode: 'root' }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_token: CLAIM_TOKEN.toUpperCase() }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_epoch: 1 }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_epoch: '9223372036854775808' }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_lease_ms: 150_001, claim_lease_ttl_ms: 150_000 })))
      .toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, extra: true }))).toBeUndefined();
    expect(parseSessionGrant('not json')).toBeUndefined();
  });
});

describe('terminal relay circuit', () => {
  it('runs a shell end to end: ready as text, PTY output as binary, typing reaching the agent', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await waitFor(() => agent.helloAck !== undefined);
    expect(agent.helloAck).toEqual({ ok: true });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    expect(harness.leg.presence()[0]).toMatchObject({ alias: 'jarvis', container_id: 'claw', runtime_user: 'claw' });
    // Un agente que no manda `home` conserva su presencia entera: sin esto, exigirlo lo dejaría
    // fuera de la consola en cuanto se desplegara el relay antes que el agente.
    expect(harness.leg.presence()[0]?.home).toBeUndefined();
    // Presence is announced on connect, not only on the next tick: the console must not show an
    // agent that is up as "no PTY agent" for ten seconds.
    expect(harness.presenceChanges.count).toBe(1);

    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.text.length > 0);
    expect(client.text[0]).toMatchObject({
      type: 'ready', session_id: SESSION_ID, alias: 'jarvis', container: 'claw', runtime_user: 'claw', mode: 'shell'
    });
    expect(agent.opens[0]).toMatchObject({ session_id: SESSION_ID, mode: 'shell', cols: 120, rows: 40 });

    agent.emit('claw@jarvis:~$ ');
    await waitFor(() => client.binary.length > 0);
    expect(client.binary[0]?.toString()).toBe('claw@jarvis:~$ ');

    client.socket.send(JSON.stringify({ type: 'input', data: 'id -un\r' }));
    await waitFor(() => agent.stdin.length > 0);
    expect(agent.stdin[0]?.toString()).toBe('id -un\r');
    await waitFor(() => client.binary.length > 1);
    expect(client.binary[1]?.toString()).toBe('id -un\r');
    // Control never arrives as binary and output never arrives as text: that split is the contract.
    expect(client.text).toHaveLength(1);

    agent.exit(0);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.normal);
    expect(harness.gateway.closeReports[0]).toMatchObject({ reason: 'exited', exit_code: 0, bytes_in: 7 });
  });

  it('public reconnect reattaches the same PTY and a concurrent replay cannot own a second socket', async () => {
    const harness = await startHarness({ reconnectGraceMs: 1_000 });
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY,
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw',
      generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell'],
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    const first = await connectConsole(harness.browserPort);
    attach(first);
    await waitFor(() => first.text.some((frame) => frame.type === 'ready'));
    agent.emit('scrollback-tail');
    await waitFor(() => first.binary.length > 0);
    const ready = first.text.find((frame) => frame.type === 'ready');
    const priorFence = {
      prior_claim_token: ready?.claim_token,
      prior_claim_epoch: ready?.claim_epoch,
    };
    first.socket.terminate();
    await waitFor(() => first.closes.length > 0);

    const winner = await connectConsole(harness.browserPort);
    resume(winner, priorFence);
    await waitFor(() => winner.text.some((frame) => frame.type === 'ready'));
    expect(winner.text[0]).toMatchObject({ type: 'ready', resumed: true, stream_offset: 0 });
    await waitFor(() => winner.binary.length > 0);
    expect(winner.binary[0]?.toString()).toBe('scrollback-tail');

    const replay = await connectConsole(harness.browserPort);
    resume(replay, priorFence);
    await waitFor(() => replay.closes.length > 0);
    expect(replay.closes[0]).toEqual({ code: CLOSE_CODES.session_conflict, reason: 'resume_conflict' });
    expect(agent.opens).toHaveLength(1);
    expect(harness.gateway.consumeCalls).toBe(1);
    expect(harness.gateway.resumeCalls).toBe(2);
  });

  it('never adopts a browser fence after relay restart and closes only its new takeover generation', async () => {
    const harness = await startHarness();
    const client = await connectConsole(harness.browserPort);
    resume(client, { prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '7' });

    await waitFor(() => client.closes.length > 0 && harness.gateway.closeReports.length > 0);

    expect(client.closes[0]).toEqual({
      code: CLOSE_CODES.session_conflict, reason: 'resume_conflict',
    });
    expect(harness.gateway.resumeClaims).toHaveLength(1);
    const attempted = harness.gateway.resumeClaims[0]!;
    expect(attempted.token).not.toBe(CLAIM_TOKEN);
    expect(attempted.epoch).toBeUndefined();
    expect(harness.gateway.closeReports[0]).toMatchObject({
      reason: 'relay_state_lost', claim_token: attempted.token, claim_epoch: '1',
    });
  });

  it('a second relay conflict never closes the live generation owned by the first relay', async () => {
    const harness = await startHarness();
    harness.gateway.resume = { status: 'conflict', retry_after_ms: 25 };
    const client = await connectConsole(harness.browserPort);
    resume(client, { prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '7' });

    await waitFor(() => client.closes.length > 0);

    expect(client.closes[0]).toEqual({
      code: CLOSE_CODES.session_conflict, reason: 'conflict',
    });
    expect(harness.gateway.resumeClaims[0]?.token).not.toBe(CLAIM_TOKEN);
    expect(harness.gateway.resumeClaims[0]?.epoch).toBeUndefined();
    expect(harness.gateway.closeReports).toHaveLength(0);
  });

  it('rejects a browser Origin mismatch before consuming or resuming a credential', async () => {
    const harness = await startHarness();
    await expect(connectConsole(
      harness.browserPort,
      { cert: TEST_CONSOLE_CERTIFICATE, key: TEST_CONSOLE_PRIVATE_KEY },
      'https://attacker.invalid',
    )).rejects.toThrow();
    expect(harness.gateway.consumeCalls).toBe(0);
    expect(harness.gateway.resumeCalls).toBe(0);
  });

  it('lleva DA/DSR por su tag end-to-end en harness y corta cualquier STDIN humano', async () => {
    const harness = await startHarness();
    harness.gateway.consume = { status: 'granted', grant: grant({ mode: 'harness' }) };
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['harness']
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.text.length > 0);

    client.socket.send(JSON.stringify({ type: 'terminal_response', data: '\x1b[?1;2c\x1b[24;80R' }));
    await waitFor(() => agent.terminalResponses.length > 0);
    expect(agent.terminalResponses[0]?.toString('ascii')).toBe('\x1b[?1;2c\x1b[24;80R');
    expect(agent.stdin).toHaveLength(0);

    client.socket.send(JSON.stringify({ type: 'input', data: 'yes\r' }));
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.protocol_error, reason: 'input_forbidden' });
    expect(agent.stdin).toHaveLength(0);
  });

  it('closes with 4400 when the first frame is not a valid attach', async () => {
    const harness = await startHarness();
    const client = await connectConsole(harness.browserPort);
    client.socket.send(JSON.stringify({ type: 'input', data: 'ls' }));
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.protocol_error, reason: 'protocol_error' });
  });

  it('closes with 4400 when the attach carries no ticket', async () => {
    const harness = await startHarness();
    const client = await connectConsole(harness.browserPort);
    attach(client, { ticket: '' });
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.protocol_error);
  });

  it('closes with 4400 when no attach arrives inside the handshake window', async () => {
    const harness = await startHarness();
    const client = await connectConsole(harness.browserPort);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.protocol_error, reason: 'attach_timeout' });
  });

  it('closes with 4401 when the gateway refuses to consume the ticket', async () => {
    const harness = await startHarness();
    harness.gateway.consume = { status: 'ticket_invalid' };
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.ticket_invalid);
  });

  it('closes with 4409 when the ticket was already consumed', async () => {
    const harness = await startHarness();
    harness.gateway.consume = { status: 'conflict' };
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.session_conflict);
  });

  it('reserves an initial sid before consume and never lets concurrent or active losers close the winner', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY,
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw',
      generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw',
      agent_version: '0.1.0', modes: ['shell'],
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    let releaseConsume!: () => void;
    harness.gateway.consumeGate = new Promise<void>((resolve) => { releaseConsume = resolve; });

    const winner = await connectConsole(harness.browserPort);
    attach(winner);
    await waitFor(() => harness.gateway.consumeCalls === 1);
    const concurrent = await connectConsole(harness.browserPort);
    attach(concurrent);
    await waitFor(() => concurrent.closes.length > 0);
    expect(concurrent.closes[0]).toEqual({
      code: CLOSE_CODES.session_conflict,
      reason: 'session_conflict',
    });
    expect(harness.gateway.consumeCalls).toBe(1);
    expect(harness.gateway.closeReports).toHaveLength(0);

    releaseConsume();
    await waitFor(() => winner.text.some((frame) => frame.type === 'ready'));
    const activeDuplicate = await connectConsole(harness.browserPort);
    attach(activeDuplicate);
    await waitFor(() => activeDuplicate.closes.length > 0);
    expect(activeDuplicate.closes[0]).toEqual({
      code: CLOSE_CODES.session_conflict,
      reason: 'session_conflict',
    });
    expect(harness.gateway.consumeCalls).toBe(1);
    expect(harness.gateway.closeReports).toHaveLength(0);
    expect(harness.sessions.hasSession(SESSION_ID)).toBe(true);

    winner.socket.send(JSON.stringify({ type: 'input', data: 'still-alive\r' }));
    await waitFor(() => agent.stdin.length > 0);
    expect(agent.stdin.at(-1)?.toString()).toBe('still-alive\r');
  });

  it('releases the reservation after an ambiguous consume response so an exact retry can recover', async () => {
    const harness = await startHarness();
    await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY,
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw',
      generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw',
      agent_version: '0.1.0', modes: ['shell'],
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    harness.gateway.consume = { status: 'unavailable' };
    const ambiguous = await connectConsole(harness.browserPort);
    attach(ambiguous);
    await waitFor(() => ambiguous.closes.length > 0);
    expect(ambiguous.closes[0]?.code).toBe(CLOSE_CODES.internal_error);
    expect(harness.gateway.consumeCalls).toBeGreaterThan(1);
    expect(new Set(harness.gateway.consumeClaimTokens).size).toBe(1);
    expect(harness.gateway.closeReports).toHaveLength(0);

    const ambiguousCalls = harness.gateway.consumeCalls;
    const retainedClaim = harness.gateway.consumeClaimTokens[0];
    harness.gateway.consume = { status: 'granted', grant: grant() };
    const recovered = await connectConsole(harness.browserPort);
    attach(recovered);
    await waitFor(() => recovered.text.some((frame) => frame.type === 'ready'));
    expect(harness.gateway.consumeCalls).toBe(ambiguousCalls + 1);
    expect(harness.gateway.consumeClaimTokens.at(-1)).toBe(retainedClaim);
    expect(harness.sessions.hasSession(SESSION_ID)).toBe(true);
  });

  it('closes with 4403 when the gateway forbids the attribution', async () => {
    const harness = await startHarness();
    harness.gateway.consume = { status: 'forbidden' };
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.revoked);
  });

  it('closes with 4404 instead of hanging when the alias has no PTY agent', async () => {
    const harness = await startHarness();
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.agent_offline, reason: 'agent_offline' });
    await waitFor(() => harness.gateway.closeReports.length > 0);
    expect(harness.gateway.closeReports[0]).toMatchObject({ reason: 'agent_offline', bytes_in: 0, bytes_out: 0 });
  });

  it('cierra el ticket si el browser desaparece mientras consume y no crea una sesión fantasma', async () => {
    const harness = await startHarness();
    let releaseConsume!: () => void;
    harness.gateway.consumeGate = new Promise<void>((resolve) => { releaseConsume = resolve; });
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => harness.gateway.consumeCalls === 1);
    client.socket.close(1000, 'gone_during_consume');
    await waitFor(() => client.closes.length > 0);
    releaseConsume();
    await waitFor(() => harness.gateway.closeReports.length > 0);
    expect(harness.gateway.closeReports[0]).toMatchObject({ reason: 'browser_closed', bytes_in: 0, bytes_out: 0 });
    expect(harness.sessions.size).toBe(0);
  });

  it('acota la entrada que llega mientras consume el ticket y libera la plaza al cortar el flood', async () => {
    const harness = await startHarness();
    let releaseConsume!: () => void;
    harness.gateway.consumeGate = new Promise<void>((resolve) => { releaseConsume = resolve; });
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => harness.gateway.consumeCalls === 1);

    const chunk = JSON.stringify({ type: 'input', data: 'x'.repeat(16 * 1024) });
    for (let index = 0; index < 9; index += 1) client.socket.send(chunk);
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.input_flood, reason: 'input_flood' });

    releaseConsume();
    await waitFor(() => harness.gateway.closeReports.length > 0);
    expect(harness.gateway.closeReports[0]).toMatchObject({ reason: 'browser_closed', bytes_in: 0, bytes_out: 0 });
    expect(harness.sessions.size).toBe(0);
  });

  it('closes the live session with 4403 within one revalidation once the grant is revoked', async () => {
    const harness = await startHarness({ authzIntervalMs: 25 });
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.text.length > 0);

    harness.gateway.authz = { status: 'revoked' };
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.revoked);
    // The agent is told to tear the PTY down; the shell does not outlive the permission.
    await waitFor(() => agent.closes.length > 0);
    expect(agent.closes[0]).toMatchObject({ session_id: SESSION_ID, reason: 'revoked' });
  });

  it('fails closed when the gateway cannot be reached past the grace window', async () => {
    const harness = await startHarness({ authzIntervalMs: 20, authzGraceMs: 50 });
    await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.text.length > 0);

    harness.gateway.authz = { status: 'unreachable' };
    await waitFor(() => client.closes.length > 0);
    expect(client.closes[0]).toEqual({ code: CLOSE_CODES.revoked, reason: 'authz_unreachable' });
  });

  it('warns and then closes with 4413 when the PTY floods the browser', async () => {
    const harness = await startHarness({ outputRateBytesPerSec: 1_000, outputWindowMs: 20 });
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await waitFor(() => harness.leg.lookup('Steven', 'jarvis') !== undefined);
    const client = await connectConsole(harness.browserPort);
    attach(client);
    await waitFor(() => client.text.length > 0);

    const flood = setInterval(() => agent.emit('A'.repeat(4_096)), 5);
    try {
      await waitFor(() => client.text.some((frame) => frame.type === 'notice' && frame.level === 'warn'));
      await waitFor(() => client.closes.length > 0);
      expect(client.closes[0]?.code).toBe(CLOSE_CODES.output_flood);
    } finally {
      clearInterval(flood);
    }
  });

  it('never admits an agent whose fingerprint is not in the registry', async () => {
    const harness = await startHarness();
    const intruder = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_INTRUDER_CERTIFICATE, key: TEST_INTRUDER_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await wait(150);
    expect(intruder.helloAck).toBeUndefined();
    expect(harness.leg.lookup('Steven', 'jarvis')).toBeUndefined();
    expect(harness.leg.presence()).toHaveLength(0);
  });

  it('refuses an agent that claims an alias its certificate does not own', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Miguel', alias: 'kratos', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await waitFor(() => agent.helloAck !== undefined);
    expect(agent.helloAck).toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(harness.leg.lookup('Miguel', 'kratos')).toBeUndefined();
    expect(harness.leg.lookup('Steven', 'jarvis')).toBeUndefined();
  });

  it('admits nobody when the identity registry is missing or expired', async () => {
    const harness = await startHarness();
    await harness.writeRegistry([{
      fingerprint_sha256: AGENT_FINGERPRINT,
      tenant_id: 'Steven',
      alias: 'jarvis',
      expires_at: new Date(Date.now() - 1_000).toISOString()
    }]);
    const expired = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    });
    await wait(150);
    expect(expired.helloAck).toBeUndefined();
    expect(harness.leg.lookup('Steven', 'jarvis')).toBeUndefined();
  });

  it('rejects a console connection whose client certificate is not the console CN', async () => {
    const harness = await startHarness();
    await expect(connectConsole(harness.browserPort, {
      cert: TEST_INTRUDER_CERTIFICATE, key: TEST_INTRUDER_PRIVATE_KEY
    })).rejects.toThrow();
  });

  it('replaces a superseded agent connection instead of keeping two', async () => {
    const harness = await startHarness();
    const hello = {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell']
    };
    const first = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, hello);
    await waitFor(() => first.helloAck !== undefined);
    const second = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, { ...hello, generation: '9f21a70b4c5d6e7f8091a2b3c4d5e6f7' });
    await waitFor(() => second.helloAck !== undefined);
    await waitFor(() => harness.leg.presence().length === 1);
    expect(harness.leg.presence()[0]).toMatchObject({ generation: '9f21a70b4c5d6e7f8091a2b3c4d5e6f7' });
  });

  it('propaga el home del agente hasta la presencia que publica al gateway', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell'],
      runtime_facts_observed: true, home: '/home/claw',
      openclaw_workspace: '/home/claw/workspace', cwd: '/home/claw/workspace/project',
      workspace_root: '/home/claw/workspace', project_root: '/home/claw/workspace/project',
    });
    await waitFor(() => agent.helloAck !== undefined);
    expect(agent.helloAck).toEqual({ ok: true });
    await waitFor(() => harness.leg.presence().length === 1);
    expect(harness.leg.presence()[0]?.home).toBe('/home/claw');
    expect(harness.leg.presence()[0]).toMatchObject({
      cwd: '/home/claw/workspace/project', workspace_root: '/home/claw/workspace',
      project_root: '/home/claw/workspace/project',
    });
  });

  it('propaga la proyección allowlisted de config.toml sin publicar el resto', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'codex', agent_version: '0.6.0', modes: ['harness'],
      runtime_facts_observed: true, home: '/home/claw', codex_home: '/home/claw/.codex',
      project_doc_max_bytes: 65_536,
      project_doc_fallback_filenames: ['TEAM.md'],
    });
    await waitFor(() => agent.helloAck !== undefined);
    await waitFor(() => harness.leg.presence().length === 1);
    expect(harness.leg.presence()[0]).toMatchObject({
      runtime_facts_observed: true,
      project_doc_max_bytes: 65_536,
      project_doc_fallback_filenames: ['TEAM.md'],
    });
  });

  it('un home que no es ruta absoluta no invalida el saludo: el alias conserva sus terminales', async () => {
    const harness = await startHarness();
    const agent = await FakePtyAgent.connect(harness.agentPort, {
      cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY
    }, {
      v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: '6364e6cc38930893688a8d19cb7a32ba', image_id: 'sha256:abc',
      runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '0.1.0', modes: ['shell'],
      home: 'home/claw'
    });
    await waitFor(() => agent.helloAck !== undefined);
    expect(agent.helloAck).toEqual({ ok: true });
    await waitFor(() => harness.leg.presence().length === 1);
    expect(harness.leg.presence()[0]?.home).toBeUndefined();
  });
});
