import { act, screen, waitFor, within } from '@testing-library/react';
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
 * El alta de cuenta y la asignación tienen barras de escritura con botones del mismo texto desde
 * que las dos mitades comparten pantalla. Este helper acota al formulario de cuenta.
 */
function accountActions() {
  return within(screen.getByRole('group', { name: /acciones de (alta|edición) de cuenta/i }));
}

/**
 * Abre explícitamente la pestaña de Inventario en Cuentas y cuotas.
 */
async function openInventory(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.click(screen.getByRole('tab', { name: 'Inventario' }));
  return within(document.getElementById('view-panel-inventario') as HTMLElement);
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

  // La vista correcta se elige en el match, no después de un rebote: la matriz está en pantalla.
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe('/accounts'));
});

it('lista el inventario con pagador, publicación al pool y estado', async () => {
  configuration({ provider_accounts: [ownAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const row = (await inventario.findByText('codex-steven')).closest('tr');
  expect(row).not.toBeNull();
  expect(within(row!).getByText('Steven')).toBeInTheDocument();
  expect(within(row!).getByText('PUBLICADA')).toBeInTheDocument();
  expect(within(row!).getByText('HABILITADA')).toBeInTheDocument();
  expect(within(row!).getByText('org-9f21')).toBeInTheDocument();
  expect(within(row!).getByText('env_path')).toBeInTheDocument();
});

it('dice que los campos del pagador no son visibles en vez de mostrarlos vacíos', async () => {
  configuration({ provider_accounts: [borrowedAccount], agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const inventario = await openInventory(user);
  const row = (await inventario.findByText('minimax-pablo')).closest('tr');
  expect(within(row!).getAllByText(/no visible: la paga pablo/i)).toHaveLength(2);
  expect(within(row!).queryByText('UNKNOWN')).not.toBeInTheDocument();
});

it('declara no disponible el inventario cuando el gateway no publica provider_accounts', async () => {
  configuration({ agents: [], alias_routing_ceiling: [], agent_account_bindings: [] });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  // Las DOS mitades lo declaran por separado, cada una con lo que a ella le falta: el inventario no
  // se puede listar, la matriz no se puede formar. Fundir las vistas no fundió los avisos, porque
  // no son el mismo hecho — y ahora que son pestañas de la misma página, sigue sin serlo.
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

  // El apply no existe como camino paralelo: está deshabilitado hasta que el servidor validó
  // exactamente esta mutación en dry-run.
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
 * El punto que decidió la fusión (b), y la objeción que estaba escrita en `App.tsx`: «Cuotas y
 * licencias» es de LECTURA y depende del recolector externo; «Cuentas de IA» ESCRIBE el registro y
 * tiene que funcionar aunque el recolector esté caído. La conclusión que se sacaba de ahí —que por
 * eso tenían que ser dos vistas— era falsa: se resuelve degradando por RECURSO.
 *
 * Las dos pruebas van en pareja a propósito. La segunda es el control negativo de la primera: sin
 * ella, una versión que pintara un `0%` inventado con el recolector muerto pasaría igual.
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

  // La vista NO se cae entera: una fuente muerta no apaga la otra.
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
  const fila = (await inventario.findByText('codex-steven')).closest('tr')!;
  // Plan y Consumo: los dos en interrogante. Un `0%` acá se leería como «esta cuenta está agotada»,
  // que es una afirmación sobre un dato que no llegó.
  expect(within(fila).getAllByText('?').length).toBeGreaterThanOrEqual(2);
  expect(fila.textContent ?? '').not.toMatch(/\d+%/);
  expect(fila.textContent ?? '').not.toMatch(/libre/);
});

it('con el recolector VIVO la misma columna sí trae el número: el «?» no es un cartel fijo', async () => {
  // El otro brazo del control: si la celda dijera «?» siempre, la prueba de arriba pasaría sin
  // demostrar nada. Acá el mismo componente, con muestra, tiene que dar el porcentaje.
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
  const fila = (await inventario.findByText('codex-steven')).closest('tr')!;
  expect(within(fila).getByText('pro')).toBeInTheDocument();
  expect(within(fila).getByText('42% libre')).toBeInTheDocument();
});
