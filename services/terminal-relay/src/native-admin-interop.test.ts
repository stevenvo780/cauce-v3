import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { NativeAdminCommandSchema, NativeAdminOutcomeSchema, type NativeAdminCommand, type NativeAdminOutcome, type NativePieceMutation } from '@cauce/protocol';
import { AgentConnection } from './agent-connection.js';
import { createBrowserHttpsServer } from './browser-leg.js';
import { FrameDecoder, FRAME_TAGS } from './framing.js';
import { setupGovernanceRelay } from './governance-relay.js';
import { agentHello } from './relay-test-fixtures.js';

const python = `
import json, sys
from unittest.mock import patch
from uuid import UUID
from cauce_pty_agent.agent import PtyAgent
from cauce_pty_agent.framing import FrameDecoder
with patch("cauce_pty_agent.agent.uuid.uuid4", return_value=UUID(sys.argv[2])):
    agent = PtyAgent(json.loads(sys.argv[1]))
if sys.argv[3] == "features":
    print(json.dumps(agent._features()))
    sys.exit(0)
agent.pending_writes = {"fixture": True} if sys.argv[3] == "blocked" else {}
agent.acknowledged = True
agent._queue = lambda frame: sys.stdout.buffer.write(frame)
for tag, payload in FrameDecoder().feed(sys.stdin.buffer.read()):
    agent._dispatch(tag, payload)
`;
let material: { directory: string; cert: Buffer; key: Buffer };
let directory: string; let profile: string; let home: string; let packaged: string;
let connection: AgentConnection; let port: number; let writes: number; let blocked: boolean; let features: string[];
let bundle: Record<string, unknown>;
let server: ReturnType<typeof createBrowserHttpsServer>;
const token = 'native-interop-fixture-token';
const identity = { generation: 'fixture-generation', container_id: 'fixture-container', writer_instance_id: '00000000-0000-4000-8000-000000000062' };
const content = '---\nname: native-proof\ndescription: Native interop fixture\n---\nRead carefully.\n';
const mutation: NativePieceMutation = { kind: 'skill', id: 'native-proof', action: 'put', expected_sha: null, value: { content } };
const operation = () => ({ operation_id: randomUUID(), operation_token: randomUUID(), operation_generation: randomUUID() });
function command(value: Record<string, unknown>): NativeAdminCommand {
  return NativeAdminCommandSchema.parse({ ...value, request_id: randomUUID(), identity });
}
function runAgent(mode: string, input?: Buffer): Buffer {
  return execFileSync('python3', ['-c', python, JSON.stringify(bundle), identity.writer_instance_id, mode],
    { input, cwd: directory, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONPATH: packaged }, timeout: 5000 });
}
function measuredFeatures(): string[] {
  const parsed: unknown = JSON.parse(runAgent('features').toString());
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('fixture features invalid');
  return parsed as string[];
}
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-native-mtls-'));
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
  material = { directory, cert: readFileSync(cert), key: readFileSync(key) };
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cauce-native-interop-')); home = join(directory, 'home'); profile = join(home, 'account'); packaged = join(directory, 'package');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const journal = join(directory, 'journal'); mkdirSync(journal, { mode: 0o700 });
  cpSync(resolve('ops/pty-agent/cauce_pty_agent'), join(packaged, 'cauce_pty_agent'), { recursive: true, filter: path => !path.includes('__pycache__') });
  writes = 0; blocked = false;
  const uid = process.geteuid?.(); if (uid === undefined) throw new Error('fixture requires POSIX uid');
  bundle = { tenant_id: 'Steven', alias: 'zeus', alias_key_hex: '00'.repeat(32), harness: 'codex', home,
    runtime_uid: uid, container_id: identity.container_id, generation: identity.generation,
    governance_journal_dir: journal, runtime_facts: { codex_home: profile } };
  features = measuredFeatures(); expect(features).toContain('native_admin_v1');
  const socket = { write: (frame: Buffer) => {
    writes += 1;
    const output = runAgent(blocked ? 'blocked' : 'ready', frame);
    for (const decoded of new FrameDecoder().push(output)) {
      expect(decoded.tag).toBe(FRAME_TAGS.NATIVE_ADMIN_RESULT); connection.handleFrame(decoded, () => Date.now());
    }
    return true;
  }, pause: () => undefined, resume: () => undefined, destroy: () => undefined };
  connection = new AgentConnection(socket as unknown as TLSSocket, agentHello({ alias: 'zeus', harness: 'codex', home,
    features, ...identity }), 'fixture', () => Date.now());
  server = createBrowserHttpsServer({ cert: material.cert, key: material.key, clientCa: material.cert });
  setupGovernanceRelay({ server, agents: { lookup: (tenant, alias) => tenant === 'Steven' && alias === 'zeus' ? connection : undefined }, token: async () => token });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); }); port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  connection.destroy('fixture_cleanup');
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); rmSync(directory, { recursive: true, force: true });
});
afterAll(() => { rmSync(material.directory, { recursive: true, force: true }); });
function call(native: NativeAdminCommand, options: { peer?: boolean; bearer?: string } = {}): Promise<{ status: number; outcome: NativeAdminOutcome }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', command: native });
    const req = request(`https://127.0.0.1:${String(port)}/v3/terminal/relay/native-admin`, { method: 'POST', ca: material.cert,
      ...(options.peer === false ? {} : { cert: material.cert, key: material.key }),
      headers: { authorization: `Bearer ${options.bearer ?? token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => {
        resolve({ status: res.statusCode ?? 500, outcome: NativeAdminOutcomeSchema.parse(JSON.parse(Buffer.concat(chunks).toString())) });
      });
    }); req.on('error', reject); req.end(payload);
  });
}
it('transports real CRUD over mTLS, TypeScript frames and the packaged Python dispatcher with durable readback', async () => {
  const prepared = await call(command({ op: 'prepare', mutation })); expect(prepared.outcome.type).toBe('plan');
  expect(existsSync(join(profile, 'skills'))).toBe(false);
  const op = operation(); const created = await call(command({ op: 'mutate', mutation, operation: op }));
  expect(created.status).toBe(200); expect(created.outcome.type).toBe('receipt');
  if (created.outcome.type !== 'receipt') throw new Error('fixture receipt missing');
  expect(readFileSync(created.outcome.path, 'utf8')).toBe(content);
  expect((await call(command({ op: 'status', mutation, operation: op }))).outcome).toEqual(created.outcome);
  expect((await call(command({ op: 'get', kind: 'skill', id: 'native-proof' }))).outcome).toMatchObject({ type: 'piece', piece: { value: { content }, sha: created.outcome.sha } });
  const removed = await call(command({ op: 'mutate', mutation: { kind: 'skill', id: 'native-proof', action: 'delete', expected_sha: created.outcome.sha }, operation: operation() }));
  expect(removed.outcome).toMatchObject({ type: 'receipt', sha: null }); expect(existsSync(created.outcome.path)).toBe(false);
  if (removed.outcome.type !== 'receipt') throw new Error('fixture delete receipt missing');
  expect(readFileSync(join(profile, '.cauce-native-admin', removed.outcome.backup_id + '.backup'), 'utf8')).toBe(content);
});
it('rejects missing mTLS identity and a wrong gateway token before invoking the PTY', async () => {
  await expect(call(command({ op: 'list', kind: 'skill' }), { peer: false })).rejects.toThrow();
  expect((await call(command({ op: 'list', kind: 'skill' }), { bearer: 'wrong' })).status).toBe(401);
  expect(writes).toBe(0); expect(existsSync(join(profile, '.cauce-native-admin'))).toBe(false);
});
it('fences capability and generation mismatches before touching the packaged writer', async () => {
  const current = command({ op: 'prepare', mutation });
  expect((await call({ ...current, identity: { ...identity, generation: 'replaced' } })).status).toBe(409);
  features.splice(0);
  expect((await call(current)).status).toBe(409); expect(writes).toBe(0);
});
it('blocks native mutations while the physical PTY has another governance write in flight', async () => {
  blocked = true;
  expect((await call(command({ op: 'mutate', mutation, operation: operation() }))).outcome).toEqual({ type: 'error', error: 'unavailable' });
  expect(existsSync(join(profile, 'skills/native-proof/SKILL.md'))).toBe(false);
});
it('starts the real packaged agent without a journal and omits native administration from hello', async () => {
  delete bundle.governance_journal_dir; features.splice(0, features.length, ...measuredFeatures());
  expect(features).not.toContain('native_admin_v1'); expect(features).not.toContain('write_quiescence_v1');
  expect((await call(command({ op: 'prepare', mutation }))).status).toBe(409); expect(writes).toBe(0);
});
it('starts the real packaged agent with an unsafe native profile and withholds the native capability', async () => {
  chmodSync(profile, 0o755); features.splice(0, features.length, ...measuredFeatures());
  expect(features).not.toContain('native_admin_v1'); expect(features).toContain('write_quiescence_v1');
  expect((await call(command({ op: 'prepare', mutation }))).status).toBe(409); expect(writes).toBe(0);
});
