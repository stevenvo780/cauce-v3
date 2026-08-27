import { CauceApi, ApiError, TIEMPO_MAXIMO_MS } from './client';

/**
 * Verificación de timeout y cancelación de peticiones en el cliente HTTP (`CauceApi`):
 * asegura que peticiones sin respuesta sean abortadas y convertidas en un `ApiError` de tipo `timeout`.
 */

/** Simula un fetch sin respuesta para probar el abort por timeout. */
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
    // El mensaje se PINTA (`ErrorState` renderiza `error.message`): tiene que estar en castellano
    // y no puede afirmar que no haya datos, sólo que no se pudieron leer.
    expect((error as ApiError).message).toContain('/v3/console/activity');
    expect((error as ApiError).message).toMatch(/no contestó en \d+ s/);
    expect((error as ApiError).message).toContain('no se pudieron leer');
    expect((error as ApiError).message).not.toMatch(/abort/i);
  });

  it('ABORTA de verdad la petición, además de contestarle a quien esperaba', async () => {
    // Rechazar la promesa y dejar el socket abierto contra un gateway que ya va al 10% de su CPU
    // es sumarle trabajo a la máquina que se está muriendo. La señal viaja al `fetch`.
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
    // CONTROL NEGATIVO del propio tope: un guardia que corta todo no sirve de guardia.
    let senal: AbortSignal | undefined;
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
      senal = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ agents: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }) as typeof fetch;
    const api = new CauceApi('http://localhost', fetcher, undefined, 40);

    await expect(api.getFleetActivity()).resolves.toEqual({ agents: [] });

    // El reloj se limpia en cuanto la respuesta llega: si no, cada lectura sana dejaría un
    // temporizador de 30 s vivo y el `AbortController` abortaría una petición ya terminada.
    await new Promise((listo) => setTimeout(listo, 80));
    expect(senal?.aborted).toBe(false);
  });

  it('con el tope apagado vuelve a colgarse: la salida es el tope, no otra cosa que lo tape', async () => {
    // Con timeout deshabilitado (0), la promesa permanece pendiente sin abortar.
    const { fetcher, senales } = fetchQueNuncaContesta();
    const api = new CauceApi('http://localhost', fetcher, undefined, 0);

    let desenlace: 'colgada' | 'cerrada' = 'colgada';
    void api.getFleetActivity().then(() => { desenlace = 'cerrada'; }, () => { desenlace = 'cerrada'; });

    await new Promise((listo) => setTimeout(listo, 120));
    expect(desenlace).toBe('colgada');
    // Y sin tope no se crea ni el controlador: no hay señal que abortar.
    expect(senales).toHaveLength(0);
  });

  it('el tope por defecto es un número declarado, no un valor escondido en una llamada', () => {
    // El cartel de carga promete al operador que la espera «se corta sola a los N s» leyendo esta
    // misma constante. Si viviera suelta dentro de `request`, la promesa y el corte podrían
    // divergir sin que nada fallara.
    expect(TIEMPO_MAXIMO_MS).toBe(30_000);
  });
});
