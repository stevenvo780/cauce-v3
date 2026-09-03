import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { GrantStore } from '../../services/gateway/src/terminal/authority.js';
import { sessionWindowExpression } from '../../services/gateway/src/terminal/helpers.js';
import { ticketSha256 } from '../../services/gateway/src/terminal/tickets.js';
import type { TerminalSessionRow } from '../../services/gateway/src/terminal/types.js';
import {
  OWNER_TOKEN_OK, REQUEST_ID_OK, UUID_OK, buildContext, configBase, makeRow, stubFleetPool,
  transactionClient, unattributedConsolePrincipal, validControlRequest, validDeleteSession,
  validSessionBody, type Context,
} from './gateway-terminal-session-control-fixtures.js';

/**
 * POST /v3/console/terminal/sessions/:sid/control — taking and giving back a writable TUI.
 * Everything here runs against stubs: the store functions of migration 040 issue real SQL that
 * the pool answers, so the gates are exercised without PostgreSQL.
 */

const HOLD_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_HOLD_ID = '55555555-5555-4555-8555-555555555555';

interface HoldRow {
  id: string;
  session_id: string;
  tenant_id: string;
  alias: string;
  operator_id: string;
  reason: string;
  taken_at: Date;
  expires_at: Date;
  released_at: Date | null;
  released_reason: string | null;
}

type OwnedRow = TerminalSessionRow & { session_expires_at: Date };

function ownedRow(overrides: Partial<TerminalSessionRow> = {}): OwnedRow {
  return {
    ...makeRow({
      mode: 'harness_rw',
      consumed_at: new Date(Date.now() - 10_000),
      ...overrides,
    }),
    session_expires_at: new Date(Date.now() + 300_000),
  };
}

function holdRow(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    id: HOLD_ID,
    session_id: UUID_OK,
    tenant_id: 'Steven',
    alias: 'jarvis',
    operator_id: 'steven-kant',
    reason: 'tomar la TUI para desatascar el turno',
    taken_at: new Date(Date.now() - 1_000),
    expires_at: new Date(Date.now() + 120_000),
    released_at: null,
    released_reason: null,
    ...overrides,
  };
}

interface ControlPoolOptions {
  readonly session?: OwnedRow | undefined;
  readonly hold?: HoldRow | undefined;
  readonly takeConflict?: boolean;
  readonly takeMissing?: boolean;
  readonly releaseFails?: boolean;
  readonly revoked?: TerminalSessionRow | undefined;
}

interface RecordedQuery { text: string; values: unknown[] }

function controlPool(
  options: ControlPoolOptions = {},
): DatabasePool & { __queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const rows = <T>(value: T | undefined): { rows: T[]; rowCount: number } =>
    value === undefined ? { rows: [], rowCount: 0 } : { rows: [value], rowCount: 1 };
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('FROM agents')) {
        return {
          rows: [{
            tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('UPDATE terminal_control_holds')) {
        return rows(options.hold === undefined ? undefined : {
          ...options.hold,
          released_at: new Date(),
          released_reason: String(values[3]),
        });
      }
      if (text.includes('FROM terminal_control_holds')) return rows(options.hold);
      if (text.includes('FROM terminal_sessions')) return rows(options.session);
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => transactionClient((text: string, values: unknown[]) => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO terminal_control_holds')) {
        if (options.takeConflict === true) {
          throw Object.assign(new Error('duplicate key value'), { code: '23505' });
        }
        return options.takeMissing === true ? { rows: [], rowCount: 0 } : { rows: [holdRow()], rowCount: 1 };
      }
      if (text.includes('UPDATE terminal_control_holds')) {
        if (options.releaseFails === true) throw new Error('release query exploded');
        return rows(options.hold === undefined ? undefined : {
          ...options.hold,
          released_at: new Date(),
          released_reason: String(values[1]),
        });
      }
      if (text.includes('SET revoked_at=now()')) return rows(options.revoked);
      return { rows: [], rowCount: 0 };
    })),
    __queries: queries,
  };
  return pool as unknown as DatabasePool & { __queries: RecordedQuery[] };
}

function auditRows(pool: { __queries: RecordedQuery[] }): Record<string, unknown>[] {
  return pool.__queries
    .filter((query) => query.text.includes('INSERT INTO audit_events'))
    .map((query) => ({
      action: query.values[2],
      decision: query.values[3],
      metadata: JSON.parse(String(query.values[5])) as Record<string, unknown>,
    }));
}

function transactionAudits(context: Context): Record<string, unknown>[] {
  return context.recordTransactionalTerminalAudit.mock.calls.map(
    (call) => call[1] as Record<string, unknown>,
  );
}

function grantsFileWith(operator: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-grants-'));
  const path = join(directory, 'grants.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    grants: [{ operator, tenant_id: 'Steven', alias: 'jarvis', modes: ['harness_rw'] }],
  }));
  return path;
}

