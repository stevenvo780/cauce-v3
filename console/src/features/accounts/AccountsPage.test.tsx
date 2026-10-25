import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigMutationSchema, configurationMutationSha256, publicConfigurationMutation } from '@cauce/protocol/configuration';
import { AccountsPage } from './AccountsPage';
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
  expect(inventory.getByRole('link', { name: /registrar en mis cuotas/i })).toHaveAttribute('href', '/my-quotas');

  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
  const cell = await screen.findByRole('button', { name: /Steven\/kant × codex-steven/i });
  expect(cell).toBeDisabled();
  expect(screen.getByRole('button', { name: /nueva asignación/i })).toBeDisabled();
  expect(posts).toBe(0);
});

/** Account editing and assignment bars share button texts. */
function accountActions() {
  return within(screen.getByRole('group', { name: /acciones de edición de cuenta/i }));
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

it('no habilita ni acredita escrituras del registro con recibos 2xx truncados', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes, async (input) => input.dry_run
    ? HttpResponse.json(await changeReceipt(input))
    : HttpResponse.json({ applied: true, dry_run: false, revision: 5 }, { status: 201 }));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory();
  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));
  await user.click(accountActions().getByRole('button', { name: /^aplicar$/i }));

  expect(await screen.findByText(/la escritura puede haberse aplicado/i)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/releído del servidor.*revisión 4/i);
  expect(screen.queryByText(/aplicado en revisión 5/i)).not.toBeInTheDocument();
}, 20_000);

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
  expect(screen.getByRole('link', { name: 'Eliminar en Mis cuotas' })).toHaveAttribute('href', '/my-quotas');
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

  expect(screen.getByText(/primero quita el acceso.*Steven\/kant/i)).toBeInTheDocument();
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
