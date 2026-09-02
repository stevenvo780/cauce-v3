import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { StoreError, type StoreErrorCode } from '@cauce/store';
import { AuthError, AuthorizationError } from '../../services/gateway/src/auth.js';
import {
  errorStatus, replyError as canonicalReplyError,
} from '../../services/gateway/src/routes/shared.js';
import { replyError } from '../../services/gateway/src/terminal/plugin.js';
import { TerminalClockSkewError } from '../../services/gateway/src/terminal/session-control.js';

interface CapturedReply {
  status: number;
  body: unknown;
}

function capture(
  handler: (reply: FastifyReply, error: unknown) => void,
  error: unknown,
): CapturedReply {
  const captured: CapturedReply = { status: 0, body: undefined };
  const reply = {
    code(value: number) { captured.status = value; return this; },
    send(payload: unknown) { captured.body = payload; return this; },
  } as unknown as FastifyReply;
  handler(reply, error);
  return captured;
}

const STORE_CODES: readonly StoreErrorCode[] = [
  'forbidden', 'fenced', 'not_found', 'conflict', 'no_route', 'invalid_actor', 'invalid_input',
  'rate_limited',
];

describe('errorStatus: registro único de estados del store', () => {
  it('mapea cada código del store a su estado HTTP', () => {
    const mapped = Object.fromEntries(
      STORE_CODES.map((code) => [code, errorStatus(new StoreError(code, code))]),
    );
    expect(mapped).toEqual({
      forbidden: 403, fenced: 403, not_found: 404, conflict: 409,
      no_route: 422, invalid_actor: 422, invalid_input: 422, rate_limited: 500,
    });
  });

  it('lo que no es StoreError no adivina un estado del store', () => {
    expect(errorStatus(new Error('boom'))).toBe(500);
    expect(errorStatus(undefined)).toBe(500);
  });
});

describe('replyError del plano de terminal', () => {
  it('traduce TerminalClockSkewError a 503 terminal_clock_skew', () => {
    const captured = capture(replyError, new TerminalClockSkewError());
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({ error: 'terminal_clock_skew' });
  });

  it('la desincronía de reloj no llega al mapeo canónico', () => {
    const canonical = capture(canonicalReplyError, new TerminalClockSkewError());
    expect(canonical.status).not.toBe(503);
  });

  it('delega todo lo demás en el mapeo canónico, sin tabla propia', () => {
    const errors: unknown[] = [
      new AuthError(),
      new AuthorizationError(),
      new Error('boom'),
      'not an error',
      ...STORE_CODES.map((code) => new StoreError(code, `store says ${code}`)),
    ];
    for (const error of errors) {
      expect(capture(replyError, error)).toEqual(capture(canonicalReplyError, error));
    }
  });
});
