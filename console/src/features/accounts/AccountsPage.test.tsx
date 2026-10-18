import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigMutationSchema, configurationMutationSha256, publicConfigurationMutation } from '@cauce/protocol/configuration';
import { AccountsPage } from './AccountsPage';
import { App } from '../../App';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

function configuration(overrides: Record<string, unknown>, revision: number | (() => number) = 4) {
  server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
    revision: typeof revision === 'function' ? revision() : revision,
    observed_at: new Date().toISOString(), tenants: [{ id: 'Steven' }, { id: 'Pablo' }],
    rooms: [], memberships: [], acl_edges: [], harness_definitions: [], role_policies: [],
    revisions: [], ...overrides,
  })));
}

async function changeReceipt(input: ChangeRequest) {
  const mutation = ConfigMutationSchema.parse(input.mutation);
  return {
    applied: input.dry_run !== true, dry_run: input.dry_run === true,
    revision: input.dry_run ? 4 : 5, mutation: publicConfigurationMutation(mutation),
    mutation_sha256: await configurationMutationSha256(mutation),
    inverse_mutation: publicConfigurationMutation(mutation), rolled_back_revision_id: null,
    summary: 'mock registry validation',
  };
}

function recordChanges(sink: ChangeRequest[], response?: (input: ChangeRequest) => Response | Promise<Response>) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    if (response) return response(input);
    return HttpResponse.json(await changeReceipt(input), { status: input.dry_run ? 200 : 201 });
  }));
}

function accessWithoutWrite(unknown = false) {
  server.use(http.get('http://localhost/v3/console/access', () => unknown
    ? HttpResponse.json({ error: 'access unavailable' }, { status: 503 })
    : HttpResponse.json({ subject: 'Steven:kant', roles: ['reader'], permissions: ['config.read'] })));
}

const ownAccount = {
  id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex del hub',
  shared_with_pool: true, enabled: true, external_account_id: 'org-9f21',
  credential_ref_kind: 'env_path', updated_at: '2026-07-22T10:00:00.000Z',
};

it.each([
  ['explicitly denied', false],
  ['unknown after access failure', true],
] as const)('keeps account data inspectable when config.write is %s without sending a mutation', async (_label, unknown) => {
  let posts = 0;
  accessWithoutWrite(unknown);
  configuration({
    provider_accounts: [ownAccount],
    agents: [{ tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true }],
    alias_routing_ceiling: [{ tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' }],
    agent_account_bindings: [],
  });
  server.use(http.post('http://localhost/v3/console/config/changes', () => {
    posts += 1;
    return HttpResponse.json({ error: 'unexpected mutation' }, { status: 403 });
  }));

  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);
  const inventory = await openInventory();
  const row = (await inventory.findByText('codex-steven')).closest('tr');
  expect(row).not.toBeNull();
  if (!row) return;

  expect(within(row).getByRole('button', { name: /editar/i })).toBeDisabled();
  expect(within(row).getByRole('button', { name: /habilitar|deshabilitar/i })).toBeDisabled();
  expect(inventory.getByRole('button', { name: /nueva cuenta/i })).toBeDisabled();

  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
  const cell = await screen.findByRole('button', { name: /Steven\/kant × codex-steven/i });
  expect(cell).toBeDisabled();
  expect(screen.getByRole('button', { name: /nueva asignación/i })).toBeDisabled();
  expect(posts).toBe(0);
});

/** Scopes to the account form: creation and assignment bars share button texts. */
function accountActions() {
  return within(screen.getByRole('group', { name: /acciones de (alta|edición) de cuenta/i }));
}

function deleteActions() {
  return within(screen.getByRole('group', { name: /acciones de retiro o rotación de cuenta/i }));
}

async function openInventory() {
  await screen.findByRole('heading', { level: 1, name: /cuentas/i });
  const el = document.getElementById('view-panel-inventario');
  expect(el).not.toBeNull();
  return within(el ?? document.body);
}

it('queda enrutada en /accounts sin desplazar a las pantallas existentes', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas/i })).toBeInTheDocument();

  act(() => {
    window.history.pushState({}, '', '/config');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(await screen.findByRole('heading', { level: 1, name: /ajustes/i })).toBeInTheDocument();
});

