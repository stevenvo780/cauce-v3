import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupGovernanceRelay } from '../../../../terminal-relay/src/governance-relay.js';
import {
  registerAgentDocumentRoutes, type AgentFactsProbe, type TerminalAuditEntry,
} from '../agent-documents.routes.js';
import { HttpGovernanceRelayClient } from '../relay-governance-client.js';
import { SondaCompartida, sondaDiferida } from '../sonda-compartida.js';
import { TerminalRelayFactsProbe } from './relay-probe.js';
import type { RuntimeFacts } from './catalog.js';
import { tlsFenceAgentFixture } from './tls-fence-agent.fixtures.js';

const path = '/home/dev/.claude/CLAUDE.md';
const facts: RuntimeFacts = {
  harness: 'claude', home: '/home/dev', generation: 'measured-one', containerId: 'container-one',
};
const before = '# Manual anterior\n';
const after = '# Manual corregido\n';
const token = 'isolated-fence-test-token';
const url = '/v3/console/tenants/Miguel/agents/kant/documents/directive/content';
const sha = (content: string): string => createHash('sha256').update(content).digest('hex');
let directory: string;
let cert: Buffer;
let key: Buffer;
let relay: Server | undefined;
let app: FastifyInstance | undefined;
let fleet: Awaited<ReturnType<typeof tlsFenceAgentFixture>> | undefined;
let disk: string;
let audit: TerminalAuditEntry[];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cauce-route-fence-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
  cert = readFileSync(join(directory, 'cert.pem'));
  key = readFileSync(join(directory, 'key.pem'));
});
afterEach(async () => {
  await app?.close(); app = undefined;
  await new Promise<void>((resolve, reject) => {
    if (relay === undefined) { resolve(); return; }
    relay.close((error) => { if (error) reject(error); else resolve(); });
    relay.closeAllConnections();
  });
  relay = undefined;
  await fleet?.close(); fleet = undefined;
});
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

async function server(options: {
  measured?: RuntimeFacts;
  replace?: { generation: string; containerId: string };
  legacyProbe?: boolean;
} = {}): Promise<SondaCompartida> {
  disk = join(directory, 'manual.md'); audit = [];
  writeFileSync(disk, before);
  fleet = await tlsFenceAgentFixture({ cert, key, directory, disk, path });
  await fleet.reconnect();
  const currentFleet = fleet;
  let relayRequests = 0;
  relay = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true });
  setupGovernanceRelay({ server: relay, timeoutMs: 1000, agents: currentFleet.leg, token: async () => {
    relayRequests += 1;
    if (relayRequests === 2 && options.replace) {
      await currentFleet.reconnect(options.replace.generation, options.replace.containerId);
    }
    return token;
  } });
  await new Promise<void>((resolve) => relay?.listen(0, '127.0.0.1', resolve));
  const client = new HttpGovernanceRelayClient({ relayUrl: `https://127.0.0.1:${String((relay.address() as AddressInfo).port)}`,
    token, ca: cert, clientCert: cert, clientKey: key, timeoutMs: 2000 });
  const measured = options.measured ?? facts;
  const probe = new TerminalRelayFactsProbe({ factsFor: async () => ({ facts: measured, source: 'measured' }) }, client);
  const slot = new SondaCompartida();
  app = Fastify();
  registerAgentDocumentRoutes(app, {
    authorize: async () => ({ tenant_id: 'Steven', alias: 'zeus' }),
    resolveOperator: () => ({ operator_id: 'isolated-operator', attributed: true }),
    authorizeTarget: async (_actor, tenant_id, alias) => ({ tenant_id, alias, enabled: true }),
    probe: sondaDiferida(slot), recordAudit: async (entry) => { audit.push(entry); },
  });
  const installed: AgentFactsProbe = options.legacyProbe ? {
    factsFor: probe.factsFor.bind(probe), readGovernanceDocument: probe.readGovernanceDocument.bind(probe),
    listMemoryDirectory: probe.listMemoryDirectory.bind(probe),
    writeGovernanceDocument: probe.writeGovernanceDocument.bind(probe),
  } : probe;
  slot.instalar(installed);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return slot;
}

async function put(extra: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const address = app?.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${String(address.port)}${url}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: after, expected_sha: sha(before), reason: 'corrijo el manual aislado', ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

describe('PUT HTTP → sonda diferida → relay HTTPS con destino medido', () => {
  it('escribe los bytes y conserva ACK y auditoría cuando la conexión no cambia', async () => {
    await server();
    expect(await put()).toMatchObject({ status: 202, body: { state: 'written_pending_session', path, sha: sha(after) } });
    expect(readFileSync(disk, 'utf8')).toBe(after);
    expect(fleet?.writes).toBe(1);
    expect(audit).toMatchObject([{ action: 'agent_document.write', decision: 'allow', metadata: { target_tenant: 'Miguel', target_alias: 'kant' } }]);
  });

  it.each([
    ['new-generation', 'container-one'], ['measured-one', 'new-container'],
  ])('rechaza reconexión %s/%s después del preflight sin enviar WRITE', async (generation, containerId) => {
    await server({ replace: { generation, containerId } });
    expect(await put()).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(readFileSync(disk, 'utf8')).toBe(before);
    expect(fleet?.writes).toBe(0);
    expect(audit).toMatchObject([{ action: 'agent_document.denied', decision: 'deny', metadata: { reason: 'conflict' } }]);
  });

  it.each([
    { harness: 'claude' as const, home: '/home/dev' },
    { ...facts, generation: '' }, { ...facts, containerId: '' },
  ])('rechaza medición incompleta %# sin abrir el escritor', async (measured) => {
    await server({ measured });
    expect(await put()).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(readFileSync(disk, 'utf8')).toBe(before);
    expect(fleet?.writes).toBe(0);
  });

  it('una sonda antigua falla 503 sin degradar a escritura legacy', async () => {
    await server({ legacyProbe: true });
    expect(await put()).toMatchObject({ status: 503, body: { error: 'unavailable' } });
    expect(readFileSync(disk, 'utf8')).toBe(before);
    expect(fleet?.writes).toBe(0);
  });

  it('el navegador no puede reemplazar autoridad medida con expected_target', async () => {
    await server();
    expect(await put({ expected_target: { generation: 'new-generation', container_id: 'new-container', path } }))
      .toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect(readFileSync(disk, 'utf8')).toBe(before);
    expect(fleet?.writes).toBe(0);
  });
});
