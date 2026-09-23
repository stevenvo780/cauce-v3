import { readFileSync } from 'node:fs';
import { DecisionError } from '../src/errors.js';
import { Limits, type LimitOptions } from '../src/limits.js';
import { startHarness } from './support/servicio.js';

function code(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof DecisionError ? error.code : 'otro';
  }
}

const BASE: LimitOptions = { perMinute: 60, burst: 10, dailyInputTokens: 1_000, dailyInputTokensTotal: 100_000, concurrency: 1, concurrencyPerAlias: 1 };

describe('límites del servicio', () => {
  it('la ráfaga se recarga con el tiempo y cada alias tiene su propio cubo', () => {
    let now = Date.parse('2026-09-23T10:00:00Z');
    const limits = new Limits({ ...BASE, burst: 2, now: () => now });
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
    expect(code(() => { limits.admit('zeus'); })).toBe('limite_excedido');
    expect(code(() => { limits.admit('kant'); })).toBeUndefined();
    now += 1_000;
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
  });

  it('el cupo diario reserva antes de llamar, cobra lo gastado y se renueva al cambiar el día UTC', () => {
    let now = Date.parse('2026-09-23T23:59:00Z');
    const limits = new Limits({ ...BASE, now: () => now });
    const primera = limits.reserve('zeus', 400);
    const segunda = limits.reserve('zeus', 400);
    expect(code(() => limits.reserve('zeus', 400))).toBe('cupo_diario_agotado');
    limits.settle(primera, 100);
    limits.settle(primera, 100);
    expect(limits.dailyTokens('zeus')).toBe(100);
    expect(code(() => limits.reserve('zeus', 400))).toBeUndefined();
    expect(code(() => limits.reserve('argos', 900))).toBeUndefined();
    now += 120_000;
    expect(limits.dailyTokens('zeus')).toBe(0);
    expect(code(() => limits.reserve('zeus', 150))).toBeUndefined();
    expect(code(() => limits.reserve('zeus', 150))).toBe('cupo_diario_agotado');
    limits.settle(segunda, 400);
    expect(limits.dailyTokens('zeus')).toBe(400);
  });

  it('el tope de la flota corta aunque cada alias tenga cupo', () => {
    const limits = new Limits({ ...BASE, dailyInputTokensTotal: 1_500 });
    limits.settle(limits.reserve('zeus', 900), 900);
    expect(code(() => limits.reserve('argos', 700))).toBe('cupo_diario_agotado');
    expect(code(() => limits.reserve('argos', 600))).toBeUndefined();
    expect(limits.fleetDailyTokens()).toBe(900);
  });

  it('rechaza por concurrencia en vez de encolar, y un alias no ocupa todas las plazas', async () => {
    const limits = new Limits({ ...BASE, concurrency: 2, concurrencyPerAlias: 1 });
    let release: () => void = () => undefined;
    const busy = limits.withSlot('jarvis', () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(limits.withSlot('jarvis', async () => 'segundo')).rejects.toMatchObject({ code: 'servicio_ocupado', message: expect.stringContaining('jarvis') as unknown });
    await expect(limits.withSlot('zeus', async () => 'otro alias')).resolves.toBe('otro alias');
    release();
    await busy;
    await expect(limits.withSlot('jarvis', async () => 'tercero')).resolves.toBe('tercero');
  });
});

describe('gasto real contra Jev', () => {
  it('cada solicitud que llegó a Jev se cobra, incluidas las del hedge', async () => {
    const h = await startHarness({
      identities: (pki) => [{ fingerprint: pki.client('jarvis').fingerprint, alias: 'jarvis' }],
      jev: { hedgeAfterMs: 100, attemptTimeoutMs: 2_000, totalTimeoutMs: 3_000 },
      limits: { concurrency: 16, concurrencyPerAlias: 16 },
    });
    try {
      h.jev.respond(() => ({ delayMs: 300, body: { model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 875, output_tokens: 1 } } }));
      const body = { state: 'x', questions: { a: { type: 'noul', instructions: 'x' } } };
      const results = await Promise.all(Array.from({ length: 16 }, () => h.call(h.pki.client('jarvis'), 'POST', '/v1/decidir', body)));
      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(h.jev.seen.length).toBe(32);
      const cobrado = results.reduce((total, result) => total + (result.body.solicitudes_jev as number), 0);
      expect(cobrado).toBe(32);
      const auditado = readFileSync(h.auditFile, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { tokens_cobrados: number }).tokens_cobrados);
      expect(auditado.reduce((total, tokens) => total + tokens, 0)).toBe(32 * 875);
    } finally { await h.stop(); }
  });

  it('las decisiones concurrentes no pasan el tope: reservan el peor caso antes de salir', async () => {
    const h = await startHarness({
      identities: (pki) => [{ fingerprint: pki.client('jarvis').fingerprint, alias: 'jarvis' }],
      limits: { concurrency: 16, concurrencyPerAlias: 16, dailyInputTokens: 2_000 },
    });
    try {
      h.jev.respond(() => ({ delayMs: 200, body: { model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.9 } } } }));
      const body = { state: 'x', questions: { a: { type: 'noul', instructions: 'x' } } };
      const results = await Promise.all(Array.from({ length: 16 }, () => h.call(h.pki.client('jarvis'), 'POST', '/v1/decidir', body)));
      const aceptadas = results.filter((result) => result.status === 200).length;
      expect(aceptadas).toBeGreaterThan(0);
      expect(aceptadas).toBeLessThan(16);
      expect(results.filter((result) => result.status === 429).every((result) => result.body.error === 'cupo_diario_agotado')).toBe(true);
      const auditado = readFileSync(h.auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { origen: string; estado: string; tokens_cobrados: number });
      expect(auditado.filter((linea) => linea.origen === 'jev')).toHaveLength(aceptadas);
      expect(auditado.filter((linea) => linea.origen === 'jev').every((linea) => linea.tokens_cobrados > 0)).toBe(true);
      expect(auditado.filter((linea) => linea.origen === 'fallo').every((linea) => linea.estado === 'cupo_diario_agotado' && linea.tokens_cobrados === 0)).toBe(true);
      expect(auditado.reduce((total, linea) => total + linea.tokens_cobrados, 0)).toBeLessThanOrEqual(2_000);
    } finally { await h.stop(); }
  });
});
