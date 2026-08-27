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
 * Techo de vida total de un intento de entrega.
 * Gateway y dispatcher comparten esta configuración para sincronizar
 * la expiración por lease cap y evitar discrepancias en la renovación de entregas.
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
 * Límite predeterminado de entregas en vuelo concurrentes permitidas por adaptador.
 * Mantiene un límite conservador para evitar timeouts acumulativos en colas locales.
 */
export const DEFAULT_MAX_INFLIGHT_DELIVERIES = 2;

/**
 * Cupo reservado adicional para entregas que no son de tipo agente-a-agente (tráfico humano),
 * evitando que tareas de larga duración bloqueen interacciones interactivas.
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
  // Al menos un cupo de admisión debe ser mayor a cero para permitir el reclamo de entregas.
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
