import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigPage } from './ConfigPage';
import { renderWithApi } from '../../test/render';

it('previews and applies a default-deny ACL mutation through the protected API', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('heading', { level: 1, name: /configuración/i })).toBeInTheDocument();
  expect(await screen.findByText(/RBAC/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  expect(await screen.findByLabelText(/resultado de preview/i)).toHaveTextContent('"dry_run": true');
  expect(screen.getByLabelText(/resultado de preview/i)).toHaveTextContent('"allow_route": false');

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  expect(await screen.findByText(/cambio atómico aplicado/i)).toBeInTheDocument();
});
