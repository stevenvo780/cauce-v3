import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { QuotaOperationClaim, QuotaOperationExecution } from '@cauce/store';
import type { ProviderAuthLogin } from '../console/provider-auth.types.js';
import type { HostCommandConfig } from './host-command.js';
import { assertLoginPins, createProviderLogin, type ProviderLoginConfig } from './provider-login.js';
import type { QuotaAuthenticationHandle, QuotaExecutionRepository, QuotaHostChannel } from './quota-executor.js';
import { QuotaAuthExchangeSchema, type QuotaAuthCommand, type QuotaAuthEvent } from './quota-auth-contracts.js';
import type { QuotaEffect } from './quota-host-command.js';

type LoginPlan = NonNullable<QuotaEffect['login_plan']>;
interface Session {
  execution: QuotaOperationExecution; claim: QuotaOperationClaim; login: ProviderAuthLogin; abort: AbortController;
  events: QuotaAuthEvent[]; completed: Map<string, boolean>; sequence: number; verified: boolean;
  unsubscribe(): void; loop: Promise<void>; expiresAt: string;
}
export interface QuotaHostAuthenticationOptions {
  host: string; command: HostCommandConfig; projectRoot: string;
  verify(execution: QuotaOperationExecution, signal: AbortSignal): Promise<{ authenticated_verified: true; account_identity: string }>;
  createLogin?(config: ProviderLoginConfig, signal: AbortSignal): Promise<ProviderAuthLogin>;
  loginConfiguration?(plan: LoginPlan, execution: QuotaOperationExecution): Promise<ProviderLoginConfig>;
}
async function fingerprint(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || ![0, process.geteuid?.()].includes(info.uid) || info.nlink !== 1
        || (info.mode & 0o022) !== 0 || info.size > 1_048_576) throw new Error('Quota login helper is unavailable');
    return createHash('sha256').update(await file.readFile()).digest('hex');
  } finally { await file.close(); }
}
async function configuration(options: QuotaHostAuthenticationOptions, plan: LoginPlan): Promise<ProviderLoginConfig> {
  const directory = dirname(options.command.executable);
  const helper = join(directory, 'provider-login.py');
  const paths = ['provider-login.py','provider_login_state.py','provider_login_native.py','provider_login_container.py','fleet_executor_view.py']
    .map(filename => join(directory, filename));
  paths.push(...['cauce_container_proc.py','cauce_container_tree.py'].map(filename => join(options.projectRoot, 'ops/container-runtime', filename)));
  const pins = Object.fromEntries(await Promise.all(paths.map(async filename => [filename, await fingerprint(filename)] as const)));
  await assertLoginPins(pins);
  return { python: options.command.python, helper: { executable: helper, sha256: pins[helper] ?? '', files: pins },
    stateRoot: plan.state_root, packet: plan, method: plan.command.includes('--device-auth') ? 'device' : 'terminal' };
}

