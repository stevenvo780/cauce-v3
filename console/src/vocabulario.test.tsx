/**
 * Format and vocabulary verification on mounted views:
 * 1. No unrendered JSX markers.
 * 2. No visible UNKNOWN literals.
 * 3. No raw snake_case identifiers in table headers.
 * 4. No unformatted raw ISO dates.
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
import { HelpPage } from './features/help/HelpPage';

const VISTAS = [
  ['la portada', LandingPage, /cauce en una pantalla/i],
  ['/live', LiveFleetPage, /la flota ahora/i],
  ['/accounts', AccountsPage, /cuentas y cuotas/i],
  ['/queues', QueuesPage, /colas y dlq operativo/i],
  ['/observability', ObservabilityPage, /señales y auditoría/i],
  ['/terminal', TerminalPage, 'Terminal de agentes'],
  ['/ayuda', HelpPage, /ayuda y documentación/i],
] as const;

/**
 * A JSX component that escaped and is being printed as text.
 *
 * An escaped `<Unknown value={x} />` shows up as `<UNKNOWN VALUE=AVAILABLE />` (CSS uppercases it,
 * but in the DOM it is `<Unknown value=…`). The search targets the SHAPE — a less-than sign, an
 * identifier, and a closing slash — and not specific text, so it will catch the next one too.
 */
const MARCADOR_DE_JSX = /<\s*[A-Za-z][A-Za-z0-9]*\s+[A-Za-z]+\s*=[^>]*\/>/;

const FECHA_ISO_CRUDA = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** English `snake_case`: the exact shape of a database column name. */
const IDENTIFICADOR_CRUDO = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function textoVisible(): string {
  return document.body.textContent;
}

describe.each(VISTAS)('%s dice la verdad en castellano', (nombre, Vista, titulo) => {
  async function montar() {
    renderWithApi(<Vista />);
    await screen.findByRole('heading', { level: 1, name: titulo }, { timeout: 5000 });
    // The views request several sources; it waits for the first table or metric to land so it
    // does not measure a loading screen and believe it is clean.
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
    // The doctrine lives in the LOGIC; what changes is the word. See `lib.ts`.
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
