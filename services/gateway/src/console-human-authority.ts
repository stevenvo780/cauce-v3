import type { FastifyReply, FastifyRequest } from 'fastify';
import { lockConsoleHuman, StoreError, type DatabaseClient, type HumanMessageOptions } from '@cauce/store';
import { AuthorizationError, type AuthProvider } from './auth.js';
import { consoleRoleAuthority } from './console-user-authority.js';
import { PasswordAuthProvider } from './password-auth.js';

export interface ConsoleHumanAccess {
  readonly options: HumanMessageOptions;
  close(): void;
}

export async function consoleHumanAccess(
  provider: AuthProvider, request: FastifyRequest, reply: FastifyReply,
): Promise<ConsoleHumanAccess | undefined> {
  if (!(provider instanceof PasswordAuthProvider)) return undefined;
  const session = await provider.verifiedConsoleSession(request);
  if (session === undefined) return undefined;
  const controller = new AbortController();
  const abort = () => { controller.abort(new DOMException('Console operation aborted', 'AbortError')); };
  const responseClosed = () => { if (!reply.raw.writableFinished) abort(); };
  const remaining = Math.max(0, Math.min(10_000, session.expiresAtMs - Date.now()));
  const timer = setTimeout(abort, remaining);
  timer.unref();
  request.raw.once('aborted', abort);
  reply.raw.once('close', responseClosed);
  if (reply.raw.destroyed || (request.raw.destroyed && !request.raw.complete)
      || session.expiresAtMs <= Date.now()) abort();
  const signal = controller.signal;
  const options: HumanMessageOptions = Object.freeze({ signal, humanAuthority: async (client: DatabaseClient) => {
    signal.throwIfAborted();
    if (session.expiresAtMs <= Date.now()) throw new AuthorizationError();
    const timeout = String(Math.max(1, Math.min(5000, session.expiresAtMs - Date.now())));
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [timeout]);
    const snapshot = await lockConsoleHuman(client, session.humanId);
    signal.throwIfAborted();
    if (session.expiresAtMs <= Date.now() || session.issuedAtMs < snapshot.account.passwordChangedAt - 1000) {
      throw new AuthorizationError();
    }
    if (snapshot.humanId !== session.humanId || snapshot.account.defaultTenant !== session.tenantId
        || snapshot.account.actorAlias !== session.actorAlias || snapshot.membership.tenantId !== session.tenantId
        || snapshot.membership.actorAlias !== session.actorAlias) {
      throw new StoreError('conflict', 'console human identity changed');
    }
    const account = consoleRoleAuthority(snapshot.account.role);
    const member = consoleRoleAuthority(snapshot.membership.role);
    if (!account.roles.includes('operator') || !member.roles.includes('operator')
        || !account.permissions.includes('route') || !member.permissions.includes('route')
        || !snapshot.membership.permissions.includes('route')) throw new AuthorizationError();
    return Object.freeze({ humanId: session.humanId, tenantId: session.tenantId, actorAlias: session.actorAlias });
  } });
  return { options, close: () => {
    clearTimeout(timer);
    request.raw.removeListener('aborted', abort);
    reply.raw.removeListener('close', responseClosed);
  } };
}
