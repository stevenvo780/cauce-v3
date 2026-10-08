import { screen, within } from '@testing-library/react';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';

const snapshot = {
  revision: 3,
  agents: [{ tenant_id: 'Steven', alias: 'kant', display_name: 'Kant', harness_id: 'claude', enabled: true }],
  memberships: [{ tenant_id: 'Steven', alias: 'kant', room_id: 'grp.steven' }, { tenant_id: 'Steven', alias: 'solo', room_id: 'grp.steven' }],
  rooms: [{ tenant_id: 'Steven', id: 'grp.steven', display_name: 'Steven' }],
};

it('manda cada agente registrado a su página de perfil y contexto, sin editor embebido', () => {
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  const lista = screen.getByRole('list', { name: 'Agentes configurados' });
  const enlace = within(lista).getByRole('link', { name: 'Perfil y contexto de Steven/kant' });
  expect(enlace).toHaveAttribute('href', '/messages/Steven/kant?view=context');
  expect(screen.queryByLabelText(/Identidad y propósito/)).not.toBeInTheDocument();
});

it('un miembro sin fila en el registro no ofrece contexto: lo dice', () => {
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  expect(screen.queryByRole('link', { name: 'Perfil y contexto de Steven/solo' })).not.toBeInTheDocument();
  expect(screen.getByText(/Contexto no disponible: solo aparece como miembro/)).toBeInTheDocument();
});
