import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createOAuthRequestContext, oauthContextSignal, oauthSessionContext } from './oauth-request-context.js';

function fixture() {
  const raw = Object.assign(new EventEmitter(), { destroyed: false, complete: true });
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false });
  const request = { raw } as unknown as FastifyRequest;
  const reply = { raw: response } as unknown as FastifyReply;
  return { raw, response, ...createOAuthRequestContext(request, reply) };
}

describe('OAuth HTTP cancellation and deadline', () => {
  it.each(['request', 'response'] as const)('cancels on early %s disconnect', (side) => {
    const f = fixture();
    try {
      if (side === 'request') f.raw.emit('aborted'); else f.response.emit('close');
      expect(f.context.signal.aborted).toBe(true);
    } finally { f.close(); }
  });
  it('keeps a completed response successful and releases its listeners', () => {
    const f = fixture();
    f.response.writableFinished = true; f.response.emit('close');
    expect(f.context.signal.aborted).toBe(false);
    f.close();
    expect(f.raw.listenerCount('aborted')).toBe(0);
    expect(f.response.listenerCount('close')).toBe(0);
  });
  it('enforces the absolute request deadline', () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      vi.advanceTimersByTime(10_000);
      expect(f.context.signal.aborted).toBe(true);
    } finally { f.close(); vi.useRealTimers(); }
  });
  it('limits consent by session expiry and rejects it after that boundary', () => {
    const f = fixture();
    const expiresAt = (Date.now() - 1) / 1000;
    try {
      const context = oauthSessionContext(f.context, { userId: 'fixture', credentialStamp: 's'.repeat(43), issuedAt: 0, expiresAt, csrf: 'fixture' });
      expect(context.deadlineMs).toBe(expiresAt * 1000);
      expect(() => oauthContextSignal(context)).toThrow('OAuth request expired');
    } finally { f.close(); }
  });
});
