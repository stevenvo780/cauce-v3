/**
 * The keyboard and focus contract of the PTY dialog.
 *
 * Every other modal of this console —directive, control plane, config confirmation— switches the
 * shell off with `inert`, wraps the tab inside itself and gives the focus back to the control that
 * opened it. This one asks for a root shell in a container that other agents share, and it is the
 * only one that used to do none of the three: the tab walked out to the page behind, still visible
 * through the veil, and cancelling dropped the focus on `body`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { closePtySession } from './pty-session';
import { installStubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const PTY_SESSION_ID = 'pty-teclado-1';
const WS_PATH = '/v3/console/terminal/ws';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code',
    shares_container_with: [{ tenant_id: 'Steven', alias: 'kant' }],
    modes: ['shell', 'harness'], pty_state: 'online', last_seen: null, authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

let restoreSocket: () => void;

beforeEach(() => {
  restoreSocket = installStubWebSocket();
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true, plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'], websocket_path: WS_PATH, target_label: 'Cauce fleet PTY',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(), websocket_path: WS_PATH,
      items: [target({ tenant_id: 'Steven', alias: 'zeus' })],
    })),
    http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
      { error: 'conflict', reason: 'container_busy' }, { status: 409 },
    )),
  );
});

afterEach(() => {
  closePtySession(PTY_SESSION_ID);
  restoreSocket();
});

/** Opens the dialog the only way the operator can: pick the alias, then ask for the PTY channel. */
async function abrirDialogoPty() {
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><TerminalPage /></div>);
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  const boton = await screen.findByRole('button', { name: /^PTY$/i });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog');
  return { user, dialogo, boton };
}

it('el foco entra al diálogo, en el campo que hay que rellenar', async () => {
  const { dialogo } = await abrirDialogoPty();
  expect(dialogo.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(within(dialogo).getByLabelText(/motivo de la sesión/i));
});

it('mientras el diálogo vive, el armazón de la consola queda inerte', async () => {
  const { user, dialogo } = await abrirDialogoPty();
  const armazon = document.querySelector('.app-shell');
  expect(armazon).not.toBeNull();
  expect(armazon).toHaveAttribute('inert');
  expect(armazon?.contains(dialogo)).toBe(false);

  await user.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => { expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert'); });
});

it('el tabulador da la vuelta dentro del diálogo en vez de irse al fondo', async () => {
  const { user, dialogo } = await abrirDialogoPty();
  const focos = [...dialogo.querySelectorAll<HTMLElement>(
    'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  expect(focos.length).toBeGreaterThan(1);

  focos[focos.length - 1].focus();
  await user.tab();
  expect(document.activeElement).toBe(focos[0]);

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(focos[focos.length - 1]);
});

it('al cancelar, el foco vuelve al botón que abrió el diálogo', async () => {
  const { user, dialogo, boton } = await abrirDialogoPty();
  await user.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(document.activeElement).toBe(boton);
});

/* The read-only TUI opens on its own when the alias is picked, so a POST is expected before the
   dialog exists. `shell` is the mode THIS dialog asks for, and the one a cancel must never send. */
it('Escape cierra el diálogo y devuelve el foco, sin pedir ninguna shell', async () => {
  const modos: unknown[] = [];
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    modos.push((await request.json() as Record<string, unknown>).mode);
    return new HttpResponse(null, { status: 500 });
  }));
  const { user, boton } = await abrirDialogoPty();

  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(document.activeElement).toBe(boton);
  expect(modos).not.toContain('shell');
});
