import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AmpliacionesTab } from './AmpliacionesTab';

const snapshot: ConfigurationSnapshot = {
  revision: 4, agents: [{ tenant_id: 'A', alias: 'worker', extensions: [] }],
  host_extensions_allowed: [{ host_id: 'test-host', extensions_allowed: { types: ['network'], mount_roots: [], networks: ['test-network'] } }],
};

function renderExtensions(current = snapshot, hostId: string | null = 'test-host') {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
    })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: false, actions: [], placements: [], reason: 'executor_unconfigured' })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
  return renderWithApi(<ErrorBoundary label="Ampliaciones de A/worker"><ConsoleAccessBoundary>
    <AmpliacionesTab tenantId="A" alias="worker" snapshot={current} hostId={hostId ?? undefined} onReloaded={vi.fn()} />
  </ConsoleAccessBoundary></ErrorBoundary>);
}

it('renders the published empty state and host policy while preserving local draft editing', async () => {
  renderExtensions();
  expect(screen.getByRole('heading', { name: 'Ampliaciones activas (0)' })).toBeVisible();
  expect(screen.getByText('No hay ampliaciones guardadas para este agente.')).toBeVisible();
  expect(screen.getByText(/El ordenador admite: network/)).toBeVisible();
  expect(screen.queryByText(/aún no publica/)).not.toBeInTheDocument();
  const add = screen.getByRole('button', { name: 'Añadir ampliación Red adicional' });
  await waitFor(() => { expect(add).toBeEnabled(); });
  const user = userEvent.setup();
  await user.click(add);
  await user.type(screen.getByRole('textbox', { name: 'Nombre de la red Docker' }), 'test-network');
  await user.click(screen.getByRole('button', { name: 'Añadir al borrador' }));
  expect(screen.getByRole('heading', { name: 'Borrador de ampliaciones (1)' })).toBeVisible();
  expect(screen.getByText('test-network')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Descartar borrador' }));
  expect(screen.getByRole('heading', { name: 'Ampliaciones activas (0)' })).toBeVisible();
});

it('distinguishes a published empty host policy from an agent without an assigned computer', () => {
  const { unmount } = renderExtensions({ ...snapshot, host_extensions_allowed: [
    { host_id: 'test-host', extensions_allowed: { types: [], mount_roots: [], networks: [] } },
  ] });
  expect(screen.getByText(/El ordenador admite: ningún tipo por ahora/)).toBeVisible();
  unmount();
  renderExtensions({ ...snapshot, host_extensions_allowed: [] }, null);
  expect(screen.getByRole('heading', { name: 'Ampliaciones activas (0)' })).toBeVisible();
  expect(screen.queryByText(/El ordenador admite:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/aún no publica/)).not.toBeInTheDocument();
});

it.each([
  { agents: [{ tenant_id: 'A', alias: 'worker' }] },
  { agents: [{ tenant_id: 'A', alias: 'worker', extensions: [{ type: 'unknown' }] }] },
  { host_extensions_allowed: [] },
])('fails closed on a snapshot outside the current configuration contract: %j', (invalid) => {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => { if (typeof message === 'string') errors.push(message); });
  renderExtensions({ ...snapshot, ...invalid });
  expect(screen.getByRole('alert')).toHaveTextContent('Ampliaciones de A/worker no se pudo dibujar');
  expect(screen.getByRole('button', { name: 'Reintentar esta vista' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Vista previa' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Aplicar y recrear' })).not.toBeInTheDocument();
  expect(screen.queryByText(/aún no publica/)).not.toBeInTheDocument();
  expect(errors).toContain('[consola] Ampliaciones de A/worker falló con Error');
});
