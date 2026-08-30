import { describe, expect, it } from 'vitest';
import { TerminalClockSkewError } from '../../services/gateway/src/terminal/session-control.js';

describe('TerminalClockSkewError (clase exportada)', () => {
  it('es instancia de Error y declara `name = TerminalClockSkewError`', () => {
    const error = new TerminalClockSkewError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TerminalClockSkewError');
  });

  it('mensaje cita explícitamente la falta de sincronía con PostgreSQL', () => {
    const error = new TerminalClockSkewError();
    expect(error.message).toMatch(/clock/i);
    expect(error.message).toMatch(/postgreSQL/i);
    expect(error.message).toMatch(/synchron/i);
  });

  it('mantiene `name` tras captura y relanzamiento (try/catch no lo borra)', () => {
    let caught: unknown;
    try { throw new TerminalClockSkewError(); } catch (error) { caught = error; }
    expect((caught as Error).name).toBe('TerminalClockSkewError');
    expect(caught).toBeInstanceOf(TerminalClockSkewError);
  });
});

describe('TerminalClockSkewError: integración con replyError', () => {
  it('la superficie de error custom se distingue de un Error genérico en la captura', () => {
    // Contractual guarantee for the plugin's `replyError`: when the orchestrator throws
    // TerminalClockSkewError, the handler does NOT confuse it with a generic 400 because
    // it has its own branch. Here we only verify instanceof works against Error.
    const err: unknown = new TerminalClockSkewError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TerminalClockSkewError).toBe(true);
    const generic: unknown = new Error('boom');
    expect(generic instanceof TerminalClockSkewError).toBe(false);
  });
});