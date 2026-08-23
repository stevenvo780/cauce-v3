import { CauceApi, ApiError, TIEMPO_MAXIMO_MS } from './client';

/**
 * **UNA PETICIÓN QUE NUNCA CIERRA ES UNA PANTALLA QUE NUNCA SALE DE LA CARGA.**
 *
 * 🔴 Medido el 2026-08-23 contra `https://consola.humanizar.tech/live`, con la máquina del
 * gateway al 89,9% de steal time: la vista se quedó **180 segundos** en «Leyendo la actividad de
 * la flota…», con el cuerpo de la página en 329 caracteres —sólo el rótulo— y sin error, sin
 * botón de reintentar y sin límite de espera. `client.ts` tenía 355 líneas y CERO apariciones de
 * `timeout`, `AbortController`, `AbortSignal` o `setTimeout`.
 *
 * La lentitud es de la máquina; que no hubiera salida era del diseño. Estas pruebas fijan la
 * salida, y la fijan donde estaba el agujero: en el cliente, no en cada vista.
 *
 * El `fetcher` de estas pruebas **no respeta la señal a propósito**: devuelve una promesa que no
 * se resuelve nunca, que es exactamente lo que hace un socket contra un gateway estrangulado.
 * Si el corte dependiera de que `fetch` haga caso al `AbortSignal`, este fichero no probaría
 * nada — y el defecto medido volvería sin que ninguna prueba se enterase.
 */

/** Un fetch que se queda esperando para siempre, como el gateway del día de la medición. */
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
    /*
     * CONTROL NEGATIVO del arreglo entero. Se reproduce el defecto medido —el mismo `fetcher` que
     * no contesta, con el tope en 0— y se exige que la promesa siga colgada. Si esta prueba
     * pasara a resolverse, sería que algo distinto del vencimiento está cerrando la lectura, y
     * las tres de arriba estarían acreditando un mecanismo que no es el que funciona.
     */
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
