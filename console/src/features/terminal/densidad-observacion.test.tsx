import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { HelpPage } from '../help/HelpPage';
import { TerminalPage } from './TerminalPage';

it('el selector identifica cada agente por tenant más alias y el agente abierto no repite cabeceras ni KPIs', async () => {
  const { container } = renderWithApi(<TerminalPage />);
  const kant = await screen.findByRole('link', { name: /^kant/ });
  expect(kant).toHaveAttribute('href', '/terminal/Steven/kant');
  expect(kant).toHaveTextContent('Steven');
  expect(container.querySelector('.terminal-overview')).toBeNull();
  expect(container.querySelector('.terminal-fleet')).toBeNull();
});

it('Docs explica la cola y la devolución del teclado sin exigir una justificación escrita', () => {
  renderWithApi(<HelpPage />);
  expect(screen.getByRole('heading', { name: 'Ayuda y documentación' })).toBeInTheDocument();
  expect(document.getElementById('terminal')).toHaveTextContent('sin justificación');
  expect(document.getElementById('terminal')).toHaveTextContent('cambiar de agente');
  expect(document.getElementById('terminal')).toHaveTextContent('mensajes nuevos del bus quedan en cola');
  expect(document.getElementById('terminal')).toHaveTextContent('un turno ya en marcha puede terminar');
});
