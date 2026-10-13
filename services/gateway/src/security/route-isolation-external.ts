import { randomBytes, randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, sha256Hex } from '@cauce/protocol';
import { WebSocket } from 'ws';
import { ROUTE_ISOLATION_MATRIX, type RouteIsolationEntry } from './route-isolation-matrix.js';
import { ISOLATION_OAUTH_ISSUER, expandProbe, probePlaceholders, type ProbeSide } from './route-isolation-probe.js';
import { ExternalClient, parseJson, verifiedBaseUrl, type ExternalResponse, type ExternalSession } from './route-isolation-external-client.js';
import {
  canaryStates, logout, populate, registerAndLogin, retireCanary,
  type CanaryState, type Side, type StepRecord, type WalkContext,
} from './route-isolation-external-canary.js';
import { compareSnapshots, readSnapshot, volatilePaths, type Snapshot } from './route-isolation-external-snapshot.js';

export type CaseOutcome = 'pass' | 'fail' | 'not_configured' | 'not_mounted' | 'inconclusive';
export type CaseClass = 'matrix' | 'header' | 'parameter' | 'credential' | 'websocket';
export interface CaseRecord {
  id: string; class: CaseClass; method: string; route: string; target: 'real' | 'synthetic' | 'none';
  status: number | null; outcome: CaseOutcome; detail?: string; synthetic?: string[];
}
export interface ExternalOptions {
  baseUrl: string; runId: string; ratePerSecond: number; maxRequests: number;
  client: { sha: string; dirty: boolean };
  /** Origin the OAuth grant routes expect; production serves them on the console origin itself. */
  oauthIssuer?: string;
  fetchImpl?: typeof fetch;
  persist?: (states: Record<Side, CanaryState>) => Promise<void>;
  log?: (line: string) => void;
}
export interface ExternalReceipt {
  schema: 'cauce.verify-external/v1'; base_url: string; run_id: string; started_at: string; finished_at: string;
  client: { sha: string; dirty: boolean };
  canaries: { side: Side; company: string; registered: boolean; retired: boolean }[];
  requests: number; rate_per_second: number; max_requests: number;
  totals: { cases: number; passed: number; failures: number; not_configured: number; not_mounted: number; inconclusive: number;
    real_targets: number; synthetic_targets: number };
  failures: { id: string; detail: string }[];
  /** What "B unchanged" was measured on: each view's status, the compared fields and the ones left out as volatile. */
  snapshot?: { routes: Record<string, string>; fields: number; volatile: string[] };
  walk: StepRecord[]; cases: CaseRecord[]; findings: string[]; fatal?: string;
}

/** Placeholders the canary walk fills with real resources of company B; any other one gets a well-formed absent value. */
export const REAL_PLACEHOLDERS = new Set(['tenant', 'tenantId', 'alias', 'director', 'company', 'human', 'room', 'ownRoom', 'ownTenant',
  'ownAlias', 'account', 'invitation', 'host', 'blob', 'revision', 'issuer', 'csrf']);
const UUID_PLACEHOLDERS = ['message', 'delivery', 'trace', 'gate', 'operation', 'environment', 'backup', 'session', 'nativeOperation',
  'providerOperation', 'providerSession', 'requestId', 'ownerToken', 'bootstrapProbe', 'binding', 'grant', 'connectionInstance', 'dlq', 'quotaOperation'];
export const MATRIX_CASES = ROUTE_ISOLATION_MATRIX.filter(entry => entry.probe !== undefined && entry.kind !== 'public' && entry.kind !== 'websocket');
export const ACTOR_VIEWS = ['/v3/auth/session', '/v3/console/companies', '/v3/console/people', '/v3/console/config', '/v3/console/office/layout',
  '/v3/console/quota-accounts', '/v3/console/fleet/hosts/enrollments', '/v3/console/agents', '/v3/console/topology', '/v3/console/access',
  '/v3/console/audit?limit=100', '/v3/console/preferences'];

