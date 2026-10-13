import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseJson, type ExternalClient, type ExternalResponse, type ExternalSession } from './route-isolation-external-client.js';

/** Synthetic canary companies: created by public registration, populated and retired through the owner's own API. */
export const CANARY_PREFIX = 'zz-canary-';
export const CANARY_EMAIL_DOMAIN = 'canary.example.invalid';
const RUN_ID = /^[a-z0-9]{4,16}$/u;

export type Side = 'a' | 'b';
export interface ConfigReceipt { summary: string; inverse: unknown; revision: number }
export interface CanaryState {
  side: Side; slug: string; email: string; password: string; name: string;
  registered?: boolean; human?: string; ownerAlias?: string; hub?: string; companyVersion?: number;
  room?: string; agent?: string; configs: ConfigReceipt[];
  reader?: { id: string; email: string; revision: string };
  invitation?: string; enrollmentHost?: string; account?: string; accountVersion?: number; blob?: string;
  layoutVersion?: number; preferencesVersion?: number; sentinel: string; retired?: boolean;
}
export interface StepRecord { step: string; side: Side | 'both'; method: string; route: string; status: number | null; outcome: 'pass' | 'fail' | 'info'; detail?: string }
export interface WalkContext { client: ExternalClient; steps: StepRecord[]; persist: () => Promise<void> }

/** A state file read back for --cleanup must still name only this run's canaries. */
export function assertCanaryStates(runId: string, states: Record<Side, CanaryState>): Record<Side, CanaryState> {
  for (const side of ['a', 'b'] as const) {
    const state = states[side];
    const slug = `${CANARY_PREFIX}${validRunId(runId)}-${side}`;
    if (state.side !== side || state.slug !== slug || state.email !== `${slug}@${CANARY_EMAIL_DOMAIN}`) {
      throw new Error(`state file does not describe the canaries of run ${runId}`);
    }
  }
  return states;
}

export function validRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error('run id must be 4-16 lowercase letters or digits');
  return runId;
}

