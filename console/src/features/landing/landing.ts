import type {
  FleetActivitySnapshot,
  QueueSnapshot,
  QuotaSnapshot,
  SystemStatus,
} from '../../api/types';

/**
 * Derivación PURA de la portada. Vive fuera del componente por una razón concreta: es la única
 * parte de la landing que decide algo —si hay que actuar o no— y una decisión así tiene que poder
 * probarse con su control negativo, no observarse a ojo en una pantalla.
 */

export type AlertaTono = 'danger' | 'warning';

export interface Alerta {
  /** Estable: sirve de `key` de React y de ancla en las pruebas. */
  id: string;
  tono: AlertaTono;
  /** La frase, en castellano y con el número adentro. */
  titulo: string;
  /** Qué significa, en castellano. Es lo que se lee. */
  detalle: string;
  /**
   * De qué lectura del servidor sale el número.
   *
   * Esto iba DENTRO de `detalle` —«GET /v3/console/activity → totals.overdue_in_flight»— y se
   * pintaba en la primera pantalla del operador, ocho veces. Una ruta de API es depuración: hace
   * falta para poder contrastar un número dudoso y no hace falta para nada más. Va al `title=`.
   */
  fuente: string;
  /** Adónde se va a resolver. Siempre una ruta viva de la consola. */
  ruta: string;
  rutaLabel: string;
}

export interface ResumenPortada {
  alertas: Alerta[];
  /**
   * Las fuentes que NO contestaron. Es la mitad que casi siempre falta: sin esto, una portada a la
   * que se le cayó `/v3/console/quotas` dibuja cero alertas y se lee exactamente igual que una
   * flota sana. "No lo sé" y "no pasa nada" no pueden pintarse del mismo color.
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
 * Las alertas de la consola entera, en un solo sitio.
 *
 * Nada se sintetiza: cada regla sale de un campo que el servidor manda y el detalle dice cuál es,
 * para que un número dudoso se pueda contrastar contra su vista completa. Una fuente que no llegó
 * no produce alerta —no se puede afirmar sobre lo que no se leyó— pero sí queda anotada en
 * `fuentesAusentes`.
 */
export function resumenPortada(entrada: EntradaPortada): ResumenPortada {
  const alertas: Alerta[] = [];
  const fuentesAusentes: string[] = [];

  if (!entrada.status) fuentesAusentes.push('Estado del sistema');
  if (!entrada.queues) fuentesAusentes.push('Colas y DLQ');
  // Identifica la lectura de cuotas ausente.
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
   * Un recolector rancio no es un detalle de infraestructura: significa que TODOS los porcentajes
   * de arriba pueden estar mintiendo, y sin este aviso se leerían como frescos.
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
 * `true` sólo cuando se leyeron TODAS las fuentes y ninguna trajo una incidencia. Es la única
 * condición bajo la que la portada tiene derecho a decir "sin incidencias".
 */
export function puedeDecirSinIncidencias(resumen: ResumenPortada): boolean {
  return resumen.alertas.length === 0 && resumen.fuentesAusentes.length === 0;
}

/* ============================================================================================ *
 * Agrupar las alertas por su destino.
 * ============================================================================================ */

export interface GrupoDeAlertas {
  ruta: string;
  rutaLabel: string;
  /** El peor tono del grupo: si una sola es `danger`, el grupo es `danger`. */
  tono: AlertaTono;
  alertas: Alerta[];
}

/**
 * Agrupa las alertas por su ruta de destino conservando el orden de gravedad.
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