function syntheticValues(b: CanaryState): Record<string, unknown> {
  const hex = (bytes: number) => randomBytes(bytes).toString('hex');
  return { ...Object.fromEntries(UUID_PLACEHOLDERS.map(name => [name, randomUUID()])),
    blob: hex(32), dlqEvidence: hex(32), connectionRef: hex(32), contextCommit: hex(20), connectionEpoch: 1, contextVersion: 1,
    connectionToken: randomBytes(32).toString('base64url'), authorityProof: randomBytes(32).toString('base64url'), ownerGeneration: '1',
    nativePiece: 'isolation-check', egressDestination: `${b.agent ?? 'owner'}.private`,
    providerRequest: { operation_id: randomUUID(), expected_operation_version: 0, request_id: `canary-${hex(8)}`, provider_id: 'codex',
      account_id: b.account ?? 'canary-account', harness_id: 'codex', host_id: b.enrollmentHost ?? 'canary-host', runtime_user: 'canary',
      profile_id: b.account ?? 'canary-account' } };
}

interface Fixture { b: ProbeSide & Record<string, unknown>; a: ProbeSide; markers: string[]; synthetic: Set<string> }

function fixtureOf(a: CanaryState, b: CanaryState): Fixture {
  const candidates: Record<string, unknown> = { tenant: b.hub, alias: b.agent ?? b.ownerAlias, room: b.room ?? 'office', ownerAlias: b.ownerAlias ?? 'owner',
    company: b.slug, human: b.reader?.id ?? b.human, account: b.account, invitation: b.invitation, host: b.enrollmentHost, blob: b.blob,
    revision: b.configs.at(0)?.revision };
  const real = Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined));
  const synthetic = syntheticValues(b);
  const missing = new Set([...Object.keys(synthetic), ...Object.keys(candidates)].filter(name => real[name] === undefined));
  const values = { ...synthetic, ...real } as ProbeSide & Record<string, unknown>;
  const markers = [b.slug, b.hub, b.human, b.reader?.id, b.invitation, b.account, b.blob, b.sentinel, b.enrollmentHost]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return { b: values, a: { tenant: a.hub ?? '', alias: a.ownerAlias ?? 'owner', room: a.room ?? 'office', ownerAlias: a.ownerAlias ?? 'owner' },
    markers, synthetic: missing };
}

/** Same rule as the local guard: no identifier or private content of B, except the exact echo a route declares; returns where it leaked. */
export function foreignData(entry: Pick<RouteIsolationEntry, 'url' | 'method' | 'errorMessageEcho'>, body: string, fixture: Fixture): string | undefined {
  let content = body;
  const parsed = parseJson(body);
  if (entry.errorMessageEcho !== undefined && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const result = parsed as { error?: unknown; message?: unknown };
    const echo = expandProbe({ ...entry, kind: 'scoped', reason: '', probe: { url: entry.errorMessageEcho } }, fixture.b, fixture.a).url;
    if (result.error === 'forbidden' && result.message === echo) { delete result.message; content = JSON.stringify(result); }
  }
  if (entry.url === '/v3/console/egress/notifications' && parsed !== null && typeof parsed === 'object'
    && Array.isArray((parsed as { items?: unknown }).items)) {
    for (const item of (parsed as { items: Record<string, unknown>[] }).items) if (item.decision === 'denied') delete item.handle;
    content = JSON.stringify(parsed);
  }
  for (const marker of fixture.markers) {
    const at = content.indexOf(marker);
    if (at >= 0) return content.slice(Math.max(0, at - 80), at + marker.length + 40);
  }
  return undefined;
}

function errorOf(body: string): string {
  const parsed = parseJson(body) as { error?: unknown; message?: unknown } | undefined;
  return parsed === undefined ? '' : [parsed.error, parsed.message].filter(value => typeof value === 'string').join(': ').slice(0, 160);
}

type Verdict = Pick<CaseRecord, 'outcome' | 'status' | 'detail'>;

/** Fastify's own 404 for a path no plugin registered: the plane is off in this deployment, nothing was denied. */
function routeNotFound(response: ExternalResponse, method: string, path: string): boolean {
  const parsed = parseJson(response.body) as { message?: unknown; statusCode?: unknown } | undefined;
  return response.status === 404 && parsed?.statusCode === 404 && parsed.message === `Route ${method}:${path} not found`;
}

