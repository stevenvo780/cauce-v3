/**
 * **El guardia del vocabulario. Una tabla, seis vistas, cuatro cosas que no pueden llegar a la
 * pantalla del operador.**
 *
 * Esta prueba existe por una razón concreta, y conviene dejarla escrita: **los 646 tests de esta
 * consola pasaban con todos estos defectos delante.** 
 *
 *  - `/terminal` imprimía, como TEXTO, `<UNKNOWN VALUE=AVAILABLE />` — un componente JSX escapado
 *    con entidades HTML— cuatro veces. Se comprobó quitando el arreglo y volviendo a correr los 155
 *    tests de `features/terminal`: **pasan los 155**. Nadie compara el texto de ese badge.
 *  - `/terminal` decía «UNKNOWN» 26 veces y `/observability` 8, en una interfaz en castellano.
 *  - `/queues` volcaba un `2026-08-23T02:02:29.830Z` crudo del servidor.
 *
 * Ninguna de esas tres cosas necesita LAYOUT para detectarse: son texto. jsdom no tiene layout —por
 * eso una cabecera que renderiza una letra por línea pasa igual, y eso hay que medirlo en un
 * navegador de verdad—, pero sí tiene `textContent`, y con eso alcanza para las cuatro invariantes
 * de abajo. Lo que no alcanza es esperar a que alguien lo note.
 *
 * Las cuatro, y por qué cada una:
 *  1. **Ningún marcador de JSX sin renderizar.** Si un componente se escapa, sale su nombre como
 *     texto y nadie se entera.
 *  2. **Ningún `UNKNOWN`.** La DOCTRINA no cambia —ausente sigue siendo desconocido y nunca
 *     permitido, eso se decide en la lógica— pero la PALABRA es «sin dato». Ver `lib.ts`.
 *  3. **Ninguna cabecera de tabla con el nombre de una columna de la base.** `snake_case` inglés en
 *     una interfaz en castellano es el esquema filtrándose a la pantalla.
 *  4. **Ninguna fecha ISO cruda.** Había tres formatos de fecha conviviendo; ahora hay uno, y el
 *     instante exacto vive en el `title=`.
 */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApi } from './test/render';
import { LandingPage } from './features/landing/LandingPage';
import { LiveFleetPage } from './features/live/LiveFleetPage';
import { AccountsPage } from './features/accounts/AccountsPage';
import { QueuesPage } from './features/queues/QueuesPage';
import { ObservabilityPage } from './features/observability/ObservabilityPage';
import { TerminalPage } from './features/terminal/TerminalPage';

/** Las seis vistas de este carril. Los mocks de `src/mocks` las alimentan con datos realistas. */
const VISTAS = [
  ['la portada', LandingPage, /cauce en una pantalla/i],
  ['/live', LiveFleetPage, /la flota ahora/i],
  ['/accounts', AccountsPage, /cuentas y cuotas/i],
  ['/queues', QueuesPage, /colas y dlq operativo/i],
  ['/observability', ObservabilityPage, /señales y auditoría/i],
  ['/terminal', TerminalPage, 'Terminal de agentes'],
] as const;

/**
 * Un componente JSX que se escapó y se está imprimiendo como texto.
 *
 * `<Unknown value={x} />` escapado sale como `<UNKNOWN VALUE=AVAILABLE />` (el CSS lo pone en
 * mayúsculas, pero en el DOM es `<Unknown value=…`). Se busca la FORMA —un signo de menor, un
 * identificador, y una barra de cierre— y no un texto concreto, para que cace también al próximo.
 */
const MARCADOR_DE_JSX = /<\s*[A-Za-z][A-Za-z0-9]*\s+[A-Za-z]+\s*=[^>]*\/>/;

/** Una fecha ISO-8601 volcada tal cual del servidor. */
const FECHA_ISO_CRUDA = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** `snake_case` inglés: la forma exacta de un nombre de columna de la base. */
const IDENTIFICADOR_CRUDO = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function textoVisible(): string {
  return document.body.textContent ?? '';
}

describe.each(VISTAS)('%s dice la verdad en castellano', (nombre, Vista, titulo) => {
  async function montar() {
    renderWithApi(<Vista />);
    await screen.findByRole('heading', { level: 1, name: titulo }, { timeout: 5000 });
    // Las vistas piden varias fuentes; se espera a que la primera tabla o métrica aterrice para
    // no medir una pantalla de carga y creer que está limpia.
    await waitFor(() => expect(textoVisible().length).toBeGreaterThan
      ? expect(textoVisible().length).toBeGreaterThan(200)
      : undefined, { timeout: 5000 });
  }

  it('no imprime ningún componente JSX como texto', async () => {
    await montar();
    const encontrado = MARCADOR_DE_JSX.exec(textoVisible());
    expect(encontrado?.[0], `${nombre} imprime un marcador de JSX sin renderizar`).toBeUndefined();
  });

  it('no le grita UNKNOWN al operador', async () => {
    await montar();
    // La doctrina se conserva en la LÓGICA; lo que cambia es la palabra. Ver `lib.ts`.
    expect(textoVisible(), `${nombre} muestra la palabra UNKNOWN`).not.toContain('UNKNOWN');
  });

  it('no titula ninguna columna con el nombre de una columna de la base', async () => {
    await montar();
    const crudas = Array.from(document.querySelectorAll('th'))
      .map((th) => (th.textContent ?? '').trim())
      .filter((texto) => IDENTIFICADOR_CRUDO.test(texto));
    expect(crudas, `${nombre} tiene cabeceras con el nombre de la columna de la base`).toEqual([]);
  });

  it('no vuelca ninguna fecha ISO cruda del servidor', async () => {
    await montar();
    const encontrada = FECHA_ISO_CRUDA.exec(textoVisible());
    expect(encontrada?.[0], `${nombre} muestra una fecha ISO sin formatear`).toBeUndefined();
  });
});
