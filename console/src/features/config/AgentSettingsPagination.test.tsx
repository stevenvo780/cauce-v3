import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';

const snapshot: ConfigurationSnapshot = {
  revision: 4,
  agents: Array.from({ length: 13 }, (_, index) => ({
    tenant_id: 'A', alias: `agent${String(index).padStart(2, '0')}`, display_name: `Agente ${String(index)}`,
    harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1,
  })),
  memberships: [{ tenant_id: 'A', alias: 'member', room_id: 'ops' }], rooms: [],
};

function renderSettings() {
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
  })));
  return renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
}

it('navigates the complete inventory and keeps the reason for unavailable context visible', async () => {
  const user = userEvent.setup();
  renderSettings();
  const list = await screen.findByRole('list', { name: 'Agentes configurados' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 1–6 de 14');
  expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 7–12 de 14');
  expect(screen.getByRole('link', { name: 'Perfil y contexto de A/agent06' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Perfil y contexto de A/agent00' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.queryByRole('link', { name: 'Perfil y contexto de A/member' })).not.toBeInTheDocument();
  expect(screen.getByText(/Contexto no disponible.*solo aparece como miembro/i)).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 13–14 de 14');
  expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
});

it('searches every page and resets the page when the search changes', async () => {
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Siguiente' }));
  await user.type(screen.getByRole('searchbox'), 'agent12');
  expect(screen.getByRole('link', { name: 'Perfil y contexto de A/agent12' })).toBeVisible();
  expect(within(screen.getByRole('list', { name: 'Agentes configurados' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.queryByRole('navigation', { name: 'Páginas de agentes' })).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 1–6 de 14');
  expect(screen.getByRole('link', { name: 'Perfil y contexto de A/agent00' })).toBeVisible();
});

it('preserves an open registry draft while moving between pages', async () => {
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/agent00' }));
  const name = screen.getByRole('textbox', { name: 'Nombre visible' });
  await user.clear(name);
  await user.type(name, 'Nombre pendiente');
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.queryByRole('textbox', { name: 'Nombre visible' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Anterior' }));
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Nombre pendiente');
});