function judge(response: ExternalResponse, allowed: readonly number[], leak: string | undefined, request: { method: string; path: string }): Verdict {
  const status = response.status;
  if (routeNotFound(response, request.method, request.path)) return { status, outcome: 'not_mounted' };
  if (leak !== undefined) return { status, outcome: 'fail', detail: `exposed company B data in HTTP ${String(status)}: …${leak}…` };
  if (status === 501) return { status, outcome: 'not_configured', detail: errorOf(response.body) };
  if (allowed.includes(status)) return { status, outcome: 'pass' };
  return { status, outcome: 'fail', detail: `HTTP ${String(status)} ${errorOf(response.body)}`.trim() };
}

class Run {
  readonly cases: CaseRecord[] = [];
  private reference: Snapshot | undefined;
  private volatile = new Set<string>();
  coverage: ExternalReceipt['snapshot'];
  constructor(readonly client: ExternalClient, readonly states: Record<Side, CanaryState>,
    readonly sessions: Record<Side, ExternalSession>, readonly fixture: Fixture, readonly log: (line: string) => void,
    readonly oauthOrigin: string) {}

  private push(record: CaseRecord): void {
    this.cases.push(record);
    if (record.outcome === 'fail') this.log(`FAIL ${record.id}: ${record.detail ?? ''}`);
  }

  async baseline(): Promise<void> {
    const first = await readSnapshot(this.client, this.sessions.b, this.states.b);
    const second = await readSnapshot(this.client, this.sessions.b, this.states.b);
    this.volatile = volatilePaths(first, second);
    this.reference = second;
    this.coverage = { routes: Object.fromEntries([...second].filter(([key]) => key.endsWith(' status')).map(([key, value]) => [key.slice(0, -7), value])),
      fields: second.size - this.volatile.size, volatile: [...this.volatile].sort() };
  }

  /** Re-reads B through its own owner session; any non-volatile difference is a cross-company write. */
  async unchanged(): Promise<string | undefined> {
    const after = await readSnapshot(this.client, this.sessions.b, this.states.b);
    const changed = this.reference === undefined ? [] : compareSnapshots(this.reference, after, this.volatile);
    this.reference = after;
    return changed.length ? `company B changed: ${changed.slice(0, 5).join(', ')}` : undefined;
  }

