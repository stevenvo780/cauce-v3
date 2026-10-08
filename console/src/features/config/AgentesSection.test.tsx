import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { openAgentMenu, openAgentSheet } from './agent-menu.test-helpers';

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

const snapshot = {
  revision: 3,
  agents: [{ tenant_id: 'Steven', alias: 'kant', display_name: 'Kant', harness_id: 'claude', enabled: true }],
  memberships: [{ tenant_id: 'Steven', alias: 'kant', room_id: 'grp.steven' }, { tenant_id: 'Steven', alias: 'solo', room_id: 'grp.steven' }],
  rooms: [{ tenant_id: 'Steven', id: 'grp.steven', display_name: 'Steven' }],
};

it('manda cada agente registrado a su página de perfil y contexto desde su menú, sin editor embebido', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  await openAgentMenu(user, 'Steven/kant');
  const enlace = await screen.findByRole('menuitem', { name: 'Perfil y contexto de Steven/kant' });
  expect(enlace).toHaveAttribute('href', '/messages/Steven/kant?view=context');
  expect(screen.queryByLabelText(/Identidad y propósito/)).not.toBeInTheDocument();
});

it('un miembro sin fila en el registro abre una ficha de solo lectura que explica por qué', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  expect(screen.queryByRole('button', { name: 'Acciones de Steven/solo' })).not.toBeInTheDocument();
  expect(screen.getAllByText('Solo miembro')).toHaveLength(1);
  const sheet = await openAgentSheet(user, 'Steven/solo');
  expect(sheet.getByText(/solo aparece como miembro de un grupo/)).toBeInTheDocument();
  expect(sheet.queryByRole('tab', { name: 'Registro' })).not.toBeInTheDocument();
  expect(sheet.queryByRole('tab', { name: 'Operación' })).not.toBeInTheDocument();
  expect(sheet.queryByRole('link', { name: /Perfil y contexto/ })).not.toBeInTheDocument();
});