it('/assignments no da 404 ni cae al fallback: redirige a /accounts y reescribe la barra de direcciones', async () => {
  window.history.pushState({}, '', '/assignments');
  renderWithApi(<App />);

  // The right view is chosen in the match, not after a bounce: the matrix is on screen.
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas/i })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/accounts'); });
});

it('lista el inventario con pagador, publicación al pool y estado', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory();
  const cell = await inventario.findByText('codex-steven');
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  if (row) {
    expect(within(row).getByText('Steven')).toBeInTheDocument();
    expect(within(row).getByText('PUBLICADA')).toBeInTheDocument();
    expect(within(row).getByText('HABILITADA')).toBeInTheDocument();
  }
});

it('declara no disponible el inventario cuando el gateway no publica provider_accounts', async () => {
  configuration({ agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  // Both halves declare it separately, each with what is missing for them: inventory cannot be
  // listed, the matrix cannot be formed. Merging the views did not merge the warnings, because
  // they are not the same fact — and now that they are tabs of the same page, it still isn't.
  const inventario = await openInventory();
  expect(await inventario.findByText(/no se muestra nada porque no hay dato/i)).toBeInTheDocument();
  expect(inventario.queryByRole('table')).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
  expect(await screen.findByText(/la matriz se muestra incompleta a propósito/i)).toBeInTheDocument();
});

it('exige dry-run antes de aplicar el alta y manda la mutación de provider_account', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /nueva cuenta/i }));
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');

// Apply does not exist as a parallel path: it is disabled until the server validated exactly
    // this mutation in dry-run.
  expect(accountActions().getByRole('button', { name: /^aplicar$/i })).toBeDisabled();
  expect(changes).toHaveLength(0);

  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));
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

  await user.click(accountActions().getByRole('button', { name: /^aplicar$/i }));
  expect(await screen.findByText(/aplicado en revisión 5/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
});

it('no habilita ni acredita escrituras del registro con recibos 2xx truncados', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes, async (input) => input.dry_run
    ? HttpResponse.json(await changeReceipt(input))
    : HttpResponse.json({ applied: true, dry_run: false, revision: 5 }, { status: 201 }));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /nueva cuenta/i }));
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));
  await user.click(accountActions().getByRole('button', { name: /^aplicar$/i }));

  expect(await screen.findByText(/la escritura puede haberse aplicado/i)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/releído del servidor.*revisión 4/i);
  expect(screen.queryByText(/aplicado en revisión 5/i)).not.toBeInTheDocument();
}, 20_000);

it('no reimprime el locator en el dry-run que el servidor devuelve', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /nueva cuenta/i }));
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  const preview = await screen.findByLabelText(/dry-run de alta de cuenta/i);
  expect(preview).not.toHaveTextContent('CAUCE_CODEX_STEVEN_PATH');
  expect(preview).not.toHaveTextContent('"credential_ref":');
});

it('bloquea aplicar si el recibo confirma otro locator aunque la proyección visible coincida', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes, async (input) => {
    const mutation = ConfigMutationSchema.parse(input.mutation);
    if (mutation.resource !== 'provider_account') throw new Error('unexpected account mutation');
    const other = { ...mutation, value: { ...mutation.value, credential_ref: 'OTHER_LOCATOR' } };
    return HttpResponse.json({ ...await changeReceipt(input), mutation_sha256: await configurationMutationSha256(other) });
  });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);
  await openInventory();
  await user.click(await screen.findByRole('button', { name: /nueva cuenta/i }));
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/sin el recibo exacto del dry-run/i);
  expect(accountActions().getByRole('button', { name: /^aplicar$/i })).toBeDisabled();
  expect(changes).toHaveLength(1);
});

