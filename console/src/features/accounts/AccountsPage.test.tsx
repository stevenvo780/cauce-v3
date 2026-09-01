import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
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

function recordChanges(sink: ChangeRequest[], response?: (input: ChangeRequest) => Response) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    if (response) return response(input);
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 4 : 5, mutation: input.mutation,
      inverse_mutation: input.mutation, rolled_back_revision_id: null,
      summary: 'mock registry validation',
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

/**
 * Account creation and assignment have write bars with buttons of the same text since the two
 * halves share screen. This helper scopes to the account form.
 */
function accountActions() {
  return within(screen.getByRole('group', { name: /acciones de (alta|edición) de cuenta/i }));
}

function deleteActions() {
  return within(screen.getByRole('group', { name: /acciones de retiro o rotación de cuenta/i }));
}

/**
 * Explicitly opens the Inventory tab in Cuentas y cuotas.
 */
async function openInventory(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.click(screen.getByRole('tab', { name: 'Inventario' }));
  const el = document.getElementById('view-panel-inventario');
  expect(el).not.toBeNull();
  return within(el ?? document.body);
}

it('queda enrutada en /accounts sin desplazar a las pantallas existentes', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i })).toBeInTheDocument();

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
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/accounts'); });
});

it('lista el inventario con pagador, publicación al pool y estado', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const cell = await inventario.findByText('codex-steven');
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  if (row) {
    expect(within(row).getByText('Steven')).toBeInTheDocument();
    expect(within(row).getByText('PUBLICADA')).toBeInTheDocument();
    expect(within(row).getByText('HABILITADA')).toBeInTheDocument();
    expect(within(row).getByText('org-9f21')).toBeInTheDocument();
    expect(within(row).getByText('env_path')).toBeInTheDocument();
  }
});

it('dice que los campos del pagador no son visibles en vez de mostrarlos vacíos', async () => {
  configuration({ provider_accounts: [borrowedAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const cell = await inventario.findByText('minimax-pablo');
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  if (row) {
    expect(within(row).getAllByText(/no visible: la paga pablo/i)).toHaveLength(2);
    expect(within(row).queryByText('UNKNOWN')).not.toBeInTheDocument();
  }
});

it('declara no disponible el inventario cuando el gateway no publica provider_accounts', async () => {
  configuration({ agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  // Both halves declare it separately, each with what is missing for them: inventory cannot be
  // listed, the matrix cannot be formed. Merging the views did not merge the warnings, because
  // they are not the same fact — and now that they are tabs of the same page, it still isn't.
  const inventario = await openInventory(user);
  expect(await inventario.findByText(/no se muestra inventario porque no hay dato que mostrar/i)).toBeInTheDocument();
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

  await openInventory(user);
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
  recordChanges(changes, (input) => input.dry_run
    ? HttpResponse.json({
      applied: false, dry_run: true, revision: 4, summary: 'preview exacto',
      mutation: input.mutation, inverse_mutation: input.mutation,
      rolled_back_revision_id: null,
    })
    : HttpResponse.json({ applied: true, dry_run: false, revision: 5 }, { status: 201 }));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openInventory(user);
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

  await openInventory(user);
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

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

  await openInventory(user);
  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'provider_account', action: 'update', id: 'codex-steven',
    value: { label: 'Codex del hub', shared_with_pool: true, enabled: false },
  });
  expect(screen.getByRole('button', { name: /retirar o rotar/i })).toBeInTheDocument();
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

  await openInventory(user);
  await user.click(await screen.findByRole('button', { name: /deshabilitar/i }));
  const preview = accountActions().getByRole('button', { name: /previsualizar/i });
  const apply = accountActions().getByRole('button', { name: /^aplicar$/i });
  await user.click(preview);
  expect(apply).toBeEnabled();
  expect(changes[0]?.expected_revision).toBe(4);

  revision = 5;
  await user.click(screen.getByRole('button', { name: /^Actualizar$/i }));
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

  await openInventory(user);
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

  await openInventory(user);
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

  await openInventory(user);
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

  await openInventory(user);
  await user.click(await screen.findByRole('button', { name: /despublicar/i }));
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/no se puede despublicar la cuenta «codex-steven» del pool/i);
  expect(alert).toHaveTextContent(/alias_routing_ceiling_borrow_requires_pool/);
  expect(alert).toHaveTextContent(/Miguel\/iza/);
  expect(alert).not.toHaveTextContent(/durable constraint/);
});

/**
 * The point that decided fusion (b), and the objection that was written in `App.tsx`: "Cuotas y
 * licencias" is for READING and depends on the external collector; "Cuentas de IA" WRITES to the
 * registry and must work even with the collector down. The conclusion that was drawn from that —
 * that they had to be two views — was false: it is solved by degrading per RESOURCE.
 *
 * The two tests come as a pair on purpose. The second is the negative control of the first:
 * without it, a version that painted an invented `0%` with a dead collector would pass anyway.
 */
it('con el recolector CAÍDO el registro se sigue escribiendo: alta con dry-run y apply', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ provider_accounts: [], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json(
    { error: 'boom', message: 'el recolector no publicó nunca' }, { status: 500 },
  )));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  // The view does NOT collapse entirely: a dead source does not turn off the other.
  await openInventory(user);
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(accountActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));
  expect(changes[0]?.dry_run).toBe(true);

  await user.click(accountActions().getByRole('button', { name: /^aplicar$/i }));
  expect(await screen.findByText(/aplicado en revisión 5/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
});

