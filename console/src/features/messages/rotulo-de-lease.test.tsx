import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderRouted } from '../../test/render';
import { LEASE_LABEL } from '../../vocabulario';
import { MessagesPage } from './MessagesPage';

/**
 * The messenger is the surface where the lease word changed the most, and nothing rendered it in a
 * test: a hardcoded «vencido» coming back here would have been green everywhere.
 */

const PALABRAS: string[] = Object.values(LEASE_LABEL);

function rotuloDeLease(elemento: Element): string | undefined {
  return /lease ([^,]+)/.exec(elemento.getAttribute('aria-label') ?? '')?.[1];
}

beforeEach(() => { window.history.pushState({}, '', '/messages'); });
afterEach(() => { window.history.pushState({}, '', '/'); });

it('el roster y la cabecera del hilo nombran el lease con el vocabulario compartido', async () => {
  const user = userEvent.setup();
  renderRouted(MessagesPage);
  const filas = await screen.findAllByRole('button', { name: /conversación con /i });
  const alias = /conversación con ([^,]+),/i.exec(filas[0].getAttribute('aria-label') ?? '')?.[1] ?? '';
  await user.click(filas[0]);

  const hilo = await screen.findByRole('region', { name: new RegExp(`^conversación con ${alias}$`, 'i') });
  const insignia = within(hilo).getByText((texto, elemento) =>
    elemento?.classList.contains('badge') === true && PALABRAS.includes(texto));
  await waitFor(() => {
    const boton = screen.getByRole('button', { name: new RegExp(`conversación con ${alias},`, 'i') });
    expect(rotuloDeLease(boton)).toBe(insignia.textContent);
  });
  expect(screen.getAllByRole('button', { name: /conversación con /i })
    .map(rotuloDeLease)
    .filter((rotulo) => rotulo === undefined || !PALABRAS.includes(rotulo))).toEqual([]);
});
