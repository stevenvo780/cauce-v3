import type { Explicacion } from './ficheros';

/**
 * The same bounds the gateway's `agent-documents/write-admission.ts` applies: TYPED by a person for
 * every save, never defaulted nor generated from the content; a write without it is refused (400).
 */
export const DOCUMENT_REASON_MIN = 8;
export const DOCUMENT_REASON_MAX = 280;

export function problemaDeMotivo(motivo: string): string | undefined {
  const escrito = motivo.trim();
  if (escrito.length < DOCUMENT_REASON_MIN) {
    return `El motivo necesita al menos ${String(DOCUMENT_REASON_MIN)} caracteres escritos a mano `
      + `(lleva ${String(escrito.length)}).`;
  }
  if (motivo.length > DOCUMENT_REASON_MAX) {
    return `El motivo no puede pasar de ${String(DOCUMENT_REASON_MAX)} caracteres `
      + `(lleva ${String(motivo.length)}).`;
  }
  return undefined;
}

/**
 * The two denials that exist ONLY on a save: both 403s answer `forbidden` and only `reason` tells
 * them apart, and a 400 here is the admission of the body, not a bad path.
 */
export function explicarFalloDeMotivo(
  status: number | undefined, codigo: string | undefined, mensajeServidor?: string,
): Explicacion | undefined {
  const detalle = mensajeServidor?.trim();
  if (status === 403 && codigo === 'writable_requires_attribution') {
    return {
      titulo: 'Esta sesión no acredita a la persona que escribe',
      detalle: `${detalle ?? 'El gateway no reconoció a nadie detrás de esta sesión.'} Entrá con tu `
        + 'propia identidad de operador y volvé a guardar: el borrador se conserva.',
      pendiente: true,
    };
  }
  if (status === 400) {
    return {
      titulo: 'La auditoría no admitió este guardado',
      detalle: `${detalle ?? 'El gateway rechazó el cuerpo de la escritura.'} Escribí a mano un `
        + `motivo de entre ${String(DOCUMENT_REASON_MIN)} y ${String(DOCUMENT_REASON_MAX)} `
        + 'caracteres y volvé a guardar: el borrador se conserva.',
      pendiente: true,
    };
  }
  return undefined;
}
