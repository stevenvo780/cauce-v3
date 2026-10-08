import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { agentAction } from './agent-menu.test-helpers';

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

it('navigates the complete inventory and states once why member-only entries have no actions', async () => {
  const user = userEvent.setup();
  renderSettings();
  await screen.findByRole('list', { name: 'Agentes configurados' });
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 1–6 de 14');
  expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 7–12 de 14');
  expect(screen.getByRole('button', { name: 'Acciones de A/agent06' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Acciones de A/agent00' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.queryByRole('button', { name: 'Acciones de A/member' })).not.toBeInTheDocument();
  expect(screen.getByText('Solo miembro')).toBeVisible();
  expect(screen.getAllByText(/no tienen registro editable de agente/)).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 13–14 de 14');
  expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
});

it('searches every page and resets the page when the search changes', async () => {
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Siguiente' }));
  await user.type(screen.getByRole('searchbox'), 'agent12');
  expect(screen.getByRole('button', { name: 'Acciones de A/agent12' })).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.queryByRole('navigation', { name: 'Páginas de agentes' })).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getByRole('status')).toHaveTextContent('Agentes 1–6 de 14');
  expect(screen.getByRole('button', { name: 'Acciones de A/agent00' })).toBeVisible();
});

it('keeps an open registry draft when a search hides its card and the search is cleared', async () => {
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/agent00', 'Editar registro');
  const name = screen.getByRole('textbox', { name: 'Nombre visible' });
  await user.clear(name);
  await user.type(name, 'Pendiente');
  await user.type(screen.getByRole('searchbox'), 'agent12');
  expect(screen.queryByRole('textbox', { name: 'Nombre visible' })).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Pendiente');
});

it('preserves an open registry draft while moving between pages', async () => {
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/agent00', 'Editar registro');
  const name = screen.getByRole('textbox', { name: 'Nombre visible' });
  await user.clear(name);
  await user.type(name, 'Nombre pendiente');
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.queryByRole('textbox', { name: 'Nombre visible' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Anterior' }));
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Nombre pendiente');
});
