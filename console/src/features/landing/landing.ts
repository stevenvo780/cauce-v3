import type {
  FleetActivitySnapshot,
  QueueSnapshot,
  QuotaSnapshot,
  SystemStatus,
} from '../../api/types';

/**
 * PURE derivation of the landing. Lives outside the component for a specific reason: it is the
 * only part of the landing that decides anything —whether to act or not— and a decision like
 * that has to be testable with its negative control, not eyeballed on a screen.
 */

export type AlertaTono = 'danger' | 'warning';

export interface Alerta {
  /** Stable: serves as React `key` and as an anchor in tests. */
  id: string;
  tono: AlertaTono;
  /** The sentence, with the number baked in. */
  titulo: string;
  /** What it means, in plain language. This is what gets read. */
  detalle: string;
  /**
   * Which server reading the number comes from.
   *
   * This used to live INSIDE `detalle` —"GET /v3/console/activity → totals.overdue_in_flight"—
   * and was painted on the operator's first screen, eight times. An API path is debug info: it
   * is needed to cross-check a dubious number and for nothing else. It goes in `title=`.
   */
  fuente: string;
  /** Where the resolution happens. Always a live console route. */
  ruta: string;
  rutaLabel: string;
}

export interface ResumenPortada {
  alertas: Alerta[];
  /**
   * The sources that did NOT answer. This is the half that is almost always missing: without
   * it, a landing where `/v3/console/quotas` has died draws zero alerts and reads exactly like a
   * healthy fleet. "I don't know" and "nothing is wrong" cannot be painted the same colour.
   */
  fuentesAusentes: string[];
}

export interface EntradaPortada {
  status?: SystemStatus;
  queues?: QueueSnapshot;
  quotas?: QuotaSnapshot;
  activity?: FleetActivitySnapshot;
}