it('🔴 CONTROL NEGATIVO: con el recolector caído el saldo dice «?», nunca un número', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json(
    { error: 'boom', message: 'el recolector no publicó nunca' }, { status: 500 },
  )));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const cell = await inventario.findByText('codex-steven');
  const fila = cell.closest('tr');
  expect(fila).not.toBeNull();
  if (fila) {
    // Consumo declares there is no sample. A `0%` here would read as "this account is exhausted",
    // which is a statement about a datum that never arrived.
    expect(within(fila).getByLabelText('sin muestra')).toBeInTheDocument();
    expect(fila.textContent).not.toMatch(/\d+%/);
    expect(fila.textContent).not.toMatch(/libre/);
  }
});

it('la sonda caída sí grita en ámbar: el gris es sólo para la cuenta que el recolector no mira', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({
    observed_at: '2026-08-22T10:00:00.000Z',
    thresholds: { stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10 },
    collectors: [{ host: 'kratos', received_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, stale: false }],
    providers: [{
      host: 'kratos', provider: 'codex', ok: false, available: false, plan: 'pro',
      note: 'el CLI no respondió', observed_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, severity: 'ok',
      groups: [{ group_key: 'codex', account_id: 'codex-steven', min_remaining_percent: null, severity: null, windows: [] }],
    }],
    unbound_groups: [], paused_accounts: [],
  })));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const fila = (await inventario.findByText('codex-steven')).closest('tr');
  expect(fila).not.toBeNull();
  if (fila) {
    const interrogante = within(fila).getByText('?');
    expect(interrogante).toHaveClass('unknown');
    expect(interrogante.getAttribute('title')).toMatch(/sonda caída/i);
    expect(within(fila).queryByLabelText('sin muestra')).not.toBeInTheDocument();
  }
});

it('con el recolector VIVO la misma columna sí trae el número: el «?» no es un cartel fijo', async () => {
  // The other arm of the control: if the cell always said "?", the test above would pass without
  // proving anything. Here the same component, with a sample, has to give the percentage.
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({
    observed_at: '2026-08-22T10:00:00.000Z',
    thresholds: { stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10 },
    collectors: [{ host: 'kratos', received_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, stale: false }],
    providers: [{
      host: 'kratos', provider: 'codex', ok: true, available: true, plan: 'pro',
      observed_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, severity: 'ok',
      groups: [{
        group_key: 'codex', account_id: 'codex-steven', min_remaining_percent: 42, severity: 'ok',
        windows: [{ window_key: 'semana', label: 'semana', used_percent: 58, remaining_percent: 42, reset_at: '2026-08-29T10:00:00.000Z', reset_in_seconds: 600_000, severity: 'ok' }],
      }],
    }],
    unbound_groups: [], paused_accounts: [],
  })));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const cell = await inventario.findByText('codex-steven');
  const fila = cell.closest('tr');
  expect(fila).not.toBeNull();
  if (fila) {
    expect(within(fila).getByText(/plan pro/)).toBeInTheDocument();
    expect(within(fila).getByText('42% libre')).toBeInTheDocument();
  }
});