  async matrix(entry: RouteIsolationEntry): Promise<void> {
    const placeholders = probePlaceholders(entry);
    const synthetic = placeholders.filter(name => this.fixture.synthetic.has(name));
    const probe = expandProbe(entry, this.fixture.b, this.fixture.a);
    const a = this.sessions.a;
    const headers = Object.fromEntries(Object.entries(probe.headers ?? {})
      .map(([key, value]) => [key, key === 'origin' && value === ISOLATION_OAUTH_ISSUER ? this.oauthOrigin : value]));
    const withCsrf = (value: unknown): unknown => value === '{csrf}' ? a.csrf : Array.isArray(value) ? value.map(withCsrf)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withCsrf(field)])) : value;
    const payload = withCsrf(probe.payload);
    const legacy = entry.url === '/v3/console/fleet/legacy-adoption/apply';
    if (legacy && payload !== null && typeof payload === 'object') {
      const preview = (payload as { preview: Record<string, unknown> }).preview;
      preview.revision = await this.globalRevision();
      const { plan_sha256: _plan, ...body } = preview;
      preview.plan_sha256 = sha256Hex(body);
    }
    const allowed = entry.probe?.expectedStatus ?? (entry.kind === 'scoped' ? [403, 404] : [200]);
    const base = { class: 'matrix' as const, route: entry.url, target: synthetic.length ? 'synthetic' as const : 'real' as const,
      ...(synthetic.length ? { synthetic } : {}) };
    const response = await this.client.send(entry.method, probe.url, { session: a, headers, ...(payload === undefined ? {} : { json: payload }) });
    const verdict = judge(response, allowed, foreignData(entry, response.body, this.fixture), { method: entry.method, path: probe.url });
    if (legacy && response.status === 409 && verdict.outcome === 'fail') {
      Object.assign(verdict, { outcome: 'inconclusive', detail: 'the global configuration revision is not observable from a company session; '
        + 'the stale-revision conflict answers before authority (the local guard covers that path)' });
    }
    if (entry.method !== 'GET') {
      const changed = await this.unchanged();
      if (changed !== undefined) Object.assign(verdict, { outcome: 'fail', detail: [verdict.detail, changed].filter(Boolean).join('; ') });
    }
    this.push({ id: `${entry.method} ${entry.url}`, method: entry.method, ...base, ...verdict });
    if (entry.method === 'GET') {
      const head = await this.client.send('HEAD', probe.url, { session: a, headers });
      const inherited = verdict.outcome === 'not_mounted' || verdict.outcome === 'not_configured';
      this.push({ id: `HEAD ${entry.url}`, method: 'HEAD', ...base,
        ...(inherited && head.status === verdict.status ? { status: head.status, outcome: verdict.outcome } : judge(head, allowed, undefined, { method: 'HEAD', path: probe.url })) });
    }
  }

  /** Legacy adoption fences on the global revision; A's own preview is the only public read of it. */
  private async globalRevision(): Promise<number> {
    const targets = [{ tenant_id: this.states.a.hub, alias: this.states.a.ownerAlias ?? 'owner' }];
    const response = await this.client.send('POST', '/v3/console/fleet/legacy-adoption/preview', { session: this.sessions.a, json: { targets } });
    const preview = parseJson(response.body) as { revision?: unknown } | undefined;
    if (response.status === 200 && typeof preview?.revision === 'number') return preview.revision;
    const config = parseJson((await this.client.send('GET', '/v3/console/config', { session: this.sessions.a })).body) as { revision?: unknown } | undefined;
    return typeof config?.revision === 'number' ? config.revision : 0;
  }

  private view(id: string, cls: CaseClass, route: string, response: ExternalResponse, allowed: readonly number[]): void {
    const entry = { url: route, method: 'GET' as const };
    let verdict = judge(response, allowed, foreignData(entry, response.body, this.fixture), { method: 'GET', path: route });
    const body = parseJson(response.body) as { acting_company?: unknown; authority?: { acting_company?: unknown } } | undefined;
    const acting = body?.authority?.acting_company ?? body?.acting_company;
    if (verdict.outcome === 'pass' && acting !== undefined && acting !== this.states.a.slug) {
      verdict = { status: response.status, outcome: 'fail', detail: `acting company became ${JSON.stringify(acting)}` };
    }
    this.push({ id, class: cls, method: 'GET', route, target: 'real', ...verdict });
  }

  async headersAndParameters(): Promise<void> {
    const b = this.states.b;
    const forged = { 'x-cauce-tenant': b.hub ?? '', 'x-cauce-alias': b.ownerAlias ?? 'owner', 'x-cauce-company': b.slug,
      'x-company-id': b.slug, 'x-tenant-id': b.hub ?? '', 'x-cauce-acting-company': b.slug };
    const query = new URLSearchParams({ company: b.slug, company_id: b.slug, tenant_id: b.hub ?? '', tenant: b.hub ?? '', alias: b.ownerAlias ?? 'owner' });
    for (const route of ACTOR_VIEWS) {
      this.view(`tenant headers ${route}`, 'header', route, await this.client.send('GET', route, { session: this.sessions.a, headers: forged }), [200]);
      const target = `${route}${route.includes('?') ? '&' : '?'}${query.toString()}`;
      this.view(`company parameters ${route}`, 'parameter', target, await this.client.send('GET', target, { session: this.sessions.a }), [200, 400, 422]);
    }
    for (const route of ['/v3/console/people', `/v3/console/companies/${b.slug}`, '/v3/console/config']) {
      this.view(`tenant headers without session ${route}`, 'header', route, await this.client.send('GET', route, { headers: forged }), [401, 403]);
    }
  }

  async credentials(): Promise<void> {
    const { a, b } = this.sessions;
    const tampered = a.cookie.replace(/.$/u, last => (last === 'A' ? 'B' : 'A'));
    const cases: [string, string, string, Parameters<ExternalClient['send']>[2], readonly number[]][] = [
      ['A session with B CSRF token', 'PATCH', '/v3/auth/profile', { session: a, csrf: b.csrf, json: { name: this.states.a.name } }, [403]],
      ['A session with B CSRF switching to B', 'POST', '/v3/auth/session/company', { session: a, csrf: b.csrf, json: { company_id: this.states.b.slug } }, [403]],
      ['A session without CSRF token', 'PATCH', '/v3/auth/profile', { session: a, csrf: false, json: { name: this.states.a.name } }, [403]],
      ['B CSRF token without any session', 'POST', '/v3/auth/session/company', { csrf: b.csrf, json: { company_id: this.states.b.slug } }, [401, 403]],
      ['tampered A cookie', 'GET', '/v3/console/people', { cookie: tampered }, [401]],
      ['tampered A cookie reading B', 'GET', `/v3/console/companies/${this.states.b.slug}`, { cookie: tampered }, [401, 403]],
      ['B cookie value as a bearer token', 'GET', `/v3/console/companies/${this.states.b.slug}`,
        { headers: { authorization: `Bearer ${b.cookie.split('=').slice(1).join('=')}` } }, [401, 403]],
    ];
    for (const [id, method, route, request, allowed] of cases) {
      const response = await this.client.send(method, route, request);
      const verdict = judge(response, allowed, foreignData({ url: route, method: 'GET' }, response.body, this.fixture), { method, path: route });
      this.push({ id, class: 'credential', method, route, target: 'real', ...verdict });
    }
    const session = parseJson((await this.client.send('GET', '/v3/auth/session', { cookie: tampered })).body) as { authenticated?: unknown } | undefined;
    this.push({ id: 'tampered A cookie session', class: 'credential', method: 'GET', route: '/v3/auth/session', target: 'real', status: null,
      outcome: session?.authenticated === true ? 'fail' : 'pass', ...(session?.authenticated === true ? { detail: 'tampered cookie authenticated' } : {}) });
    const changed = await this.unchanged();
    if (changed !== undefined) this.push({ id: 'credential class left B unchanged', class: 'credential', method: 'GET', route: 'snapshot',
      target: 'real', status: null, outcome: 'fail', detail: changed });
  }

  /** WebSocket admission: a B hello under A's cookie is refused, and a foreign provider stream never emits data. */
  async sockets(): Promise<void> {
    const b = this.states.b;
    const hello = { type: 'hello', version: PROTOCOL_VERSION, tenant_id: b.hub, alias: b.agent ?? b.ownerAlias,
      instance_id: randomUUID(), capabilities: [] };
    this.push(await this.socket('foreign hello under A session', '/v3/ws', hello, frame => frame.type === 'error'));
    this.push(await this.socket('foreign provider stream under A session', `/v3/console/provider-auth/sessions/${randomUUID()}/stream`,
      { type: 'auth', ticket: randomBytes(32).toString('base64url') }, () => false, 'synthetic'));
  }

  private async socket(id: string, path: string, frame: unknown, accepted: (frame: Record<string, unknown>) => boolean,
    target: 'real' | 'synthetic' = 'real'): Promise<CaseRecord> {
    await this.client.slot();
    const url = this.client.url(path);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.sessions.a.cookie, origin: this.client.origin }, perMessageDeflate: false, handshakeTimeout: 10_000 });
    const base = { id, class: 'websocket' as const, method: 'GET', route: path.replace(/[0-9a-f-]{36}/u, ':id'), target };
    try {
      return await new Promise<CaseRecord>(resolve => {
        const timer = setTimeout(() => { resolve({ ...base, status: 101, outcome: 'fail', detail: 'no explicit denial within 10 s' }); }, 10_000);
        const done = (record: Omit<CaseRecord, keyof typeof base>) => { clearTimeout(timer); resolve({ ...base, ...record }); };
        socket.once('open', () => { socket.send(JSON.stringify(frame)); });
        socket.once('message', raw => {
          const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw).toString('utf8');
          const parsed = parseJson(text) as Record<string, unknown> | undefined;
          const leak = this.fixture.markers.some(marker => text.includes(marker));
          const ok = !leak && parsed !== undefined && accepted(parsed);
          done({ status: 101, outcome: ok ? 'pass' : 'fail', detail: leak ? 'foreign data on the socket' : `frame ${String(parsed?.type)}/${String(parsed?.code)}` });
        });
        socket.once('close', code => { done({ status: 101, outcome: code === 1008 || code >= 4000 ? 'pass' : 'fail', detail: `closed ${String(code)}` }); });
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          done({ status, outcome: [401, 403, 404].includes(status) ? 'pass' : status === 501 ? 'not_configured' : 'fail', detail: `upgrade refused ${String(status)}` });
        });
        socket.once('error', error => { done({ status: null, outcome: 'fail', detail: error.message }); });
      });
    } finally { socket.terminate(); }
  }
}

