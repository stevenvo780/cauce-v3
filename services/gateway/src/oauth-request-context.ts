import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OAuthPasswordSession, OAuthRequestContext } from './oauth-authorization-types.js';

export function createOAuthRequestContext(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const deadlineMs = Date.now() + 10_000;
  const close = () => {
    clearTimeout(timer);
    request.raw.removeListener('aborted', abort);
    reply.raw.removeListener('close', closed);
  };
  const abort = () => {
    controller.abort(new DOMException('OAuth request aborted', 'AbortError'));
    close();
  };
  const closed = () => {
    if (!reply.raw.writableFinished) abort();
    close();
  };
  const timer = setTimeout(abort, 10_000);
  timer.unref();
  request.raw.once('aborted', abort);
  reply.raw.once('close', closed);
  if (reply.raw.destroyed || (request.raw.destroyed && !request.raw.complete)) abort();
  return {
    context: Object.freeze({ signal: controller.signal, deadlineMs }),
    close,
  };
}

export function oauthSessionContext(context: OAuthRequestContext, session: OAuthPasswordSession): OAuthRequestContext {
  return Object.freeze({ signal: context.signal, deadlineMs: Math.min(context.deadlineMs, session.expiresAt * 1000) });
}

export function oauthContextSignal(context: OAuthRequestContext): AbortSignal {
  context.signal.throwIfAborted();
  const remaining = Math.floor(context.deadlineMs - Date.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new DOMException('OAuth request expired', 'AbortError');
  return AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(10_000, remaining))]);
}
