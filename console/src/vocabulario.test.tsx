/**
 * Verificación de formato y vocabulario en vistas montadas:
 * 1. Sin marcadores JSX sin renderizar.
 * 2. Sin literales UNKNOWN visibles.
 * 3. Sin identificadores snake_case crudos en cabeceras de tabla.
 * 4. Sin fechas ISO crudas sin formatear.
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

const FECHA_ISO_CRUDA = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** `snake_case` inglés: la forma exacta de un nombre de columna de la base. */
const IDENTIFICADOR_CRUDO = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function textoVisible(): string {
  return document.body.textContent;
}

describe.each(VISTAS)('%s dice la verdad en castellano', (nombre, Vista, titulo) => {
  async function montar() {
    renderWithApi(<Vista />);
    await screen.findByRole('heading', { level: 1, name: titulo }, { timeout: 5000 });
    // Las vistas piden varias fuentes; se espera a que la primera tabla o métrica aterrice para
    // no medir una pantalla de carga y creer que está limpia.
    await waitFor(() => {
      expect(textoVisible().length).toBeGreaterThan(200);
    }, { timeout: 5000 });
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
      .map((th) => th.textContent.trim())
      .filter((texto) => IDENTIFICADOR_CRUDO.test(texto));
    expect(crudas, `${nombre} tiene cabeceras con el nombre de la columna de la base`).toEqual([]);
  });

  it('no vuelca ninguna fecha ISO cruda del servidor', async () => {
    await montar();
    const encontrada = FECHA_ISO_CRUDA.exec(textoVisible());
    expect(encontrada?.[0], `${nombre} muestra una fecha ISO sin formatear`).toBeUndefined();
  });
});
