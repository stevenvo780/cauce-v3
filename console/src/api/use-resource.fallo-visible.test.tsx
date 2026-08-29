import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useResource } from './use-resource';

/**
 * Visibility and persistence check of errors in `useResource`: verifies that fetch rejections are
 * not discarded by generation desynchronization, nor silenced under automatic reloads or StrictMode.
 */

function cargadorGobernado() {
  const pendientes: { resolver: (v: string) => void; rechazar: (e: Error) => void }[] = [];
  const cargador = () => new Promise<string>((resolver, rechazar) => {
    pendientes.push({ resolver, rechazar });
  });
  return { cargador, pendientes };
}

/**
 * Resolves everything in flight — including the reload `StrictMode` leaves queued — until the
 * hook is idle. Without this, a subsequent `reload()` queues instead of starting and the test
 * measures something different from what it thinks it measures.
 */
async function enReposo(
  pendientes: { resolver: (v: string) => void; rechazar: (e: Error) => void }[],
  cargando: () => boolean,
  valor: string,
): Promise<void> {
  for (let vuelta = 0; vuelta < 10; vuelta += 1) {
    const sinContestar = pendientes.length;
    await waitFor(() => { expect(pendientes.length).toBeGreaterThanOrEqual(sinContestar); });
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
    // StrictMode unmounts and remounts; the error must still be recorded, not discarded.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });

    await waitFor(() => { expect(pendientes).toHaveLength(1); });
    await act(async () => {
      pendientes[0].rechazar(new Error('el servidor no contestó en 30 s'));
      await Promise.resolve();
    });

    await waitFor(() => { expect(result.current.error?.message).toBe('el servidor no contestó en 30 s'); });
  });

  it('el fallo SOBREVIVE al reintento que el refresco automático dispara en el acto', async () => {
    // If the automatic retry starts immediately, the previous failure must not disappear until resolved.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });
    await waitFor(() => { expect(pendientes).toHaveLength(1); });

    // The refresh requests another read while the first is still in flight: it stays queued.
    act(() => { void result.current.reload(); });

    await act(async () => {
      pendientes[0].rechazar(new Error('el servidor no contestó en 30 s'));
      await Promise.resolve();
    });

    // The retry has already started...
    await waitFor(() => { expect(pendientes.length).toBeGreaterThan(1); });
    // ...and the failure is still standing, because there is no data to show in its place.
    expect(result.current.error?.message).toBe('el servidor no contestó en 30 s');
    expect(result.current.data).toBeUndefined();
  });

  it('en cuanto una lectura BUENA llega, el fallo se va: no se queda pegado', async () => {
    // POSITIVE CONTROL. An error that never clears would be worse than the bug: it would leave
    // the view red forever against an already recovered server.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });
    await waitFor(() => { expect(pendientes).toHaveLength(1); });

    await act(async () => { pendientes[0].rechazar(new Error('caído')); await Promise.resolve(); });
    await waitFor(() => { expect(result.current.error).toBeDefined(); });

    await waitFor(() => { expect(pendientes.length).toBeGreaterThan(1); });
    await act(async () => { pendientes[pendientes.length - 1].resolver('ya contesta'); await Promise.resolve(); });

    await waitFor(() => { expect(result.current.data).toBe('ya contesta'); });
    expect(result.current.error).toBeUndefined();
  });

  it('con dato en mano, un reintento SÍ limpia el error: ahí la pantalla tiene qué enseñar', async () => {
    // The other half of the rule. With a previous snapshot already on screen, the failure is
    // reported separately ("the last read failed, the previous one is shown") and must not block
    // the screen.
    const { cargador, pendientes } = cargadorGobernado();
    const { result } = renderHook(() => useResource('clave-fija', cargador), { wrapper: StrictMode });

    // Drive the hook to idle WITH data: `StrictMode` leaves a reload queued that also has to be
    // answered, otherwise the `reload()` below would queue instead of starting.
    await enReposo(pendientes, () => result.current.loading, 'primer dato');
    expect(result.current.data).toBe('primer dato');

    const conDato = pendientes.length;
    act(() => { void result.current.reload(); });
    await waitFor(() => { expect(pendientes.length).toBe(conDato + 1); });
    await act(async () => { pendientes[conDato].rechazar(new Error('se cayó')); await Promise.resolve(); });
    await waitFor(() => { expect(result.current.error?.message).toBe('se cayó'); });

    // The old data stays on screen: the failure does not erase it.
    expect(result.current.data).toBe('primer dato');

    // And the next attempt DOES clear the error, because there is something to show meanwhile.
    act(() => { void result.current.reload(); });
    await waitFor(() => { expect(result.current.error).toBeUndefined(); });
    expect(result.current.data).toBe('primer dato');
  });

  it('una lectura de OTRA clave sí se descarta: la generación sigue haciendo su trabajo', async () => {
    /*
     * NEGATIVE CONTROL of the generation fix. If "don't bump on every pass" had been implemented
     * as "never bump", the late result of the old key would clobber the new one's, and the view
     * would show data from another alias without saying so.
     */
    const { cargador, pendientes } = cargadorGobernado();
    const { result, rerender } = renderHook(
      ({ clave }: { clave: string }) => useResource(clave, cargador),
      { wrapper: StrictMode, initialProps: { clave: 'primera' } },
    );
    await waitFor(() => { expect(pendientes).toHaveLength(1); });

    rerender({ clave: 'segunda' });

    // Resolve the read of the OLD key, which became obsolete when the key changed.
    await act(async () => { pendientes[0].resolver('dato viejo'); await Promise.resolve(); });
    expect(result.current.data).not.toBe('dato viejo');

    // The new key's read does paint.
    await waitFor(() => { expect(pendientes.length).toBeGreaterThan(1); });
    await act(async () => { pendientes[pendientes.length - 1].resolver('dato nuevo'); await Promise.resolve(); });
    await waitFor(() => { expect(result.current.data).toBe('dato nuevo'); });
  });
});

/** Silences React's warning about acts outside `act` in the deliberate rejections. */
vi.spyOn(console, 'error').mockImplementation(() => undefined);
