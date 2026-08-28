import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The outcome of ONE concrete reload: it either fetched data, or it fetched an error. Never both.
 *
 * Exists because `reload()` returned `void` and the caller had no way to know whether the read
 * had arrived: the declared-role editor announced "the snapshot reloaded" without having waited
 * for anything, and on top of that kept sending the stale revision. A screen cannot claim what it
 * did not check, so the reload returns its result to the one who asked for it.
 */
export type RecargaResultado<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: Error };

export interface Resource<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  /**
   * Reload. The promise resolves with the result of the fetch that STARTS from this call —never
   * with one that was already in flight—, which is the only way for the waiter to know it is
   * looking at data that came after its own request.
   */
  reload: () => Promise<RecargaResultado<T>>;
}

interface ResourceState<T> extends Omit<Resource<T>, 'reload'> {
  /** Exact key under which `data` and `error` belong. They are never shown under another key. */
  key: string;
}

export function useResource<T>(key: string, loader: () => Promise<T>): Resource<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [state, setState] = useState<ResourceState<T>>({ key, loading: true });
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const runRef = useRef<() => void>(() => undefined);
  // Whoever asked for a reload and still has no fetch answering for them.
  const esperandoRef = useRef<((resultado: RecargaResultado<T>) => void)[]>([]);
  // Whoever was already adopted by the in-flight fetch: they get answered when that fetch ends.
  const adoptadosRef = useRef<((resultado: RecargaResultado<T>) => void)[]>([]);
  const claveRef = useRef(key);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      // Unmounted is not "reloaded": whoever was waiting is told their read will not arrive,
      // instead of leaving them with an `await` hanging forever.
      const huerfanos = [...esperandoRef.current, ...adoptadosRef.current];
      esperandoRef.current = [];
      adoptadosRef.current = [];
      for (const resolver of huerfanos) {
        resolver({ error: new Error('la vista se cerró antes de terminar de releer') });
      }
    };
  }, []);

  runRef.current = () => {
    if (!mountedRef.current || inFlightRef.current) {
      if (mountedRef.current) pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    adoptadosRef.current = esperandoRef.current;
    esperandoRef.current = [];
    const generation = generationRef.current;
    const runKey = claveRef.current;
    let resultado: RecargaResultado<T> | undefined;
    // If there is no prior data, the error is kept during the reload to avoid flicker.
    setState((current) => current.key === runKey
      ? {
          ...current,
          loading: true,
          error: current.data === undefined ? current.error : undefined,
        }
      : { key: runKey, loading: true });
    void Promise.resolve().then(() => loaderRef.current()).then(
      (data) => {
        resultado = { data };
        if (mountedRef.current && generation === generationRef.current) {
          setState({ key: runKey, data, loading: false });
        }
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error('Error desconocido');
        resultado = { error };
        if (mountedRef.current && generation === generationRef.current) setState((current) => (
          current.key === runKey
            ? { ...current, error, loading: false }
            : { key: runKey, error, loading: false }
        ));
      },
    ).finally(() => {
      inFlightRef.current = false;
      const avisar = adoptadosRef.current;
      adoptadosRef.current = [];
      for (const resolver of avisar) {
        resolver(resultado ?? { error: new Error('la relectura terminó sin dato ni error') });
      }
      if (!mountedRef.current || !pendingRef.current) return;
      pendingRef.current = false;
      runRef.current();
    });
  };

  const queueReload = useCallback(() => {
    // The resolver is registered BEFORE anything starts: that way the fetch fired below already
    // finds and adopts it, and there is no window in which the response arrives with no recipient.
    const promesa = new Promise<RecargaResultado<T>>((resolve) => {
      esperandoRef.current.push(resolve);
    });
    if (inFlightRef.current) pendingRef.current = true;
    else runRef.current();
    return promesa;
  }, []);

  // The generation only increments when the resource key changes, to discard stale responses.
  useEffect(() => {
    if (claveRef.current !== key) {
      claveRef.current = key;
      generationRef.current += 1;
      // The previous snapshot belongs to another identity. It is invalidated even if the prior
      // read is still in flight: keeping it would let data from A be labelled with B's header.
      setState({ key, loading: true });
    }
    void queueReload();
  }, [key, queueReload]);

  // Effects run after the render. This guard avoids even that first frame where React already
  // delivered the new `key` but has not yet run the invalidation above.
  if (state.key !== key) return { loading: true, reload: queueReload };
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: queueReload,
  };
}
