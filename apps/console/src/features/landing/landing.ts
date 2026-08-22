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
  /** De dónde salió el número, para poder contrastarlo. */
  detalle: string;
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
  if (!entrada.quotas) fuentesAusentes.push('Cuotas y licencias');
  if (!entrada.activity) fuentesAusentes.push('Actividad de la flota');

  const muertas = positivo(entrada.queues?.dead);
  if (muertas !== undefined) {
    alertas.push({
      id: 'dlq',
      tono: 'danger',
      titulo: `${muertas} ${muertas === 1 ? 'entrega muerta' : 'entregas muertas'} en la DLQ`,
      detalle: 'GET /v3/console/queues → dead. Cada una es un encargo que nadie va a contestar hasta que alguien la reinyecte.',
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
      titulo: `${vencidas} ${vencidas === 1 ? 'entrega' : 'entregas'} con el ACK vencido`,
      detalle: 'GET /v3/console/activity → totals.overdue_in_flight: el agente que las tomó dejó pasar su ack_deadline_at.',
      ruta: '/live',
      rutaLabel: 'La flota ahora',
    });
  }

  const detenidos = positivo(totals?.by_state?.stalled);
  if (detenidos !== undefined) {
    alertas.push({
      id: 'agentes-detenidos',
      tono: 'danger',
      titulo: `${detenidos} ${detenidos === 1 ? 'agente detenido' : 'agentes detenidos'}`,
      detalle: 'GET /v3/console/activity → totals.by_state.stalled: tomaron trabajo y dejaron de acusar recibo.',
      ruta: '/live',
      rutaLabel: 'La flota ahora',
    });
  }

  const sinConsumidor = positivo(totals?.flagged?.queued_without_consumer);
  if (sinConsumidor !== undefined) {
    alertas.push({
      id: 'cola-sin-consumidor',
      tono: 'danger',
      titulo: `${sinConsumidor} ${sinConsumidor === 1 ? 'alias con cola y sin quien la consuma' : 'alias con cola y sin quien la consuma'}`,
      detalle: 'GET /v3/console/activity → totals.flagged.queued_without_consumer. Libre y sordo se ven igual desde afuera; esto los separa.',
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
      titulo: `${agotados.length} ${agotados.length === 1 ? 'proveedor sin saldo' : 'proveedores sin saldo'}`,
      detalle: `Sin cuota: ${agotados.map((provider) => provider.provider ?? 'UNKNOWN').join(', ')}. GET /v3/console/quotas → severity=exhausted.`,
      ruta: '/quotas',
      rutaLabel: 'Cuotas y licencias',
    });
  }

  const enAviso = proveedores.filter((provider) => provider.severity === 'warn');
  if (enAviso.length > 0) {
    alertas.push({
      id: 'cuota-en-aviso',
      tono: 'warning',
      titulo: `${enAviso.length} ${enAviso.length === 1 ? 'proveedor cerca del tope' : 'proveedores cerca del tope'}`,
      detalle: `En aviso: ${enAviso.map((provider) => provider.provider ?? 'UNKNOWN').join(', ')}. GET /v3/console/quotas → severity=warn.`,
      ruta: '/quotas',
      rutaLabel: 'Cuotas y licencias',
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
      titulo: `${rancios.length} ${rancios.length === 1 ? 'recolector de cuotas rancio' : 'recolectores de cuotas rancios'}`,
      detalle: `Sin datos frescos de: ${rancios.map((collector) => collector.host ?? 'UNKNOWN').join(', ')}. Los porcentajes de esos hosts son viejos, no actuales.`,
      ruta: '/quotas',
      rutaLabel: 'Cuotas y licencias',
    });
  }

  const pausadas = (entrada.quotas?.paused_accounts ?? []).length;
  if (pausadas > 0) {
    alertas.push({
      id: 'cuentas-pausadas',
      tono: 'warning',
      titulo: `${pausadas} ${pausadas === 1 ? 'cuenta pausada' : 'cuentas pausadas'}`,
      detalle: 'GET /v3/console/quotas → paused_accounts: mientras dure la pausa, el enrutado no las va a elegir.',
      ruta: '/quotas',
      rutaLabel: 'Cuotas y licencias',
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

/**
 * El recuento del panel «El resto de la consola», derivado de la lista y no contado con el dedo.
 *
 * El rótulo decía «Ocho vistas» cuando ya eran nueve: el atajo a «Ultimate Terminal» faltaba y
 * nadie volvió a contar. Un número escrito a mano en una frase envejece en cuanto se agrega una
 * entrada, y envejece en silencio —no rompe ninguna prueba, no tira ningún error: sólo miente—.
 *
 * En letras hasta doce porque es una frase, no una tabla; de ahí en adelante en cifra, que es como
 * se escribe un número grande en castellano corrido.
 */
const NUMERALES = [
  'Ninguna', 'Una', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis',
  'Siete', 'Ocho', 'Nueve', 'Diez', 'Once', 'Doce',
];

export function rotuloDeVistas(cantidad: number): string {
  if (!Number.isFinite(cantidad) || cantidad < 0) return 'Ninguna vista';
  const entero = Math.trunc(cantidad);
  const palabra = NUMERALES[entero] ?? String(entero);
  // «Ninguna vista» y «Una vista» en singular; de dos en adelante, plural.
  return `${palabra} ${entero <= 1 ? 'vista' : 'vistas'}`;
}
