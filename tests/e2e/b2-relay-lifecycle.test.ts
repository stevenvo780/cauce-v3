import { createHash, randomUUID } from 'node:crypto';
import { chown, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { requireDockerLab } from '../integration/b2-lab.js';
import { persistCloseSpool } from '../../services/terminal-relay/src/session-spool.js';
import { startColdRelay } from './b2-relay-cold-start.js';

let fixture: RealPtyFixture;
const claims = new Map<string, string>();
const closePosts: { session: string; boot: unknown; digest: unknown; batches: unknown; capped: unknown; status: number }[] = [];

beforeAll(async () => {
  await requireDockerLab();
  fixture = await startRealPtyFixture({ tui: true, skipBrowser: true, owner: 'b2-relay',
    sessionTtlSeconds: 30, sessionMaxTotalSeconds: 60, idleTimeoutSeconds: 60, maxSessionsPerOperator: 1,
    configureGateway: async ({ app }) => {
      app.addHook('preHandler', async request => {
        const match = /^\/v3\/terminal\/relay\/sessions\/([^/]+)\/(consume|close)$/u.exec(request.url);
        if (!match || request.body === null || typeof request.body !== 'object') return;
        const body = request.body as Record<string, unknown>; const session = match[1] ?? '';
        if (match[2] === 'consume' && typeof body.claim_token === 'string') claims.set(session, body.claim_token);
      });
      app.addHook('onResponse', async (request, reply) => {
        const match = /^\/v3\/terminal\/relay\/sessions\/([^/]+)\/close$/u.exec(request.url);
        if (!match || request.body === null || typeof request.body !== 'object') return;
        const body = request.body as Record<string, unknown>;
        closePosts.push({ session: match[1] ?? '', boot: body.relay_boot_id,
          digest: body.recording_sha256, batches: body.input_batches, capped: body.recording_capped,
          status: reply.statusCode });
      });
    } });
}, 600_000);
afterAll(async () => { await fixture.close(); }, 90_000);

async function open(mode: 'shell' | 'harness_rw' = 'shell') {
  const auth = await fixture.login();
  await fixture.waitForTarget(auth.cookie);
  const requestId = randomUUID(); const ownerToken = randomUUID();
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: fixture.gatewayUrl };
  const requested = await fixture.request('/v3/console/terminal/sessions', { method: 'POST', headers,
    body: { tenant_id: fixture.tenant, alias: fixture.targetAlias, mode, cols: 100, rows: 30,
      request_id: requestId, owner_token: ownerToken } });
  expect(requested.status).toBe(201);
  const admission = JSON.parse(requested.body) as { session_id: string; ticket: string; authority_proof: string; owner_generation: string };
  const pty = await fixture.connect(admission.ticket, admission.session_id, admission.authority_proof, 100, 30);
  await pty.waitControl(frame => frame.type === 'ready');
  return { auth, headers, requestId, ownerToken, admission, pty };
}

async function closed(session: string) {
  await expect.poll(async () => (await fixture.database.pool.query<{ closed_at: Date | null }>(
    'SELECT closed_at FROM terminal_sessions WHERE id=$1', [session])).rows[0]?.closed_at instanceof Date,
  { timeout: 15_000, interval: 100 }).toBe(true);
}

