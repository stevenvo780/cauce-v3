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

interface ResourceState<T> extends Omit<Resource<T>, 'reload'> {
  /** Clave exacta a la que pertenecen `data` y `error`. Nunca se muestran bajo otra clave. */
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
  // Quien pidió recarga y todavía no tiene un fetch que responda por él.
  const esperandoRef = useRef<((resultado: RecargaResultado<T>) => void)[]>([]);
  // Quien ya fue adoptado por el fetch en curso: se le contesta cuando ese fetch termine.
  const adoptadosRef = useRef<((resultado: RecargaResultado<T>) => void)[]>([]);
  const claveRef = useRef(key);

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
    const runKey = claveRef.current;
    let resultado: RecargaResultado<T> | undefined;
    // Si no hay datos previos, se preserva el error durante la recarga para evitar parpadeos.
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
    // El resolver se anota ANTES de arrancar nada: así el fetch que se dispara acá abajo ya lo
    // encuentra y lo adopta, y no hay ventana en la que la respuesta llegue sin destinatario.
    const promesa = new Promise<RecargaResultado<T>>((resolve) => {
      esperandoRef.current.push(resolve);
    });
    if (inFlightRef.current) pendingRef.current = true;
    else runRef.current();
    return promesa;
  }, []);

  // La generación solo incrementa cuando cambia la clave del recurso para descartar respuestas obsoletas.
  useEffect(() => {
    if (claveRef.current !== key) {
      claveRef.current = key;
      generationRef.current += 1;
      // El snapshot anterior pertenece a otra identidad. Se invalida aunque la lectura previa
      // siga en vuelo: conservarlo permitiría rotular datos de A con la cabecera de B.
      setState({ key, loading: true });
    }
    void queueReload();
  }, [key, queueReload]);

  // Los efectos corren después del render. Este guard evita incluso ese primer frame en el que
  // React ya entregó la nueva `key` pero todavía no ejecutó la invalidación de arriba.
  if (state.key !== key) return { loading: true, reload: queueReload };
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: queueReload,
  };
}
