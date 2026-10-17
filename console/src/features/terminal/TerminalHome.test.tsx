import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TerminalHome } from './TerminalHome';

it('un error de flota en la terminal ofrece reintentar la lectura', async () => {
  const user = userEvent.setup();
  const onRefresh = vi.fn();
  render(<TerminalHome agentCount={0} loading={false} error={new Error('gateway caído')} onRefresh={onRefresh} />);

  expect(screen.getByRole('alert')).toHaveTextContent('La flota no se pudo leer.');
  await user.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('una flota vacía dice dónde registrar el primer agente', () => {
  render(<TerminalHome agentCount={0} loading={false} />);

  expect(screen.getByText(/Registra el primero en Ajustes, sección Agentes/)).toBeInTheDocument();
});
