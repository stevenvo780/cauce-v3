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
    // Garantía contractual para el `replyError` del plugin: cuando el orquestador lanza
    // TerminalClockSkewError, el handler NO lo confunde con un 400 genérico porque tiene
    // su propio branch. Aquí solo verificamos que instanceof funciona contra Error.
    const err: unknown = new TerminalClockSkewError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TerminalClockSkewError).toBe(true);
    const generic: unknown = new Error('boom');
    expect(generic instanceof TerminalClockSkewError).toBe(false);
  });
});