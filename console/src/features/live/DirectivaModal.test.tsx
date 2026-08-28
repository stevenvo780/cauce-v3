import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * THE KEYBOARD AND FOCUS CONTRACT OF THE DIRECTIVE DIALOG.
 *
 * This is exactly what jsdom CAN demonstrate: which element has focus, what Escape listens to,
 * what ARIA attributes exist and what happens when closing. What it CANNOT demonstrate — and
 * is not attempted here — is that the dialog fits: jsdom does not compute layout, every box
 * measures 0. Geometry was measured in Chrome and lives in the report.
 *
 * Each case below describes a failure that a poorly-made modal actually commits:
 *  · open and leave focus outside → the keyboard stays on the page behind, dimmed;
 *  · close and drop focus on `body` → the next tab returns to the start of the console;
 *  · Escape without stopping propagation → the drawer, which has its OWN Escape, also closes;
 *  · tab without trap → it goes to the inert background and focus disappears from view;
 *  · the background stays alive → one can scroll and click what is behind the veil.
 */

import { configConBrief } from './agent-state-fixtures';

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

async function abrir() {
  const user = userEvent.setup();
  configConBrief('Sos kant, el hub de la flota.\nAUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  const boton = await within(cajon).findByRole('button', { name: /abrir directiva completa/i });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  return { user, cajon, dialogo, boton };
}

it('se anuncia como diálogo modal y con nombre', async () => {
  const { dialogo } = await abrir();
  expect(dialogo).toHaveAttribute('aria-modal', 'true');
  expect(dialogo).toHaveAttribute('aria-labelledby', 'directiva-modal-titulo');
  expect(document.getElementById('directiva-modal-titulo')).toHaveTextContent('Directiva de kant');
}, 25_000);

it('el foco entra al diálogo al abrir y vuelve al botón que lo abrió al cerrar', async () => {
  const { user, dialogo, boton } = await abrir();
  expect(dialogo.contains(document.activeElement)).toBe(true);

  await user.click(within(dialogo).getByRole('button', { name: /cerrar la directiva/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.activeElement).toBe(boton);
}, 25_000);

it('desde la capa manual abre directamente el editor real de ficheros del mismo alias', async () => {
  const { user, dialogo, cajon } = await abrir();
  await user.click(within(dialogo).getByRole('button', {
    name: /editar claude\.md \/ agents\.md/i,
  }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(within(cajon).getByRole('tab', { name: 'Ficheros' })).toHaveAttribute('aria-selected', 'true');
  expect(await within(cajon).findByText('CLAUDE.md (manual del sitio)')).toBeInTheDocument();
}, 25_000);

/**
 * Escape closes the DIALOG and only the dialog. `AgentDrawer` has its own Escape listener on
 * `document` to close itself; without stopping propagation, a single press took both down and
 * the operator was left looking at the map.
 */
it('Escape cierra el diálogo y deja el cajón abierto', async () => {
  const { user } = await abrir();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: /detalle de kant/i })).toBeInTheDocument();
}, 25_000);

it('un clic en el velo cierra; un clic dentro del diálogo no', async () => {
  const { user, dialogo } = await abrir();
  await user.click(within(dialogo).getByText('Directiva de kant'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  const velo = dialogo.parentElement;
  expect(velo).not.toBeNull();
  if (!velo) throw new Error('dialogo.parentElement is missing');
  expect(velo).toHaveClass('directiva-modal-fondo');
  await user.click(velo);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}, 25_000);

/**
 * The focus trap: from the last control, Tab returns to the first; from the first, Shift+Tab
 * jumps to the last. Without this the tab goes to the frame — which is `inert` — and focus
 * disappears: nobody sees where it is and there is no way back without the mouse.
 */
it('el tabulador da la vuelta dentro del diálogo en vez de irse al fondo', async () => {
  const { user, dialogo } = await abrir();
  const focos = [...dialogo.querySelectorAll<HTMLElement>(
    'button:not([disabled]), summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )];
  expect(focos.length).toBeGreaterThan(1);

  focos[focos.length - 1].focus();
  await user.tab();
  expect(document.activeElement).toBe(focos[0]);

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(focos[focos.length - 1]);
}, 25_000);

/**
 * The background switches off while the dialog lives, and switches on when it closes.
 *
 * `inert` on `.app-shell` cuts mouse, tab and screen reader. The class on the root element is
 * what cuts the WHEEL: measured in Chrome, with the dialog open the page behind kept 2,894 px
 * of scroll. Here the MECHANISM is checked — the attribute and the class; that the CSS rule
 * hanging off that class takes effect was measured in Chrome, because jsdom does not load the
 * stylesheet and `getComputedStyle` would return the default value no matter what.
 */
it('mientras el diálogo vive, el armazón queda inerte y el cajón marcado como no desplazable', async () => {
  const { user, dialogo } = await abrir();
  expect(document.documentElement).toHaveClass('directiva-modal-abierta');

  await user.click(within(dialogo).getByRole('button', { name: /cerrar la directiva/i }));
  expect(document.documentElement).not.toHaveClass('directiva-modal-abierta');
}, 25_000);

/** The legacy column cannot reopen a save that omits the runtime ACK. */
it('la columna 1 muestra la proyección sólo lectura y dirige al perfil canónico', async () => {
  const { dialogo } = await abrir();
  const capa1 = within(dialogo).getByLabelText('Capa 1: rol declarado');
  expect(await within(capa1).findByLabelText(/proyección del rol de kant/i)).toHaveAttribute('readonly');
  expect(within(capa1).getByText(/\/ 1200$/)).toBeInTheDocument();
  expect(within(capa1).queryByRole('button', { name: /guardar el rol/i })).not.toBeInTheDocument();
  expect(within(capa1).getByRole('button', { name: /editar el perfil canónico/i })).toBeInTheDocument();
}, 25_000);

it('no afirma que falta un manual cuando el runtime no fue medido', async () => {
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    publicado: true,
    medido: false,
    motivo: 'contenedor no medido todavía (sin hechos de entorno)',
    files: null,
    memory: null,
  })));
  const { dialogo } = await abrir();
  expect(within(dialogo).getAllByText(/contenedor no medido todavía/i)).toHaveLength(2);
  expect(within(dialogo).queryByText(/Ningún manual: este alias arranca sin contexto operativo/i))
    .not.toBeInTheDocument();
  expect(within(dialogo).queryByText(/El servidor miró y no hay/i)).not.toBeInTheDocument();
}, 25_000);

it('muestra orden, cobertura parcial y un timeout sin convertirlo en ausencia', async () => {
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    publicado: true,
    medido: true,
    container_id: 'ws-kant',
    manual_order: 'codex_precedence',
    context_coverage: 'standard_manuals',
    context_limitations: ['project_doc_fallback_filenames no está proyectado'],
    files: [
      {
        path: '/workspace/repo/AGENTS.md', scope: 'workspace', precedence: 2,
        bytes: 10, modified_at: '2026-08-26T00:00:00Z', text: '# manual\n', sha: 'a'.repeat(64),
      },
      {
        path: '/workspace/repo/sub/AGENTS.override.md', scope: 'workspace', precedence: 3,
        bytes: null, modified_at: null, text: null, error: 'timeout', reason: 'panel sin respuesta',
      },
    ],
    memory: { error: 'unavailable', reason: 'sin índice' },
  })));
  const { dialogo } = await abrir();
  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');
  expect(within(capa2).getByText(/más profundo prevalece; override gana/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/Cobertura limitada:.*fallback_filenames/i)).toBeInTheDocument();
  expect(within(capa2).getByRole('alert')).toHaveTextContent(/timeout.*panel sin respuesta.*No se toma como ausencia/i);
  expect(within(capa2).queryByText(/no hay ningún manual estándar/i)).not.toBeInTheDocument();
}, 25_000);
