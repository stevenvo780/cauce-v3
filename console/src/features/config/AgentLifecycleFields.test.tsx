import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetCapability } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentLifecycleFields } from './AgentLifecycleFields';
import { agentLifecycleDraft } from './agent-lifecycle-model';

const snapshot: ConfigurationSnapshot = { tenants: [{ id: 'A' }], harness_definitions: [{ id: 'openclaw' }],
  provider_accounts: [{ id: 'codex-account', provider: 'codex' }, { id: 'gemini-account', provider: 'gemini' },
    { id: 'gemini-selected', provider: 'gemini' }] };
const runtime = { mode: 'native' as const, harness_id: 'openclaw', provider: 'codex', runtime_user: 'runner',
  systemd_user: 'runner', home_directory: '/home/runner', state_root: '/state' };
const capability: FleetCapability = { available: true, actions: ['create'], placements: [{ host_id: 'test-host',
  modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'],
  runtimes: [runtime, { ...runtime, provider: 'gemini' }] }] };

function Form({ accountId, current = snapshot }: { accountId: string; current?: ConfigurationSnapshot }) {
  const [draft, setDraft] = useState({ ...agentLifecycleDraft(current), tenantId: 'A', alias: 'worker',
    runtimeKey: 'worker', harnessId: 'openclaw', hostId: 'test-host', runtimeUser: 'runner', systemdUser: 'runner',
    homeDirectory: '/home/runner', stateDirectory: '/state/worker', primaryAccountId: accountId });
  return <AgentLifecycleFields draft={draft} snapshot={current} capability={capability} disabled={false}
    edit={patch => { setDraft(previous => ({ ...previous, ...patch })); }} />;
}

it('displays and selects the provider of the current account among identical runtime templates', () => {
  render(<Form accountId="gemini-selected" />);
  expect(screen.getByRole('combobox', { name: 'Plantilla de ejecución' })).toHaveValue('1');
  expect(screen.getByRole('option', { name: 'openclaw · gemini · native · runner · /home/runner' })).toBeInTheDocument();
});
it('changes the account with its template and retains an explicitly compatible account', async () => {
  const user = userEvent.setup();
  render(<Form accountId="gemini-selected" />);
  const templates = screen.getByRole('combobox', { name: 'Plantilla de ejecución' });
  const accounts = screen.getByRole('combobox', { name: 'Cuenta principal de ejecución' });
  await user.selectOptions(templates, '1');
  expect(accounts).toHaveValue('gemini-selected');
  await user.selectOptions(templates, '0');
  expect(accounts).toHaveValue('codex-account');
  await user.selectOptions(templates, '1');
  expect(accounts).toHaveValue('gemini-account');
});
it('clears an incompatible account when no published account matches the selected provider', async () => {
  const user = userEvent.setup();
  render(<Form accountId="codex-account" current={{ ...snapshot, provider_accounts: snapshot.provider_accounts?.slice(0, 1) }} />);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Plantilla de ejecución' }), '1');
  expect(screen.getByRole('combobox', { name: 'Cuenta principal de ejecución' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Plantilla de ejecución' })).toHaveValue('-1');
});
