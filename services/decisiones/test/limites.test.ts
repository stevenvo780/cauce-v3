import { DecisionError } from '../src/errors.js';
import { Limits } from '../src/limits.js';

function code(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof DecisionError ? error.code : 'otro';
  }
}

describe('límites del servicio', () => {
  it('la ráfaga se recarga con el tiempo y cada alias tiene su propio cubo', () => {
    let now = Date.parse('2026-09-23T10:00:00Z');
    const limits = new Limits({ perMinute: 60, burst: 2, dailyInputTokens: 1_000, concurrency: 1, now: () => now });
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
    expect(code(() => { limits.admit('zeus'); })).toBe('limite_excedido');
    expect(code(() => { limits.admit('kant'); })).toBeUndefined();
    now += 1_000;
    expect(code(() => { limits.admit('zeus'); })).toBeUndefined();
  });

  it('el cupo diario de tokens se agota por alias y se renueva al cambiar el día UTC', () => {
    let now = Date.parse('2026-09-23T23:59:00Z');
    const limits = new Limits({ perMinute: 60, burst: 10, dailyInputTokens: 1_000, concurrency: 1, now: () => now });
    limits.charge('zeus', 999);
    expect(code(() => { limits.assertDailyBudget('zeus'); })).toBeUndefined();
    limits.charge('zeus', 1);
    expect(code(() => { limits.assertDailyBudget('zeus'); })).toBe('cupo_diario_agotado');
    expect(code(() => { limits.assertDailyBudget('argos'); })).toBeUndefined();
    now += 120_000;
    expect(limits.dailyTokens('zeus')).toBe(0);
    expect(code(() => { limits.assertDailyBudget('zeus'); })).toBeUndefined();
  });

  it('rechaza por concurrencia en vez de encolar sin tope', async () => {
    const limits = new Limits({ perMinute: 60, burst: 10, dailyInputTokens: 1_000, concurrency: 1 });
    let release: () => void = () => undefined;
    const busy = limits.withSlot(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(limits.withSlot(async () => 'segundo')).rejects.toMatchObject({ code: 'servicio_ocupado' });
    release();
    await busy;
    await expect(limits.withSlot(async () => 'tercero')).resolves.toBe('tercero');
  });
});
