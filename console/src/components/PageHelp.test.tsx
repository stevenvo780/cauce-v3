/**
 * The contract of the page help modal, the one every view's header hangs off.
 *
 * Each view used to open with a paragraph of prose plus its RBAC lines, so the first screenful
 * was reference text and the work started below it. Measured in Chrome, moving it behind a button
 * gave back between 81 and 143 px of useful height per view. Two things have to stay true for that
 * to keep holding: the prose must NOT be painted on the page, and the button must lead somewhere
 * a keyboard can actually use and get out of.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { renderWithApi } from '../test/render';
import { QueuesPage } from '../features/queues/QueuesPage';
import { FleetProvider } from '../shell/fleet';

const PROSA = /Las entregas y los incidentes causales son fuentes distintas/i;
const ABRIDOR = /Qué es «Colas y DLQ operativo»/i;

async function abrirAyuda() {
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><FleetProvider><QueuesPage /></FleetProvider></div>);
  const boton = await screen.findByRole('button', { name: ABRIDOR });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog');
  return { user, boton, dialogo };
}

it('la prosa de la cabecera no se pinta en la página: vive detrás del botón', async () => {
  renderWithApi(<div className="app-shell"><FleetProvider><QueuesPage /></FleetProvider></div>);
  await screen.findByRole('button', { name: ABRIDOR });

  expect(screen.queryByText(PROSA)).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('el botón se anuncia como el que abre un diálogo, y dice si está abierto', async () => {
  const { user, boton } = await abrirAyuda();
  expect(boton).toHaveAttribute('aria-haspopup', 'dialog');
  expect(boton).toHaveAttribute('aria-expanded', 'true');

  await user.keyboard('{Escape}');
  await waitFor(() => { expect(boton).toHaveAttribute('aria-expanded', 'false'); });
});

it('el diálogo lleva el título de la vista, la prosa y los permisos que exige', async () => {
  const { dialogo } = await abrirAyuda();
  expect(within(dialogo).getByRole('heading', { name: 'Colas y DLQ operativo' })).toBeInTheDocument();
  expect(within(dialogo).getByText(PROSA)).toBeInTheDocument();
});

it('Escape cierra el diálogo y el foco vuelve al botón que lo abrió', async () => {
  const { user, boton } = await abrirAyuda();
  await waitFor(() => { expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement); });
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(boton).toHaveFocus();
});
