import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useResource } from './use-resource';

/**
 * Verificación de visibilidad y persistencia de errores en `useResource`:
 * comprueba que los rechazos de fetch no se descarten por desincronización de generación
 * ni queden silenciados bajo recargas automáticas o StrictMode.
 */

/** Un cargador que se puede resolver o rechazar a mano, y que cuenta cuántas veces lo llamaron. */
function cargadorGobernado() {
  const pendientes: Array<{ resolver: (v: string) => void; rechazar: (e: Error) => void }> = [];
  const cargador = () => new Promise<string>((resolver, rechazar) => {
    pendientes.push({ resolver, rechazar });
  });
  return { cargador, pendientes };
}

/**
 * Contesta todo lo que haya en vuelo —incluida la recarga que `StrictMode` deja encolada— hasta
 * que el hook queda quieto. Sin esto, un `reload()` posterior se encola en vez de arrancar y la
 * prueba mide otra cosa que la que cree medir.
 */
async function enReposo(
  pendientes: Array<{ resolver: (v: string) => void; rechazar: (e: Error) => void }>,
  cargando: () => boolean,
  valor: string,
): Promise<void> {
  for (let vuelta = 0; vuelta < 10; vuelta += 1) {
    const sinContestar = pendientes.length;
    await waitFor(() => expect(pendientes.length).toBeGreaterThanOrEqual(sinContestar));
    await act(async () => {
      for (const pendiente of pendientes.slice(0, sinContestar)) pendiente.resolver(valor);
      await Promise.resolve();
    });
    await new Promise((listo) => setTimeout(listo, 5));
    if (!cargando() && pendientes.length === sinContestar) return;
  }
  throw new Error('el hook no llegó a quedarse quieto');
}

describe('useResource: el fallo tiene que llegar a la pantalla', () => {
  it('el rechazo de la PRIMERA lectura llega al estado, aunque el efecto haya corrido dos veces', async () => {
    /*
     * `StrictMode` monta, desmonta y vuelve a montar: exactamente lo que hacía subir la
     * generación y descartar el resultado. Sin el arreglo, `error` se queda en `undefined` y este
     * `waitFor` agota su tiempo — que es, punto por punto, lo que pasaba en pantalla.
     */
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });

    await waitFor(() => expect(pendientes).toHaveLength(1));
    await act(async () => {
      pendientes[0].rechazar(new Error('el servidor no contestó en 30 s'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error?.message).toBe('el servidor no contestó en 30 s'));
  });

  it('el fallo SOBREVIVE al reintento que el refresco automático dispara en el acto', async () => {
    /*
     * La secuencia medida en `/live`: la vista refresca cada 4 s, así que cuando la lectura de 30 s
     * vence hay recargas encoladas y una arranca inmediatamente. Si el arranque limpiara el error,
     * la pantalla volvería al cartel de carga sin haberlo enseñado nunca.
     */
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });
    await waitFor(() => expect(pendientes).toHaveLength(1));

    // El refresco pide otra lectura mientras la primera sigue en vuelo: queda encolada.
    act(() => { void result.current.reload(); });

    await act(async () => {
      pendientes[0].rechazar(new Error('el servidor no contestó en 30 s'));
      await Promise.resolve();
    });

    // El reintento ya arrancó...
    await waitFor(() => expect(pendientes.length).toBeGreaterThan(1));
    // ...y el fallo sigue en pie, porque no hay ni un dato que enseñar en su lugar.
    expect(result.current.error?.message).toBe('el servidor no contestó en 30 s');
    expect(result.current.data).toBeUndefined();
  });

  it('en cuanto una lectura BUENA llega, el fallo se va: no se queda pegado', async () => {
    // CONTROL POSITIVO. Un error que no se borra nunca sería peor que el defecto: dejaría la vista
    // en rojo permanente sobre un servidor ya recuperado.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });
    await waitFor(() => expect(pendientes).toHaveLength(1));

    await act(async () => { pendientes[0].rechazar(new Error('caído')); await Promise.resolve(); });
    await waitFor(() => expect(result.current.error).toBeDefined());

    await waitFor(() => expect(pendientes.length).toBeGreaterThan(1));
    await act(async () => { pendientes[pendientes.length - 1].resolver('ya contesta'); await Promise.resolve(); });

    await waitFor(() => expect(result.current.data).toBe('ya contesta'));
    expect(result.current.error).toBeUndefined();
  });

  it('con dato en mano, un reintento SÍ limpia el error: ahí la pantalla tiene qué enseñar', async () => {
    // La otra mitad de la regla. Con snapshot anterior a la vista, el fallo se cuenta aparte
    // («la última lectura falló, se muestra el anterior») y no tiene que bloquear la pantalla.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });

    // Se lleva el hook a reposo CON dato: `StrictMode` deja una recarga encolada que también hay
    // que contestar, o el `reload()` de más abajo se encolaría en vez de arrancar.
    await enReposo(pendientes, () => result.current.loading, 'primer dato');
    expect(result.current.data).toBe('primer dato');

    const conDato = pendientes.length;
    act(() => { void result.current.reload(); });
    await waitFor(() => expect(pendientes.length).toBe(conDato + 1));
    await act(async () => { pendientes[conDato].rechazar(new Error('se cayó')); await Promise.resolve(); });
    await waitFor(() => expect(result.current.error?.message).toBe('se cayó'));

    // El dato viejo sigue en pantalla: el fallo no lo borra.
    expect(result.current.data).toBe('primer dato');

    // Y el siguiente intento SÍ limpia el error, porque hay algo que enseñar mientras tanto.
    act(() => { void result.current.reload(); });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.data).toBe('primer dato');
  });

  it('una lectura de OTRA clave sí se descarta: la generación sigue haciendo su trabajo', async () => {
    /*
     * CONTROL NEGATIVO del arreglo de la generación. Si «no subirla en cada pasada» se hubiera
     * implementado como «no subirla nunca», el resultado tardío de la clave vieja pisaría al de la
     * nueva y la vista mostraría datos de otro alias sin decirlo.
     */
    const { cargador, pendientes } = cargadorGobernado();
    const { result, rerender } = renderHook(
      ({ clave }: { clave: string }) => useResource(clave, cargador),
      { wrapper: StrictMode, initialProps: { clave: 'primera' } },
    );
    await waitFor(() => expect(pendientes).toHaveLength(1));

    rerender({ clave: 'segunda' });

    // Contesta la lectura de la clave VIEJA, que quedó obsoleta al cambiar de clave.
    await act(async () => { pendientes[0].resolver('dato viejo'); await Promise.resolve(); });
    expect(result.current.data).not.toBe('dato viejo');

    // La de la clave nueva sí pinta.
    await waitFor(() => expect(pendientes.length).toBeGreaterThan(1));
    await act(async () => { pendientes[pendientes.length - 1].resolver('dato nuevo'); await Promise.resolve(); });
    await waitFor(() => expect(result.current.data).toBe('dato nuevo'));
  });
});

/** Silencia el aviso de React sobre actos fuera de `act` en los rechazos deliberados. */
vi.spyOn(console, 'error').mockImplementation(() => undefined);
