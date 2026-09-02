import type { CapabilityState, DlqDisposition } from './api/types';
import type { BadgeTone } from './features/live/activity';
import type { LeaseState } from './lib';

/**
 * One label map and one tone map per domain union, so two screens reached from the same sidebar
 * cannot name the same fact differently. Every surface reads them from here, `/live` included.
 */

export const LEASE_LABEL: Readonly<Record<LeaseState, string>> = {
  online: 'Conectado',
  expired: 'Caído',
  unknown: 'Sin dato',
};

export const LEASE_TONE: Readonly<Record<LeaseState, BadgeTone>> = {
  online: 'online',
  expired: 'offline',
  unknown: 'unknown',
};

/** `unknown` is NOT said "unavailable": absent data is not a measured fault. */
export const CAPABILITY_LABEL: Readonly<Record<CapabilityState, string>> = {
  available: 'Disponible',
  degraded: 'Degradado',
  unavailable: 'No disponible',
  unknown: 'Sin reportar',
};

/** `unavailable` is a fault, not an idle state: it takes the same tone on every surface. */
export const CAPABILITY_TONE: Readonly<Record<CapabilityState, BadgeTone>> = {
  available: 'online',
  degraded: 'warning',
  unavailable: 'danger',
  unknown: 'unknown',
};

export const DLQ_DISPOSITION_LABEL: Readonly<Record<DlqDisposition, string>> = {
  ambiguous: 'EFECTO INCIERTO',
  safe_retry: 'REINTENTO SEGURO',
  missing_final: 'FINAL AUSENTE',
  auth: 'AUTORIZACIÓN',
  expected_offline: 'OFFLINE ESPERADO',
  unclassified: 'SIN CLASIFICAR',
};

export const DLQ_DISPOSITION_TONE: Readonly<Record<DlqDisposition, BadgeTone>> = {
  ambiguous: 'danger',
  missing_final: 'danger',
  safe_retry: 'warning',
  auth: 'warning',
  expected_offline: 'done',
  unclassified: 'info',
};
