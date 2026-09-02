import { describe, expect, it } from 'vitest';
import type { EntradaPortada } from './landing';
import {
  agruparAlertas, ALCANCE_DE_LA_CIFRA, conteoPorEstado, desgloseDeColas, puedeDecirSinIncidencias,
  resumenPortada, saldosPorProveedor,
} from './landing';

/**
 * A healthy fleet, read end to end. This is the NEGATIVE CONTROL of this whole file: if
 * `resumenPortada` returned alerts here, every positive test below would be indistinguishable
 * from a detector that always fires, and the landing would be crying wolf — which is worse than
 * not warning at all, because it hides the real failure.
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
    if (entrada.activity?.totals) {
      entrada.activity.totals.overdue_in_flight = 2;
    }
    const alerta = resumenPortada(entrada).alertas.find((item) => item.id === 'ack-vencido');
    expect(alerta?.titulo).toBe('2 entregas con el ACK vencido');
    expect(alerta?.ruta).toBe('/live');
  });

  it('un agente detenido y un alias con cola sin consumidor son DOS alertas distintas', () => {
    const entrada = flotaSana();
    if (entrada.activity?.totals) {
      entrada.activity.totals.by_state = { stalled: 1 };
      entrada.activity.totals.flagged = { queued_without_consumer: 3 };
    }
    const ids = resumenPortada(entrada).alertas.map((alerta) => alerta.id);
    expect(ids).toContain('agentes-detenidos');
    expect(ids).toContain('cola-sin-consumidor');
  });

  it('un proveedor agotado es danger y uno en aviso es warning, y no se pisan', () => {
    const entrada = flotaSana();
    if (entrada.quotas) {
      entrada.quotas.providers = [
        { provider: 'codex', severity: 'exhausted' },
        { provider: 'claude', severity: 'warn' },
        { provider: 'gemini', severity: 'ok' },
      ];
    }
    const alertas = resumenPortada(entrada).alertas;
    const agotada = alertas.find((alerta) => alerta.id === 'cuota-agotada');
    const aviso = alertas.find((alerta) => alerta.id === 'cuota-en-aviso');
    expect(agotada?.tono).toBe('danger');
    expect(agotada?.detalle).toContain('codex');
    expect(aviso?.tono).toBe('warning');
    expect(aviso?.detalle).toContain('claude');
    // The healthy provider does not appear in either.
    expect(agotada?.detalle).not.toContain('gemini');
    expect(aviso?.detalle).not.toContain('gemini');
  });

  it('un recolector rancio se avisa aunque los porcentajes se vean bien: son viejos, no actuales', () => {
    const entrada = flotaSana();
    if (entrada.quotas) {
      entrada.quotas.collectors = [
        { host: 'kratos', stale: false },
        { host: 'ws-midas', stale: true },
      ];
    }
    const alerta = resumenPortada(entrada).alertas.find((item) => item.id === 'recolector-rancio');
    expect(alerta?.titulo).toBe('1 recolector de cuotas rancio');
    expect(alerta?.detalle).toContain('ws-midas');
    expect(alerta?.detalle).not.toContain('kratos');
  });

  it('una cuenta pausada se avisa porque el enrutado deja de elegirla', () => {
    const entrada = flotaSana();
    if (entrada.quotas) {
      entrada.quotas.paused_accounts = [{ account_id: 'codex-pro', paused_reason: 'quota_exhausted' }];
    }
    expect(resumenPortada(entrada).alertas.map((alerta) => alerta.id)).toContain('cuentas-pausadas');
  });
});

describe('lo que no se leyó no se afirma', () => {
  it('una fuente caída NO produce alertas, pero tampoco deja decir «sin incidencias»', () => {
    const entrada = flotaSana();
    entrada.quotas = undefined;
    const resumen = resumenPortada(entrada);
    // The whole point: zero alerts and STILL forbidden to reassure.
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


describe('agruparAlertas — una fila por vista, no una por hallazgo', () => {
  it('junta los avisos que se resuelven en el mismo sitio, sin perder ninguno', () => {
    const resumen = resumenPortada({
      queues: { observed_at: 'x', pending: 0, retrying: 0, dead: 3 },
      activity: {
        observed_at: 'x',
        totals: {
          agents: 5, in_flight: 1, queued: 0, retrying: 0, overdue_in_flight: 7,
          by_state: { stalled: 2 }, flagged: { queued_without_consumer: 1 },
        },
        agents: [],
      },
      quotas: {
        observed_at: 'x',
        collectors: [{ host: 'kratos', stale: true, age_seconds: 9000 }],
        providers: [{ provider: 'codex', severity: 'exhausted' }],
        paused_accounts: [{ account_id: 'a-1' }],
      },
      status: { online: 5, queued: 0, dead_letters: 3, outbox_pending: 0 },
    });
    const grupos = agruparAlertas(resumen.alertas);

    // Seven findings, THREE destinations: /queues, /live and /accounts.
    expect(resumen.alertas.length).toBe(7);
    expect(grupos.map((grupo) => grupo.ruta)).toEqual(['/queues', '/live', '/accounts']);
    // Not one is lost on the way.
    expect(grupos.flatMap((grupo) => grupo.alertas).map((alerta) => alerta.id).sort())
      .toEqual(resumen.alertas.map((alerta) => alerta.id).sort());
    // And the group inherits the WORST tone of its members: a `warning` cannot hide a `danger`.
    expect(grupos.find((grupo) => grupo.ruta === '/accounts')?.tono).toBe('danger');
  });

  it('sin alertas no inventa grupos', () => {
    expect(agruparAlertas([])).toEqual([]);
  });
});

describe('ninguna alerta imprime la ruta del endpoint en su texto visible', () => {
  it('la ruta vive en `fuente`, que la portada cuelga del title=', () => {
    const resumen = resumenPortada({
      queues: { observed_at: 'x', pending: 0, retrying: 0, dead: 1 },
      activity: {
        observed_at: 'x',
        totals: {
          agents: 1, in_flight: 1, queued: 0, retrying: 0, overdue_in_flight: 1,
          by_state: { stalled: 1 }, flagged: { queued_without_consumer: 1 },
        },
        agents: [],
      },
      quotas: {
        observed_at: 'x',
        collectors: [{ host: 'kratos', stale: true, age_seconds: 9000 }],
        providers: [{ provider: 'codex', severity: 'exhausted' }, { provider: 'claude', severity: 'warn' }],
        paused_accounts: [{ account_id: 'a-1' }],
      },
      status: { online: 1, queued: 0, dead_letters: 1, outbox_pending: 0 },
    });
    expect(resumen.alertas.length).toBeGreaterThan(0);
    for (const alerta of resumen.alertas) {
      expect(alerta.titulo, `${alerta.id}.titulo`).not.toMatch(/GET \/v3\//);
      expect(alerta.detalle, `${alerta.id}.detalle`).not.toMatch(/GET \/v3\//);
      // But the source is NOT lost: there is still something to cross-check the number against.
      expect(alerta.fuente, `${alerta.id}.fuente`).toMatch(/^GET \/v3\/console\//);
    }
  });
});

describe('las tres tiras se pintan con lo que el servidor dijo, y con nada más', () => {
  it('una fuente que no contestó devuelve `undefined`, que es lo único que no se puede pintar como un cero', () => {
    expect(desgloseDeColas(undefined)).toBeUndefined();
    expect(saldosPorProveedor(undefined)).toBeUndefined();
    expect(conteoPorEstado(undefined)).toBeUndefined();
    expect(conteoPorEstado({ agents: 3 })).toBeUndefined();
  });

  it('los totales de cola salen del recuento del servidor, no de las filas que cupieron en la página', () => {
    const desglose = desgloseDeColas({
      pending: 4, retrying: 2, dead: 1,
      totals: { pending: 900, retrying: 40, dead: 7 },
      items: [{ lane: 'interactive', state: 'pending' }],
    });
    expect(desglose?.totalesDelServidor).toEqual({ pendientes: 900, retry: 40, revision: 7 });
    expect(desglose?.enPagina).toBe(1);
  });

  it('sin `totals` cae a las cifras de la página, y un campo ausente queda ausente', () => {
    const desglose = desgloseDeColas({ pending: 4, retrying: null, dead: 1, items: [] });
    expect(desglose?.totalesDelServidor).toEqual({ pendientes: 4, retry: undefined, revision: 1 });
  });

  it('el desglose por carril cuenta la muestra: `failed` entra en revisión y el carril desconocido no se inventa', () => {
    const desglose = desgloseDeColas({
      dead: 2,
      muestra_recortada: true,
      items: [
        { lane: 'interactive', state: 'pending' },
        { lane: 'interactive', state: 'failed' },
        { lane: 'batch', state: 'retry' },
        { lane: 'raro' as never, state: 'dead' },
      ],
    });
    expect(desglose?.recortada).toBe(true);
    expect(desglose?.carrilesDeLaPagina).toEqual([
      { lane: 'batch', cuenta: { pendientes: 0, retry: 1, revision: 0 } },
      { lane: 'interactive', cuenta: { pendientes: 1, retry: 0, revision: 1 } },
      { lane: undefined, cuenta: { pendientes: 0, retry: 0, revision: 1 } },
    ]);
  });

  it('la cifra es la peor ventana, no el efectivo: un proveedor agotado que publica 100 % va primero y a cero', () => {
    const saldos = saldosPorProveedor({
      providers: [
        { host: 'kratos', provider: 'sin-lectura', effective_remaining_percent: null, severity: 'unknown' },
        {
          host: 'kratos', provider: 'codex', effective_remaining_percent: 100, severity: 'exhausted',
          limiting_groups: ['codex'],
          groups: [
            { group_key: 'codex', windows: [{ window_key: 'semana', remaining_percent: 0 }] },
            { group_key: 'codex_bengalfox', windows: [{ window_key: 'semana', remaining_percent: 100 }] },
          ],
        },
        {
          host: 'kratos', provider: 'claude', effective_remaining_percent: 14, severity: 'warn',
          groups: [{ windows: [{ remaining_percent: 55 }, { remaining_percent: 14 }, { remaining_percent: 100 }] }],
        },
      ],
    });
    expect(saldos?.map((saldo) => saldo.proveedor)).toEqual(['codex', 'claude', 'sin-lectura']);
    expect(saldos?.[0]).toEqual({
      proveedor: 'codex', host: 'kratos', restante: 0, efectivo: 100, conflicto: true, severidad: 'exhausted',
    });
    expect(saldos?.[1].conflicto).toBe(false);
    expect(saldos?.[2].restante).toBeUndefined();
  });

  it('un cero de saldo SÍ es una lectura: se pinta en cabeza y no se confunde con la ausencia', () => {
    const saldos = saldosPorProveedor({
      providers: [
        { provider: 'sin-lectura', effective_remaining_percent: null },
        { provider: 'seco', effective_remaining_percent: 0, severity: 'exhausted', groups: [{ windows: [{ remaining_percent: 0 }] }] },
      ],
    });
    expect(saldos?.map((saldo) => saldo.restante)).toEqual([0, undefined]);
    expect(saldos?.[1].severidad).toBe('unknown');
  });

  it('«Trabajando» suma `working` y `saturated` en UNA fila: dos filas con la misma palabra se leen como un doble recuento', () => {
    const filas = conteoPorEstado({ by_state: { idle: 3, queued: 1, working: 8, saturated: 1, stalled: 2 } });
    expect(filas?.map((fila) => [fila.label, fila.valor])).toEqual([
      ['Libre', 3], ['Recibiendo', 1], ['Trabajando', 9], ['Trabado', 2],
    ]);
    expect(filas?.find((fila) => fila.label === 'Trabajando')?.estados).toEqual(['working', 'saturated']);
    expect(filas?.reduce((suma, fila) => suma + fila.parte, 0)).toBeCloseTo(1);
  });

  it('un estado que el servidor no mandó no aparece con un cero, y sin ninguno la barra no se divide por cero', () => {
    expect(conteoPorEstado({ by_state: { stalled: 2 } })?.map((fila) => fila.label)).toEqual(['Trabado']);
    expect(conteoPorEstado({ by_state: {} })).toEqual([]);
    expect(conteoPorEstado({ by_state: { idle: 0 } })).toEqual([
      { label: 'Libre', valor: 0, parte: 0, estados: ['idle'] },
    ]);
  });
});

describe('el alcance de cada cifra', () => {
  it('nombra una lectura distinta por frase: dos cifras que no cuadran no pueden decir lo mismo', () => {
    const alcances = Object.values(ALCANCE_DE_LA_CIFRA);
    expect(new Set(alcances).size).toBe(alcances.length);
    for (const alcance of alcances) expect(alcance.trim()).toBe(alcance);
  });
});
