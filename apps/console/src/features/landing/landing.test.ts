import { describe, expect, it } from 'vitest';
import type { EntradaPortada } from './landing';
import { puedeDecirSinIncidencias, resumenPortada, rotuloDeVistas } from './landing';

/**
 * Una flota sana, leída entera. Es el CONTROL NEGATIVO de todo este fichero: si `resumenPortada`
 * devolviera alertas acá, cada prueba positiva de abajo sería indistinguible de un detector que
 * dispara siempre, y la portada estaría gritando en falso — que es peor que no avisar, porque tapa
 * el fallo real.
 */
function flotaSana(): EntradaPortada {
  return {
    status: { online: 15, queued: 0, dead_letters: 0, outbox_pending: 0 },
    queues: { observed_at: '2026-08-22T10:00:00.000Z', pending: 0, retrying: 0, dead: 0 },
    quotas: {
      observed_at: '2026-08-22T10:00:00.000Z',
      collectors: [{ host: 'kratos', stale: false, age_seconds: 30 }],
      providers: [
        { provider: 'claude', severity: 'ok', effective_remaining_percent: 80 },
        { provider: 'codex', severity: 'ok', effective_remaining_percent: 61 },
      ],
      paused_accounts: [],
    },
    activity: {
      observed_at: '2026-08-22T10:00:00.000Z',
      totals: {
        agents: 15,
        in_flight: 3,
        queued: 0,
        retrying: 0,
        overdue_in_flight: 0,
        by_state: { working: 3, idle: 12, stalled: 0 },
        flagged: { queued_without_consumer: 0 },
      },
    },
  };
}

describe('control negativo', () => {
  it('una flota sana y leída entera no produce NI UNA alerta', () => {
    const resumen = resumenPortada(flotaSana());
    expect(resumen.alertas).toEqual([]);
    expect(resumen.fuentesAusentes).toEqual([]);
    expect(puedeDecirSinIncidencias(resumen)).toBe(true);
  });

  it('los ceros no se confunden con ausencia: `dead: 0` no es una alerta, `dead: null` tampoco', () => {
    const conNulos = flotaSana();
    conNulos.queues = { pending: null, retrying: null, dead: null };
    expect(resumenPortada(conNulos).alertas).toEqual([]);
  });
});

