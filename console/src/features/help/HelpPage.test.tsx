import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { HelpPage } from './HelpPage';
import { NAV_ENTRIES } from '../../nav';

/**
 * The help is a hand-written map of the console, so nothing keeps it honest except a test: a route
 * that changes its address or its name leaves the help pointing at a view that no longer exists,
 * and a help that lies is worse than none.
 */

it('describe TODAS las vistas del menú, con la dirección real de cada una', () => {
  render(<HelpPage />);
  const texto = document.body.textContent;

  for (const entrada of NAV_ENTRIES) {
    expect(texto).toContain(`${entrada.label} (/${entrada.id})`);
  }
});

it('documenta el atajo que la consola declara en su propia barra lateral', () => {
  // `App.tsx` publishes `aria-keyshortcuts="Alt+Shift+B"` on the toggle: a shortcut announced by the interface and ab
  render(<HelpPage />);
  const atajos = screen.getByRole('heading', { name: /atajos de teclado/i }).closest('.panel');

  expect(atajos).not.toBeNull();
  expect(atajos?.textContent).toMatch(/Alt \+ Shift \+ B/);
  expect(atajos?.textContent).toMatch(/barra lateral/i);
});

it('abre con su propio encabezado, igual que su entrada de ruta', () => {
  render(<HelpPage />);

  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Ayuda y documentación$/);
  expect(screen.getByRole('heading', { name: /mapa de vistas/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /estados de la flota/i })).toBeInTheDocument();
});

it('separa el contexto declarado de capacidades y permisos, con un solo lugar de edición', () => {
  render(<HelpPage />);
  const seccion = screen.getByRole('heading', { name: /contexto, capacidades y permisos/i })
    .closest('.panel');

  expect(seccion).not.toBeNull();
  expect(seccion).toHaveTextContent(/herramientas declaradas/i);
  expect(seccion).toHaveTextContent(/no habilita un binario ni un MCP/i);
  expect(seccion).toHaveTextContent(/membresías, roles de permisos, ACL y RBAC/i);
  expect(seccion).toHaveTextContent(/el control vive en «Contexto», no en este visor/i);
  expect(document.body).toHaveTextContent(/«Contexto» es el único lugar para modificar/i);
  expect(document.body).toHaveTextContent(/«Ficheros» es un visor/i);
});
