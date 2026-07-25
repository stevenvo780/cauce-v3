import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApi } from '../../test/render';
import { FleetAgentDetailPage } from './FleetAgentDetailPage';

it('resolves tenant + alias into a single agent and reuses the terminal workspace to open its session', async () => {
  const user = userEvent.setup();
  renderWithApi(<FleetAgentDetailPage tenantId="Steven" alias="kant" />);

  expect(await screen.findByRole('heading', { level: 1, name: 'kant' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /volver a fleet/i })).toHaveAttribute('href', '/fleet');
  expect(await screen.findByText('1 agentes')).toBeInTheDocument();

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
  expect(await screen.findByRole('textbox', { name: /entrada para kant/i })).toBeInTheDocument();
});

it('shows an explicit not-found state instead of inventing an agent the server never observed', async () => {
  renderWithApi(<FleetAgentDetailPage tenantId="Ghost" alias="nadie" />);

  expect(await screen.findByText(/no observa/i)).toBeInTheDocument();
  expect(screen.getByText('Ghost:nadie')).toBeInTheDocument();
});
