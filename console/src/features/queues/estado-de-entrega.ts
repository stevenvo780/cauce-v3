import type { DeliveryState } from '../../api/types';

/** The eight delivery states in Spanish. What is translated is the LABEL: the key stays as the server writes it, so `state=dead` in a log and "MUERTA" on screen are the same row. */
export const ESTADO_ENTREGA: Readonly<Record<DeliveryState, string>> = {
  pending: 'PENDIENTE',
  leased: 'TOMADA',
  accepted: 'ACEPTADA',
  started: 'EN CURSO',
  done: 'HECHA',
  failed: 'FALLÓ',
  retry: 'EN REINTENTO',
  dead: 'MUERTA',
};

export function rotuloDeEstado(state: DeliveryState | null | undefined): string | undefined {
  return state ? ESTADO_ENTREGA[state] : undefined;
}
