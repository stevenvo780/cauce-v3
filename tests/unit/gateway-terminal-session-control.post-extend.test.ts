import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalSessionWindowExpression, type DatabasePool } from '@cauce/store';
import {
  sessionExpiry, sessionWindowExpression,
} from '../../services/gateway/src/terminal/helpers.js';
import type { TerminalSessionRow } from '../../services/gateway/src/terminal/types.js';
import {
  UUID_OK, buildContext, configBase, makeRow, transactionClient, validExtendSession,
  type Context,
} from './gateway-terminal-session-control-fixtures.js';

/**
 * POST /v3/console/terminal/sessions/:sid/extend — TUI-06. The extension lives in
 * `window_extended_to`; `consumed_at` is never touched because the console counts slots with it.
 */

type OwnedRow = TerminalSessionRow & { session_expires_at: Date };
interface RecordedQuery { text: string; values: unknown[] }

const AUTHORIZATION_SOURCE = 'services/gateway/src/terminal/relay-proxy/authorization.ts';
const CLAIM_TRANSITION_SOURCE = 'services/gateway/src/terminal/relay-proxy/claim-transition.ts';

function ownedRow(overrides: Partial<TerminalSessionRow> = {}): OwnedRow {
  return {
    ...makeRow({ consumed_at: new Date(Date.now() - 10_000), ...overrides }),
    session_expires_at: new Date(Date.now() + 30_000),
  };
}

function extendPool(options: {
  locked?: OwnedRow | undefined;
  extended?: OwnedRow | undefined;
}): DatabasePool & { __queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => transactionClient((text, values) => {
      queries.push({ text, values });
      if (text.includes('UPDATE terminal_sessions SET window_extended_to')) {
        return options.extended === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [options.extended], rowCount: 1 };
      }
      if (text.includes('FROM terminal_sessions')) {
        return options.locked === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [options.locked], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    })),
    __queries: queries,
  };
  return pool as unknown as DatabasePool & { __queries: RecordedQuery[] };
}

describe('POST /v3/console/terminal/sessions/:sid/extend', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  async function extend() {
    return ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/extend`,
      payload: validExtendSession(),
    });
  }

  it('responde 403 control_permission_required cuando el repositorio rechaza', async () => {
    const pool = extendPool({ locked: ownedRow() });
    ctx = buildContext({
      pool,
      repository: { assertPermission: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const response = await extend();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('responde 409 stale_terminal_owner cuando el vallado de propietario no casa', async () => {
    const pool = extendPool({});
    ctx = buildContext({ pool });
    const response = await extend();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
  });

  it('responde 409 extension_exhausted cuando la ventana ya está en el techo', async () => {
    const pool = extendPool({ locked: ownedRow() });
    ctx = buildContext({ pool });
    const response = await extend();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'extension_exhausted' });
  });

  it('empuja la ventana, audita el nuevo plazo y no toca consumed_at', async () => {
    const consumedAt = new Date(Date.now() - 10_000);
    const extended = {
      ...ownedRow({ consumed_at: consumedAt }),
      session_expires_at: new Date(Date.now() + 30_000),
    };
    const pool = extendPool({ locked: ownedRow({ consumed_at: consumedAt }), extended });
    ctx = buildContext({ pool });
    const response = await extend();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session_id: UUID_OK,
      expires_at: extended.session_expires_at.toISOString(),
    });
    const update = pool.__queries.find(
      (query) => query.text.includes('UPDATE terminal_sessions SET window_extended_to'),
    );
    expect(update?.text).not.toContain('consumed_at=');
    expect(update?.values[7]).toBe(configBase().sessionTtlSeconds);
    expect(update?.values[8]).toBe(configBase().sessionMaxTotalSeconds);
    const audit = ctx.recordTransactionalTerminalAudit.mock.calls.at(-1);
    expect(audit?.[1]).toMatchObject({
      action: 'terminal.session.extended',
      decision: 'info',
      metadata: expect.objectContaining({
        expires_at: extended.session_expires_at.toISOString(),
      }) as unknown,
    });
  });

  it('el empujón está acotado por el techo y sólo avanza si gana ventana', async () => {
    const pool = extendPool({ locked: ownedRow(), extended: ownedRow() });
    ctx = buildContext({ pool });
    await extend();
    const update = pool.__queries.find(
      (query) => query.text.includes('UPDATE terminal_sessions SET window_extended_to'),
    );
    expect(update?.text).toContain(
      'SET window_extended_to=LEAST(now()+make_interval(secs => $8), consumed_at+make_interval(secs => $9))',
    );
    expect(update?.text).toContain(
      `AND LEAST(now()+make_interval(secs => $8), consumed_at+make_interval(secs => $9))>${sessionWindowExpression(8, 9)}`,
    );
  });

  it('la expresión de ventana es la MISMA que revalida el relay en /authz', () => {
    const authorizationSource = readFileSync(AUTHORIZATION_SOURCE, 'utf8');
    const claimTransitionSource = readFileSync(CLAIM_TRANSITION_SOURCE, 'utf8');
    expect(authorizationSource).toContain(sessionWindowExpression(2, 3));
    expect(claimTransitionSource).toContain('sessionWindowExpression(4, 8)');
  });

  it('la ventana la construye el store y lleva SIEMPRE el techo consumed_at + maxTotal', () => {
    expect(sessionWindowExpression(2, 3)).toBe(terminalSessionWindowExpression(2, 3));
    expect(sessionWindowExpression(4, 8)).toBe(
      'LEAST(GREATEST(consumed_at + make_interval(secs => $4), '
      + "COALESCE(window_extended_to, 'epoch'::timestamptz)), "
      + 'consumed_at + make_interval(secs => $8))',
    );
    expect(sessionWindowExpression(2)).toBe(
      'GREATEST(consumed_at + make_interval(secs => $2), '
      + "COALESCE(window_extended_to, 'epoch'::timestamptz))",
    );
  });

  it('sessionExpiry honra la prórroga y nunca pasa del techo total', () => {
    const consumedAt = new Date('2026-01-01T00:00:00Z');
    const base = makeRow({ consumed_at: consumedAt });
    expect(sessionExpiry(base, 900)?.toISOString()).toBe('2026-01-01T00:15:00.000Z');
    const stretched = { ...base, window_extended_to: new Date('2026-01-01T00:40:00Z') };
    expect(sessionExpiry(stretched, 900, 3_600)?.toISOString()).toBe('2026-01-01T00:40:00.000Z');
    const beyond = { ...base, window_extended_to: new Date('2026-01-01T09:00:00Z') };
    expect(sessionExpiry(beyond, 900, 3_600)?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(sessionExpiry({ ...base, consumed_at: null }, 900, 3_600)).toBeUndefined();
  });
});