export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/\D/gu, '').slice(2, 12)}${randomBytes(2).toString('hex')}`;
}

export function canaryStates(runId: string): Record<Side, CanaryState> {
  validRunId(runId);
  const make = (side: Side): CanaryState => {
    const slug = `${CANARY_PREFIX}${runId}-${side}`;
    return { side, slug, email: `${slug}@${CANARY_EMAIL_DOMAIN}`, password: randomBytes(24).toString('base64url'),
      name: `Canario ${side.toUpperCase()} ${runId}`, configs: [], sentinel: `${slug}-secreto-${randomBytes(6).toString('hex')}` };
  };
  return { a: make('a'), b: make('b') };
}

/** Refuses to act on any company outside this run's two canaries. */
export function assertCanary(state: CanaryState, company: unknown): void {
  if (typeof company !== 'string' || company !== state.slug || !company.startsWith(CANARY_PREFIX)) {
    throw new Error(`refusing to operate on a non-canary company (${String(company)})`);
  }
}

function record(context: WalkContext, step: string, state: CanaryState, method: string, route: string,
  response: ExternalResponse | null, ok: boolean, detail?: string): void {
  context.steps.push({ step, side: state.side, method, route, status: response?.status ?? null,
    outcome: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
}

function bodyOf(response: ExternalResponse): Record<string, unknown> {
  const value = parseJson(response.body);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reason(response: ExternalResponse): string {
  const body = bodyOf(response);
  return [body.error, body.message].filter(value => typeof value === 'string').join(': ').slice(0, 200);
}

async function step(context: WalkContext, name: string, state: CanaryState, method: string, route: string,
  request: Parameters<ExternalClient['send']>[2], accept: readonly number[], check?: (body: Record<string, unknown>) => string | undefined,
  tolerate: readonly number[] = [],
): Promise<Record<string, unknown> | undefined> {
  let response: ExternalResponse | null = null;
  try {
    response = await context.client.send(method, route, request);
    if (tolerate.includes(response.status)) {
      context.steps.push({ step: name, side: state.side, method, route, status: response.status, outcome: 'info', detail: reason(response) });
      return undefined;
    }
    if (!accept.includes(response.status)) { record(context, name, state, method, route, response, false, reason(response)); return undefined; }
    const body = bodyOf(response);
    const problem = check?.(body);
    record(context, name, state, method, route, response, problem === undefined, problem);
    return problem === undefined ? body : undefined;
  } catch (error) {
    record(context, name, state, method, route, response, false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function registerAndLogin(context: WalkContext, state: CanaryState): Promise<ExternalSession | undefined> {
  const registered = await step(context, 'register', state, 'POST', '/v3/auth/register', {
    json: { email: state.email, name: state.name, password: state.password, company: { name: state.name, slug: state.slug } },
  }, [201], body => {
    const company = body.company as { id?: unknown } | undefined; const hub = body.hub as { id?: unknown } | undefined;
    const user = body.user as { id?: unknown; username?: unknown } | undefined;
    if (company?.id !== state.slug || typeof hub?.id !== 'string' || typeof user?.id !== 'string') return 'registration receipt does not match the canary';
    Object.assign(state, { registered: true, hub: hub.id, human: user.id, ownerAlias: typeof user.username === 'string' ? user.username : 'owner' });
    return undefined;
  });
  await context.persist();
  if (!registered) return undefined;
  let session: ExternalSession | undefined;
  try {
    session = await context.client.login(state.email, state.password);
    record(context, 'login', state, 'POST', '/v3/auth/login', { status: 200, body: '', setCookies: [], retryAfter: null }, true);
  } catch (error) {
    record(context, 'login', state, 'POST', '/v3/auth/login', null, false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const current = await step(context, 'session', state, 'GET', '/v3/auth/session', { session }, [200], body => {
    const authority = body.authority as { role?: unknown; acting_company?: unknown } | undefined;
    if (body.authenticated !== true || authority?.role !== 'company_owner') return 'session is not an authenticated company owner';
    assertCanary(state, authority.acting_company);
    return undefined;
  });
  return current ? session : undefined;
}

async function config(context: WalkContext, state: CanaryState, session: ExternalSession, name: string, mutation: Record<string, unknown>): Promise<boolean> {
  const body = await step(context, name, state, 'POST', '/v3/console/config/changes', { session, json: { dry_run: false, mutation } }, [201],
    receipt => receipt.applied === true && receipt.inverse_mutation !== undefined ? undefined : 'configuration change has no applied receipt');
  if (!body) return false;
  state.configs.push({ summary: String(body.summary), inverse: body.inverse_mutation, revision: Number(body.revision) });
  await context.persist();
  return true;
}

/** Basic company operations of the walk; B's resources are also the real targets of the isolation probes. */
export async function populate(context: WalkContext, state: CanaryState, session: ExternalSession, full: boolean): Promise<void> {
  const hub = state.hub ?? '';
  await step(context, 'company', state, 'GET', `/v3/console/companies/${state.slug}`, { session }, [200], body => {
    assertCanary(state, body.id);
    if (typeof body.version !== 'number') return 'company has no version';
    state.companyVersion = body.version; return undefined;
  });
  const room = `${state.slug}-sala`;
  if (await config(context, state, session, 'room', { resource: 'room', action: 'create', tenant_id: hub, id: room,
    value: { display_name: `Sala ${state.sentinel}` } })) state.room = room;
  if (!full) {
    // A publishes from its own room so the cross-company recipient check, not the actor check, answers.
    if (state.room !== undefined) await config(context, state, session, 'membership', { resource: 'membership', action: 'create', tenant_id: hub,
      room_id: room, alias: state.ownerAlias ?? 'owner', value: { role: 'agent' } });
    return;
  }
  const agent = `${state.slug}-lector`;
  if (await config(context, state, session, 'agent', { resource: 'agent', action: 'create', tenant_id: hub, alias: agent,
    value: { display_name: 'Lector canario' } })
    && await config(context, state, session, 'membership', { resource: 'membership', action: 'create', tenant_id: hub, room_id: room,
      alias: agent, value: { role: 'agent' } })) state.agent = agent;
  const readerEmail = `${state.slug}-lector@${CANARY_EMAIL_DOMAIN}`;
  await step(context, 'person', state, 'POST', '/v3/console/people', { session, json: { email: readerEmail, display_name: `Persona ${state.sentinel}`,
    role: 'reader', tenant_id: hub, alias: agent, active: true, password: randomBytes(24).toString('base64url') } }, [200, 201], body => {
    if (typeof body.id !== 'string' || typeof body.revision !== 'string') return 'person receipt has no id';
    state.reader = { id: body.id, email: readerEmail, revision: body.revision }; return undefined;
  });
  await context.persist();
  await step(context, 'people', state, 'GET', '/v3/console/people', { session }, [200],
    body => JSON.stringify(body.items).includes(readerEmail) ? undefined : 'the new person is not listed');
  const host = `${state.slug}-zz_canary_${randomBytes(4).toString('hex')}`;
  await step(context, 'invitation', state, 'POST', '/v3/console/fleet/hosts/enrollments', { session, json: { host_id: host, display_name: 'Ordenador canario' } },
    [201], body => {
      assertCanary(state, body.company_id);
      if (typeof body.enrollment_id !== 'string') return 'invitation has no id';
      state.invitation = body.enrollment_id; state.enrollmentHost = host; return undefined;
    });
  await context.persist();
  await step(context, 'account', state, 'POST', '/v3/console/quota-accounts', { session,
    json: { provider: 'codex', label: `Cuenta ${state.sentinel}`, idempotency_key: `canary-${randomUUID()}` } }, [200, 201], body => {
    if (typeof body.account_id !== 'string') return 'quota account has no id';
    state.account = body.account_id; return undefined;
  });
  await context.persist();
  await step(context, 'accounts', state, 'GET', '/v3/console/quota-accounts', { session }, [200], body => {
    const found = (body.accounts as { id?: unknown; version?: unknown }[] | undefined)?.find(item => item.id === state.account);
    if (typeof found?.version !== 'number') return 'the new quota account is not listed';
    state.accountVersion = found.version; return undefined;
  });
  const bytes = `Contenido privado ${state.sentinel}\n`;
  await step(context, 'blob', state, 'PUT', '/v3/blobs', { session, raw: { body: bytes, contentType: 'application/octet-stream' },
    headers: { 'x-cauce-blob-name': 'canario.txt' } }, [200, 201], body => {
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (body.sha256 !== sha) return 'blob receipt does not match the uploaded bytes';
    state.blob = sha; return undefined;
  });
  const layout = await step(context, 'layout', state, 'GET', '/v3/console/office/layout', { session }, [200]);
  if (layout && state.room !== undefined) {
    await step(context, 'layout-write', state, 'PUT', '/v3/console/office/layout', { session, json: { expected_version: layout.version,
      rooms: [{ tenant_id: hub, room_id: state.room, x: 0, y: 0, width: 200, height: 120, parts: [] }] } }, [200], body => {
      if (typeof body.version !== 'number') return 'layout has no version';
      state.layoutVersion = body.version; return undefined;
    });
  }
  const preferences = await step(context, 'preferences', state, 'GET', '/v3/console/preferences', { session }, [200]);
  if (preferences && state.account !== undefined) {
    await step(context, 'preferences-write', state, 'PUT', '/v3/console/preferences', { session,
      json: { expected_version: preferences.version, pinned_quota_accounts: [state.account] } }, [200], body => {
      if (typeof body.version !== 'number') return 'preferences have no version';
      state.preferencesVersion = body.version; return undefined;
    });
  }
  await context.persist();
}

/** Removes what the walk created, then retires the company: the owner's supported deletion (data is preserved, access ends). */
export async function retireCanary(context: WalkContext, state: CanaryState, session: ExternalSession): Promise<void> {
  const name = (value: string) => `cleanup-${value}`;
  const own = await step(context, name('session'), state, 'GET', '/v3/auth/session', { session }, [200], body => {
    assertCanary(state, (body.authority as { acting_company?: unknown } | undefined)?.acting_company); return undefined;
  });
  if (!own) return;
  if (state.layoutVersion !== undefined) {
    await step(context, name('layout'), state, 'PUT', '/v3/console/office/layout', { session, json: { expected_version: state.layoutVersion, rooms: [] } }, [200]);
  }
  if (state.preferencesVersion !== undefined) {
    await step(context, name('preferences'), state, 'PUT', '/v3/console/preferences', { session,
      json: { expected_version: state.preferencesVersion, pinned_quota_accounts: [] } }, [200]);
  }
  // Retiring is the supported end for a person with audit history: purge refuses anyone the audit names.
  if (state.reader) {
    await step(context, name('person-retire'), state, 'DELETE', `/v3/console/people/${state.reader.id}`, { session,
      json: { expected_revision: state.reader.revision } }, [200], body => body.active === false ? undefined : 'person is still active');
  }
  // 409 keeps a resource that durable history still references (the retired person's agent); retiring the company ends it.
  for (const change of [...state.configs].reverse()) {
    await step(context, name(`config ${change.summary}`), state, 'POST', '/v3/console/config/changes', { session,
      json: { dry_run: false, mutation: change.inverse } }, [201], undefined, [409]);
  }
  if (state.account !== undefined && state.accountVersion !== undefined) {
    await step(context, name('account'), state, 'DELETE', `/v3/console/quota-accounts/${state.account}?expected_version=${String(state.accountVersion)}`,
      { session }, [200, 204]);
  }
  if (state.invitation !== undefined) {
    await step(context, name('invitation'), state, 'DELETE', `/v3/console/fleet/hosts/enrollments/${state.invitation}`, { session }, [200, 204]);
  }
  const company = await step(context, name('company-read'), state, 'GET', `/v3/console/companies/${state.slug}`, { session }, [200], body => {
    assertCanary(state, body.id); return typeof body.version === 'number' ? undefined : 'company has no version';
  });
  if (company) {
    await step(context, name('company-retire'), state, 'DELETE', `/v3/console/companies/${state.slug}?expected_version=${String(company.version)}`,
      { session }, [200], body => body.state === 'retired' ? undefined : 'company was not retired');
  }
  await step(context, name('authority-ended'), state, 'GET', '/v3/auth/session', { session }, [200], body => {
    const authority = body.authority as { role?: unknown } | undefined;
    if (authority?.role !== 'none') return 'the retired company still grants authority';
    state.retired = true; return undefined;
  });
  await context.persist();
}

/** Logout clears the cookie; the walk records whether a replayed token still works (stateless sessions). */
export async function logout(context: WalkContext, state: CanaryState, session: ExternalSession): Promise<void> {
  const response = await context.client.send('POST', '/v3/auth/logout', { session });
  const cleared = response.setCookies.some(cookie => /max-age=0|expires=thu, 01 jan 1970/iu.test(cookie));
  record(context, 'logout', state, 'POST', '/v3/auth/logout', response, response.status === 204 && cleared,
    cleared ? undefined : 'logout did not clear the session cookie');
  const replay = await context.client.send('GET', '/v3/auth/session', { session });
  const still = bodyOf(replay).authenticated === true;
  context.steps.push({ step: 'logout-replay', side: state.side, method: 'GET', route: '/v3/auth/session', status: replay.status, outcome: 'info',
    detail: still ? 'a token copied before logout keeps working until it expires (stateless session by design)' : 'the replayed token is rejected' });
}
