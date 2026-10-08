import { createHash, randomUUID } from 'node:crypto';
import { ProviderAuthError, ProviderAuthRequestSchema } from './provider-auth.contracts.js';
import type {
  ProviderAuthActor, ProviderAuthChannel, ProviderAuthCode, ProviderAuthDependencies,
  ProviderAuthLogin, ProviderAuthRequest, ProviderAuthReservation, ProviderAuthSnapshot, ProviderAuthStatus,
} from './provider-auth.types.js';

interface Session {
  actor: ProviderAuthActor;
  request: ProviderAuthRequest;
  snapshot: ProviderAuthSnapshot;
  abort: AbortController;
  cohort: string;
  reservation: ProviderAuthReservation | undefined;
  login: ProviderAuthLogin | undefined;
  unsubscribe: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  revalidation: ReturnType<typeof setInterval> | undefined;
  closing: Promise<void> | undefined;
  connected: boolean;
  initializing: boolean;
}
const ACTIVE = new Set<ProviderAuthStatus>(['opening', 'awaiting_login', 'verifying']);

export class ProviderAuthManager {
  private readonly sessions = new Map<string, Session>();
  private readonly cohorts = new Set<string>();
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<ProviderAuthSnapshot> }>();
  private readonly tickets = new Map<string, { actor: ProviderAuthActor; sessionId: string; expires: number }>();
  private readonly ttlMs: number;
  constructor(private readonly dependencies: ProviderAuthDependencies, options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 600_000) throw new ProviderAuthError('INVALID_REQUEST');
  }

  async start(actor: ProviderAuthActor, value: unknown): Promise<ProviderAuthSnapshot> {
    const parsed = ProviderAuthRequestSchema.safeParse(value);
    if (!parsed.success || !actor.subject) throw new ProviderAuthError('INVALID_REQUEST');
    const request = parsed.data;
    const key = JSON.stringify([actor.subject, actor.tenant_id, actor.alias, request.request_id]);
    const fingerprint = JSON.stringify(request);
    const prior = this.requests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ProviderAuthError('SESSION_CONFLICT');
      await this.authorize(actor, request);
      const result = await prior.result;
      return this.get(actor, result.session_id);
    }
    const result = this.open(actor, request);
    this.requests.set(key, { fingerprint, result });
    try { return await result; } catch (error) { this.requests.delete(key); throw error; }
  }

  private async open(actor: ProviderAuthActor, request: ProviderAuthRequest): Promise<ProviderAuthSnapshot> {
    await this.authorize(actor, request);
    if (this.sessions.size >= 1000) throw new ProviderAuthError('SESSION_CONFLICT');
    const cohort = JSON.stringify([request.host_id, request.runtime_user, request.profile_id]);
    if (this.cohorts.has(cohort)) throw new ProviderAuthError('SESSION_CONFLICT');
    this.cohorts.add(cohort);
    const id = randomUUID();
    const session: Session = { actor: { ...actor }, request, cohort, abort: new AbortController(), reservation: undefined,
      login: undefined, unsubscribe: undefined, timer: undefined, revalidation: undefined, closing: undefined, connected: false, initializing: true,
      snapshot: { session_id: id, operation_id: request.operation_id, provider_id: request.provider_id,
        account_id: request.account_id, harness_id: request.harness_id, host_id: request.host_id, runtime_user: request.runtime_user, profile_id: request.profile_id,
        method: 'device', status: 'opening', expires_at: new Date(Date.now() + this.ttlMs).toISOString(), cleanup_pending: false, error: null } };
    this.sessions.set(id, session);
    session.timer = setTimeout(() => { void this.finish(session, 'expired', 'SESSION_EXPIRED'); }, this.ttlMs);
    session.timer.unref();
    try {
      session.reservation = await this.dependencies.reserve(actor, request, id, session.snapshot.expires_at);
      if (session.abort.signal.aborted) throw new ProviderAuthError('SESSION_EXPIRED');
      const stopped = await session.reservation.stopAdapter(session.abort.signal);
      if (stopped.stopped !== true) throw new ProviderAuthError('STOP_UNCONFIRMED');
      await this.access(actor, session);
      if (session.abort.signal.aborted) throw new ProviderAuthError('SESSION_EXPIRED');
      session.login = await session.reservation.openLogin(session.abort.signal);
      if (session.abort.signal.aborted) throw new ProviderAuthError('SESSION_EXPIRED');
      session.snapshot.method = session.login.method;
      session.snapshot.status = 'awaiting_login';
      await this.audit(session);
    } catch (error) {
      if (ACTIVE.has(session.snapshot.status)) await this.finish(session, 'failed', error instanceof ProviderAuthError ? error.code : 'HOST_UNAVAILABLE');
    } finally {
      session.initializing = false;
      if (session.abort.signal.aborted) await this.finish(session, session.snapshot.status, session.snapshot.error);
    }
    return this.snapshot(session);
  }

  async get(actor: ProviderAuthActor, id: string): Promise<ProviderAuthSnapshot> {
    const session = this.lookup(actor, id);
    await this.access(actor, session);
    return this.snapshot(session);
  }

  async attach(actor: ProviderAuthActor, id: string, output: (bytes: Uint8Array) => void): Promise<ProviderAuthChannel> {
    const session = this.lookup(actor, id);
    await this.access(actor, session);
    if (session.connected || session.snapshot.status !== 'awaiting_login' || !session.login) throw new ProviderAuthError('SESSION_CONFLICT');
    session.connected = true;
    session.unsubscribe = session.login.subscribeOutput((bytes) => {
      if (ACTIVE.has(session.snapshot.status) && Date.now() < Date.parse(session.snapshot.expires_at) && bytes.byteLength <= 65_536) {
        try { output(bytes); } catch { void this.finish(session, 'failed', 'LOGIN_FAILED'); }
      }
    });
    let checking = false;
    session.revalidation = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.access(actor, session).catch(() => undefined).finally(() => { checking = false; });
    }, 1000);
    session.revalidation.unref();
    try { await session.login.start(); } catch { await this.finish(session, 'failed', 'LOGIN_FAILED'); throw new ProviderAuthError('LOGIN_FAILED'); }
    return {
      input: async (bytes) => {
        await this.access(actor, session);
        this.assertChannel(session);
        if (bytes.byteLength > 4096) throw new ProviderAuthError('INVALID_REQUEST');
        try { await session.login?.write(bytes); } catch { await this.finish(session, 'failed', 'LOGIN_FAILED'); throw new ProviderAuthError('LOGIN_FAILED'); }
      },
      resize: async (cols, rows) => {
        await this.access(actor, session);
        this.assertChannel(session);
        if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw new ProviderAuthError('INVALID_REQUEST');
        await session.login?.resize(cols, rows);
      },
      close: async () => { if (ACTIVE.has(session.snapshot.status)) await this.finish(session, 'cancelled', null); },
    };
  }

  async verify(actor: ProviderAuthActor, id: string): Promise<ProviderAuthSnapshot> {
    const session = this.lookup(actor, id);
    await this.access(actor, session);
    this.assertChannel(session);
    session.snapshot.status = 'verifying';
    try {
      const evidence = await session.reservation?.verify(session.abort.signal);
      if (session.snapshot.status !== 'verifying') return this.snapshot(session);
      if (evidence?.identity_matches !== true) throw new ProviderAuthError('IDENTITY_MISMATCH');
      if (evidence.functional_call_verified !== true) throw new ProviderAuthError('FUNCTIONAL_CHECK_FAILED');
      await this.access(actor, session);
      if (session.snapshot.status !== 'verifying') return this.snapshot(session);
      await this.finish(session, 'authenticated', null);
    } catch (error) {
      await this.finish(session, 'failed', error instanceof ProviderAuthError ? error.code : 'LOGIN_FAILED');
    }
    return this.snapshot(session);
  }

  async cancel(actor: ProviderAuthActor, id: string): Promise<ProviderAuthSnapshot> {
    const session = this.lookup(actor, id);
    await this.access(actor, session);
    if (ACTIVE.has(session.snapshot.status) || session.snapshot.cleanup_pending) await this.finish(session, 'cancelled', null);
    return this.snapshot(session);
  }

  async revokeOperation(operationId: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => session.request.operation_id === operationId
      && (ACTIVE.has(session.snapshot.status) || session.snapshot.cleanup_pending))
      .map((session) => this.finish(session, 'failed', 'AUTHORITY_REVOKED')));
  }

  async issueSocketTicket(actor: ProviderAuthActor, id: string): Promise<{ ticket: string; expires_at: string }> {
    const session = this.lookup(actor, id);
    await this.access(actor, session);
    if (session.snapshot.status !== 'awaiting_login' || session.connected) throw new ProviderAuthError('SESSION_CONFLICT');
    const now = Date.now();
    for (const [key, ticket] of this.tickets) if (ticket.expires <= now || ticket.sessionId === id) this.tickets.delete(key);
    const ticket = randomUUID();
    const expires = Math.min(now + 10_000, Date.parse(session.snapshot.expires_at));
    this.tickets.set(createHash('sha256').update(ticket).digest('hex'), { actor: { ...actor }, sessionId: id, expires });
    return { ticket, expires_at: new Date(expires).toISOString() };
  }

  async consumeSocketTicket(actor: ProviderAuthActor, id: string, value: string): Promise<void> {
    const key = createHash('sha256').update(value).digest('hex');
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (!ticket || ticket.sessionId !== id || ticket.expires <= Date.now() || !this.sameActor(ticket.actor, actor)) {
      throw new ProviderAuthError('AUTHORITY_REVOKED');
    }
    await this.access(actor, this.lookup(actor, id));
  }

  async shutdown(): Promise<void> {
    this.tickets.clear();
    await Promise.all([...this.sessions.values()].filter((session) => ACTIVE.has(session.snapshot.status) || session.snapshot.cleanup_pending)
      .map((session) => this.finish(session, 'cancelled', null)));
  }

  private sameActor(left: ProviderAuthActor, right: ProviderAuthActor): boolean {
    return left.subject === right.subject && left.tenant_id === right.tenant_id && left.alias === right.alias;
  }

  private lookup(actor: ProviderAuthActor, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || !this.sameActor(session.actor, actor)) throw new ProviderAuthError('AUTHORITY_REVOKED');
    return session;
  }
  private async authorize(actor: ProviderAuthActor, request: ProviderAuthRequest): Promise<void> {
    try { await this.dependencies.authorize(actor, request); } catch { throw new ProviderAuthError('AUTHORITY_REVOKED'); }
  }
  private async access(actor: ProviderAuthActor, session: Session): Promise<void> {
    if (ACTIVE.has(session.snapshot.status) && Date.now() >= Date.parse(session.snapshot.expires_at)) await this.finish(session, 'expired', 'SESSION_EXPIRED');
    try { await this.authorize(actor, session.request); } catch (error) {
      if (ACTIVE.has(session.snapshot.status)) await this.finish(session, 'failed', 'AUTHORITY_REVOKED');
      throw error;
    }
  }
  private assertChannel(session: Session): void {
    if (session.snapshot.status === 'expired') throw new ProviderAuthError('SESSION_EXPIRED');
    if (!session.connected || session.snapshot.status !== 'awaiting_login') throw new ProviderAuthError('SESSION_CONFLICT');
  }
  private snapshot(session: Session): ProviderAuthSnapshot { return { ...session.snapshot }; }
  private async audit(session: Session): Promise<void> {
    await this.dependencies.audit({ actor_subject: session.actor.subject, session_id: session.snapshot.session_id,
      operation_id: session.request.operation_id, status: session.snapshot.status, error: session.snapshot.error });
  }
  private async finish(session: Session, status: ProviderAuthStatus, error: ProviderAuthCode | null): Promise<void> {
    if (session.closing) return session.closing;
    session.closing = this.cleanup(session, status, error);
    try { await session.closing; } finally { session.closing = undefined; }
  }
  private async cleanup(session: Session, status: ProviderAuthStatus, error: ProviderAuthCode | null): Promise<void> {
    session.snapshot.status = status;
    session.snapshot.error = error;
    session.abort.abort();
    clearTimeout(session.timer);
    clearInterval(session.revalidation);
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    if (session.initializing) {
      session.snapshot.cleanup_pending = true;
      try { await this.audit(session); } catch { session.snapshot.error = 'LOGIN_FAILED'; }
      return;
    }
    try {
      const stopped = session.login ? await session.login.close() : { stopped: true };
      if (stopped.stopped !== true) throw new ProviderAuthError('STOP_UNCONFIRMED');
      await session.reservation?.release();
      this.cohorts.delete(session.cohort);
      session.snapshot.cleanup_pending = false;
      session.connected = false;
      for (const [key, ticket] of this.tickets) if (ticket.sessionId === session.snapshot.session_id) this.tickets.delete(key);
      session.timer = setTimeout(() => {
        this.sessions.delete(session.snapshot.session_id);
        this.requests.delete(JSON.stringify([session.actor.subject, session.actor.tenant_id, session.actor.alias, session.request.request_id]));
      }, 900_000);
      session.timer.unref();
    } catch {
      session.snapshot.status = 'failed'; session.snapshot.error = 'STOP_UNCONFIRMED'; session.snapshot.cleanup_pending = true;
    }
    try { await this.audit(session); } catch { session.snapshot.status = 'failed'; session.snapshot.error = 'LOGIN_FAILED'; }
  }
}
