import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOSE_CODES
} from './sessions.js';
import {
  CLAIM_TOKEN,
  FakePtyAgent,
  grant,
  SESSION_ID,
  TEST_AGENT_CERTIFICATE,
  TEST_AGENT_PRIVATE_KEY,
  TEST_CONSOLE_CERTIFICATE,
  TEST_CONSOLE_PRIVATE_KEY,
  attach,
  connectConsole,
  harnesses,
  resume,
  startHarness,
  waitFor,
} from './relay-test-fixtures.js';

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close();
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
    expect(harness.leg.presence()[0]?.home).toBeUndefined();
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
    const attempted = harness.gateway.resumeClaims[0];
    if (!attempted) throw new Error('Attempted claim not found');
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

    const flood = setInterval(() => { agent.emit('A'.repeat(4_096)); }, 5);
    try {
      await waitFor(() => client.text.some((frame) => frame.type === 'notice' && frame.level === 'warn'));
      await waitFor(() => client.closes.length > 0);
      expect(client.closes[0]?.code).toBe(CLOSE_CODES.output_flood);
    } finally {
      clearInterval(flood);
    }
  });
});
