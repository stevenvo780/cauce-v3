import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { renderWithApi } from '../../test/render';
import { GroupChips, GroupsTab, SummaryTab } from './AgentSheetTabs';
import type { AgentView } from './agent-view';
import type { SettingsAgent } from './settings-model';

const agent: SettingsAgent = {
  key: '["A","w"]', tenantId: 'A', alias: 'w', name: 'Worker', registered: true,
  enabled: true, harness: 'codex', responsibility: undefined, groups: [],
};

function view(row: Record<string, unknown>): AgentView {
  return {
    ref: 'A/w', row, hostId: undefined, host: undefined, hostName: 'Sin computadora',
    hasRuntime: false, state: { label: 'Habilitado', tone: 'ok' },
  };
}

it('shows the account by label and provider, the payer by name, and no raw ids or revision', () => {
  const snapshot = {
    tenants: [{ id: 'A', display_name: 'Empresa A' }, { id: 'B', display_name: 'Empresa B' }],
    provider_accounts: [{ id: 'acc-1', label: 'Claude de Steven', provider: 'claude', payer_tenant_id: 'B' }],
  } as unknown as ConfigurationSnapshot;
  render(<SummaryTab agent={agent} view={view({ primary_account_id: 'acc-1', lifecycle_state: 'auth_pending' })} snapshot={snapshot} />);
  expect(screen.getByText(/Claude de Steven/)).toHaveAttribute('title', 'acc-1');
  expect(screen.getByText('Empresa B')).toHaveAttribute('title', 'B');
  expect(screen.getByText('Esperando inicio de sesión')).toHaveAttribute('title', 'auth_pending');
  expect(screen.queryByText(/ciclo de vida:/)).not.toBeInTheDocument();
  expect(screen.queryByText('Última revisión leída')).not.toBeInTheDocument();
});

it('never prints the raw account id as the main text when the account has no label', () => {
  const snapshot = {
    tenants: [{ id: 'A', display_name: 'Empresa A' }],
    provider_accounts: [{ id: 'acc-secreto', label: null, provider: 'codex', payer_tenant_id: 'A' }],
  } as unknown as ConfigurationSnapshot;
  render(<SummaryTab agent={agent} view={view({ primary_account_id: 'acc-secreto' })} snapshot={snapshot} />);
  expect(screen.getByText(/Cuenta sin etiqueta/)).toHaveAttribute('title', 'acc-secreto');
  expect(screen.queryByText('acc-secreto')).not.toBeInTheDocument();
  expect(screen.getByText('La misma empresa')).toBeInTheDocument();
});

it('shows historical groups in GroupChips and GroupsTab without falling back to empty notices', () => {
  const retiredMemberAgent: SettingsAgent = {
    key: 'retired:A/retirado', tenantId: 'A', alias: 'retirado', name: 'Agente Retirado',
    registered: true, enabled: false, harness: 'codex', responsibility: undefined,
    groups: [{ id: 'grp.a', label: 'Grupo Alfa', enabled: false }],
  };
  const snapshot = {
    revision: 1,
    tenants: [{ id: 'A', display_name: 'Empresa A' }],
    rooms: [{ tenant_id: 'A', id: 'grp.a', display_name: 'Grupo Alfa', enabled: true }],
  } as unknown as ConfigurationSnapshot;

  render(<GroupChips agent={retiredMemberAgent} />);
  expect(screen.getByText(/Grupo Alfa/)).toBeInTheDocument();
  expect(screen.getByText(/pausada/)).toBeInTheDocument();
  expect(screen.queryByText('Sin grupos')).not.toBeInTheDocument();

  renderWithApi(<ConsoleAccessBoundary><GroupsTab agent={retiredMemberAgent} view={view({})} snapshot={snapshot} onReloaded={() => undefined} /></ConsoleAccessBoundary>);
  expect(screen.getByText('Grupo Alfa')).toBeInTheDocument();
  expect(screen.getByText('Membresía deshabilitada')).toBeInTheDocument();
  expect(screen.queryByText('Este agente no tiene membresías registradas.')).not.toBeInTheDocument();
});

it('shows empty notices in GroupChips and GroupsTab when an agent has no groups', () => {
  const withoutGroups: SettingsAgent = { ...agent, groups: [] };
  const snapshot = { revision: 1 } as unknown as ConfigurationSnapshot;

  render(<GroupChips agent={withoutGroups} />);
  expect(screen.getByText('Sin grupos')).toBeInTheDocument();

  renderWithApi(<ConsoleAccessBoundary><GroupsTab agent={withoutGroups} view={view({})} snapshot={snapshot} onReloaded={() => undefined} /></ConsoleAccessBoundary>);
  expect(screen.getByText('Este agente no tiene membresías registradas.')).toBeInTheDocument();
});