export interface ExternalPlan {
  base_url: string; run_id: string; canaries: { side: Side; company: string; email: string }[]; actions: string[];
  matrix: { cases: number; with_head: number; mutating: number; real_targets: number; synthetic_targets: number; routes: string[] };
  header_cases: number; parameter_cases: number; credential_cases: number; websocket_cases: number;
  estimated_requests: number; estimated_minutes: number; rate_per_second: number; max_requests: number;
}

export function planExternalVerification(options: Pick<ExternalOptions, 'baseUrl' | 'runId' | 'ratePerSecond' | 'maxRequests'>): ExternalPlan {
  const base = verifiedBaseUrl(options.baseUrl);
  const states = canaryStates(options.runId);
  const synthetic = MATRIX_CASES.filter(entry => probePlaceholders(entry).some(name => !REAL_PLACEHOLDERS.has(name)));
  const gets = MATRIX_CASES.filter(entry => entry.method === 'GET').length;
  const mutating = MATRIX_CASES.length - gets;
  const snapshot = 15;
  const estimated = 60 + MATRIX_CASES.length + gets + (mutating + 3) * snapshot + ACTOR_VIEWS.length * 2 + 3 + 9 + 2;
  const actions = [
    `POST /v3/auth/register de ${states.a.slug} y ${states.b.slug} (correos @${states.a.email.split('@')[1] ?? ''}, contraseñas aleatorias que no se imprimen)`,
    'POST /v3/auth/login y GET /v3/auth/session de cada owner; se aborta si la empresa activa no es su canario',
    'A: sala y membresía del owner. B: sala, agente lector, membresía, persona lectora, invitación de ordenador, cuenta de cuota, blob, plano y preferencias',
    `B se relee con su propia sesión (${String(snapshot)} vistas) dos veces para fijar los campos volátiles`,
    `cabeceras de tenant y parámetros de empresa ajenos sobre ${String(ACTOR_VIEWS.length)} vistas de A, más 3 peticiones sin sesión`,
    `${String(MATRIX_CASES.length)} casos de la matriz desde A contra B (HEAD además en los GET); tras cada escritura B se relee`,
    'credenciales cruzadas: CSRF de B con la sesión de A, sin CSRF, cookie alterada y cookie de B como bearer',
    'WebSocket: hello con tenant y alias de B bajo la cookie de A, y flujo de proveedor ajeno',
    'limpieza: plano y preferencias vacíos, persona retirada, configuración revertida, cuenta e invitación borradas, '
      + 'DELETE /v3/console/companies/:id (retirada) de ambas y logout',
  ];
  return { base_url: base.origin, run_id: options.runId, actions,
    canaries: (['a', 'b'] as const).map(side => ({ side, company: states[side].slug, email: states[side].email })),
    matrix: { cases: MATRIX_CASES.length, with_head: gets, mutating, real_targets: MATRIX_CASES.length - synthetic.length,
      synthetic_targets: synthetic.length, routes: MATRIX_CASES.map(entry => `${entry.method} ${entry.url}`) },
    header_cases: ACTOR_VIEWS.length + 3, parameter_cases: ACTOR_VIEWS.length, credential_cases: 8, websocket_cases: 2,
    estimated_requests: estimated, estimated_minutes: Math.ceil(estimated / options.ratePerSecond / 60),
    rate_per_second: options.ratePerSecond, max_requests: options.maxRequests };
}

