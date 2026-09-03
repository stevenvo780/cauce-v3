import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordTerminalAudit,
  terminalAuditMetadata,
  type TerminalAuditContext,
  type TerminalAuditEntry,
} from '../../services/gateway/src/terminal/audit.js';

/**
 * Estrecha un opcional sin `!` ni `as`.
 *
 * Las dos reglas del preset se contradicen sobre un `T | undefined`: `no-non-null-assertion`
 * prohibe el `!` y `non-nullable-type-assertion-style` exige el `!` en lugar del `as`. La salida
 * no es elegir una, es no aseverar: si el valor falta, la prueba falla diciendo QUE falto, en vez
 * de reventar con «cannot read property of undefined».
 */
function exigir<T>(valor: T | undefined, que: string): T {
  if (valor === undefined) throw new Error(`se esperaba ${que} y no lo hubo`);
  return valor;
}

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
    const call = exigir(query.mock.calls[0], 'una llamada registrada');
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
    const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
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
    const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
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
    const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
    expect(JSON.parse(params[5] as string)).toEqual(nested);
  });

  it('relanza el error cuando metadata no es JSON-serializable (referencia circular)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    // Extiende `Record<string, unknown>` a proposito: se asigna a un `Readonly<Record<string,
    // unknown>>` y una interfaz sin indice no es asignable ahi.
    interface Cyclic extends Record<string, unknown> { name: string; self?: unknown }
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

  it('las acciones del canal de documentos gobernados llegan intactas al column action', async () => {
    const acciones = ['agent_document.write', 'agent_document.denied', 'agent_document.read'] as const;
    for (const action of acciones) {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      await recordTerminalAudit(poolCon(query), {
        tenant_id: 'Steven',
        actor_alias: 'zeus',
        action,
        decision: action === 'agent_document.denied' ? 'deny' : 'allow',
        metadata: {
          operator_id: 'Steven:zeus',
          target_tenant: 'Miguel',
          target_alias: 'kant',
          kind: 'directive',
          path: '/home/dev/.claude/CLAUDE.md',
          sha_before: 'a'.repeat(64),
          sha_after: 'b'.repeat(64),
          bytes: 12,
          harness_id: 'claude',
          home_directory: '/home/dev',
          facts_source: 'measured'
        }
      });
      const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
      expect(params[2]).toBe(action);
      const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('content');
      expect(metadata).not.toHaveProperty('text');
      expect(JSON.stringify(metadata)).not.toContain('CLAUDE.md contenido');
      expect(metadata.target_tenant).toBe('Miguel');
    }
  });

  it('la denegación de documentos nombra su canal y su razón sin cuerpo ninguno', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await recordTerminalAudit(poolCon(query), {
      tenant_id: 'Steven',
      actor_alias: 'zeus',
      action: 'agent_document.denied',
      decision: 'deny',
      metadata: {
        operator_id: 'Steven:zeus',
        target_tenant: 'Miguel',
        target_alias: 'kant',
        channel: 'read',
        reason: 'not_readable',
        kind: 'tools',
        path: null,
        facts_source: 'measured'
      }
    });
    const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
    const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(metadata.channel).toBe('read');
    expect(metadata.reason).toBe('not_readable');
    expect(metadata).not.toHaveProperty('content');
  });

  it('las cinco acciones del control de TUI llegan intactas al column action', async () => {
    const acciones = [
      'terminal.control_taken', 'terminal.control_released', 'terminal.session.extended',
      'terminal.session.authz_denied', 'terminal.session.input'
    ] as const;
    for (const action of acciones) {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      await recordTerminalAudit(poolCon(query), {
        tenant_id: 'Steven',
        actor_alias: 'zeus',
        action,
        decision: action === 'terminal.session.authz_denied' ? 'deny' : 'info',
        metadata: {
          operator_id: 'Steven:zeus',
          session_id: '5d1f6b1e-0000-4000-8000-000000000001',
          bytes: 12,
          refusal: 'session_expired',
          sha256_first16: 'a'.repeat(16)
        }
      });
      const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
      expect(params[2]).toBe(action);
      const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
      expect(metadata.sha256_first16).toHaveLength(16);
      expect(metadata.bytes).toBe(12);
    }
  });

  it('la negativa de autorización del relay se distingue de una revocación real', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await recordTerminalAudit(poolCon(query), {
      tenant_id: 'Steven',
      actor_alias: 'jarvis',
      action: 'terminal.session.authz_denied',
      decision: 'deny',
      metadata: { session_id: 'sesion-1', refusal: 'session_expired', claim_epoch: '3' }
    });
    const params = exigir(query.mock.calls[0], 'una llamada registrada')[1] as readonly unknown[];
    expect(params[2]).toBe('terminal.session.authz_denied');
    expect(params[3]).toBe('deny');
    const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(metadata.refusal).toBe('session_expired');
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

const EMISORES_DE_AUDITORIA = /(terminalAuditMetadata|recordTerminalAudit|recordTransactionalTerminalAudit)\(/g;
const CLAVE_DE_CONTENIDO = /(^|[^\w$.])(content|text|body|payload|data|stdin|keystrokes|ticket|token|secret)\s*:/;

function ficherosDeFuente(directorio: string): string[] {
  return readdirSync(directorio).flatMap((nombre) => {
    const completo = join(directorio, nombre);
    if (statSync(completo).isDirectory()) return ficherosDeFuente(completo);
    return completo.endsWith('.ts') && !completo.endsWith('.test.ts') ? [completo] : [];
  });
}

function llamadasBalanceadas(fuente: string): string[] {
  const encontradas: string[] = [];
  for (const emisor of fuente.matchAll(EMISORES_DE_AUDITORIA)) {
    let profundidad = 0;
    let cursor = emisor.index + emisor[0].length - 1;
    for (; cursor < fuente.length; cursor += 1) {
      if (fuente[cursor] === '(') profundidad += 1;
      else if (fuente[cursor] === ')') {
        profundidad -= 1;
        if (profundidad === 0) break;
      }
    }
    encontradas.push(fuente.slice(emisor.index, cursor + 1));
  }
  return encontradas;
}

describe('«ni un byte de contenido» medido sobre los emisores reales, no sobre metadata fabricada', () => {
  it('ninguna llamada de auditoría de services/gateway/src/terminal nombra una clave de contenido', () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const ficheros = ficherosDeFuente(join(raiz, 'services', 'gateway', 'src', 'terminal'));
    expect(ficheros.length).toBeGreaterThan(10);
    const ofensas: string[] = [];
    let emisores = 0;
    for (const fichero of ficheros) {
      for (const llamada of llamadasBalanceadas(readFileSync(fichero, 'utf8'))) {
        emisores += 1;
        const clave = CLAVE_DE_CONTENIDO.exec(llamada);
        if (clave) ofensas.push(`${fichero}: ${clave[0].trim()}`);
      }
    }
    expect(emisores).toBeGreaterThan(15);
    expect(ofensas).toEqual([]);
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
