import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ConfigurationSnapshot } from '../../api/types';
import { SummaryTab } from './AgentSheetTabs';
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
