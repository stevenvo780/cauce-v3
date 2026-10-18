import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { haceCuanto } from '../lib';

const MOMENTO_MS = 60_000;

function failureOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('error' in result)) return undefined;
  const error = result.error;
  if (!(error instanceof Error)) return undefined;
  return error.message.length > 0 ? error.message : 'No se pudo completar la acción.';
}

function freshReadPhrase(at: number, now = Date.now()): string {
  if (now - at < MOMENTO_MS) return 'Actualizado · hace un momento';
  const relative = haceCuanto(new Date(at).toISOString(), now);
  return `Actualizado · ${relative ?? 'hace un momento'}`;
}

type Phase = 'idle' | 'pending' | 'done' | 'error';

export interface ActionRunOptions {
  /** `false` keeps the result on the caller's own notice. A string replaces the fresh-read phrase. */
  done?: string | false;
  /** When false, a failure stays on the caller's notice and this control does not claim success. */
  announceError?: boolean;
}

export function useActionRun(action: (event: MouseEvent<HTMLButtonElement>) => unknown, options?: ActionRunOptions) {
  const actionRef = useRef(action);
  const optionsRef = useRef(options);
  actionRef.current = action;
  optionsRef.current = options;
  const phaseRef = useRef<Phase>('idle');
  const [phase, setPhase] = useState<Phase>('idle');
  const [doneAt, setDoneAt] = useState<number>();
  const [errorText, setErrorText] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase !== 'done') return undefined;
    const timer = setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { clearInterval(timer); };
  }, [phase]);

  const customDone = options?.done;
  const doneText = phase === 'done' && doneAt !== undefined && customDone !== false
    ? (typeof customDone === 'string' ? customDone : freshReadPhrase(doneAt, now))
    : undefined;

  async function run(event: MouseEvent<HTMLButtonElement>) {
    if (phaseRef.current === 'pending') return;
    phaseRef.current = 'pending';
    setPhase('pending');
    setErrorText(undefined);
    try {
      const failure = failureOf(await actionRef.current(event));
      const announce = optionsRef.current?.announceError !== false;
      if (failure) {
        if (announce) {
          setErrorText(failure);
          phaseRef.current = 'error';
          setPhase('error');
        } else {
          phaseRef.current = 'idle';
          setPhase('idle');
        }
        return;
      }
      if (optionsRef.current?.done === false) {
        phaseRef.current = 'idle';
        setPhase('idle');
        return;
      }
      const at = Date.now();
      setDoneAt(at);
      setNow(at);
      phaseRef.current = 'done';
      setPhase('done');
    } catch (cause: unknown) {
      const announce = optionsRef.current?.announceError !== false;
      const message = cause instanceof Error && cause.message.length > 0
        ? cause.message
        : 'No se pudo completar la acción.';
      if (announce) {
        setErrorText(message);
        phaseRef.current = 'error';
        setPhase('error');
      } else {
        phaseRef.current = 'idle';
        setPhase('idle');
      }
    }
  }

  return { phase, doneText, errorText, run };
}
