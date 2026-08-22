import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * El desenlace de UNA recarga concreta: o trajo dato, o trajo error. Nunca las dos cosas.
 *
 * Existe porque `reload()` devolvía `void` y quien la llamaba no tenía forma de saber si la
 * lectura llegó: el editor del rol declarado anunciaba «se recargó el snapshot» sin haber
 * esperado nada, y encima seguía mandando la revisión vencida. Una pantalla no puede afirmar lo
 * que no comprobó, así que la recarga devuelve su resultado a quien la pidió.
 */
export type RecargaResultado<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: Error };

export interface Resource<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  /**
   * Vuelve a leer. La promesa se resuelve con el resultado del fetch que ARRANCA a partir de esta
   * llamada —nunca con el de uno que ya venía en vuelo—, que es la única forma de que quien
   * espera sepa que está mirando datos posteriores a su pedido.
   */
  reload: () => Promise<RecargaResultado<T>>;
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
  // Quien pidió recarga y todavía no tiene un fetch que responda por él.
  const esperandoRef = useRef<Array<(resultado: RecargaResultado<T>) => void>>([]);
  // Quien ya fue adoptado por el fetch en curso: se le contesta cuando ese fetch termine.
  const adoptadosRef = useRef<Array<(resultado: RecargaResultado<T>) => void>>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      // Desmontado no es «recargado»: a quien esperaba se le dice que su lectura no va a llegar,
      // en vez de dejarle un `await` colgado para siempre.
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
    let resultado: RecargaResultado<T> | undefined;
    setState((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.resolve().then(() => loaderRef.current()).then(
      (data) => {
        resultado = { data };
        if (mountedRef.current && generation === generationRef.current) setState({ data, loading: false });
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error('Error desconocido');
        resultado = { error };
        if (mountedRef.current && generation === generationRef.current) setState((current) => ({
          ...current,
          error,
          loading: false,
        }));
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
    // El resolver se anota ANTES de arrancar nada: así el fetch que se dispara acá abajo ya lo
    // encuentra y lo adopta, y no hay ventana en la que la respuesta llegue sin destinatario.
    const promesa = new Promise<RecargaResultado<T>>((resolve) => {
      esperandoRef.current.push(resolve);
    });
    if (inFlightRef.current) pendingRef.current = true;
    else runRef.current();
    return promesa;
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    void queueReload();
  }, [key, queueReload]);

  return { ...state, reload: queueReload };
}
