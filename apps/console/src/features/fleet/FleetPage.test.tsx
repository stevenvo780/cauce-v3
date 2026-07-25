import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
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

it('lists a topology member that never connected, distinguishable from one with a live lease', async () => {
  server.use(
    http.get('http://localhost/v3/status', () => HttpResponse.json({
      version: '3.0',
      presence: [
        { tenant_id: 'Steven', alias: 'kant', epoch: 9, lease_expires_at: new Date(Date.now() + 60_000).toISOString() },
      ],
    })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({
      tenants: [
        { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'kant', enabled: true }, { alias: 'ghost', enabled: true }] }] },
      ],
    })),
  );
  renderWithApi(<FleetPage />);

  const onlineRow = within(await screen.findByRole('row', { name: /kant/i }));
  expect(onlineRow.getByText('ONLINE')).toBeInTheDocument();

  // "ghost" nunca envió presencia pero sigue configurado en la topología: no debe desaparecer.
  const neverConnectedRow = within(await screen.findByRole('row', { name: /ghost/i }));
  expect(neverConnectedRow.getByText('NUNCA CONECTADO')).toBeInTheDocument();
  expect(neverConnectedRow.getByText('grp.steven')).toBeInTheDocument();
});

it('filters the fleet by free text across alias, tenant, room and capabilities', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost/v3/status', () => HttpResponse.json({
      version: '3.0',
      presence: [{ tenant_id: 'Steven', alias: 'kant', epoch: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }],
    })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({
      tenants: [{ id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'kant', enabled: true }, { alias: 'ghost', enabled: true }] }] }],
    })),
  );
  renderWithApi(<FleetPage />);

  await screen.findByRole('row', { name: /ghost/i });
  await user.type(screen.getByPlaceholderText(/Filtrar por alias/i), 'kant');

  expect(screen.getByRole('row', { name: /kant/i })).toBeInTheDocument();
  expect(screen.queryByRole('row', { name: /ghost/i })).not.toBeInTheDocument();
});

it('renders presence as soon as it resolves, without waiting for a slow topology', async () => {
  server.use(
    http.get('http://localhost/v3/status', () => HttpResponse.json({
      version: '3.0',
      presence: [{ tenant_id: 'Steven', alias: 'kant', epoch: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }],
    })),
    http.get('http://localhost/v3/console/topology', async () => {
      await delay(3_000);
      return HttpResponse.json({ tenants: [] });
    }),
  );
  renderWithApi(<FleetPage />);

  // La presencia ya resolvió: la fila de kant debe existir sin esperar a la topología (que tarda 3s).
  expect(await screen.findByRole('row', { name: /kant/i })).toBeInTheDocument();
  expect(screen.queryByText(/Consultando leases, epochs y topología/i)).not.toBeInTheDocument();
});

it('surfaces the status error with a retry button instead of spinning forever while topology is still in flight', async () => {
  server.use(
    http.get('http://localhost/v3/status', () => HttpResponse.json({ error: 'boom', message: 'status caído' }, { status: 500 })),
    http.get('http://localhost/v3/console/topology', async () => {
      await delay(3_000);
      return HttpResponse.json({ tenants: [] });
    }),
  );
  renderWithApi(<FleetPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/status caído/i);
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  expect(screen.queryByText(/Consultando leases, epochs y topología/i)).not.toBeInTheDocument();
});

it('shows a known zero for "Leases vigentes" when the server reports an explicit empty presence list', async () => {
  server.use(
    http.get('http://localhost/v3/status', () => HttpResponse.json({ version: '3.0', presence: [] })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({ tenants: [] })),
  );
  renderWithApi(<FleetPage />);

  await screen.findByText('En cola');
  expect(screen.getByText('Leases vigentes').nextElementSibling).toHaveTextContent('0');
  expect(screen.getByText('Leases vigentes').nextElementSibling).not.toHaveTextContent('UNKNOWN');
});
