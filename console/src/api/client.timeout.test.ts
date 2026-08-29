import { CauceApi, ApiError, TIEMPO_MAXIMO_MS } from './client';

/**
 * Verification of timeout and request cancellation in the HTTP client (`CauceApi`):
 * ensures that unanswered requests are aborted and converted into an `ApiError` of type `timeout`.
 */

function fetchQueNuncaContesta(): { fetcher: typeof fetch; llamadas: () => number; senales: AbortSignal[] } {
  let llamadas = 0;
  const senales: AbortSignal[] = [];
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    llamadas += 1;
    if (init?.signal) senales.push(init.signal);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  return { fetcher, llamadas: () => llamadas, senales };
}

describe('el tope de espera del cliente HTTP', () => {
  it('corta una lectura que no vuelve y la convierte en un error que las vistas YA saben pintar', async () => {
    const { fetcher } = fetchQueNuncaContesta();
    const api = new CauceApi('http://localhost', fetcher, undefined, 40);

    const error = await api.getFleetActivity().then(() => undefined, (causa: unknown) => causa);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('timeout');
    // The message is PAINTED (`ErrorState` renders `error.message`): it has to be in Spanish and
    // must not claim there is no data, only that it could not be read.
    expect((error as ApiError).message).toContain('/v3/console/activity');
    expect((error as ApiError).message).toMatch(/no contestó en \d+ s/);
    expect((error as ApiError).message).toContain('no se pudieron leer');
    expect((error as ApiError).message).not.toMatch(/abort/i);
  });

  it('ABORTA de verdad la petición, además de contestarle a quien esperaba', async () => {
    // Rejecting the promise and leaving the socket open against a gateway already at 10% CPU
    // adds work to a machine that is already dying. The signal travels to `fetch`.
    const { fetcher, senales } = fetchQueNuncaContesta();
    const api = new CauceApi('http://localhost', fetcher, undefined, 40);

    await api.getFleetActivity().catch(() => undefined);

    expect(senales).toHaveLength(1);
    expect(senales[0].aborted).toBe(true);
  });

  it('mantiene el mismo tope después de los headers si el cuerpo JSON nunca termina', async () => {
    let senal: AbortSignal | undefined;
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
      senal = init?.signal ?? undefined;
      return Promise.resolve(new Response(
        new ReadableStream({ start() { /* headers llegan; el body nunca cierra */ } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;
    const api = new CauceApi('http://localhost', fetcher, undefined, 40);

    const error = await api.getFleetActivity().then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 504, code: 'timeout' });
    expect(senal?.aborted).toBe(true);
  });

  it('no toca las lecturas que sí llegan: ni las corta, ni les deja el reloj corriendo', async () => {
    // NEGATIVE CONTROL of the ceiling itself: a guard that cuts everything is no guard at all.
    let senal: AbortSignal | undefined;
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
      senal = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ agents: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }) as typeof fetch;
    const api = new CauceApi('http://localhost', fetcher, undefined, 40);

    await expect(api.getFleetActivity()).resolves.toEqual({ agents: [] });

    // The clock is cleared as soon as the response arrives: otherwise every healthy reading would
    // leave a 30s timer alive and the `AbortController` would abort an already-finished request.
    await new Promise((listo) => setTimeout(listo, 80));
    expect(senal?.aborted).toBe(false);
  });

  it('con el tope apagado vuelve a colgarse: la salida es el tope, no otra cosa que lo tape', async () => {
    // With timeout disabled (0), the promise stays pending without aborting.
    const { fetcher, senales } = fetchQueNuncaContesta();
    const api = new CauceApi('http://localhost', fetcher, undefined, 0);

    let desenlace: 'colgada' | 'cerrada' = 'colgada';
    void api.getFleetActivity().then(() => { desenlace = 'cerrada'; }, () => { desenlace = 'cerrada'; });

    await new Promise((listo) => setTimeout(listo, 120));
    expect(desenlace).toBe('colgada');
    // And without a ceiling the controller is not even created: there is no signal to abort.
    expect(senales).toHaveLength(0);
  });

  it('el tope por defecto es un número declarado, no un valor escondido en una llamada', () => {
    // The loading banner promises the operator that the wait "cuts itself off at N s" by reading
    // this very constant. If it lived loose inside `request`, the promise and the cut could
    // diverge without anything failing.
    expect(TIEMPO_MAXIMO_MS).toBe(30_000);
  });
});
