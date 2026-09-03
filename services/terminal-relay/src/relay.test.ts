import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentRegistry } from './agent-leg.js';
import { parseAttachRequest } from './browser-leg.js';
import { loadRelayConfig } from './config.js';
import { parseSessionGrant } from './gateway-client.js';
import {
  MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS
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
  TEST_INTRUDER_CERTIFICATE,
  TEST_INTRUDER_PRIVATE_KEY,
  connectConsole,
  harnesses,
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
    expect(parseSessionGrant(JSON.stringify({ ...valid, mode: 'harness_rw' }))).toMatchObject({ mode: 'harness_rw' });
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_token: CLAIM_TOKEN.toUpperCase() }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({
      ...valid, claim_token: '12345678-1234-1234-8234-123456789abc',
    }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_epoch: 1 }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_epoch: '9223372036854775808' }))).toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, claim_lease_ms: 150_001, claim_lease_ttl_ms: 150_000 })))
      .toBeUndefined();
    expect(parseSessionGrant(JSON.stringify({ ...valid, extra: true }))).toBeUndefined();
    expect(parseSessionGrant('not json')).toBeUndefined();
  });
});

describe('agent admission and identity', () => {
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