describe('POST /v3/console/terminal/sessions/:sid/control', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  async function control(body: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/control`,
      payload: body as object,
    });
  }

  it('responde 403 control_permission_required cuando el repositorio rechaza', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({
      pool,
      repository: { assertPermission: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('responde 403 writable_tui_disabled cuando el interruptor de la runbook está apagado', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({ pool, config: { writableTuiEnabled: false } });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'writable_tui_disabled' });
    expect(pool.__queries).toHaveLength(0);
  });

  it('responde 409 stale_terminal_owner cuando el vallado de propietario no casa', async () => {
    const pool = controlPool({});
    ctx = buildContext({ pool });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
  });

  it('lee la sesión con el vallado completo del propietario y la ventana de la 040', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({ pool });
    await control(validControlRequest());
    const owned = pool.__queries.find((query) => query.text.includes('FROM terminal_sessions'));
    expect(owned?.text).toContain('browser_owner_sha256=$7');
    expect(owned?.text).toContain('browser_owner_generation=$6::bigint');
    expect(owned?.text).toContain('operator_id=$2');
    expect(owned?.text).toContain('consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL');
    expect(owned?.text).toContain(`${sessionWindowExpression(8, 9)}>now()`);
    expect(owned?.values.slice(0, 6)).toEqual([
      UUID_OK, 'steven-kant', true, 'Steven:kant', REQUEST_ID_OK, '1',
    ]);
    expect(owned?.values[6]).toEqual(ticketSha256(OWNER_TOKEN_OK));
  });

  it('responde 409 no_recognized_mode cuando la sesión es de sólo lectura', async () => {
    const pool = controlPool({ session: ownedRow({ mode: 'harness' }) });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'no_recognized_mode' });
  });

  it('responde 403 sin atribución: UNATTRIBUTED_OPERATOR nunca toma el control', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({ pool, principal: async () => unattributedConsolePrincipal() });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'forbidden', reason: 'writable_requires_named_operator',
    });
    expect(auditRows(pool)).toEqual([expect.objectContaining({
      action: 'terminal.control_taken', decision: 'deny',
    })]);
  });

  it('responde 403 no_grant_for_operator con un grant comodín sobre un modo escribible', async () => {
    const pool = controlPool({ session: ownedRow() });
    const grants = new GrantStore(grantsFileWith('*'));
    ctx = buildContext({ pool, grants: grants as unknown as never });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant_for_operator' });
  });

  it('toma el control con un grant nominal y audita el arriendo', async () => {
    const pool = controlPool({ session: ownedRow() });
    const grants = new GrantStore(grantsFileWith('steven-kant'));
    ctx = buildContext({ pool, grants: grants as unknown as never });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session_id: UUID_OK, hold_id: HOLD_ID, held_by: 'steven-kant',
    });
    expect(auditRows(pool)).toEqual([expect.objectContaining({
      action: 'terminal.control_taken',
      decision: 'allow',
      metadata: expect.objectContaining({
        hold_id: HOLD_ID,
        operator_reason: 'tomar la TUI para desatascar el turno',
        mode: 'harness_rw',
      }) as unknown,
    })]);
  });

  it('la ventana del arriendo la acota la base: la ruta pasa TTL y techo, no un resto de JS', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(200);
    const inserted = pool.__queries.find(
      (query) => query.text.includes('INSERT INTO terminal_control_holds'),
    );
    expect(inserted?.text).toContain(`LEAST(${sessionWindowExpression(7, 8)}, now()+($6||' milliseconds')::interval)`);
    expect(inserted?.text).toContain('consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL');
    expect(inserted?.text).toContain('FOR UPDATE');
    expect(inserted?.values.slice(5)).toEqual([
      String((configBase().controlHoldSeconds ?? 0) * 1_000),
      configBase().sessionTtlSeconds,
      configBase().sessionMaxTotalSeconds,
    ]);
  });

  it('responde 409 stale_terminal_owner si la sesión muere entre el vallado y la toma', async () => {
    const pool = controlPool({ session: ownedRow(), takeMissing: true });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
  });

  it('exige el grant sobre la cohorte ENTERA del contenedor, no sobre un solo miembro', async () => {
    const pool = controlPool({ session: ownedRow() });
    const grants = new GrantStore(grantsFileWith('steven-kant'));
    ctx = buildContext({
      pool,
      grants: grants as unknown as never,
      cohort: [
        { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw' },
        { tenant_id: 'Steven', alias: 'socrates', container: 'claw', runtime_user: 'claw' },
      ],
    });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant_for_operator' });
    expect(pool.__queries.some((query) => query.text.includes('INSERT INTO terminal_control_holds')))
      .toBe(false);
  });

  it('responde 409 control_held en la segunda toma y sólo nombra al operador', async () => {
    const live = holdRow({ operator_id: 'otro-operador' });
    const pool = controlPool({ session: ownedRow(), takeConflict: true, hold: live });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest());
    expect(response.statusCode).toBe(409);
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      error: 'conflict',
      reason: 'control_held',
      held_by: 'otro-operador',
      expires_at: live.expires_at.toISOString(),
    });
  });

  it('devolver un arriendo ajeno es 403 control_held', async () => {
    const pool = controlPool({
      session: ownedRow(),
      hold: holdRow({ id: OTHER_HOLD_ID, operator_id: 'otro-operador' }),
    });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest({ action: 'release' }));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_held' });
  });

  it('devolver sin arriendo vivo es idempotente: el navegador reintenta desde beforeunload', async () => {
    const pool = controlPool({ session: ownedRow() });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/control`,
      payload: { action: 'release', ...validDeleteSession() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session_id: UUID_OK, hold_id: null, released: true });
  });

  it('devuelve el arriendo propio y lo audita', async () => {
    const pool = controlPool({ session: ownedRow(), hold: holdRow() });
    ctx = buildContext({ pool });
    const response = await control(validControlRequest({ action: 'release' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hold_id: HOLD_ID, released: true });
    expect(auditRows(pool)).toEqual([expect.objectContaining({
      action: 'terminal.control_released', decision: 'allow',
    })]);
  });

  it('revocar la sesión suelta el arriendo en el acto', async () => {
    const revoked = makeRow({ mode: 'harness_rw', consumed_at: new Date(Date.now() - 5_000) });
    const pool = controlPool({ revoked, hold: holdRow() });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession(),
    });
    expect(response.statusCode).toBe(204);
    const released = pool.__queries.filter(
      (query) => query.text.includes('UPDATE terminal_control_holds'),
    );
    expect(released).toHaveLength(1);
    expect(released[0]?.values).toEqual([revoked.id, 'session_revoked']);
    expect(transactionAudits(ctx)).toEqual([
      expect.objectContaining({ action: 'terminal.session.revoked' }),
      expect.objectContaining({
        action: 'terminal.control_released',
        decision: 'info',
        metadata: expect.objectContaining({
          session_id: revoked.id, hold_id: HOLD_ID, reason: 'session_revoked',
        }) as unknown,
      }),
    ]);
    const outsideTransaction = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.filter((call) => String(call[0]).includes('terminal_control_holds'));
    expect(outsideTransaction).toEqual([]);
  });

  it('un arriendo que no se puede devolver tumba la revocación en vez de silenciarse', async () => {
    const revoked = makeRow({ mode: 'harness_rw', consumed_at: new Date(Date.now() - 5_000) });
    const pool = controlPool({ revoked, hold: holdRow(), releaseFails: true });
    ctx = buildContext({ pool });
    const logged = vi.spyOn(ctx.app.log, 'error');
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession(),
    });
    expect(response.statusCode).toBe(400);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: revoked.id, reason: 'session_revoked' }),
      'terminal control hold was not released',
    );
  });

  it('una sesión de sólo lectura no consulta siquiera la tabla de arriendos al revocarse', async () => {
    const revoked = makeRow({ mode: 'shell', consumed_at: new Date(Date.now() - 5_000) });
    const pool = controlPool({ revoked, hold: holdRow() });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession(),
    });
    expect(response.statusCode).toBe(204);
    expect(pool.__queries.some((query) => query.text.includes('terminal_control_holds'))).toBe(false);
  });
});

