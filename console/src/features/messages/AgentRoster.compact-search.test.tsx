import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { bloqueMedia, declaraciones, sinComentarios, valor } from '../../test/css-parser';
import { leerCss } from '../../test/leer-css';
import { AgentRoster } from './AgentRoster';
import type { AgenteDeMensajeria } from './roster';

const agents: AgenteDeMensajeria[] = [
  ['a', 'alpha', 'uno'], ['b', 'beta', 'dos'], ['c', 'alpha-dos', 'dos'],
].map(([id, alias, tenantId]) => ({ id, alias, tenantId, roomIds: [], roomMembership: {}, leaseState: 'unknown', origenes: ['registro'], mensajesVisibles: 0 }));

it('abre con teclado, enfoca, conserva consulta al cerrar con Escape y permite limpiarla', async () => {
  const user = userEvent.setup();
  render(<AgentRoster agents={agents} salud={{}} loading={false} onSelect={vi.fn()} />);
  const toggle = screen.getByRole('button', { name: 'Buscar' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(screen.getByRole('textbox', { name: 'Buscar agente' }));
  toggle.focus();
  await user.keyboard('{Enter}');
  const input = screen.getByRole('textbox', { name: 'Buscar agente' });
  expect(input).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await user.type(input, 'beta');
  expect(screen.getAllByRole('button', { name: /^Conversación con/ })).toHaveLength(1);
  await user.keyboard('{Escape}');
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(input).toHaveValue('beta');
  expect(screen.getByText('Búsqueda: beta')).toBeInTheDocument();
  await user.click(toggle);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('beta');
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(toggle).toHaveFocus();
  expect(input).toHaveValue('');
  expect(screen.getAllByRole('button', { name: /^Conversación con/ })).toHaveLength(3);
});

it('combina Cliente y búsqueda, anuncia filtro y no pierde selección al limpiar consulta', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<AgentRoster agents={agents} salud={{}} loading={false} onSelect={onSelect} />);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Cliente' }), 'dos');
  expect(screen.getByRole('status')).toHaveTextContent('Cliente: dos · 2 agentes visibles');
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
  await user.type(screen.getByRole('textbox', { name: 'Buscar agente' }), 'alpha');
  expect(screen.getByRole('status')).toHaveTextContent('Cliente: dos · Búsqueda: alpha · 1 agentes visibles');
  await user.click(screen.getByRole('button', { name: /^Conversación con alpha-dos/ }));
  expect(onSelect).toHaveBeenCalledWith(agents[2]);
  await user.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(screen.getByRole('combobox')).toHaveValue('dos');
  expect(screen.getAllByRole('button', { name: /^Conversación con/ })).toHaveLength(2);
});

it('mantiene búsqueda desktop y compacta sólo la portada móvil con controles táctiles', () => {
  const css = sinComentarios(leerCss('features/messages/messages.css'));
  const mobile = bloqueMedia(css, '@media (max-width: 760px)');
  expect(valor(declaraciones(css, '.messenger-search-toggle, .messenger-active-query'), 'display')).toBe('none');
  expect(valor(declaraciones(css, '.messenger-search'), 'display')).toBe('block');
  expect(valor(declaraciones(mobile, '.messenger-roster-filters'), 'grid-template-columns')).toBe('auto minmax(0, 1fr)');
  expect(valor(declaraciones(mobile, '.messenger-roster-filters .messenger-search'), 'display')).toBe('none');
  expect(valor(declaraciones(mobile, '.messenger-roster-filters[data-search-open] .messenger-search'), 'display')).toBe('block');
  expect(valor(declaraciones(mobile, '.messenger-search-toggle'), 'min-width')).toBe('44px');
  expect(valor(declaraciones(mobile, '.messenger-search-toggle'), 'min-height')).toBe('44px');
  expect(valor(declaraciones(mobile, '.messenger-tenant-filter select'), 'min-height')).toBe('44px');
  expect(valor(declaraciones(mobile, '.messenger-active-query > button'), 'min-height')).toBe('44px');
  expect(valor(declaraciones(mobile, '.messenger-search input'), 'font-size')).toBe('16px');
  expect(valor(declaraciones(mobile, '.messenger-shell[data-conversacion="abierta"] .messenger-roster'), 'display')).toBe('none');
});
