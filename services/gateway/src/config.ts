import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
} from '@cauce/store';

export const DEFAULT_ACK_DEADLINE_MS = 30_000;

export function validateAckDeadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  }
  return value;
}

export function configuredAckDeadlineMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return validateAckDeadlineMs(Number(
    environment.CAUCE_ACK_DEADLINE_MS ?? DEFAULT_ACK_DEADLINE_MS,
  ));
}

/**
 * Techo de vida total de un intento, leído con los MISMOS nombres de variable que el
 * dispatcher. Que los dos servicios lean la misma configuración no es cosmético: el gateway es
 * quien escribe el plazo en cada renovación y el dispatcher quien recoge lo que lo superó. Si
 * el gateway tuviera un techo más alto, seguiría renovando entregas que el reaper ya considera
 * vencidas por techo; si lo tuviera más bajo, congelaría plazos que el reaper todavía no está
 * dispuesto a matar y la entrega moriría por "ACK timeout" genérico — justo la confusión que
 * este guarda existe para evitar. Se despliegan con el mismo bloque de entorno.
 */
export function configuredDeliveryLeaseCap(
  environment: NodeJS.ProcessEnv = process.env,
): { leaseCapMs: number; leaseCapGraceMs: number } {
  const leaseCapMs = Number(
    environment.CAUCE_DELIVERY_LEASE_CAP_MS ?? DEFAULT_DELIVERY_LEASE_CAP_MS,
  );
  if (!Number.isSafeInteger(leaseCapMs) || leaseCapMs <= 0) {
    throw new Error('CAUCE_DELIVERY_LEASE_CAP_MS must be a positive integer');
  }
  const leaseCapGraceMs = Number(
    environment.CAUCE_DELIVERY_LEASE_CAP_GRACE_MS ?? DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
  );
  if (!Number.isSafeInteger(leaseCapGraceMs) || leaseCapGraceMs <= 0) {
    throw new Error('CAUCE_DELIVERY_LEASE_CAP_GRACE_MS must be a positive integer');
  }
  if (leaseCapMs < configuredAckDeadlineMs(environment)) {
    throw new Error(
      'CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS',
    );
  }
  return { leaseCapMs, leaseCapGraceMs };
}

/**
 * Cuántas entregas puede tener un adaptador EN VUELO a la vez.
 *
 * De dónde sale el 2, con los números del incidente del 2026-07-27:
 * el plazo de ACK en producción es de 30 min (CAUCE_ACK_DEADLINE_MS=1800000) y el trabajo real
 * de un agente codex dura p50 10,8 min y p90 56 min. Cuando el gateway reclama N entregas en el
 * mismo instante, las N arrancan el mismo plazo de 30 min a la vez. Para que la última del lote
 * todavía esté dentro de su ventana cuando le toque, hace falta (N−1)·p50 ≤ 30 min, o sea
 * N ≤ 3,7. Con el default del store (20) la cola era 20·10,8 = 216 min contra una ventana de
 * 30: la cola del lote se moría sin haber empezado, se reintentaba, y cada reintento volvía a
 * pagar una corrida entera. Así se llegó a 71 entregas en vuelo en kratos y a 1.001 "ACK
 * timeout" de 1.622 errores.
 *
 * 2 = una ejecutándose + una ya reclamada para que el agente no quede esperando un round trip
 * de red al terminar. Deja la exposición de la segunda en 10,8 min de mediana, un tercio de la
 * ventana. Es deliberadamente conservador: subirlo se hace con la variable de entorno, y el
 * costo de equivocarse hacia arriba (trabajo muerto que se vuelve a pagar) es mucho más caro
 * que el de equivocarse hacia abajo (un round trip de más entre tarea y tarea).
 */
export const DEFAULT_MAX_INFLIGHT_DELIVERIES = 2;

/**
 * Cupo ADICIONAL, reservado, que sólo puede ocupar una entrega que no sea agente-a-agente.
 *
 * Sin esto, el control de admisión de arriba EMPEORA la conversación: si los 2 huecos están
 * ocupados por tareas de 40 minutos, el mensaje de la persona espera 40 minutos. Medido hoy:
 * midas espera 114 min de mediana antes de que su entrega sea reclamada (peor caso 235), y hoy
 * mismo un mensaje a "iza" esperó 50,8 min y murió sin respuesta.
 *
 * 2 porque el tráfico humano por agente es de unidades por hora, no de decenas: dos huecos
 * dejan que un asistente conteste un mensaje nuevo y todavía tome el mensaje siguiente mientras
 * una tarea larga sigue corriendo. Es aditivo, así que el peor caso en vuelo por agente pasa a
 * ser 4 — 17 veces menos que los 71 observados.
 */
export const DEFAULT_HUMAN_RESERVED_DELIVERIES = 2;

export interface DeliveryAdmissionConfig {
  /** Cupo general: lo ocupa cualquier entrega, incluida la de trabajo entre agentes. */
  readonly maxInflightDeliveries: number;
  /** Cupo extra que sólo puede ocupar tráfico humano. */
  readonly humanReservedDeliveries: number;
}

function nonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function validateDeliveryAdmission(value: DeliveryAdmissionConfig): DeliveryAdmissionConfig {
  if (!Number.isSafeInteger(value.maxInflightDeliveries) || value.maxInflightDeliveries < 0) {
    throw new Error('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
  }
  if (!Number.isSafeInteger(value.humanReservedDeliveries) || value.humanReservedDeliveries < 0) {
    throw new Error('CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer');
  }
  // Los dos en cero dejarían al agente sin poder reclamar NADA nunca: un adaptador conectado
  // que jamás recibe trabajo se ve idéntico a un adaptador roto, y ya nos costó una semana
  // distinguir esos dos casos una vez. Falla al arrancar, que es donde se ve.
  if (value.maxInflightDeliveries + value.humanReservedDeliveries < 1) {
    throw new Error(
      'CAUCE_MAX_INFLIGHT_DELIVERIES and CAUCE_HUMAN_RESERVED_DELIVERIES cannot both be zero',
    );
  }
  return value;
}

export function configuredDeliveryAdmission(
  environment: NodeJS.ProcessEnv = process.env,
): DeliveryAdmissionConfig {
  return validateDeliveryAdmission({
    maxInflightDeliveries: nonNegativeInteger(
      'CAUCE_MAX_INFLIGHT_DELIVERIES',
      environment.CAUCE_MAX_INFLIGHT_DELIVERIES,
      DEFAULT_MAX_INFLIGHT_DELIVERIES,
    ),
    humanReservedDeliveries: nonNegativeInteger(
      'CAUCE_HUMAN_RESERVED_DELIVERIES',
      environment.CAUCE_HUMAN_RESERVED_DELIVERIES,
      DEFAULT_HUMAN_RESERVED_DELIVERIES,
    ),
  });
}