describe.sequential('relay real, gateway real y agente PTY Python en Docker Lab', () => {
  it('acredita presencia, salud y grabación de entrada/salida con digest y auditoría sin contenido', async () => {
    const f = await open('harness_rw');
    const health = `http://127.0.0.1:${String(fixture.relayPorts.health)}`;
    expect((await fetch(`${health}/health/ready`)).status).toBe(200);
    const marker = `B2-RELAY-${randomUUID()}`;
    f.pty.socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'; id -u\n` }));
    await f.pty.waitOutput(text => text.includes(marker) && text.includes('1000'));
    f.pty.socket.close(1000, 'owned_test_done'); await f.pty.waitForClose();
    await closed(f.admission.session_id);
    const recording = await readFile(join(fixture.directory, 'recordings', `${f.admission.session_id}.cast`));
    expect(recording.toString('utf8')).toContain(marker);
    expect(JSON.parse(recording.toString('utf8').split('\n')[0] ?? '{}')).toMatchObject({ version: 2, width: 100, height: 30 });
    const audits = (await fixture.database.pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_events WHERE action IN ('terminal.session.close','terminal.session.input') AND metadata->>'session_id'=$1",
    [f.admission.session_id])).rows;
    expect(audits.find(row => row.action === 'terminal.session.input')?.metadata).toMatchObject({
      recording_sha256: createHash('sha256').update(recording).digest('hex') });
    expect(JSON.stringify(audits)).not.toContain(marker);
    const metrics = await (await fetch(`${health}/metrics`)).text();
    expect(metrics).toContain('cauce_terminal_ready 1');
    expect(metrics).toContain('cauce_terminal_bytes_in_total');
    expect(metrics).not.toContain(fixture.targetAlias);
  }, 45_000);

  it('rechaza la segunda plaza y libera la plaza al agotarse la ventana segura del claim', async () => {
    const f = await open();
    const rejected = await fixture.request('/v3/console/terminal/sessions', { method: 'POST', headers: f.headers,
      body: { tenant_id: fixture.tenant, alias: fixture.targetAlias, mode: 'shell', cols: 100, rows: 30,
        request_id: randomUUID(), owner_token: randomUUID() } });
    expect(rejected.status).toBe(409);
    await f.pty.waitForClose(45_000);
    expect([4403, 4423]).toContain(f.pty.closeCode);
    await closed(f.admission.session_id);
    const reason = (await fixture.database.pool.query<{ close_reason: string }>('SELECT close_reason FROM terminal_sessions WHERE id=$1', [f.admission.session_id])).rows[0]?.close_reason;
    expect(reason).toMatch(/^(?:ttl_expired|claim_lease_expired|claim_lease_invalid)$/u);
    const next = await open(); next.pty.socket.close(1000); await next.pty.waitForClose(); await closed(next.admission.session_id);
  }, 60_000);

  it('rechaza un frame de entrada excesivo antes de escribirlo en la PTY', async () => {
    const f = await open();
    f.pty.socket.send(JSON.stringify({ type: 'input', data: 'x'.repeat(20_000) }));
    await f.pty.waitForClose(); expect(f.pty.closeCode).toBe(4414);
    await closed(f.admission.session_id);
    const row = (await fixture.database.pool.query<{ close_reason: string; bytes_in: string }>(
      'SELECT close_reason,bytes_in::text FROM terminal_sessions WHERE id=$1', [f.admission.session_id])).rows[0];
    expect(row).toEqual({ close_reason: 'input_flood', bytes_in: '0' });
  }, 30_000);

  it('cierra al perder autorización, conserva el cierre en spool y lo entrega cuando vuelve el gateway', async () => {
    const f = await open();
    const server = fixture.app.server;
    const port = Number(new URL(fixture.gatewayUrl).port);
    const stopped = new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    server.closeAllConnections(); await stopped;
    let restored = false;
    const restore = async () => {
      if (restored) return;
      await new Promise<void>(resolve => { server.listen(port, '127.0.0.1', resolve); }); restored = true;
    };
    try {
      await f.pty.waitForClose(10_000); expect(f.pty.closeCode).toBe(4403);
      const spool = join(fixture.directory, 'close-spool.json');
      await expect.poll(async () => {
        const raw = await readFile(spool, 'utf8');
        if (raw === '') return false;
        const state = JSON.parse(raw) as { reports: { session_id: string; reason: string }[] };
        return state.reports.some(report => report.session_id === f.admission.session_id && report.reason === 'authz_unreachable');
      }, { timeout: 10_000 }).toBe(true);
      expect((await stat(spool)).mode & 0o777).toBe(0o600);
      expect((await fixture.database.pool.query<{ closed_at: Date | null }>('SELECT closed_at FROM terminal_sessions WHERE id=$1', [f.admission.session_id])).rows[0]?.closed_at).toBeNull();
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${String(fixture.relayPorts.health)}/health/ready`)).status,
        { timeout: 15_000 }).toBe(503);
      expect((await fetch(`http://127.0.0.1:${String(fixture.relayPorts.health)}/health/live`)).status).toBe(200);
      await restore(); await closed(f.admission.session_id);
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(spool, 'utf8')) as { reports: unknown[] }; return state.reports.length;
      }, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${String(fixture.relayPorts.health)}/health/ready`)).status,
        { timeout: 20_000 }).toBe(200);
      expect((await fixture.database.pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='terminal.session.close' AND metadata->>'session_id'=$1",
        [f.admission.session_id])).rows).toEqual([{ count: 1 }]);
    } finally { await restore(); }
  }, 45_000);

  it('recarga un spool preparado en un proceso real nuevo, conserva sus metadatos y recibe 401 sin mutar la sesión dueña', async () => {
    const f = await open('harness_rw');
    let stop: (() => Promise<void>) | undefined;
    try {
      const marker = `B2-COLD-${randomUUID()}`;
      f.pty.socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'\n` }));
      await f.pty.waitOutput(text => text.includes(marker));
      const recording = await readFile(join(fixture.directory, 'recordings', `${f.admission.session_id}.cast`));
      const digest = createHash('sha256').update(recording).digest('hex');
      const state = (await fixture.database.pool.query<{ relay_boot_id: string; relay_claim_epoch: string }>(
        'SELECT relay_boot_id,relay_claim_epoch FROM terminal_sessions WHERE id=$1', [f.admission.session_id])).rows[0];
      const claim = claims.get(f.admission.session_id);
      if (!state || !claim) throw new Error('real session did not expose its close fence to the network observer');
      const spool = join(fixture.directory, 'cold-close-spool.json');
      persistCloseSpool(spool, new Map([[f.admission.session_id, { reason: 'cold_start_fixture', exit_code: null,
        bytes_in: 37, bytes_out: recording.length, claim_token: claim, claim_epoch: state.relay_claim_epoch,
        input_batches: 1, recording_sha256: digest, recording_capped: true }]]));
      if (process.getuid?.() === 0) await chown(spool, 1000, 1000);
      stop = await startColdRelay(fixture, spool);
      await expect.poll(() => closePosts.some(post => post.session === f.admission.session_id
        && post.boot !== state.relay_boot_id && post.status === 401), { timeout: 15_000 }).toBe(true);
      const post = closePosts.find(value => value.session === f.admission.session_id && value.boot !== state.relay_boot_id);
      expect(post).toMatchObject({ digest, batches: 1, capped: true, status: 401 });
      expect((await fixture.database.pool.query<{ closed_at: Date | null }>(
        'SELECT closed_at FROM terminal_sessions WHERE id=$1', [f.admission.session_id])).rows[0]?.closed_at).toBeNull();
      expect((await fixture.database.pool.query<{ decision: string; reason: string }>(
        "SELECT decision,metadata->>'reason' AS reason FROM audit_events WHERE action='terminal.session.close' AND metadata->>'session_id'=$1",
        [f.admission.session_id])).rows).toEqual([]);
      const persisted = JSON.parse(await readFile(spool, 'utf8')) as { reports: { recording_sha256: string }[] };
      expect(persisted.reports.length).toBe(1);
      expect(persisted.reports[0]?.recording_sha256).toBe(digest);
      expect((await stat(spool)).mode & 0o777).toBe(0o600);
      expect((await fixture.database.pool.query(
        "SELECT id FROM audit_events WHERE action='terminal.session.input' AND metadata->>'session_id'=$1", [f.admission.session_id])).rows).toHaveLength(0);
    } finally {
      await stop?.(); claims.delete(f.admission.session_id);
      f.pty.socket.close(1000); await f.pty.waitForClose(); await closed(f.admission.session_id);
    }
  }, 45_000);
});
