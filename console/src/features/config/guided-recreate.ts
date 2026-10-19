import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { GUIDED_RECREATE_LABEL, operationErrorHuman } from './fleet-operation-text';

export type GuidedStepId = 'cancel' | 'preview' | 'enqueue' | 'follow' | 'auth';

export interface GuidedStepDef { id: GuidedStepId; label: string; activeLabel: string }

export const GUIDED_STEPS: readonly GuidedStepDef[] = [
  { id: 'cancel', label: 'Cancelar la operación desfasada', activeLabel: 'Cancelando la operación desfasada…' },
  { id: 'preview', label: 'Comprobar la preparación', activeLabel: 'Comprobando la preparación…' },
  { id: 'enqueue', label: 'Encolar la recreación del contenedor', activeLabel: 'Encolando la recreación del contenedor…' },
  { id: 'follow', label: 'Recrear el contenedor', activeLabel: 'Recreando el contenedor…' },
  { id: 'auth', label: 'Abrir el inicio de sesión', activeLabel: 'Abriendo el inicio de sesión…' },
];

export const GUIDED_ACTION_LABEL = GUIDED_RECREATE_LABEL;
export const GUIDED_RETRY_LABEL = 'Reintentar';

export type GuidedStatus = 'idle' | 'running' | 'failed' | 'awaiting_auth' | 'done';

export interface GuidedState {
  status: GuidedStatus;
  step: GuidedStepId;
  failedStep: GuidedStepId | null;
  message: string | null;
  operation: FleetOperation | null;
}

export const initialGuidedState: GuidedState = {
  status: 'idle', step: 'cancel', failedStep: null, message: null, operation: null,
};

export type GuidedEvent =
  | { type: 'start' }
  | { type: 'step'; step: GuidedStepId }
  | { type: 'awaiting_auth'; operation: FleetOperation }
  | { type: 'done'; operation?: FleetOperation }
  | { type: 'failed'; step: GuidedStepId; message: string }
  | { type: 'retry' }
  | { type: 'reset' };

export function guidedReduce(state: GuidedState, event: GuidedEvent): GuidedState {
  switch (event.type) {
    case 'start':
      return { status: 'running', step: 'cancel', failedStep: null, message: null, operation: state.operation };
    case 'step':
      return { ...state, status: 'running', step: event.step, failedStep: null, message: null };
    case 'awaiting_auth':
      return { status: 'awaiting_auth', step: 'auth', failedStep: null, message: null, operation: event.operation };
    case 'done':
      return { status: 'done', step: 'auth', failedStep: null, message: null, operation: event.operation ?? state.operation };
    case 'failed':
      return { ...state, status: 'failed', step: event.step, failedStep: event.step, message: event.message };
    case 'retry':
      return { ...state, status: 'running', step: state.failedStep ?? state.step, failedStep: null, message: null };
    case 'reset':
      return initialGuidedState;
  }
}

export function guidedStepIndex(step: GuidedStepId): number {
  return GUIDED_STEPS.findIndex((entry) => entry.id === step);
}

export type GuidedStepStatus = 'done' | 'current' | 'pending' | 'failed';

export function guidedStepStatus(state: GuidedState, step: GuidedStepId): GuidedStepStatus {
  if (state.status === 'done') return 'done';
  if (state.status === 'failed' && state.failedStep === step) return 'failed';
  const current = guidedStepIndex(state.step);
  const index = guidedStepIndex(step);
  if (state.status === 'awaiting_auth') return index < current ? 'done' : index === current ? 'current' : 'done';
  if (index < current) return 'done';
  if (index === current) return state.status === 'idle' ? 'pending' : 'current';
  return 'pending';
}

/** One clear progress line in Spanish for the current guided step. */
export function guidedProgressLine(state: GuidedState): string {
  if (state.status === 'idle') return `Pulsa «${GUIDED_ACTION_LABEL}» para cancelar la operación desfasada, recrear el contenedor y abrir el inicio de sesión.`;
  if (state.status === 'failed') {
    const def = GUIDED_STEPS.find((entry) => entry.id === state.failedStep) ?? GUIDED_STEPS[0];
    return `Se detuvo en: ${def.label.charAt(0).toLowerCase()}${def.label.slice(1)}.`;
  }
  if (state.status === 'awaiting_auth') return 'El contenedor ya está recreado. Se abrió el inicio de sesión: complétalo para que la operación siga.';
  if (state.status === 'done') return 'El contenedor ya está recreado y la operación terminó.';
  const def = GUIDED_STEPS.find((entry) => entry.id === state.step) ?? GUIDED_STEPS[0];
  return def.activeLabel;
}

/** A drifted operation that the guided flow can still cancel and recreate. */
export function isGuidedDrift(operation: FleetOperation | undefined): operation is FleetOperation {
  return !!operation && operation.error?.code === 'RUNTIME_DRIFT'
    && operation.status !== 'cancelled' && operation.status !== 'succeeded';
}

export function isRuntimeDrift(operation: FleetOperation | undefined): boolean {
  return operation?.error?.code === 'RUNTIME_DRIFT';
}

/** Human failure text for an operation that failed while being followed. */
export function guidedOperationFailure(operation: FleetOperation): string {
  if (!operation.error) return 'La operación de recreación falló. Reintenta desde este paso o cancela la operación.';
  const human = operationErrorHuman(operation.error);
  return human.next ? `${human.message} ${human.next}` : human.message;
}
