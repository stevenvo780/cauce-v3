/**
 * Single vocabulary for how a context edit reaches the running process, shared by the two
 * channels that mutate it: the canonical profile and the manual governed document.
 *
 * `sessionReloaded` is the only field that claims the process is reading the new text, and only
 * `session_adoption_ack` backs it. A write ACK proves bytes on disk, never a reload.
 */

type ContextApplyChannel = 'profile' | 'manual';

type ContextApplyEvidence =
  | 'none'
  | 'durable_revision'
  | 'probe_write_ack'
  | 'runtime_verification'
  | 'session_adoption_ack';

export type ContextApplyState =
  | 'absent'
  | 'disabled'
  | 'pending'
  | 'written_pending_session'
  | 'pending_session_refresh'
  | 'runtime_unverified'
  | 'drifted'
  | 'applied';

export interface ContextApplyPolicy {
  readonly channels: readonly ContextApplyChannel[];
  readonly evidence: ContextApplyEvidence;
  readonly sessionReloaded: boolean;
  readonly message: string;
}

export const CONTEXT_APPLY_POLICY = {
  absent: {
    channels: ['profile', 'manual'],
    evidence: 'none',
    sessionReloaded: false,
    message: 'no hay contexto guardado todavía para este alias.',
  },
  disabled: {
    channels: ['profile', 'manual'],
    evidence: 'none',
    sessionReloaded: false,
    message: 'el alias está apagado: su contexto no se aplica a ningún runtime.',
  },
  pending: {
    channels: ['profile'],
    evidence: 'durable_revision',
    sessionReloaded: false,
    message: 'hay una revisión guardada que todavía no llegó a los ficheros del contenedor.',
  },
  written_pending_session: {
    channels: ['manual'],
    evidence: 'probe_write_ack',
    sessionReloaded: false,
    message: 'el fichero quedó escrito y la sonda acreditó los bytes, pero un ACK de escritura no '
      + 'prueba que el proceso releyera el fichero: se aplicará cuando la sesión recargue su contexto.',
  },
  pending_session_refresh: {
    channels: ['profile'],
    evidence: 'runtime_verification',
    sessionReloaded: false,
    message: 'el contexto está en disco y verificado, pero la sesión compartida todavía no '
      + 'acreditó haberlo adoptado.',
  },
  runtime_unverified: {
    channels: ['profile'],
    evidence: 'none',
    sessionReloaded: false,
    message: 'no se pudo verificar el runtime, así que no se afirma nada sobre lo que el proceso lee.',
  },
  drifted: {
    channels: ['profile'],
    evidence: 'runtime_verification',
    sessionReloaded: false,
    message: 'lo que hay en el contenedor no coincide con la revisión guardada.',
  },
  applied: {
    channels: ['profile'],
    evidence: 'session_adoption_ack',
    sessionReloaded: true,
    message: 'la sesión acreditó con su propio ACK haber adoptado esta revisión.',
  },
} as const satisfies Readonly<Record<ContextApplyState, ContextApplyPolicy>>;
