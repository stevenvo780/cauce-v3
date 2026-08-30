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

const PROSA = /Las entregas y los incidentes causales son fuentes distintas/i;
const ABRIDOR = /Qué es «Colas y DLQ operativo»/i;

async function abrirAyuda() {
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><QueuesPage /></div>);
  const boton = await screen.findByRole('button', { name: ABRIDOR });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog');
  return { user, boton, dialogo };
}

it('la prosa de la cabecera no se pinta en la página: vive detrás del botón', async () => {
  renderWithApi(<div className="app-shell"><QueuesPage /></div>);
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
  expect(dialogo).toHaveAttribute('aria-modal', 'true');
  expect(dialogo).toHaveAttribute('aria-labelledby', 'page-help-titulo');
  expect(document.getElementById('page-help-titulo')).toHaveTextContent('Colas y DLQ operativo');
  expect(within(dialogo).getByText(PROSA)).toBeInTheDocument();
  expect(within(dialogo).getByText('delivery.replay')).toBeInTheDocument();
});

it('el foco entra al diálogo y vuelve al botón que lo abrió al cerrarlo', async () => {
  const { user, dialogo, boton } = await abrirAyuda();
  expect(dialogo.contains(document.activeElement)).toBe(true);

  await user.click(within(dialogo).getByRole('button', { name: /cerrar/i }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(document.activeElement).toBe(boton);
});

it('mientras el diálogo vive, el armazón queda inerte y el diálogo fuera de él', async () => {
  const { user, dialogo } = await abrirAyuda();
  const armazon = document.querySelector('.app-shell');
  expect(armazon).not.toBeNull();
  expect(armazon).toHaveAttribute('inert');
  expect(armazon?.contains(dialogo)).toBe(false);

  await user.keyboard('{Escape}');
  await waitFor(() => { expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert'); });
});

it('el tabulador da la vuelta dentro del diálogo en vez de irse al fondo apagado', async () => {
  const { user, dialogo } = await abrirAyuda();
  const focos = [...dialogo.querySelectorAll<HTMLElement>(
    'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  expect(focos.length).toBeGreaterThan(0);

  focos[focos.length - 1].focus();
  await user.tab();
  expect(document.activeElement).toBe(focos[0]);

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(focos[focos.length - 1]);
});

it('un clic en el velo cierra; un clic dentro del diálogo no', async () => {
  const { user, dialogo } = await abrirAyuda();
  await user.click(within(dialogo).getByText(PROSA));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  const velo = dialogo.parentElement;
  expect(velo).toHaveClass('page-help-fondo');
  if (!velo) throw new Error('el diálogo no tiene velo');
  await user.click(velo);
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
});
