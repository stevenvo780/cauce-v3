import type { DeliveryState } from '../../api/types';

export type DeliveryTone = 'done' | 'danger' | 'warning' | 'running';
export type DeliveryGroup = 'pending' | 'retry' | 'review' | 'complete';
export type DeliveryErrorExpectation = 'absent' | 'required';

export interface DeliveryPolicy {
  readonly label: string;
  readonly tone: DeliveryTone;
  readonly group: DeliveryGroup;
  readonly replayable: boolean;
  readonly cancellable: boolean;
  readonly errorExpectation: DeliveryErrorExpectation;
}

/** The single lifecycle policy consumed by every delivery surface in the console. */
export const DELIVERY_POLICY = {
  pending: {
    label: 'PENDIENTE', tone: 'running', group: 'pending', replayable: false, cancellable: true,
    errorExpectation: 'absent',
  },
  leased: {
    label: 'TOMADA', tone: 'running', group: 'pending', replayable: false, cancellable: true,
    errorExpectation: 'absent',
  },
  accepted: {
    label: 'ACEPTADA', tone: 'running', group: 'pending', replayable: false, cancellable: true,
    errorExpectation: 'absent',
  },
  started: {
    label: 'EN CURSO', tone: 'running', group: 'pending', replayable: false, cancellable: true,
    errorExpectation: 'absent',
  },
  done: {
    label: 'HECHA', tone: 'done', group: 'complete', replayable: false, cancellable: false,
    errorExpectation: 'absent',
  },
  failed: {
    label: 'FALLÓ', tone: 'danger', group: 'review', replayable: true, cancellable: false,
    errorExpectation: 'required',
  },
  retry: {
    label: 'EN REINTENTO', tone: 'warning', group: 'retry', replayable: false, cancellable: true,
    errorExpectation: 'required',
  },
  dead: {
    label: 'MUERTA', tone: 'danger', group: 'review', replayable: true, cancellable: false,
    errorExpectation: 'required',
  },
} as const satisfies Readonly<Record<DeliveryState, DeliveryPolicy>>;

export const DELIVERY_STATES = Object.freeze(Object.keys(DELIVERY_POLICY) as DeliveryState[]);

export interface KnownDeliveryPolicy extends DeliveryPolicy {
  readonly known: true;
  readonly state: DeliveryState;
}

export interface UnknownDeliveryPolicy {
  readonly known: false;
  readonly state: undefined;
  readonly label: 'UNKNOWN';
  readonly tone: 'unknown';
  readonly group: 'unknown';
  readonly replayable: false;
  readonly cancellable: false;
  readonly errorExpectation: 'unknown';
}

const UNKNOWN_DELIVERY_POLICY: UnknownDeliveryPolicy = Object.freeze({
  known: false,
  state: undefined,
  label: 'UNKNOWN',
  tone: 'unknown',
  group: 'unknown',
  replayable: false,
  cancellable: false,
  errorExpectation: 'unknown',
});

/** Unknown server values remain visible but can never inherit a group or a mutation. */
export function deliveryPolicy(value: unknown): KnownDeliveryPolicy | UnknownDeliveryPolicy {
  if (typeof value !== 'string' || !Object.hasOwn(DELIVERY_POLICY, value)) {
    return UNKNOWN_DELIVERY_POLICY;
  }
  const state = value as DeliveryState;
  return { known: true, state, ...DELIVERY_POLICY[state] };
}
