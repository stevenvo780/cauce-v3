import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { HelpPage } from '../help/HelpPage';
import { TerminalPage } from './TerminalPage';

it('la referencia del control está en Docs y la selección usa identidad tenant más alias', async () => {
  const { container } = renderWithApi(<TerminalPage />);
  const select = await screen.findByRole('combobox', { name: 'Agente' });
  expect(select).toBeEnabled();
  expect(await screen.findByRole('option', { name: /^kant · Steven/ })).toHaveValue('Steven:kant');
  expect(container.querySelector('.terminal-overview')).toBeNull();
  expect(container.querySelector('.terminal-fleet')).toBeNull();
  expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/ayuda#terminal');
});

it('Docs explica la cola y la devolución del teclado sin exigir una justificación escrita', () => {
  renderWithApi(<HelpPage />);
  expect(screen.getByRole('heading', { name: 'Ayuda y documentación' })).toBeInTheDocument();
  expect(document.getElementById('terminal')).toHaveTextContent('no hace falta escribir una justificación');
  expect(document.getElementById('terminal')).toHaveTextContent('cambiar de agente');
  expect(document.getElementById('terminal')).toHaveTextContent('mensajes nuevos del bus quedan en cola');
  expect(document.getElementById('terminal')).toHaveTextContent('un turno que ya estaba en marcha puede terminar');
});