describe('cada regla dispara sobre su propio campo', () => {
  it('la DLQ con filas es la alerta más grave y manda a Queues', () => {
    const entrada = flotaSana();
    entrada.queues = { pending: 0, retrying: 0, dead: 4 };
    const [alerta] = resumenPortada(entrada).alertas;
    expect(alerta.id).toBe('dlq');
    expect(alerta.tono).toBe('danger');
    expect(alerta.titulo).toBe('4 entregas muertas en la DLQ');
    expect(alerta.ruta).toBe('/queues');
  });

  it('singular y plural no se escriben igual: una sola entrega muerta dice «entrega»', () => {
    const entrada = flotaSana();
    entrada.queues = { dead: 1 };
    expect(resumenPortada(entrada).alertas[0].titulo).toBe('1 entrega muerta en la DLQ');
  });

  it('un ACK vencido sale de totals.overdue_in_flight y manda a la vista viva', () => {
    const entrada = flotaSana();
    entrada.activity!.totals!.overdue_in_flight = 2;
    const alerta = resumenPortada(entrada).alertas.find((item) => item.id === 'ack-vencido');
    expect(alerta?.titulo).toBe('2 entregas con el ACK vencido');
    expect(alerta?.ruta).toBe('/live');
  });

  it('un agente detenido y un alias con cola sin consumidor son DOS alertas distintas', () => {
    const entrada = flotaSana();
    entrada.activity!.totals!.by_state = { stalled: 1 };
    entrada.activity!.totals!.flagged = { queued_without_consumer: 3 };
    const ids = resumenPortada(entrada).alertas.map((alerta) => alerta.id);
    expect(ids).toContain('agentes-detenidos');
    expect(ids).toContain('cola-sin-consumidor');
  });

  it('un proveedor agotado es danger y uno en aviso es warning, y no se pisan', () => {
    const entrada = flotaSana();
    entrada.quotas!.providers = [
      { provider: 'codex', severity: 'exhausted' },
      { provider: 'claude', severity: 'warn' },
      { provider: 'gemini', severity: 'ok' },
    ];
    const alertas = resumenPortada(entrada).alertas;
    const agotada = alertas.find((alerta) => alerta.id === 'cuota-agotada');
    const aviso = alertas.find((alerta) => alerta.id === 'cuota-en-aviso');
    expect(agotada?.tono).toBe('danger');
    expect(agotada?.detalle).toContain('codex');
    expect(aviso?.tono).toBe('warning');
    expect(aviso?.detalle).toContain('claude');
    // El proveedor sano no aparece en ninguna de las dos.
    expect(agotada?.detalle).not.toContain('gemini');
    expect(aviso?.detalle).not.toContain('gemini');
  });

  it('un recolector rancio se avisa aunque los porcentajes se vean bien: son viejos, no actuales', () => {
    const entrada = flotaSana();
    entrada.quotas!.collectors = [
      { host: 'kratos', stale: false },
      { host: 'ws-midas', stale: true },
    ];
    const alerta = resumenPortada(entrada).alertas.find((item) => item.id === 'recolector-rancio');
    expect(alerta?.titulo).toBe('1 recolector de cuotas rancio');
    expect(alerta?.detalle).toContain('ws-midas');
    expect(alerta?.detalle).not.toContain('kratos');
  });

  it('una cuenta pausada se avisa porque el enrutado deja de elegirla', () => {
    const entrada = flotaSana();
    entrada.quotas!.paused_accounts = [{ account_id: 'codex-pro', paused_reason: 'quota_exhausted' }];
    expect(resumenPortada(entrada).alertas.map((alerta) => alerta.id)).toContain('cuentas-pausadas');
  });
});

describe('lo que no se leyó no se afirma', () => {
  it('una fuente caída NO produce alertas, pero tampoco deja decir «sin incidencias»', () => {
    const entrada = flotaSana();
    entrada.quotas = undefined;
    const resumen = resumenPortada(entrada);
    // El punto entero: cero alertas y AUN ASÍ prohibido tranquilizar.
    expect(resumen.alertas).toEqual([]);
    expect(resumen.fuentesAusentes).toEqual(['Consumo de cuotas']);
    expect(puedeDecirSinIncidencias(resumen)).toBe(false);
  });

  it('con el gateway entero caído las cuatro fuentes se declaran por su nombre', () => {
    const resumen = resumenPortada({});
    expect(resumen.fuentesAusentes).toEqual([
      'Estado del sistema',
      'Colas y DLQ',
      'Consumo de cuotas',
      'Actividad de la flota',
    ]);
    expect(puedeDecirSinIncidencias(resumen)).toBe(false);
  });
});

/**
 * El recuento del panel de atajos. Se prueba porque el rótulo escrito a mano ya mintió una vez
 * («Ocho vistas» cuando eran nueve) y una frase que miente no rompe nada: sólo se lee mal.
 */
describe('rotuloDeVistas', () => {
  it('deriva el numeral y concuerda el sustantivo', () => {
    expect(rotuloDeVistas(9)).toBe('Nueve vistas');
    expect(rotuloDeVistas(1)).toBe('Una vista');
    expect(rotuloDeVistas(0)).toBe('Ninguna vista');
  });

  it('pasa a cifra cuando se sale de los numerales escritos', () => {
    expect(rotuloDeVistas(13)).toBe('13 vistas');
  });

  it('no inventa un rótulo con una entrada absurda', () => {
    expect(rotuloDeVistas(-1)).toBe('Ninguna vista');
    expect(rotuloDeVistas(Number.NaN)).toBe('Ninguna vista');
  });
});
