import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  PROTOCOL_VERSION, PublishMessageSchema, buildPublishReceipt, type PublishMessage,
} from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { AuthError, AuthorizationError, type Principal } from '../auth.js';
import {
  consolePublishOperatorScope, errorStatus, replyError, validatedPublishReceipt,
  type TrustedPublishCommand,
} from './shared.js';

/**
 * The gateway never credits a 2xx for a receipt that is not the exact durable effect of THIS
 * invocation. A response assembled from the request half of one publish and the IDs of another
 * answers 409 and forces reconciliation by read, while a truncated store layer keeps its raw
 * fields out of the response.
 */

const COMMAND: TrustedPublishCommand = {
  version: PROTOCOL_VERSION,
  request_id: '30000000-0000-4000-8000-000000000001',
  trace_id: 'trace-30000000-0000-4000-8000-000000000001',
  tenant_id: 'Steven',
  actor_alias: 'argos',
  authenticated_context: { session_id: 'sesion', channel: 'mtls' },
  room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  body: { text: 'recibo exacto' },
  lane: 'interactive',
  priority: 0,
  idempotency_key: 'recibo-exacto-1',
};

function exactReceipt() {
  return buildPublishReceipt(COMMAND, {
    message_id: '11111111-1111-4111-8111-111111111111',
    delivery_ids: ['22222222-2222-4222-8222-222222222222'],
    duplicate: false,
    request_id: COMMAND.request_id,
    trace_id: COMMAND.trace_id,
  });
}

function conflictOf(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    return error as StoreError;
  }
  throw new Error('expected validatedPublishReceipt to throw');
}

describe('validatedPublishReceipt', () => {
  it('accepts the exact durable receipt of this invocation', () => {
    expect(validatedPublishReceipt(exactReceipt(), COMMAND, 1)).toEqual(exactReceipt());
  });

  it('accepts an idempotent duplicate carrying the original transport pair', () => {
    const original = buildPublishReceipt(COMMAND, {
      message_id: '11111111-1111-4111-8111-111111111111',
      delivery_ids: ['22222222-2222-4222-8222-222222222222'],
      duplicate: true,
      request_id: '30000000-0000-4000-8000-000000000099',
      trace_id: 'trace-30000000-0000-4000-8000-000000000099',
    });

    expect(validatedPublishReceipt(original, COMMAND, 1)).toEqual(original);
  });

  it('rejects a receipt that credits another tenant, actor or request', () => {
    const receipt = exactReceipt();
    for (const tampered of [
      { ...receipt, tenant_id: 'Pablo' as const },
      { ...receipt, actor_alias: 'otro' },
      { ...receipt, idempotency_key: 'otra-clave' },
    ]) {
      const conflict = conflictOf(() => validatedPublishReceipt(tampered, COMMAND, 1));
      expect(conflict.code).toBe('conflict');
    }
  });

  it('rejects a receipt with a truncated or duplicated delivery set', () => {
    const receipt = exactReceipt();
    const duplicated = buildPublishReceipt(
      COMMAND,
      {
        message_id: receipt.message_id,
        delivery_ids: [receipt.delivery_ids[0] ?? '', receipt.delivery_ids[0] ?? ''],
        duplicate: false,
        request_id: COMMAND.request_id,
        trace_id: COMMAND.trace_id,
      },
    );

    expect(conflictOf(() => validatedPublishReceipt(receipt, COMMAND, 2)).code).toBe('conflict');
    expect(conflictOf(() => validatedPublishReceipt(duplicated, COMMAND, 2)).code)
      .toBe('conflict');
  });

  it('recomputes the causal hash instead of trusting a self-described one', () => {
    // A receipt assembled from the request half of one publish and the IDs of another: every
    // field parses and every identity matches, but the binding hash no longer binds.
    const receipt = exactReceipt();
    const tampered = {
      ...receipt,
      message_id: '99999999-9999-4999-8999-999999999999',
    };

    expect(conflictOf(() => validatedPublishReceipt(tampered, COMMAND, 1)).code).toBe('conflict');
  });

  it('rejects a fresh insert carrying another invocation transport pair', () => {
    const receipt = buildPublishReceipt(COMMAND, {
      message_id: '11111111-1111-4111-8111-111111111111',
      delivery_ids: ['22222222-2222-4222-8222-222222222222'],
      duplicate: false,
      request_id: '30000000-0000-4000-8000-000000000099',
      trace_id: COMMAND.trace_id,
    });

    expect(conflictOf(() => validatedPublishReceipt(receipt, COMMAND, 1)).code).toBe('conflict');
  });

  it('rejects anything that is not a receipt at all', () => {
    for (const value of [null, {}, { ...exactReceipt(), delivery_ids: [] }]) {
      expect(conflictOf(() => validatedPublishReceipt(value, COMMAND, 1)).code).toBe('conflict');
    }
  });

  it('never leaks the raw store fields through the conflict it throws', () => {
    const conflict = conflictOf(() => validatedPublishReceipt({ secreto: 'x' }, COMMAND, 1));
    expect(conflict.message).not.toContain('secreto');
    expect(conflict.message).toBe('publish did not return an exact durable receipt');
  });
});

