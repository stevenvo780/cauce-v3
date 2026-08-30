import type { DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordTerminalAudit,
  terminalAuditMetadata,
  type TerminalAuditContext,
  type TerminalAuditEntry,
} from '../../services/gateway/src/terminal/audit.js';

/**
 * Hermetic tests for `services/gateway/src/terminal/audit.ts`.
 *
 * The audit module has exactly one moving part: the INSERT into `audit_events`.
 * It is the only place that touches `audit_events` from the terminal plane and
 * the column order must match `/audit` in the console. The metadata MUST round
 * trip through `JSON.stringify`/`jsonb` without losing shape, including arrays
 * and nested objects.
 */

function poolCon(query: ReturnType<typeof vi.fn>): DatabasePool {
  return { query } as unknown as DatabasePool;
}

const QUERY_PATTERN = /INSERT INTO audit_events\(/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordTerminalAudit', () => {
  it('hace INSERT con todos los campos serializando metadata como jsonb', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const pool = poolCon(query);
    const entry: TerminalAuditEntry = {
      tenant_id: 'Steven',
      actor_alias: 'zeus',
      action: 'terminal.session.request',
      decision: 'allow',
      trace_id: 'trace-1234',
      metadata: { operator_id: 'op-1', attributed: true, modes: ['shell'] }
    };
    await recordTerminalAudit(pool, entry);
    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0]!;
    const [sql, params] = call as [string, readonly unknown[]];
    expect(sql).toMatch(QUERY_PATTERN);
    expect(sql).toContain('tenant_id, actor_alias, action, decision, trace_id, metadata');
    expect(sql).toContain('VALUES($1,$2,$3,$4,$5,$6::jsonb)');
    expect(params[0]).toBe('Steven');
    expect(params[1]).toBe('zeus');
    expect(params[2]).toBe('terminal.session.request');
    expect(params[3]).toBe('allow');
    expect(params[4]).toBe('trace-1234');
    expect(params[5]).toBe(JSON.stringify(entry.metadata));
    expect(JSON.parse(params[5] as string)).toEqual(entry.metadata);
  });

  it('deja trace_id en null cuando no se provee', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await recordTerminalAudit(poolCon(query), {
      tenant_id: 'Miguel',
      actor_alias: 'kratos',
      action: 'terminal.session.consume',
      decision: 'deny',
      metadata: { reason: 'ticket_expired' }
    });
    const params = query.mock.calls[0]![1] as readonly unknown[];
    expect(params[4]).toBeNull();
    expect(params[3]).toBe('deny');
  });

  it('serializa un metadata vacío como "{}" sin perder la forma del objeto', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await recordTerminalAudit(poolCon(query), {
      tenant_id: 'Pablo',
      actor_alias: 'seneca',
      action: 'terminal.session.close',
      decision: 'info',
      metadata: {}
    });
    const params = query.mock.calls[0]![1] as readonly unknown[];
    expect(params[5]).toBe('{}');
    expect(JSON.parse(params[5] as string)).toEqual({});
  });

  it('preserva metadata profundamente anidado y arrays', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const nested = {
      operator: 'pablo',
      tags: ['vip', 'admin'],
      nested: { a: 1, b: { c: [true, null, 'x'] } }
    };
    await recordTerminalAudit(poolCon(query), {
      tenant_id: 'Pablo',
      actor_alias: 'vulcano',
      action: 'terminal.session.owner_rotated',
      decision: 'allow',
      trace_id: 'trace-nested',
      metadata: nested
    });
    const params = query.mock.calls[0]![1] as readonly unknown[];
    expect(JSON.parse(params[5] as string)).toEqual(nested);
  });

  it('relanza el error cuando metadata no es JSON-serializable (referencia circular)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    interface Cyclic { name: string; self?: unknown }
    const cycle: Cyclic = { name: 'cycle' };
    cycle.self = cycle;
    await expect(recordTerminalAudit(poolCon(query), {
      tenant_id: 'Isa',
      actor_alias: 'salva',
      action: 'terminal.session.revoked',
      decision: 'deny',
      metadata: cycle
    })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('cada decisión posible (allow, deny, info) llega al column decision intacta', async () => {
    for (const decision of ['allow', 'deny', 'info'] as const) {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      await recordTerminalAudit(poolCon(query), {
        tenant_id: 'Jhon',
        actor_alias: 'hegel',
        action: 'terminal.session.resume',
        decision,
        metadata: {}
      });
      const params = query.mock.calls[0]?.[1] as readonly unknown[] | undefined;
      expect(params?.[3]).toBe(decision);
    }
  });
});

describe('terminalAuditMetadata', () => {
  it('compone el esqueleto compartido con los campos del contexto', () => {
    const context: TerminalAuditContext = {
      operator_id: 'pablo',
      attributed: true,
      target_tenant: 'Pablo',
      target_alias: 'seneca',
      container: 'cauce-seneca-1',
      cohort: ['Pablo:seneca', 'Pablo:dedalo'],
      mode: 'shell'
    };
    expect(terminalAuditMetadata(context)).toEqual({
      operator_id: 'pablo',
      attributed: true,
      target_tenant: 'Pablo',
      target_alias: 'seneca',
      container: 'cauce-seneca-1',
      cohort: ['Pablo:seneca', 'Pablo:dedalo'],
      mode: 'shell'
    });
  });

  it('clona el cohort para que mutaciones del caller no contaminen la fila auditada', () => {
    const cohort = ['Pablo:seneca'];
    const context: TerminalAuditContext = {
      operator_id: 'pablo',
      attributed: false,
      target_tenant: 'Pablo',
      target_alias: 'seneca',
      container: null,
      cohort,
      mode: 'harness'
    };
    const metadata = terminalAuditMetadata(context);
    cohort.push('Pablo:dedalo');
    expect(metadata.cohort).toEqual(['Pablo:seneca']);
  });

  it('los extras se mergean POR ENCIMA del esqueleto y admiten shadowing explícito', () => {
    const context: TerminalAuditContext = {
      operator_id: 'pablo',
      attributed: true,
      target_tenant: 'Pablo',
      target_alias: 'seneca',
      container: null,
      cohort: [],
      mode: 'shell'
    };
    const metadata = terminalAuditMetadata(context, {
      ticket_sha256_first16: 'abcd',
      operator_id: 'override'
    });
    expect(metadata).toMatchObject({
      ticket_sha256_first16: 'abcd',
      operator_id: 'override'
    });
  });

  it('los extras vacíos no rompen la composición (default param)', () => {
    const context: TerminalAuditContext = {
      operator_id: 'unattributed:console-basic-auth',
      attributed: false,
      target_tenant: 'Steven',
      target_alias: 'kant',
      container: 'cauce-kant-1',
      cohort: ['Steven:kant'],
      mode: 'shell'
    };
    expect(terminalAuditMetadata(context, {})).toMatchObject({
      operator_id: 'unattributed:console-basic-auth'
    });
  });
});