export class QuotaHostAuthentication {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly channel: QuotaHostChannel, private readonly repository: QuotaExecutionRepository,
    private readonly options: QuotaHostAuthenticationOptions) {}
  async begin(execution: QuotaOperationExecution, plan: LoginPlan, claim: QuotaOperationClaim,
    kickoffSignal: AbortSignal): Promise<QuotaAuthenticationHandle> {
    kickoffSignal.throwIfAborted();
    if (execution.action !== 'authenticate' || !execution.consent || execution.environment.host_id !== this.options.host
        || plan.operation_id !== execution.operation_id || claim.id !== execution.operation_id
        || plan.account_scope !== execution.environment.account_id || this.sessions.has(claim.id) || this.sessions.size >= 64) {
      throw new Error('Quota authentication scope is unavailable');
    }
    const abort = new AbortController();
    const config = await (this.options.loginConfiguration?.(plan, execution) ?? configuration(this.options, plan));
    const login = await (this.options.createLogin ?? createProviderLogin)(config, abort.signal);
    const session: Session = { execution, claim, login, abort, events: [], completed: new Map(), sequence: 0,
      verified: false, unsubscribe: () => undefined, loop: Promise.resolve(),
      expiresAt: new Date(Date.now() + plan.ttl_seconds * 1000).toISOString() };
    try {
      z.object({ registered: z.literal(true) }).strict().parse(await this.channel.request('POST',
        `/v3/fleet/hosts/${this.options.host}/quota-auth`, { action: 'register', claim, expires_at: session.expiresAt, method: login.method }));
      kickoffSignal.throwIfAborted();
      session.unsubscribe = login.subscribeOutput(bytes => {
        if (bytes.byteLength > 65_536 || session.events.length >= 16) { abort.abort(); return; }
        for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
          if (session.events.length >= 16) { abort.abort(); return; }
          session.sequence += 1;
          session.events.push({ type: 'output', sequence: session.sequence, data: Buffer.from(bytes.subarray(offset, offset + 4096)).toString('base64') });
        }
      });
      this.sessions.set(claim.id, session);
      session.loop = this.poll(session);
      return { public_result: { expires_at: session.expiresAt }, close: async () => { abort.abort(); await session.loop; } };
    } catch (error) { abort.abort(); await login.close(); throw error; }
  }
  private async dispatch(session: Session, command: QuotaAuthCommand): Promise<boolean> {
    const previous = session.completed.get(command.id);
    if (previous !== undefined) return previous;
    let ok = false;
    try {
      if (session.abort.signal.aborted || Date.now() >= Date.parse(session.expiresAt)) throw new Error('Quota session expired');
      switch (command.type) {
        case 'start': await session.login.start(); break;
        case 'input': await session.login.write(Buffer.from(command.data, 'base64')); break;
        case 'resize': await session.login.resize(command.cols, command.rows); break;
        case 'close': {
          const proof = await session.login.close();
          if (!proof.stopped) throw new Error('Quota login stop was not confirmed');
          break;
        }
        case 'verify': {
          if (!(await session.login.close()).stopped) throw new Error('Quota login stop was not confirmed');
          if (!await this.repository.resumeAuthentication(session.claim)) throw new Error('Quota authentication fence was revoked');
          if (!isDeepStrictEqual(await this.repository.execution(session.claim), session.execution)) throw new Error('Quota authentication changed');
          let renewing: Promise<void> | undefined;
          const lease = setInterval(() => {
            if (renewing) return;
            renewing = this.repository.renew(session.claim).then(valid => { if (!valid) session.abort.abort(); })
              .catch(() => { session.abort.abort(); }).finally(() => { renewing = undefined; });
          }, 5000);
          lease.unref();
          try {
            const evidence = await this.options.verify(session.execution, session.abort.signal);
            session.abort.signal.throwIfAborted();
            if (!isDeepStrictEqual(await this.repository.execution(session.claim), session.execution)) throw new Error('Quota authentication changed');
            clearInterval(lease);
            await renewing;
            session.abort.signal.throwIfAborted();
            if (Date.now() >= Date.parse(session.expiresAt)) throw new Error('Quota session expired');
            await this.repository.finish(session.claim, evidence);
            session.verified = true;
          } finally { clearInterval(lease); await renewing; }
          break;
        }
      }
      ok = true;
    } catch { ok = false; }
    session.completed.set(command.id, ok);
    if (session.completed.size > 4096) session.abort.abort();
    return ok;
  }
  private async poll(session: Session): Promise<void> {
    try {
      while (!session.abort.signal.aborted && Date.now() < Date.parse(session.expiresAt)) {
        const sent = session.events.splice(0, 32);
        let response: z.infer<typeof QuotaAuthExchangeSchema>;
        try {
          response = QuotaAuthExchangeSchema.parse(await this.channel.request('POST', `/v3/fleet/hosts/${this.options.host}/quota-auth`,
            { action: 'exchange', claim: session.claim, events: sent }));
        } catch { session.events.unshift(...sent); throw new Error('Quota authentication channel disconnected'); }
        for (const command of response.commands) {
          const ok = await this.dispatch(session, command);
          session.events.push({ type: 'result', id: command.id, ok });
        }
        if (response.finished) break;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); session.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 250); session.abort.signal.addEventListener('abort', done, { once: true });
          if (session.abort.signal.aborted) done();
        });
      }
    } catch { session.abort.abort(); }
    finally {
      session.unsubscribe();
      session.abort.abort();
      const stopped = await session.login.close().catch(() => ({ stopped: false }));
      if (!session.verified && stopped.stopped) {
        try {
          await this.repository.resumeAuthentication(session.claim);
          await this.repository.fail(session.claim, 'STEP_FAILED');
        } catch { /* Expired or replaced claims cannot accept a result. */ }
      }
      this.sessions.delete(session.claim.id);
    }
  }
  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.abort.abort();
    await Promise.all(sessions.map(session => session.loop));
  }
}