function positivo(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * All the console's alerts, in one place.
 *
 * Nothing is synthesised: each rule comes from a field the server sends and the detail names it,
 * so a dubious number can be cross-checked against its full view. A source that did not arrive
 * does not produce an alert —you cannot assert about what you have not read— but it is recorded
 * in `fuentesAusentes`.
 */
export function resumenPortada(entrada: EntradaPortada): ResumenPortada {
  const alertas: Alerta[] = [];
  const fuentesAusentes: string[] = [];

  if (!entrada.status) fuentesAusentes.push('Estado del sistema');
  if (!entrada.queues) fuentesAusentes.push('Colas y DLQ');
  // Identifies the missing quotas reading.
  if (!entrada.quotas) fuentesAusentes.push('Consumo de cuotas');
  if (!entrada.activity) fuentesAusentes.push('Actividad de la flota');

  const muertas = positivo(entrada.queues?.dead);
  if (muertas !== undefined) {
    alertas.push({
      id: 'dlq',
      tono: 'danger',
      titulo: `${String(muertas)} ${muertas === 1 ? 'entrega muerta' : 'entregas muertas'} en la DLQ`,
      detalle: 'Cada una es un encargo que nadie va a contestar hasta que alguien la reinyecte.',
      fuente: 'GET /v3/console/queues → dead',
      ruta: '/queues',
      rutaLabel: 'Queues & DLQ',
    });
  }

  const totals = entrada.activity?.totals;
  const vencidas = positivo(totals?.overdue_in_flight);
  if (vencidas !== undefined) {
    alertas.push({
      id: 'ack-vencido',
      tono: 'danger',
      titulo: `${String(vencidas)} ${vencidas === 1 ? 'entrega' : 'entregas'} con el ACK vencido`,
      detalle: 'El agente que las tomó dejó pasar el plazo para acusar recibo.',
      fuente: 'GET /v3/console/activity → totals.overdue_in_flight',
      ruta: '/live',
      rutaLabel: 'La flota ahora',
    });
  }

  const detenidos = positivo(totals?.by_state?.stalled);
  if (detenidos !== undefined) {
    alertas.push({
      id: 'agentes-detenidos',
      tono: 'danger',
      titulo: `${String(detenidos)} ${detenidos === 1 ? 'agente trabado' : 'agentes trabados'}`,
      detalle: 'Tomaron trabajo y dejaron de acusar recibo. En «La flota ahora» son los que salen como «Trabado».',
      fuente: 'GET /v3/console/activity → totals.by_state.stalled',
      ruta: '/live',
      rutaLabel: 'La flota ahora',
    });
  }

  const sinConsumidor = positivo(totals?.flagged?.queued_without_consumer);
  if (sinConsumidor !== undefined) {
    alertas.push({
      id: 'cola-sin-consumidor',
      tono: 'danger',
      titulo: `${String(sinConsumidor)} ${sinConsumidor === 1 ? 'alias con cola y sin quien la consuma' : 'alias con cola y sin quien la consuma'}`,
      detalle: 'Libre y sordo se ven igual desde afuera; esto los separa.',
      fuente: 'GET /v3/console/activity → totals.flagged.queued_without_consumer',
      ruta: '/live',
      rutaLabel: 'La flota ahora',
    });
  }

  const proveedores = entrada.quotas?.providers ?? [];
  const agotados = proveedores.filter((provider) => provider.severity === 'exhausted');
  if (agotados.length > 0) {
    alertas.push({
      id: 'cuota-agotada',
      tono: 'danger',
      titulo: `${String(agotados.length)} ${agotados.length === 1 ? 'proveedor sin saldo' : 'proveedores sin saldo'}`,
      detalle: `Sin cuota: ${agotados.map((provider) => provider.provider ?? 'un proveedor sin nombre').join(', ')}.`,
      fuente: 'GET /v3/console/quotas → severity=exhausted',
      ruta: '/accounts',
      rutaLabel: 'Cuentas y cuotas',
    });
  }

  const enAviso = proveedores.filter((provider) => provider.severity === 'warn');
  if (enAviso.length > 0) {
    alertas.push({
      id: 'cuota-en-aviso',
      tono: 'warning',
      titulo: `${String(enAviso.length)} ${enAviso.length === 1 ? 'proveedor cerca del tope' : 'proveedores cerca del tope'}`,
      detalle: `En aviso: ${enAviso.map((provider) => provider.provider ?? 'un proveedor sin nombre').join(', ')}.`,
      fuente: 'GET /v3/console/quotas → severity=warn',
      ruta: '/accounts',
      rutaLabel: 'Cuentas y cuotas',
    });
  }

  /**
   * A stale collector is not an infrastructure detail: it means ALL the percentages above may
   * be lying, and without this notice they would be read as fresh.
   */
  const rancios = (entrada.quotas?.collectors ?? []).filter((collector) => collector.stale === true);
  if (rancios.length > 0) {
    alertas.push({
      id: 'recolector-rancio',
      tono: 'warning',
      titulo: `${String(rancios.length)} ${rancios.length === 1 ? 'recolector de cuotas rancio' : 'recolectores de cuotas rancios'}`,
      detalle: `Sin datos frescos de: ${rancios.map((collector) => collector.host ?? 'un host sin nombre').join(', ')}. Los porcentajes de esos hosts son viejos, no actuales.`,
      fuente: 'GET /v3/console/quotas → collectors[].stale',
      ruta: '/accounts',
      rutaLabel: 'Cuentas y cuotas',
    });
  }

  const pausadas = (entrada.quotas?.paused_accounts ?? []).length;
  if (pausadas > 0) {
    alertas.push({
      id: 'cuentas-pausadas',
      tono: 'warning',
      titulo: `${String(pausadas)} ${pausadas === 1 ? 'cuenta pausada' : 'cuentas pausadas'}`,
      detalle: 'Mientras dure la pausa, el enrutado no las va a elegir.',
      fuente: 'GET /v3/console/quotas → paused_accounts',
      ruta: '/accounts',
      rutaLabel: 'Cuentas y cuotas',
    });
  }

  return { alertas, fuentesAusentes };
}

/**
 * `true` only when ALL sources were read and none brought an incident. This is the only
 * condition under which the landing is allowed to say "no incidents".
 */
export function puedeDecirSinIncidencias(resumen: ResumenPortada): boolean {
  return resumen.alertas.length === 0 && resumen.fuentesAusentes.length === 0;
}

/* ============================================================================================ *
 * Group alerts by their destination.
 * ============================================================================================ */

export interface GrupoDeAlertas {
  ruta: string;
  rutaLabel: string;
  /** The worst tone in the group: if a single one is `danger`, the group is `danger`. */
  tono: AlertaTono;
  alertas: Alerta[];
}

/**
 * Groups alerts by their destination route, preserving severity order.
 */
export function agruparAlertas(alertas: readonly Alerta[]): GrupoDeAlertas[] {
  const grupos: GrupoDeAlertas[] = [];
  for (const alerta of alertas) {
    const existente = grupos.find((grupo) => grupo.ruta === alerta.ruta);
    if (existente) {
      existente.alertas.push(alerta);
      if (alerta.tono === 'danger') existente.tono = 'danger';
      continue;
    }
    grupos.push({ ruta: alerta.ruta, rutaLabel: alerta.rutaLabel, tono: alerta.tono, alertas: [alerta] });
  }
  return grupos;
}
