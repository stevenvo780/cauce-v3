import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isCanonicalUuidV4 } from '@cauce/protocol';
import type { RouteIsolationEntry } from './route-isolation-matrix.js';
import type { CaseRecord } from './route-isolation-external.js';
import type { CanaryState, Side } from './route-isolation-external-canary.js';
import { parseJson, type ExternalClient, type ExternalRequest, type ExternalResponse, type ExternalSession } from './route-isolation-external-client.js';

interface Options {
  runId?: string; client: ExternalClient; states: Record<Side, CanaryState>;
  sessions: Record<Side, ExternalSession>; socketPath: string;
}
interface Probe { url: string; payload?: unknown; headers?: Record<string, string> }
export interface ExternalTerminalVerification {
  readonly values: Record<string, unknown>; readonly markers: string[];
  probe(entry: RouteIsolationEntry): Probe | undefined;
  attacks(): Promise<CaseRecord[]>;
  close(): Promise<void>;
}
export class ExternalTerminalCleanupError extends Error {
  constructor() {
    super('terminal fixture cleanup is pending');
    this.name = 'ExternalTerminalCleanupError';
  }
}
interface TerminalMaterial {
  alias: string; grantId: string; grantVersion: number; requestId: string; ownerToken: string; ownerGeneration: string;
  sessionId: string; ticket: string; authorityProof: string;
  claimToken: string; claimEpoch: string; resumeToken: string; relayInstanceId: string; relayBootId: string;
}
const LISTS = ['/v3/console/terminal/targets', '/v3/console/terminal/grants', '/v3/console/terminal/sessions'];
const MAX_FRAME_BYTES = 262_144;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('terminal fixture returned an invalid object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 8192) throw new Error('terminal fixture returned an invalid string');
  return value;
}
function uuid(value: unknown): string {
  if (!isCanonicalUuidV4(value)) throw new Error('terminal fixture returned an invalid UUID');
  return value;
}
function generation(value: unknown): string {
  const result = text(value);
  if (!/^[1-9][0-9]{0,18}$/u.test(result)) throw new Error('terminal fixture returned an invalid generation');
  return result;
}
function items(response: ExternalResponse): Record<string, unknown>[] {
  const rows = object(parseJson(response.body)).items;
  if (response.status !== 200 || !Array.isArray(rows)) throw new Error('terminal owner list is unavailable');
  return rows.map(object);
}

async function fixtureRpc(socketPath: string, request: Record<string, unknown>): Promise<unknown> {
  const parent = dirname(socketPath); const uid = process.getuid?.();
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || uid === undefined) throw new Error('terminal fixture requires an absolute local socket');
  const [socket, directory, canonical] = await Promise.all([lstat(socketPath), lstat(parent), realpath(parent)]);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600
    || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0 || canonical !== parent) {
    throw new Error('terminal fixture socket must be private and owned by the caller');
  }
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('terminal fixture request is too large');
  return await new Promise<unknown>((complete, reject) => {
    const connection = createConnection(socketPath); let received = Buffer.alloc(0); let finished = false;
    const fail = (): void => { if (finished) return; finished = true; connection.destroy(); reject(new Error('terminal fixture RPC failed')); };
    connection.setTimeout(request.op === 'prepare' ? 180_000 : 45_000, fail);
    connection.once('error', fail); connection.once('end', () => { if (!finished) fail(); });
    connection.once('connect', () => { connection.write(frame); });
    connection.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_FRAME_BYTES) { fail(); return; }
      const end = received.indexOf(10); if (end < 0) return;
      try {
        if (received.subarray(end + 1).length !== 0) { fail(); return; }
        const reply = object(JSON.parse(received.subarray(0, end).toString('utf8')) as unknown);
        if (reply.ok !== true || !Object.hasOwn(reply, 'value')) { fail(); return; }
        finished = true; connection.destroy(); complete(reply.value);
      } catch { fail(); }
    });
  });
}

/** Credentials remain in this process and the private fixture socket, never in case receipts. */
class TerminalVerification implements ExternalTerminalVerification {
  readonly values: Record<string, unknown> = {};
  readonly markers: string[] = [];
  private readonly materials: Partial<Record<Side, TerminalMaterial>> = {};
  private readonly records: CaseRecord[] = [];
  private reference = '';
  private closed = false;
  private readonly runId: string;
  constructor(private readonly options: Options) {
    this.runId = options.runId ?? options.states.a.slug.slice('zz-canary-'.length, -2);
    if (!/^[a-z0-9]{4,16}$/u.test(this.runId)) throw new Error('terminal fixture requires a canary run id');
  }

