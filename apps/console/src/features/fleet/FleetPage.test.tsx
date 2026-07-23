import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { FleetPage } from './FleetPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

it('derives presence from lease expiry and preserves unknowns', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  server.use(http.get('http://localhost/v3/status', () => HttpResponse.json({
    version: '3.0', presence: [
      { tenant_id: 'Steven', alias: 'fresh', epoch: 4, lease_expires_at: future, online: false },
      { tenant_id: 'Steven', alias: 'stale', epoch: 5, lease_expires_at: past, online: true },
      { tenant_id: 'Steven', alias: 'uncertain', epoch: null, lease_expires_at: null, online: true },
    ],
  })));
  renderWithApi(<FleetPage />);

  expect(within(await screen.findByRole('row', { name: /fresh/i })).getByText('ONLINE')).toBeInTheDocument();
  expect(within(screen.getByRole('row', { name: /stale/i })).getByText('EXPIRADO')).toBeInTheDocument();
  expect(within(screen.getByRole('row', { name: /uncertain/i })).getAllByText('UNKNOWN').length).toBeGreaterThan(0);
  expect(screen.getByText('Leases vigentes').nextElementSibling).toHaveTextContent('1');
});
