import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AccountsPage } from './AccountsPage';
import { App } from '../../App';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

function configuration(overrides: Record<string, unknown>) {
  server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
    revision: 4, observed_at: new Date().toISOString(), tenants: [{ id: 'Steven' }, { id: 'Pablo' }],
    rooms: [], memberships: [], acl_edges: [], harness_definitions: [], role_policies: [],
    revisions: [], ...overrides,
  })));
}

function recordChanges(sink: ChangeRequest[], response?: (input: ChangeRequest) => Response) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    if (response) return response(input);
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 4 : 5, mutation: input.mutation, summary: 'mock registry validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

const ownAccount = {
  id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex del hub',
  shared_with_pool: true, enabled: true, external_account_id: 'org-9f21',
  credential_ref_kind: 'env_path', updated_at: '2026-07-22T10:00:00.000Z',
};
const borrowedAccount = {
  id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax de Pablo',
  shared_with_pool: true, enabled: true, external_account_id: null, credential_ref_kind: null,
  updated_at: '2026-07-20T10:00:00.000Z',
};

it('queda enrutada en /accounts y /assignments sin desplazar a las pantallas existentes', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas de ia/i })).toBeInTheDocument();

  window.history.pushState({}, '', '/assignments');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(await screen.findByRole('heading', { level: 1, name: /matriz agente × cuenta/i })).toBeInTheDocument();

  window.history.pushState({}, '', '/config');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(await screen.findByRole('heading', { level: 1, name: /configuración/i })).toBeInTheDocument();
});

it('lista el inventario con pagador, publicación al pool y estado', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  renderWithApi(<AccountsPage />);

  expect(await screen.findByRole('heading', { level: 1, name: /cuentas de ia/i })).toBeInTheDocument();
  const row = (await screen.findByText('codex-steven')).closest('tr');
  expect(row).not.toBeNull();
  expect(within(row!).getByText('Steven')).toBeInTheDocument();
  expect(within(row!).getByText('PUBLICADA')).toBeInTheDocument();
  expect(within(row!).getByText('HABILITADA')).toBeInTheDocument();
  expect(within(row!).getByText('org-9f21')).toBeInTheDocument();
  expect(within(row!).getByText('env_path')).toBeInTheDocument();
});

it('dice que los campos del pagador no son visibles en vez de mostrarlos vacíos', async () => {
  configuration({ provider_accounts: [borrowedAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  renderWithApi(<AccountsPage />);

  const row = (await screen.findByText('minimax-pablo')).closest('tr');
  expect(within(row!).getAllByText(/no visible: la paga pablo/i)).toHaveLength(2);
  expect(within(row!).queryByText('UNKNOWN')).not.toBeInTheDocument();
});

it('declara no disponible el inventario cuando el gateway no publica provider_accounts', async () => {
  configuration({ agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  renderWithApi(<AccountsPage />);

  expect(await screen.findByText(/no disponible: este gateway no publica/i)).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('exige dry-run antes de aplicar el alta y manda la mutación de provider_account', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');

  // El apply no existe como camino paralelo: está deshabilitado hasta que el servidor validó
  // exactamente esta mutación en dry-run.
  expect(screen.getByRole('button', { name: /^aplicar$/i })).toBeDisabled();
  expect(changes).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));
  expect(await screen.findByLabelText(/dry-run de alta de cuenta/i)).toHaveTextContent('"dry_run": true');
  expect(changes[0]).toEqual({
    dry_run: true,
    expected_revision: 4,
    mutation: {
      resource: 'provider_account', action: 'create', id: 'codex-steven',
      value: {
        provider: 'codex', external_account_id: 'org-9f21', payer_tenant_id: 'Steven', label: null,
        credential_ref_kind: 'env_path', credential_ref: 'CAUCE_CODEX_STEVEN_PATH',
        shared_with_pool: false, enabled: false,
      },
    },
  });

  await user.click(screen.getByRole('button', { name: /^aplicar$/i }));
  expect(await screen.findByText(/aplicado en revisión 5/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
});

it('no reimprime el locator en el dry-run que el servidor devuelve', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  const preview = await screen.findByLabelText(/dry-run de alta de cuenta/i);
  expect(preview).not.toHaveTextContent('CAUCE_CODEX_STEVEN_PATH');
  expect(preview).toHaveTextContent(/locator no reimpreso/i);
});

it('deshabilita sin borrar: la acción abre el update con enabled en false', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'provider_account', action: 'update', id: 'codex-steven',
    value: { label: 'Codex del hub', shared_with_pool: true, enabled: false },
  });
  expect(screen.queryByRole('button', { name: /eliminar|borrar/i })).not.toBeInTheDocument();
});

it('explica la causa real cuando el servidor bloquea despublicar una cuenta prestada', async () => {
  const changes: ChangeRequest[] = [];
  configuration({
    provider_accounts: [ownAccount],
    agents: [{ tenant_id: 'Miguel', alias: 'iza' }],
    alias_routing_ceiling: [{ tenant_id: 'Miguel', alias: 'iza', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Miguel' }],
    agent_account_bindings: [],
  });
  recordChanges(changes, (input) => (input.dry_run
    ? HttpResponse.json({ error: 'conflict', message: 'configuration change violates a durable constraint' }, { status: 409 })
    : HttpResponse.json({ applied: true }, { status: 201 })));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.click(await screen.findByRole('button', { name: /despublicar/i }));
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/no se puede despublicar la cuenta «codex-steven» del pool/i);
  expect(alert).toHaveTextContent(/alias_routing_ceiling_borrow_requires_pool/);
  expect(alert).toHaveTextContent(/Miguel\/iza/);
  expect(alert).not.toHaveTextContent(/durable constraint/);
});
