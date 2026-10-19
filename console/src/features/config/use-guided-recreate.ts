import { useEffect, useRef, useState } from 'react';
import type { FleetOperation, FleetOperationPreview, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import type { FleetOperationsClient } from '../../api/client/fleet-operations-client';
import { cancellable, resumable } from './fleet-operation-text';
import {
  guidedOperationFailure, guidedReduce, initialGuidedState, isGuidedDrift,
  type GuidedState, type GuidedStepId,
} from './guided-recreate';

export type GuidedRecreateClient = Pick<FleetOperationsClient,
  'cancelFleetOperation' | 'previewFleetOperation' | 'enqueueFleetOperation' | 'getFleetOperation' | 'resumeFleetOperation'>;

export interface GuidedBuildResult { request?: FleetOperationRequest; error?: string }

export interface UseGuidedRecreateOptions {
  client: GuidedRecreateClient;
  /** The operation currently shown; the hook captures the drifted one when the flow starts. */
  operation: FleetOperation | undefined;
  buildRequest: () => GuidedBuildResult;
  accept: (operation: FleetOperation) => void;
  translateError?: (message: string) => string;
  pollMs?: number;
}

export interface GuidedRecreateFlow {
  state: GuidedState;
  busy: boolean;
  start: () => void;
  retry: () => void;
  reset: () => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function errorMessage(cause: unknown, translate: ((message: string) => string) | undefined, fallback: string): string {
  if (cause instanceof Error) return translate ? translate(cause.message) : cause.message;
  return fallback;
}

export function useGuidedRecreate(options: UseGuidedRecreateOptions): GuidedRecreateFlow {
  const [state, setState] = useState<GuidedState>(initialGuidedState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const generation = useRef(0);
  const running = useRef(false);
  const driftRef = useRef<FleetOperation | undefined>(undefined);
  const requestRef = useRef<FleetOperationRequest | undefined>(undefined);
  const previewRef = useRef<FleetOperationPreview | undefined>(undefined);
  const createdRef = useRef<FleetOperation | undefined>(undefined);

  useEffect(() => {
    if (isGuidedDrift(options.operation)) driftRef.current = options.operation;
  }, [options.operation]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.status !== 'awaiting_auth' || !options.operation) return;
    if (options.operation.id !== current.operation?.id || options.operation.status !== 'succeeded') return;
    const operation = options.operation;
    setState((previous) => guidedReduce(previous, { type: 'done', operation }));
  }, [options.operation]);

  useEffect(() => () => { generation.current += 1; running.current = false; }, []);

  function dispatch(event: Parameters<typeof guidedReduce>[1], gen: number): boolean {
    if (gen !== generation.current) return false;
    setState((previous) => {
      const next = guidedReduce(previous, event);
      stateRef.current = next;
      return next;
    });
    // Keep the ref in sync for the synchronous reads below.
    stateRef.current = guidedReduce(stateRef.current, event);
    return true;
  }

  function fail(step: GuidedStepId, message: string, gen: number) {
    running.current = false;
    dispatch({ type: 'failed', step, message }, gen);
  }

  async function waitCancelled(first: FleetOperation, gen: number): Promise<FleetOperation | undefined> {
    const { client, accept } = optionsRef.current;
    let current = first;
    while (current.status === 'cancelling' && gen === generation.current) {
      await delay(optionsRef.current.pollMs ?? 1200);
      if (gen !== generation.current) return undefined;
      current = await client.getFleetOperation(current.id);
      accept(current);
    }
    return current;
  }

  async function follow(first: FleetOperation, gen: number): Promise<void> {
    const { client, accept } = optionsRef.current;
    if (!dispatch({ type: 'step', step: 'follow' }, gen)) return;
    let current = first;
    createdRef.current = current;
    while (gen === generation.current && ['queued', 'running', 'cancelling'].includes(current.status)) {
      await delay(optionsRef.current.pollMs ?? 1200);
      if (gen !== generation.current) return;
      try {
        current = await client.getFleetOperation(current.id);
      } catch (cause) {
        fail('follow', errorMessage(cause, optionsRef.current.translateError, 'No se pudo seguir la recreación. Reintenta desde este paso.'), gen);
        return;
      }
      createdRef.current = current;
      accept(current);
    }
    if (gen !== generation.current) return;
    if (current.status === 'awaiting_auth') {
      dispatch({ type: 'awaiting_auth', operation: current }, gen);
      running.current = false;
      return;
    }
    if (current.status === 'succeeded') {
      dispatch({ type: 'done', operation: current }, gen);
      running.current = false;
      return;
    }
    if (current.status === 'cancelled') {
      fail('follow', 'La recreación se canceló. Vuelve a pulsar «Recrear contenedor e iniciar sesión» si todavía la necesitas.', gen);
      return;
    }
    fail('follow', guidedOperationFailure(current), gen);
  }

  async function runFrom(from: GuidedStepId, gen: number): Promise<void> {
    const opts = optionsRef.current;
    const { client, accept } = opts;
    let step = from;
    try {
      if (step === 'cancel') {
        if (!dispatch({ type: 'step', step: 'cancel' }, gen)) return;
        const drift = driftRef.current ?? (isGuidedDrift(opts.operation) ? opts.operation : undefined);
        if (!drift) { fail('cancel', 'Ya no hay una operación desfasada para cancelar. Relee la operación y vuelve a intentarlo.', gen); return; }
        let current: FleetOperation;
        if (drift.status === 'cancelled') {
          current = drift;
        } else if (!cancellable(drift)) {
          fail('cancel', 'Esta operación ya no se puede cancelar. Relee la operación y vuelve a intentarlo.', gen);
          return;
        } else {
          // Refresh the version first so a retry after a conflict cancels the current receipt.
          let fresh = drift;
          try { fresh = await client.getFleetOperation(drift.id); accept(fresh); } catch { /* use the last known version */ }
          if (gen !== generation.current) return;
          if (fresh.status === 'cancelled') {
            current = fresh;
          } else {
            const cancelled = await client.cancelFleetOperation(fresh.id, fresh.version);
            accept(cancelled);
            const settled = await waitCancelled(cancelled, gen);
            if (!settled || gen !== generation.current) return;
            current = settled;
          }
        }
        if (current.status !== 'cancelled') {
          fail('cancel', 'La cancelación todavía no se confirmó. Reintenta desde este paso.', gen);
          return;
        }
        driftRef.current = current;
        step = 'preview';
      }
      if (step === 'preview') {
        if (!dispatch({ type: 'step', step: 'preview' }, gen)) return;
        const built = optionsRef.current.buildRequest();
        if (!built.request) {
          fail('preview', built.error ?? 'La intención actual no se puede preparar. Revisa la configuración del agente y reintenta.', gen);
          return;
        }
        const preview = await client.previewFleetOperation(built.request);
        if (gen !== generation.current) return;
        if (!preview.can_apply) {
          fail('preview', 'La preparación todavía no se puede encolar: revisa lo que bloquea la previsualización y reintenta desde este paso.', gen);
          return;
        }
        requestRef.current = built.request;
        previewRef.current = preview;
        step = 'enqueue';
      }
      if (step === 'enqueue') {
        if (!dispatch({ type: 'step', step: 'enqueue' }, gen)) return;
        if (!requestRef.current) { await runFrom('preview', gen); return; }
        // Retrying an enqueue that may have reached the server reuses the same idempotency key in the request.
        const created = await client.enqueueFleetOperation(requestRef.current);
        if (gen !== generation.current) return;
        createdRef.current = created;
        accept(created);
        step = 'follow';
      }
      if (step === 'follow') {
        const created = createdRef.current;
        if (!created) { fail('follow', 'No hay una recreación encolada para seguir. Reintenta desde este paso.', gen); return; }
        // A failed operation is resumed from its failed step before following it again.
        if (created.status === 'failed' && resumable(created)) {
          const resumed = await client.resumeFleetOperation(created.id, created.version);
          if (gen !== generation.current) return;
          createdRef.current = resumed;
          accept(resumed);
          await follow(resumed, gen);
          return;
        }
        if (created.status === 'failed') {
          fail('follow', guidedOperationFailure(created), gen);
          return;
        }
        await follow(created, gen);
        return;
      }
    } catch (cause) {
      if (gen !== generation.current) return;
      const fallback = step === 'cancel' ? 'No se pudo cancelar la operación desfasada. Reintenta desde este paso.'
        : step === 'preview' ? 'No se pudo comprobar la preparación. Reintenta desde este paso.'
          : step === 'enqueue' ? 'No se pudo encolar la recreación. Reintenta desde este paso con la misma solicitud.'
            : 'No se pudo seguir la recreación. Reintenta desde este paso.';
      fail(step, errorMessage(cause, optionsRef.current.translateError, fallback), gen);
    }
  }

  function start() {
    if (running.current) return;
    const drift = driftRef.current ?? (isGuidedDrift(optionsRef.current.operation) ? optionsRef.current.operation : undefined);
    if (!drift) return;
    driftRef.current = drift;
    requestRef.current = undefined;
    previewRef.current = undefined;
    createdRef.current = undefined;
    const gen = ++generation.current;
    running.current = true;
    dispatch({ type: 'start' }, gen);
    void runFrom('cancel', gen);
  }

  function retry() {
    if (running.current) return;
    const failedStep = stateRef.current.failedStep ?? stateRef.current.step;
    const gen = ++generation.current;
    running.current = true;
    dispatch({ type: 'retry' }, gen);
    void runFrom(failedStep, gen);
  }

  function reset() {
    generation.current += 1;
    running.current = false;
    requestRef.current = undefined;
    previewRef.current = undefined;
    createdRef.current = undefined;
    setState(initialGuidedState);
    stateRef.current = initialGuidedState;
  }

  return { state, busy: state.status === 'running', start, retry, reset };
}