  private material(side: Side): TerminalMaterial {
    const value = this.materials[side]; if (value === undefined) throw new Error('terminal fixture is not prepared'); return value;
  }
  private record(id: string, method: string, route: string, response: ExternalResponse | null, ok: boolean, detail?: string): void {
    this.records.push({ id, class: 'credential', method, route, target: 'real', status: response?.status ?? null,
      outcome: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  }
  private owner(material: TerminalMaterial): Record<string, unknown> {
    return { request_id: material.requestId, owner_generation: material.ownerGeneration, owner_token: material.ownerToken };
  }
  private browserPayload(material: TerminalMaterial, action: string): Record<string, unknown> {
    if (action === 'owner') return { request_id: material.requestId, expected_owner_generation: material.ownerGeneration,
      owner_token: material.ownerToken, authority_proof: material.authorityProof };
    return { ...this.owner(material), authority_proof: material.authorityProof, ...(action === 'control' ? { action: 'take' } : {}) };
  }
  private relayPayload(material: TerminalMaterial, action: string, proof = material.authorityProof): Record<string, unknown> {
    const identity = { relay_instance_id: material.relayInstanceId, relay_boot_id: material.relayBootId };
    if (action === 'agents') return { ...identity, agents: [] };
    if (action === 'close') return { ...identity, claim_token: material.claimToken, claim_epoch: material.claimEpoch,
      reason: 'isolation_probe', exit_code: null, bytes_in: 0, bytes_out: 0 };
    return { ...identity, authority_proof: proof, claim_token: material.claimToken,
      ...(action === 'consume' ? { ticket: material.ticket } : { claim_epoch: material.claimEpoch }),
      ...(action === 'resume' ? { resume_token: material.resumeToken } : {}) };
  }
  private async relay(path: string, json: unknown, identity = 'valid'): Promise<ExternalResponse> {
    await this.options.client.slot();
    const reply = object(await fixtureRpc(this.options.socketPath, { op: 'relay', method: 'POST', path, json, identity }));
    if (typeof reply.status !== 'number' || !Number.isInteger(reply.status) || reply.status < 0 || reply.status > 599
      || typeof reply.body !== 'string') throw new Error('terminal fixture returned an invalid relay response');
    return { status: reply.status, body: reply.body, setCookies: [], retryAfter: null };
  }

  async prepare(): Promise<void> {
    const { client, states, sessions, socketPath } = this.options;
    const sides = (['a', 'b'] as const).map(side => {
      const state = states[side];
      if (!state.registered || state.slug !== `zz-canary-${this.runId}-${side}` || !state.hub || !state.ownerAlias || !state.human) {
        throw new Error('terminal fixture requires both fully populated canary owners');
      }
      return { side, company: state.slug, tenant: state.hub, alias: state.ownerAlias, human: state.human };
    });
    if (object(await fixtureRpc(socketPath, { op: 'prepare', runId: this.runId, sides })).ready !== true) throw new Error('terminal fixture is not ready');
    for (const side of ['a', 'b'] as const) {
      const state = states[side]; const session = sessions[side];
      const created = await client.send('POST', '/v3/console/terminal/grants', { session,
        json: { tenant_id: state.hub, alias: state.ownerAlias, grantee_human_id: state.human, modes: ['shell', 'harness', 'harness_rw'] } });
      const grant = object(parseJson(created.body));
      if (created.status !== 201 || grant.company_id !== state.slug || grant.tenant_id !== state.hub || grant.alias !== state.ownerAlias
        || typeof grant.version !== 'number' || !Number.isSafeInteger(grant.version) || grant.version < 1) throw new Error('terminal owner grant creation failed');
      const material: TerminalMaterial = { alias: text(state.ownerAlias), grantId: uuid(grant.id), grantVersion: grant.version,
        requestId: randomUUID(), ownerToken: randomUUID(), ownerGeneration: '1', sessionId: '', ticket: '', authorityProof: '',
        claimToken: '', claimEpoch: '', resumeToken: '', relayInstanceId: '', relayBootId: '' };
      this.materials[side] = material;
      this.record(`terminal ${side} owner creates grant`, 'POST', '/v3/console/terminal/grants', created, true);
      const grants = await client.send('GET', LISTS[1] ?? '', { session });
      if (!items(grants).some(row => row.id === material.grantId)) throw new Error('terminal owner cannot list its real grant');
      this.record(`terminal ${side} owner lists grant`, 'GET', '/v3/console/terminal/grants', grants, true);
      const targets = await client.send('GET', LISTS[0] ?? '', { session });
      const target = items(targets).find(row => row.tenant_id === state.hub && row.alias === material.alias);
      if (target?.authorized !== true || target.pty_state !== 'online') {
        const reason = typeof target?.reason === 'string' ? /^[a-z_]+(?=:)/u.exec(target.reason)?.[0] ?? 'unspecified' : 'missing_target';
        throw new Error(`terminal owner target is not online and authorized ${JSON.stringify({ status: targets.status,
          present: target !== undefined, authorized: target?.authorized === true,
          pty_state: typeof target?.pty_state === 'string' && /^(?:online|agent_offline|not_installed|unknown)$/u.test(target.pty_state) ? target.pty_state : 'unknown', reason })}`);
      }
      this.record(`terminal ${side} owner lists target`, 'GET', '/v3/console/terminal/targets', targets, true);
      const opened = await client.send('POST', '/v3/console/terminal/sessions', { session,
        json: { tenant_id: state.hub, alias: material.alias, mode: 'shell', initiator: 'operator', cols: 80, rows: 24,
          request_id: material.requestId, owner_token: material.ownerToken } });
      const receipt = object(parseJson(opened.body));
      if (opened.status !== 201 || receipt.request_id !== material.requestId) throw new Error('terminal owner session creation failed');
      material.sessionId = uuid(receipt.session_id); material.ticket = text(receipt.ticket);
      material.authorityProof = text(receipt.authority_proof); material.ownerGeneration = generation(receipt.owner_generation);
      if (!material.authorityProof.startsWith('ac2.')) throw new Error('terminal owner did not receive a real continuity proof');
      this.record(`terminal ${side} owner opens session`, 'POST', '/v3/console/terminal/sessions', opened, true);
      const attached = object(await fixtureRpc(socketPath, { op: 'attach', side, sessionId: material.sessionId,
        ticket: material.ticket, authorityProof: material.authorityProof }));
      if (attached.ready !== true || attached.ptyNonceVerified !== true || typeof attached.outputBytes !== 'number'
        || attached.outputBytes < 1) throw new Error('terminal real PTY nonce was not verified');
      material.claimToken = uuid(attached.claimToken); material.claimEpoch = generation(attached.claimEpoch);
      material.relayBootId = uuid(attached.relayBootId); material.resumeToken = text(attached.resumeToken);
      material.relayInstanceId = text(attached.relayInstanceId);
      if (!/^[a-f0-9]{64}$/u.test(material.relayInstanceId) || material.resumeToken.length < 80) throw new Error('terminal relay claim is incomplete');
      this.record(`terminal ${side} real PTY nonce`, 'WS', '/v3/console/terminal/relays/:relay/ws', null, true, 'real PTY output nonce verified');
      const listed = await client.send('GET', '/v3/console/terminal/sessions', { session });
      if (!items(listed).some(row => row.session_id === material.sessionId && row.state === 'active')) throw new Error('terminal real session is not active');
      this.record(`terminal ${side} owner lists active session`, 'GET', '/v3/console/terminal/sessions', listed, true);
      const route = `/v3/terminal/relay/sessions/${material.sessionId}/authz`;
      const authorized = await this.relay(route, this.relayPayload(material, 'authz'));
      if (authorized.status !== 200 || object(parseJson(authorized.body)).ok !== true) throw new Error('terminal nominal relay identity did not authorize its real claim');
      this.record(`terminal ${side} valid mTLS bearer claim`, 'POST', '/v3/terminal/relay/sessions/:sid/authz', authorized, true);
    }
    const b = this.material('b');
    Object.assign(this.values, { terminalSession: b.sessionId, terminalGrant: b.grantId, terminalGrantVersion: b.grantVersion });
    this.markers.push(b.sessionId, b.grantId);
    this.reference = await this.snapshot();
  }

  probe(entry: RouteIsolationEntry): Probe | undefined {
    const b = this.material('b'); const state = this.options.states.b;
    const route = '/v3/console/terminal';
    if (entry.url === `${route}/grants/:id`) return { url: `${route}/grants/${b.grantId}${entry.method === 'DELETE' ? `?expected_version=${String(b.grantVersion)}` : ''}`,
      ...(entry.method === 'PATCH' ? { payload: { expected_version: b.grantVersion, modes: ['shell'] } } : {}) };
    if (entry.url === `${route}/grants` && entry.method === 'POST') return { url: entry.url,
      payload: { tenant_id: state.hub, alias: b.alias, grantee_human_id: state.human, modes: ['shell'] } };
    if (entry.url === `${route}/sessions` && entry.method === 'POST') return { url: entry.url,
      payload: { tenant_id: state.hub, alias: b.alias, mode: 'shell', cols: 80, rows: 24, request_id: randomUUID(), owner_token: randomUUID() } };
    if (entry.url.startsWith(`${route}/sessions/:sid`)) {
      const action = entry.url.split('/').at(-1) ?? '';
      return { url: entry.url.replace(':sid', b.sessionId), payload: entry.method === 'DELETE' ? this.owner(b) : this.browserPayload(b, action) };
    }
    if (entry.url.startsWith('/v3/terminal/relay/')) {
      const action = entry.url.split('/').at(-1) ?? '';
      return { url: entry.url.replace(':sid', b.sessionId), payload: this.relayPayload(b, action) };
    }
    return undefined;
  }

  private async snapshot(): Promise<string> {
    const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'observed_at' && key !== 'last_seen')
          .sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, normalize(field)])) : value;
    const result: unknown[] = [];
    for (const route of LISTS) {
      const response = await this.options.client.send('GET', route, { session: this.options.sessions.b });
      if (response.status !== 200) throw new Error('terminal B integrity snapshot is unavailable');
      result.push([route, normalize(parseJson(response.body))]);
    }
    return JSON.stringify(result);
  }
  private async check(id: string, method: string, route: string, response: ExternalResponse,
    allowed: readonly number[], detail?: string): Promise<void> {
    const body = object(parseJson(response.body) ?? {});
    const mounted = !(response.status === 404 && body.message === `Route ${method}:${route} not found`);
    const unchanged = this.reference === await this.snapshot();
    const leaked = this.markers.some(marker => response.body.includes(marker));
    const ok = mounted && unchanged && !leaked && allowed.includes(response.status);
    this.record(id, method, route, response, ok, !mounted ? 'terminal route is not mounted' : !unchanged ? 'company B terminal state changed'
      : leaked ? 'response exposed a company B terminal resource' : !allowed.includes(response.status) ? 'terminal request did not produce the required denial' : detail);
  }

  async attacks(): Promise<CaseRecord[]> {
    const { client, sessions, states } = this.options; const a = this.material('a'); const b = this.material('b');
    for (const action of ['owner', 'control', 'extend', 'delete']) {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const route = `/v3/console/terminal/sessions/${b.sessionId}${action === 'delete' ? '' : `/${action}`}`;
      const json = action === 'delete' ? this.owner(b) : this.browserPayload(b, action);
      await this.check(`terminal A uses B valid ${action} credentials`, method, route,
        await client.send(method, route, { session: sessions.a, json }), action === 'delete' ? [403, 404, 409] : [403, 404]);
    }
    for (const method of ['PATCH', 'DELETE']) {
      const route = `/v3/console/terminal/grants/${b.grantId}${method === 'DELETE' ? `?expected_version=${String(b.grantVersion)}` : ''}`;
      await this.check(`terminal A uses B real grant ${method}`, method, route, await client.send(method, route, { session: sessions.a,
        ...(method === 'PATCH' ? { json: { expected_version: b.grantVersion, modes: ['harness'] } } : {}) }), [403, 404]);
    }
    const ownRoute = `/v3/console/terminal/sessions/${a.sessionId}/extend`; const json = this.browserPayload(a, 'extend');
    const credentials: [string, ExternalRequest][] = [
      ['without cookie', { csrf: sessions.a.csrf, json }], ['without CSRF', { session: sessions.a, csrf: false, json }],
      ['with B CSRF', { session: sessions.a, csrf: sessions.b.csrf, json }],
      ['with foreign Origin', { session: sessions.a, headers: { origin: 'https://foreign.example.invalid' }, json }],
      ['with cross-site fetch', { session: sessions.a, headers: { 'sec-fetch-site': 'cross-site' }, json }],
    ];
    for (const [label, request] of credentials) await this.check(`terminal own action ${label}`, 'POST', ownRoute,
      await client.send('POST', ownRoute, request), [401, 403]);
    const forged = { 'x-cauce-tenant': states.b.hub ?? '', 'x-cauce-company': states.b.slug, 'x-cauce-alias': b.alias };
    for (const route of LISTS) await this.check(`terminal forged headers without cookie ${route}`, 'GET', route,
      await client.send('GET', route, { headers: forged }), [401, 403]);
    for (const action of ['consume', 'resume', 'authz', 'close']) {
      const route = `/v3/terminal/relay/sessions/${b.sessionId}/${action}`;
      const payload = this.relayPayload(a, action, b.authorityProof);
      await this.check(`terminal valid relay A ${action} credential against B`, 'POST', route, await this.relay(route, payload),
        action === 'close' ? [200] : action === 'authz' ? [403] : [401, 403],
        action === 'close' ? 'stale close acknowledged; B grant, target and active session unchanged' : 'valid A credential cannot authorize B session');
      if (action !== 'close') {
        const crossed = await this.relay(route, this.relayPayload(a, action));
        const body = object(parseJson(crossed.body) ?? {});
        const boundDenial = crossed.status === 400 && body.error === 'invalid_request' && body.message === 'terminal authority is unavailable';
        await this.check(`terminal valid relay A proof bound against B ${action}`, 'POST', route, crossed,
          boundDenial ? [400] : [401, 403], 'real continuity proof rejected for another session');
      }
    }
    const route = `/v3/terminal/relay/sessions/${b.sessionId}/authz`;
    for (const identity of ['no_certificate', 'wrong_certificate', 'wrong_bearer']) {
      const response = await this.relay(route, this.relayPayload(b, 'authz'), identity);
      const tlsRefused = identity === 'no_certificate' && response.status === 0
        && object(parseJson(response.body)).error === 'TLS_CLIENT_CERT_REQUIRED';
      await this.check(`terminal relay ${identity}`, 'POST', route, response, tlsRefused ? [0] : [401, 403],
        tlsRefused ? 'TLS required the client certificate before HTTP admission' : undefined);
    }
    return [...this.records];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const { client, sessions, socketPath } = this.options; const failures: unknown[] = [];
    for (const side of ['b', 'a'] as const) {
      const material = this.materials[side]; if (material === undefined) continue;
      if (material.sessionId) {
        try {
          const response = await client.send('DELETE', `/v3/console/terminal/sessions/${material.sessionId}`,
            { session: sessions[side], json: this.owner(material) });
          if (response.status !== 204) throw new Error('terminal owner session cleanup failed');
        } catch (error) { failures.push(error); }
      }
      try {
        const grants = items(await client.send('GET', '/v3/console/terminal/grants', { session: sessions[side] }));
        const existing = grants.find(row => row.id === material.grantId);
        if (existing !== undefined) {
          const version = existing.version;
          if (typeof version !== 'number' || !Number.isSafeInteger(version)) throw new Error('terminal owner cleanup version is unavailable');
          const response = await client.send('DELETE', `/v3/console/terminal/grants/${material.grantId}?expected_version=${String(version)}`,
            { session: sessions[side] });
          if (response.status !== 200) throw new Error('terminal owner grant cleanup failed');
        }
      } catch (error) { failures.push(error); }
    }
    try { await fixtureRpc(socketPath, { op: 'close', runId: this.runId }); } catch (error) { failures.push(error); }
    if (failures.length) throw new ExternalTerminalCleanupError();
    this.closed = true;
  }
}

export async function prepareExternalTerminal(options: Options): Promise<ExternalTerminalVerification> {
  const verification = new TerminalVerification(options);
  try { await verification.prepare(); return verification; }
  catch (error) {
    try { await verification.close(); } catch { throw new ExternalTerminalCleanupError(); }
    throw error;
  }
}