describe('consolePublishOperatorScope', () => {
  const base: Principal = {
    tenant_id: 'Steven',
    alias: 'kant',
    session_id: 'sesion',
    channel: 'password',
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
  };

  it('derives a stable scope from the verified operator, not the session', () => {
    const left = consolePublishOperatorScope({ ...base, operator_id: 'operadora-1' });
    const right = consolePublishOperatorScope({
      ...base, operator_id: 'operadora-1', session_id: 'otra-sesion',
    });

    expect(left).toMatch(/^[a-f0-9]{64}$/u);
    expect(right).toBe(left);
  });

  it('separates operators, aliases and the unattributed fallback from each other', () => {
    const scopes = new Set([
      consolePublishOperatorScope({ ...base, operator_id: 'operadora-1' }),
      consolePublishOperatorScope({ ...base, operator_id: 'operadora-2' }),
      consolePublishOperatorScope({ ...base, alias: 'zeus', operator_id: 'operadora-1' }),
      consolePublishOperatorScope(base),
    ]);

    expect(scopes.size).toBe(4);
  });
});

describe('replyError', () => {
  // What the handler observed travels beside the reply, not on it: `status` on the real
  // FastifyReply is a method, and reading it as a value trips the unbound-method rule.
  function reply(): { target: FastifyReply; seen: { status: number; payload: unknown } } {
    const seen = { status: 0, payload: undefined as unknown };
    const target = {
      code(status: number) {
        seen.status = status;
        return {
          send(payload: unknown) {
            seen.payload = payload;
          },
        };
      },
    } as unknown as FastifyReply;
    return { target, seen };
  }

  it.each([
    ['forbidden', 403], ['fenced', 403], ['not_found', 404], ['conflict', 409],
    ['no_route', 422], ['invalid_actor', 422], ['invalid_input', 422],
  ] as const)('maps store %s to %d', (code, status) => {
    const { target, seen } = reply();
    replyError(target, new StoreError(code, 'detalle'));

    expect(seen.status).toBe(status);
    expect(seen.payload).toEqual({ error: code, message: 'detalle' });
    expect(errorStatus(new StoreError(code, 'detalle'))).toBe(status);
  });

  it('answers 401 on authentication failures and 403 on authorization ones', () => {
    const unauthenticated = reply();
    replyError(unauthenticated.target, new AuthError('falta certificado'));
    expect(unauthenticated.seen.status).toBe(401);

    const unauthorized = reply();
    replyError(unauthorized.target, new AuthorizationError('sin permiso'));
    expect(unauthorized.seen.status).toBe(403);
  });

  it('collapses anything else to a 400 without a stack', () => {
    const { target, seen } = reply();
    replyError(target, new Error('explotó el analizador'));

    expect(seen.status).toBe(400);
    expect(seen.payload).toEqual({ error: 'invalid_request', message: 'explotó el analizador' });
  });

  it('keeps an unexpected store code at 500', () => {
    expect(errorStatus(new StoreError('unavailable' as never, 'caído'))).toBe(500);
    expect(errorStatus(new Error('x'))).toBe(500);
  });
});

describe('trustedPublishCommand shape', () => {
  it('keeps the test command inside the protocol', () => {
    // A compile-time shaped command that no longer parses would make every receipt test above
    // prove nothing about the real route.
    expect(PublishMessageSchema.safeParse(COMMAND as PublishMessage).success).toBe(true);
  });
});
