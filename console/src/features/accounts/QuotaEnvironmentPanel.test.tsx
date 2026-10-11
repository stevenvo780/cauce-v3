import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { QuotaAccount, QuotaEnvironment, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { renderWithApi, testApi } from '../../test/render';
import { ApiProvider } from '../../api/context';
import { QuotaEnvironmentPanel } from './QuotaEnvironmentPanel';

const accounts = ['codex', 'claude', 'gemini'].map(provider => ({ id: provider, provider, label: provider })) as QuotaAccount[];
const environment: QuotaEnvironment = { id: 'env', company_id: 'one', account_id: 'codex', host_id: 'gpt-host', provider: 'codex', label: 'GPT',
  status: 'ready', version: 1, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
const snapshot: QuotaEnvironmentsSnapshot = { company_id: 'one', environments: [environment], operations: [], capabilities: {
  available: true, providers: ['codex', 'claude', 'gemini'], actions: ['create', 'authenticate', 'query', 'update_cli', 'delete'], hosts: [
    { host_id: 'gpt-host', display_name: 'GPT Host', providers: ['codex'], provider_actions: { codex: ['create', 'query'] } },
    { host_id: 'claude-host', display_name: 'Claude Host', providers: ['claude'], provider_actions: { claude: ['create', 'authenticate', 'delete'] } },
    { host_id: 'read-host', display_name: 'Read Host', providers: ['codex'], provider_actions: { codex: ['query'] } },
  ],
} };

it('filtra ordenadores por proveedor y create e invalida el host al cambiar de cuenta', async () => {
  const reload = vi.fn().mockResolvedValue(undefined);
  const create = vi.spyOn(testApi, 'createQuotaEnvironment').mockResolvedValue({ environment, operation: { id: 'op', environment_id: 'env',
    action: 'create', status: 'pending', error_code: null, result: null, created_at: environment.created_at, updated_at: environment.updated_at } });
  renderWithApi(<QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={reload} />);
  const user = userEvent.setup(); const form = within(screen.getByRole('form', { name: 'Crear entorno de cuotas' }));
  const account = form.getByRole('combobox', { name: 'Cuenta' }); const host = form.getByRole('combobox', { name: 'Computadora' });
  expect(within(account).queryByRole('option', { name: /gemini/u })).not.toBeInTheDocument();
  expect(host).toBeDisabled(); await user.selectOptions(account, 'codex');
  expect(within(host).queryByRole('option', { name: 'Claude Host' })).not.toBeInTheDocument();
  expect(within(host).queryByRole('option', { name: 'Read Host' })).not.toBeInTheDocument();
  await user.selectOptions(host, 'gpt-host'); await user.type(form.getByRole('textbox', { name: 'Nombre del entorno' }), 'Consulta');
  await user.selectOptions(account, 'claude'); expect(host).toHaveValue('');
  expect(form.getByRole('button', { name: 'Crear entorno' })).toBeDisabled();
  await user.selectOptions(host, 'claude-host'); await user.click(form.getByRole('button', { name: 'Crear entorno' }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ account_id: 'claude', host_id: 'claude-host', label: 'Consulta' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('habilita únicamente acciones del host y proveedor del entorno y bloquea hosts retirados', () => {
  const view = renderWithApi(<QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={vi.fn()} />);
  const card = within(screen.getByRole('article', { name: 'Entorno GPT' }));
  expect(card.getByRole('button', { name: 'Consultar cuotas' })).toBeEnabled();
  for (const name of ['Autenticar cuenta', 'Actualizar CLI', 'Eliminar entorno']) expect(card.getByRole('button', { name })).toBeDisabled();
  view.rerender(<ApiProvider api={testApi}><QuotaEnvironmentPanel snapshot={{ ...snapshot, capabilities: { ...snapshot.capabilities, hosts: snapshot.capabilities.hosts.slice(1) } }} accounts={accounts} canWrite reload={vi.fn()} /></ApiProvider>);
  expect(card.getByRole('button', { name: 'Consultar cuotas' })).toBeDisabled();
});

it('revocar capacidad tras el consentimiento bloquea la confirmación sin enviar una acción', async () => {
  const action = vi.spyOn(testApi, 'actQuotaEnvironment'); const user = userEvent.setup();
  const allowed = { ...snapshot, capabilities: { ...snapshot.capabilities, hosts: [{ ...snapshot.capabilities.hosts[0], provider_actions: { codex: ['authenticate' as const] } }] } };
  const view = renderWithApi(<QuotaEnvironmentPanel snapshot={allowed} accounts={accounts} canWrite reload={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Autenticar cuenta' }));
  view.rerender(<ApiProvider api={testApi}><QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={vi.fn()} /></ApiProvider>);
  expect(screen.getByRole('button', { name: 'Confirmar autenticación' })).toBeDisabled(); expect(action).not.toHaveBeenCalled();
});

it('awaiting_auth sin operación devuelta también bloquea comandos nuevos', () => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, environments: [{ ...environment, status: 'awaiting_auth' }] }} accounts={accounts} canWrite reload={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Consultar cuotas' })).toBeDisabled();
});
