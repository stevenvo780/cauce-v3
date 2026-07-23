import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(key: string, loader: () => Promise<T>): Resource<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [state, setState] = useState<Omit<Resource<T>, 'reload'>>({ loading: true });
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
    };
  }, []);

  runRef.current = () => {
    if (!mountedRef.current || inFlightRef.current) {
      if (mountedRef.current) pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const generation = generationRef.current;
    setState((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.resolve().then(() => loaderRef.current()).then(
      (data) => {
        if (mountedRef.current && generation === generationRef.current) setState({ data, loading: false });
      },
      (cause: unknown) => {
        if (mountedRef.current && generation === generationRef.current) setState((current) => ({
          ...current,
          error: cause instanceof Error ? cause : new Error('Error desconocido'),
          loading: false,
        }));
      },
    ).finally(() => {
      inFlightRef.current = false;
      if (!mountedRef.current || !pendingRef.current) return;
      pendingRef.current = false;
      runRef.current();
    });
  };

  const queueReload = useCallback(() => {
    if (inFlightRef.current) pendingRef.current = true;
    else runRef.current();
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    queueReload();
  }, [key, queueReload]);

  return { ...state, reload: queueReload };
}