async function cleanup(context: WalkContext, states: Record<Side, CanaryState>, sessions: Partial<Record<Side, ExternalSession>>): Promise<void> {
  for (const side of ['b', 'a'] as const) {
    const state = states[side];
    if (!state.registered || state.retired) continue;
    try {
      const session = sessions[side] ?? await context.client.login(state.email, state.password);
      await retireCanary(context, state, session);
      await logout(context, state, session);
    } catch (error) {
      context.steps.push({ step: 'cleanup', side, method: 'POST', route: '/v3/auth/login', status: null, outcome: 'fail',
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

function receiptOf(options: ExternalOptions, client: ExternalClient, states: Record<Side, CanaryState>, steps: StepRecord[],
  run: Run | undefined, started: Date, fatal: string | undefined): ExternalReceipt {
  const cases = run?.cases ?? [];
  const failures = [...steps.filter(item => item.outcome === 'fail').map(item => ({ id: `walk ${item.side} ${item.step}`, detail: item.detail ?? `HTTP ${String(item.status)}` })),
    ...cases.filter(item => item.outcome === 'fail').map(item => ({ id: item.id, detail: item.detail ?? '' })),
    ...(fatal === undefined ? [] : [{ id: 'run', detail: fatal }])];
  const count = (outcome: CaseOutcome) => cases.filter(item => item.outcome === outcome).length;
  const replay = steps.find(item => item.step === 'logout-replay');
  return { schema: 'cauce.verify-external/v1', base_url: client.origin, run_id: options.runId, started_at: started.toISOString(),
    finished_at: new Date().toISOString(), client: options.client,
    canaries: (['a', 'b'] as const).map(side => ({ side, company: states[side].slug, registered: states[side].registered === true, retired: states[side].retired === true })),
    requests: client.requests, rate_per_second: options.ratePerSecond, max_requests: options.maxRequests,
    totals: { cases: cases.length, passed: count('pass'), failures: failures.length, not_configured: count('not_configured'), not_mounted: count('not_mounted'),
      inconclusive: count('inconclusive'),
      real_targets: cases.filter(item => item.target === 'real').length, synthetic_targets: cases.filter(item => item.target === 'synthetic').length },
    ...(run?.coverage === undefined ? {} : { snapshot: run.coverage }), failures, walk: steps, cases, findings: replay?.detail === undefined ? [] : [`logout: ${replay.detail}`],
    ...(fatal === undefined ? {} : { fatal }) };
}

/** Registers two canaries, walks the company basics, runs every manipulation from A against B, then retires both. */
export async function runExternalVerification(options: ExternalOptions, existing?: Record<Side, CanaryState>): Promise<ExternalReceipt> {
  const started = new Date();
  const log = options.log ?? (() => undefined);
  const client = new ExternalClient(verifiedBaseUrl(options.baseUrl), { ratePerSecond: options.ratePerSecond, maxRequests: options.maxRequests,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
  const states = existing ?? canaryStates(options.runId);
  const steps: StepRecord[] = [];
  const context: WalkContext = { client, steps, persist: async () => { await options.persist?.(states); } };
  const sessions: Partial<Record<Side, ExternalSession>> = {};
  const run: { current?: Run } = {};
  let fatal: string | undefined;
  try {
    if (existing !== undefined) throw new Error('cleanup-only run');
    await context.persist();
    log(`registering ${states.a.slug} and ${states.b.slug}`);
    const a = await registerAndLogin(context, states.a);
    if (a) sessions.a = a;
    const b = await registerAndLogin(context, states.b);
    if (b) sessions.b = b;
    if (!a || !b) throw new Error('canary registration or login failed');
    await populate(context, states.a, a, false);
    await populate(context, states.b, b, true);
    const current = new Run(client, states, { a, b }, fixtureOf(states.a, states.b), log, new URL(options.oauthIssuer ?? client.origin).origin);
    run.current = current;
    await current.baseline();
    // A's views are read before the attacks: its own audit afterwards rightly lists the B identifiers A sent in denied requests.
    await current.headersAndParameters();
    log(`running ${String(MATRIX_CASES.length)} matrix cases`);
    for (const entry of MATRIX_CASES) await current.matrix(entry);
    await current.credentials();
    await current.sockets();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'cleanup-only run') fatal = message;
  } finally {
    log('retiring canaries');
    try { await cleanup(context, states, sessions); } catch (error) { fatal ??= `cleanup: ${error instanceof Error ? error.message : String(error)}`; }
    await context.persist();
  }
  return receiptOf(options, client, states, steps, run.current, started, fatal);
}
