import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { openAgentMenu } from './agent-menu.test-helpers';

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

it('un miembro sin fila en el registro no ofrece acciones: lo dice una sola vez', () => {
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  expect(screen.queryByRole('button', { name: 'Acciones de Steven/solo' })).not.toBeInTheDocument();
  expect(screen.getAllByText('Solo miembro')).toHaveLength(1);
  expect(screen.getAllByText(/no tienen registro editable de agente/)).toHaveLength(1);
});
