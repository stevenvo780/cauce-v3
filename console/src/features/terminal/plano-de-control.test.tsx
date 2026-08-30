/*
 * THE CONTROL PLANE IS ON DEMAND, AND THERE IS ONLY ONE OF IT. jsdom computes no geometry, so the
 * width the terminal won back is measured in a real browser (`console/qa/layout-gate.mjs`); what
 * belongs here is the half a stylesheet cannot answer: the data was not deleted, it is reachable
 * from a named control by keyboard, and it is mounted ONCE — the old layout rendered the same
 * inspector twice and chose by window width, so every check about it had to say "at least one".
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { installStubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const CONTROL = /plano de control/i;
const BLOQUES = ['Permisos efectivos', 'Adaptadores', 'PTY directo'];

let restoreSocket: () => void;

beforeEach(() => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws',
  })));
  restoreSocket = installStubWebSocket();
});

afterEach(() => { restoreSocket(); });

it('deja el ancho al terminal: el plano de control no está montado hasta que se pide', async () => {
  renderWithApi(<TerminalPage />);

  const control = await screen.findByRole('button', { name: CONTROL });
  expect(control).toHaveAttribute('aria-haspopup', 'dialog');
  expect(control).toHaveAttribute('aria-expanded', 'false');
  for (const bloque of BLOQUES) expect(screen.queryByRole('heading', { name: bloque })).toBeNull();
});

it('abre los tres bloques en un diálogo, una sola vez y con nombre accesible', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: CONTROL }));

  const dialogo = await screen.findByRole('dialog', { name: /plano de control/i });
  for (const bloque of BLOQUES) expect(within(dialogo).getByRole('heading', { name: bloque })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: CONTROL })).toHaveAttribute('aria-expanded', 'true');
  // The double mount, spelled out: two copies would make this two, and every check about the
  // control plane would have to go back to counting "one or more".
  for (const bloque of BLOQUES) expect(screen.getAllByRole('heading', { name: bloque })).toHaveLength(1);
});

it('cierra con Escape y devuelve el foco al control que lo abrió', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  const control = await screen.findByRole('button', { name: CONTROL });
  await user.click(control);
  await screen.findByRole('dialog');

  await user.keyboard('{Escape}');

  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(screen.getByRole('button', { name: CONTROL })).toHaveFocus();
  expect(screen.getByRole('button', { name: CONTROL })).toHaveAttribute('aria-expanded', 'false');
});

it('cierra con su botón de cerrar, que es el foco de entrada del diálogo', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: CONTROL }));
  const dialogo = await screen.findByRole('dialog');
  const cerrar = within(dialogo).getByRole('button', { name: /cerrar/i });
  expect(cerrar).toHaveFocus();

  await user.click(cerrar);
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(screen.getByRole('button', { name: CONTROL })).toHaveFocus();
});

/* The two halves the other cases leave out: the background is really switched off, and the tab
   wraps instead of walking into it. Without the trap the focus lands on an `inert` page, where the
   caret cannot be seen and there is no way back without the mouse. */
it('apaga el armazón mientras vive y da la vuelta al tabulador en vez de irse a él', async () => {
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><TerminalPage /></div>);
  await user.click(await screen.findByRole('button', { name: CONTROL }));
  const dialogo = await screen.findByRole('dialog', { name: /plano de control/i });

  const armazon = document.querySelector('.app-shell');
  expect(armazon).toHaveAttribute('inert');
  expect(armazon?.contains(dialogo)).toBe(false);

  const focos = [...dialogo.querySelectorAll<HTMLElement>(
    'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  expect(focos.length).toBeGreaterThan(0);
  focos[focos.length - 1].focus();
  await user.tab();
  expect(document.activeElement).toBe(focos[0]);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(focos[focos.length - 1]);

  await user.keyboard('{Escape}');
  await waitFor(() => { expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert'); });
});