it('deshabilita sin borrar: la acción abre el update con enabled en false', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  // Retiring is a separate affordance from disabling: disabling never offers the delete.
  expect(await screen.findByRole('button', { name: /retirar o rotar/i })).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'provider_account', action: 'update', id: 'codex-steven',
    value: { label: 'Codex del hub', shared_with_pool: true, enabled: false },
  });
});

it('invalida el dry-run si Actualizar cambia la revisión y exige previsualizar otra vez', async () => {
  const changes: ChangeRequest[] = [];
  let revision = 4;
  configuration(
    { provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] },
    () => revision,
  );
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  const preview = accountActions().getByRole('button', { name: /previsualizar/i });
  const apply = accountActions().getByRole('button', { name: /^aplicar$/i });
  await user.click(preview);
  expect(apply).toBeEnabled();
  expect(changes[0]?.expected_revision).toBe(4);

  revision = 5;
  // The modal keeps the page behind it inert, but a poll or another operator still moves the revision.
  await user.click(screen.getByRole('button', { name: /^Actualizar$/i, hidden: true }));
  await waitFor(() => { expect(apply).toBeDisabled(); });
  await user.click(apply);
  expect(changes).toHaveLength(1);

  await user.click(preview);
  await waitFor(() => { expect(changes).toHaveLength(2); });
  expect(changes[1]?.expected_revision).toBe(5);
  expect(apply).toBeEnabled();
});

it('ofrece el delete necesario para retiro o rotación con confirmación exacta y dry-run', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(screen.getByRole('button', { name: /retirar o rotar «codex-steven»/i }));
  expect(deleteActions().getByRole('button', { name: /previsualizar/i })).toBeDisabled();
  await user.type(screen.getByLabelText(/confirmar borrado de codex-steven/i), 'codex-steven');
  expect(deleteActions().getByRole('button', { name: /^aplicar$/i })).toBeDisabled();

  await user.click(deleteActions().getByRole('button', { name: /previsualizar/i }));
  expect(changes[0]).toEqual({
    dry_run: true,
    expected_revision: 4,
    mutation: { resource: 'provider_account', action: 'delete', id: 'codex-steven' },
  });
  await user.click(deleteActions().getByRole('button', { name: /^aplicar$/i }));
  expect(changes[1]?.mutation).toEqual({ resource: 'provider_account', action: 'delete', id: 'codex-steven' });
});

it('no deja borrar una cuenta mientras un techo la referencia', async () => {
  const changes: ChangeRequest[] = [];
  configuration({
    provider_accounts: [ownAccount],
    agents: [{ tenant_id: 'Steven', alias: 'kant' }],
    alias_routing_ceiling: [{
      tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven',
      account_payer_tenant: 'Steven', created_by_tenant: 'Steven',
    }],
    agent_account_bindings: [],
  });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(screen.getByRole('button', { name: /retirar o rotar «codex-steven»/i }));
  await user.type(screen.getByLabelText(/confirmar borrado de codex-steven/i), 'codex-steven');

  expect(screen.getByText(/primero revocá el techo.*Steven\/kant/i)).toBeInTheDocument();
  expect(deleteActions().getByRole('button', { name: /previsualizar/i })).toBeDisabled();
  expect(changes).toEqual([]);
});

it('ante 409 por revisión relee y obliga a validar otra vez la mutación del registro', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes, () => HttpResponse.json(
    { error: 'conflict', message: 'configuration revision changed: expected 4, current 9' },
    { status: 409 },
  ));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(screen.getByRole('button', { name: /deshabilitar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/conflicto de revisión/i);
  expect(alert).toHaveTextContent(/revisión 4 y el servidor ya va por la 9/i);
  expect(alert).toHaveTextContent(/releído del servidor/i);
  expect(accountActions().getByRole('button', { name: /^aplicar$/i })).toBeDisabled();
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

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /despublicar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/no se puede despublicar la cuenta «codex-steven» del pool/i);
  expect(alert).toHaveTextContent(/alias_routing_ceiling_borrow_requires_pool/);
  expect(alert).toHaveTextContent(/Miguel\/iza/);
  expect(alert).not.toHaveTextContent(/durable constraint/);
});