describe('POST /v3/console/terminal/sessions: puertas del modo escribible', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  function fleetPool() {
    return stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' },
    ]);
  }

  function visibleTarget() {
    return vi.fn(async (_actorTenant: string, _actorAlias: string, targetTenant: string) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled',
    }));
  }

  async function openWritable() {
    return ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody({ mode: 'harness_rw' }),
    });
  }

  it('rechaza harness_rw con el interruptor apagado antes de mirar la flota', async () => {
    const pool = fleetPool();
    const authorizeAgentTarget = visibleTarget();
    ctx = buildContext({
      pool,
      config: { writableTuiEnabled: false },
      repository: { authorizeAgentTarget },
    });
    const response = await openWritable();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'writable_tui_disabled' });
    expect(authorizeAgentTarget).not.toHaveBeenCalled();
  });

  it('rechaza harness_rw sin operador con nombre aunque el destino sea de su propio cliente', async () => {
    const pool = fleetPool();
    ctx = buildContext({
      pool,
      principal: async () => unattributedConsolePrincipal(),
      repository: { authorizeAgentTarget: visibleTarget() },
    });
    const response = await openWritable();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'forbidden', reason: 'writable_requires_named_operator',
    });
  });

  it('deja pasar un shell sin atribuir: es el comportamiento de hoy y no se toca', async () => {
    const pool = fleetPool();
    ctx = buildContext({
      pool,
      principal: async () => unattributedConsolePrincipal(),
      repository: { authorizeAgentTarget: visibleTarget() },
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody({ mode: 'shell' }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'agent_offline' });
  });
});

beforeEach(() => { vi.clearAllMocks(); });
