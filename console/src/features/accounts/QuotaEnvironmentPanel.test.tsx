import { fireEvent, screen, within } from '@testing-library/react';
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

it('no ofrece gemini aunque un host anuncie create', () => {
  const advertised = { ...snapshot, capabilities: { ...snapshot.capabilities, hosts: [...snapshot.capabilities.hosts,
    { host_id: 'gemini-host', display_name: 'Gemini Host', providers: ['gemini' as const], provider_actions: { gemini: ['create' as const] } }] } };
  renderWithApi(<QuotaEnvironmentPanel snapshot={advertised} accounts={accounts} canWrite reload={vi.fn()} />);
  const account = within(screen.getByRole('form', { name: 'Crear entorno de cuotas' })).getByRole('combobox', { name: 'Cuenta' });
  expect(within(account).queryByRole('option', { name: /gemini/u })).not.toBeInTheDocument();
});

it('habilita únicamente acciones del host y proveedor del entorno y bloquea hosts retirados', () => {
  const view = renderWithApi(<QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={vi.fn()} />);
  const card = within(screen.getByRole('article', { name: 'Entorno GPT' }));
  expect(card.getByRole('button', { name: 'Consultar cuotas' })).toBeEnabled();
  for (const name of ['Actualizar CLI', 'Eliminar entorno']) expect(card.getByRole('button', { name })).toBeDisabled();
  expect(card.getByRole('button', { name: 'Actualizar CLI' })).toHaveAttribute('title', expect.stringContaining('no puede ejecutar esta acción'));
  view.rerender(<ApiProvider api={testApi}><QuotaEnvironmentPanel snapshot={{ ...snapshot, capabilities: { ...snapshot.capabilities, hosts: snapshot.capabilities.hosts.slice(1) } }} accounts={accounts} canWrite reload={vi.fn()} /></ApiProvider>);
  expect(card.getByRole('button', { name: 'Consultar cuotas' })).toBeDisabled();
});

it.each<[string, QuotaEnvironmentsSnapshot | undefined, boolean]>([
  ['sin lectura', undefined, true],
  ['sin permiso', snapshot, false],
  ['sin entorno', { ...snapshot, environments: [] }, true],
])('un editor abierto queda bloqueado %s y conserva el borrador', async (_reason, current, canWrite) => {
  const update = vi.spyOn(testApi, 'updateQuotaEnvironment').mockResolvedValue({ environment });
  const reload = vi.fn(); const user = userEvent.setup();
  const view = renderWithApi(<QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={reload} />);
  await user.click(screen.getByRole('button', { name: 'Editar entorno' }));
  const form = screen.getByRole('form', { name: 'Editar entorno de cuotas' });
  const name = within(form).getByRole('textbox', { name: 'Nombre del entorno' });
  await user.clear(name); await user.type(name, 'Mi borrador');
  view.rerender(<ApiProvider api={testApi}><QuotaEnvironmentPanel snapshot={current} accounts={accounts} canWrite={canWrite} reload={reload} /></ApiProvider>);
  fireEvent.submit(form);
  expect(update).not.toHaveBeenCalled();
  expect(within(form).getByRole('button', { name: 'Guardar entorno' })).toBeDisabled();
  expect(name).toHaveValue('Mi borrador');
  expect(name).toBeDisabled();
});

it('editar entorno con nombre vacío o de espacios deshabilita Guardar y no envía', async () => {
  const update = vi.spyOn(testApi, 'updateQuotaEnvironment').mockResolvedValue({ environment });
  const user = userEvent.setup();
  renderWithApi(<QuotaEnvironmentPanel snapshot={snapshot} accounts={accounts} canWrite reload={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Editar entorno' }));
  const form = screen.getByRole('form', { name: 'Editar entorno de cuotas' });
  const name = within(form).getByRole('textbox', { name: 'Nombre del entorno' });
  const save = within(form).getByRole('button', { name: 'Guardar entorno' });
  expect(save).toBeEnabled();
  await user.clear(name);
  expect(save).toBeDisabled();
  expect(save).toHaveAttribute('title', 'Escribe el nombre del entorno.');
  await user.type(name, '   ');
  expect(save).toBeDisabled();
  fireEvent.submit(form);
  expect(update).not.toHaveBeenCalled();
  await user.type(name, 'Renombrado');
  expect(save).toBeEnabled();
});

it('awaiting_auth sin operación devuelta también bloquea comandos nuevos', () => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, environments: [{ ...environment, status: 'awaiting_auth' }] }} accounts={accounts} canWrite reload={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Consultar cuotas' })).toBeDisabled();
});

it.each(['pending', 'running'] as const)('muestra Actualizando… para una consulta %s', status => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, operations: [{ id: 'query', environment_id: environment.id,
    action: 'query', status, error_code: null, result: null, created_at: environment.created_at, updated_at: environment.updated_at }] }}
    accounts={accounts} canWrite reload={vi.fn()} />);
  expect(within(screen.getByRole('article', { name: 'Entorno GPT' })).getByRole('status')).toHaveTextContent('Actualizando…');
});

it('una operación ajena a query no presenta la cuota como actualizándose', () => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, operations: [{ id: 'update', environment_id: environment.id,
    action: 'update_cli', status: 'pending', error_code: null, result: null, created_at: environment.created_at, updated_at: environment.updated_at }] }}
    accounts={accounts} canWrite reload={vi.fn()} />);
  expect(screen.queryByText('Actualizando…')).not.toBeInTheDocument();
});

it('muestra el estado de refresco del servidor aunque la operación no esté en la página', () => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, environments: [{ ...environment, refresh_status: 'updating' }] }}
    accounts={accounts} canWrite reload={vi.fn()} />);
  expect(within(screen.getByRole('article', { name: 'Entorno GPT' })).getByRole('status')).toHaveTextContent('Actualizando…');
});

it.each([
  ['executor_unavailable', 'No hay un ejecutor disponible para actualizar esta cuenta.'],
  ['not_authenticated', 'Cuenta sin sesión iniciada: pulsa «Iniciar sesión».'],
] as const)('muestra %s para el entorno incluso si otro ejecutor sigue disponible', (refresh_status, message) => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, environments: [{ ...environment, refresh_status }] }}
    accounts={accounts} canWrite reload={vi.fn()} />);
  expect(within(screen.getByRole('article', { name: 'Entorno GPT' })).getByText(message)).toBeVisible();
  expect(screen.queryByText('Actualizando…')).not.toBeInTheDocument();
});

it('anuncia la carga inicial y mantiene el formulario deshabilitado hasta que llega el snapshot', () => {
  renderWithApi(<QuotaEnvironmentPanel loading accounts={accounts} canWrite reload={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent(/Leyendo entornos de consulta…/u);
  expect(screen.getByRole('button', { name: 'Crear entorno' })).toBeDisabled();
});

it('traduce el código de error de la operación en vez de mostrarlo crudo', () => {
  renderWithApi(<QuotaEnvironmentPanel snapshot={{ ...snapshot, operations: [{ id: 'auth', environment_id: environment.id,
    action: 'authenticate', status: 'failed', error_code: 'AUTH_EXPIRED', result: null, created_at: environment.created_at, updated_at: environment.updated_at }] }}
    accounts={accounts} canWrite reload={vi.fn()} />);
  expect(screen.getByText('La autenticación venció. Autentica la cuenta de nuevo.')).toBeVisible();
  expect(screen.queryByText('AUTH_EXPIRED')).not.toBeInTheDocument();
});
