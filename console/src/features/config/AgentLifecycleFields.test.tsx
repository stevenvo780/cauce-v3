import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { FleetCapability } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentLifecycleFields } from './AgentLifecycleFields';
import { agentLifecycleDraft } from './agent-lifecycle-model';

function computadora(host_id: string, overrides: Record<string, unknown> = {}) {
  return { host_id, display_name: `Nombre de ${host_id}`, notes: '', enabled: true, status: 'reachable',
    status_source: 'controller', last_seen_at: null, registered: true, approved: true, version: 1, agents: [], ...overrides };
}

beforeEach(() => {
  server.use(http.get('*/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [
    computadora('test-host'),
    computadora('apagada', { status: 'unreachable' }),
    computadora('deshabilitada', { enabled: false }),
  ] })));
});

const snapshot: ConfigurationSnapshot = { tenants: [{ id: 'A' }], harness_definitions: [{ id: 'openclaw' }],
  provider_accounts: [{ id: 'codex-account', provider: 'codex' }, { id: 'gemini-account', provider: 'gemini' },
    { id: 'gemini-selected', provider: 'gemini' }] };
const runtime = { mode: 'native' as const, harness_id: 'openclaw', provider: 'codex', runtime_user: 'runner',
  systemd_user: 'runner', home_directory: '/home/runner', state_root: '/state' };
const capability: FleetCapability = { available: true, actions: ['create'], placements: [{ host_id: 'test-host',
  modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'],
  runtimes: [runtime, { ...runtime, provider: 'gemini' }] },
  { host_id: 'apagada', modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'] }] };

function Form({ accountId, current = snapshot }: { accountId: string; current?: ConfigurationSnapshot }) {
  const [draft, setDraft] = useState({ ...agentLifecycleDraft(current), tenantId: 'A', alias: 'worker',
    runtimeKey: 'worker', harnessId: 'openclaw', hostId: 'test-host', runtimeUser: 'runner', systemdUser: 'runner',
    homeDirectory: '/home/runner', stateDirectory: '/state/worker', primaryAccountId: accountId });
  return <AgentLifecycleFields draft={draft} snapshot={current} capability={capability} disabled={false}
    edit={patch => { setDraft(previous => ({ ...previous, ...patch })); }} />;
}

it('displays and selects the provider of the current account among identical runtime templates', () => {
  renderWithApi(<Form accountId="gemini-selected" />);
  expect(screen.getByRole('combobox', { name: 'Plantilla de ejecución' })).toHaveValue('1');
  expect(screen.getByRole('option', { name: 'openclaw · gemini · native · runner · /home/runner' })).toBeInTheDocument();
});
it('changes the account with its template and retains an explicitly compatible account', async () => {
  const user = userEvent.setup();
  renderWithApi(<Form accountId="gemini-selected" />);
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
  renderWithApi(<Form accountId="codex-account" current={{ ...snapshot, provider_accounts: snapshot.provider_accounts?.slice(0, 1) }} />);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Plantilla de ejecución' }), '1');
  expect(screen.getByRole('combobox', { name: 'Cuenta principal de ejecución' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Plantilla de ejecución' })).toHaveValue('-1');
});

it('anota cada host de la capacidad con su registro y deja deshabilitado el que no es usable', async () => {
  renderWithApi(<Form accountId="codex-account" />);
  const hosts = screen.getByRole('combobox', { name: 'Host operativo' });
  await waitFor(() => { expect(screen.getByRole('option', { name: 'test-host · Nombre de test-host · Conectada' })).toBeEnabled(); });
  expect(screen.getByRole('option', { name: 'test-host · Nombre de test-host · Conectada' })).not.toBeDisabled();
  expect(screen.getByRole('option', { name: /Nombre de apagada/ })).toBeDisabled();
  expect(hosts).toHaveValue('test-host');
});

it('re-derives the state directory and container from the template when the physical key changes', async () => {
  const user = userEvent.setup();
  renderWithApi(<Form accountId="codex-account" />);
  const key = screen.getByLabelText('Clave física de ejecución');
  await user.clear(key);
  await user.type(key, 'nuevo');
  expect(screen.getByLabelText('Directorio de estado operativo')).toHaveValue('/state/nuevo');
  expect(screen.getByRole('combobox', { name: 'Plantilla de ejecución' })).toHaveValue('0');
});

it('shows the state directory read-only while a template is selected and editable otherwise', async () => {
  const user = userEvent.setup();
  renderWithApi(<Form accountId="codex-account" />);
  const state = screen.getByLabelText('Directorio de estado operativo');
  expect(state).toHaveAttribute('readonly');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Plantilla de ejecución' }), '-1');
  expect(state).toHaveAttribute('readonly');
});

it('offers a membership role select from role_policies with agent preselected', async () => {
  const user = userEvent.setup();
  const withRooms = { ...snapshot, rooms: [{ id: 'r1', tenant_id: 'A' }],
    role_policies: [{ role: 'observer' }, { role: 'agent' }] };
  renderWithApi(<Form accountId="codex-account" current={withRooms} />);
  await user.click(screen.getByRole('checkbox', { name: /Incluir/ }));
  const role = screen.getByRole('combobox', { name: /Rol en/ });
  expect(role).toHaveValue('agent');
  expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(expect.arrayContaining(['observer', 'agent']));
});
