import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { HelpPage } from './HelpPage';
import { NAV_ENTRIES } from '../../nav';
import { LIVE_STATE_META, LIVE_STATES } from '../live/agent-state';

/**
 * The help is a hand-written map of the console, so nothing keeps it honest except a test: a route
 * that changes its address or its name leaves the help pointing at a view that no longer exists,
 * and a help that lies is worse than none.
 */

it('describe TODAS las vistas del menú, con la dirección real de cada una', () => {
  render(<HelpPage />);
  const mapa = screen.getByRole('region', { name: /mapa de vistas/i });

  for (const entrada of NAV_ENTRIES) {
    const enlace = within(mapa).getByRole('link', { name: new RegExp(`^${entrada.label} /${entrada.id}$`) });
    expect(enlace).toHaveAttribute('href', `/${entrada.id}`);
  }
});

it('documenta el atajo que la consola declara en su propia barra lateral', () => {
  // `AppShell` publishes `aria-keyshortcuts="Alt+Shift+B"` on the toggle: a shortcut announced by the interface and absent here would be a lie.
  render(<HelpPage />);
  const atajos = screen.getByRole('region', { name: /atajos de teclado/i });

  expect(atajos.textContent).toMatch(/Alt \+ Shift \+ B/);
  expect(atajos.textContent).toMatch(/barra lateral/i);
  expect(atajos.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(7);
});

it('abre con su propio encabezado y un índice que apunta a cada sección', () => {
  render(<HelpPage />);

  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Ayuda y documentación$/);
  const indice = screen.getByRole('navigation', { name: /en esta página/i });
  for (const enlace of within(indice).getAllByRole('link')) {
    const destino = enlace.getAttribute('href')?.slice(1) ?? '';
    expect(document.getElementById(destino), `la sección ${destino} no existe`).not.toBeNull();
  }
});

it('nombra los estados de la flota con las palabras que muestra la consola, no con sus enums', () => {
  render(<HelpPage />);
  const estados = screen.getByRole('region', { name: /estados de la flota/i });

  for (const estado of LIVE_STATES) expect(estados).toHaveTextContent(LIVE_STATE_META[estado].label);
  expect(estados.textContent).not.toMatch(/in_flight|degraded|down \/ off/);
});

it('separa el contexto declarado de capacidades y permisos, con un solo lugar de edición', () => {
  render(<HelpPage />);
  const seccion = screen.getByRole('region', { name: /contexto, capacidades y permisos/i });

  expect(seccion).toHaveTextContent(/herramientas declaradas/i);
  expect(seccion).toHaveTextContent(/no habilita un binario ni un MCP/i);
  expect(seccion).toHaveTextContent(/membresías, roles de permisos, ACL y RBAC/i);
  expect(seccion).toHaveTextContent(/el control vive en «Contexto», no en este visor/i);
  expect(document.body).toHaveTextContent(/«Contexto» es el único lugar para modificar/i);
  expect(document.body).toHaveTextContent(/«Ficheros» es un visor/i);
});
