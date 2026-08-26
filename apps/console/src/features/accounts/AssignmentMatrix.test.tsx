import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AccountsPage } from './AccountsPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/*
 * La matriz dejó de ser la ruta `/assignments` el 2026-08-06: es la segunda mitad de "Cuentas de
 * IA". Estos tests montan **AccountsPage**, no la matriz suelta, justamente para que fallen si
 * alguien vuelve a partir la vista en dos: si la matriz saliera de esta pantalla, ninguna de estas
 * aserciones encontraría su botón.
 */

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

const accounts = [
  { id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex', shared_with_pool: true, enabled: true, external_account_id: 'org-9f21', credential_ref_kind: 'env_path' },
  { id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax', shared_with_pool: true, enabled: true, external_account_id: null, credential_ref_kind: null },
];

function configuration(overrides: Record<string, unknown> = {}) {
  server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
    revision: 4, observed_at: new Date().toISOString(), tenants: [{ id: 'Steven' }, { id: 'Pablo' }],
    rooms: [], memberships: [], acl_edges: [], harness_definitions: [], role_policies: [], revisions: [],
    agents: [{ tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true }],
    provider_accounts: accounts,
    alias_routing_ceiling: [
      { tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' },
      { tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo', account_payer_tenant: 'Pablo', created_by_tenant: 'Steven' },
    ],
    agent_account_bindings: [
      { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven', priority: 10, enabled: true },
      { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'minimax-pablo', priority: 50, enabled: false },
    ],
    ...overrides,
  })));
}

function recordChanges(sink: ChangeRequest[]) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 4 : 5, mutation: input.mutation,
      inverse_mutation: input.mutation, rolled_back_revision_id: null,
      summary: 'mock registry validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

/**
 * Las dos barras de escritura de la vista tienen botones con el mismo texto. Se distinguen por el
 * `role="group"` que las nombra: sin eso, `getByRole('button', { name: /previsualizar/i })`
 * encontraría dos, y previsualizar el formulario equivocado manda una mutación que nadie pidió.
 */
function assignmentActions() {
  return within(screen.getByRole('group', { name: /acciones de asignación/i }));
}

/**
 * Desde el 2026-08-22 la matriz es la pestaña «Asignaciones» de «Cuentas y cuotas». El panel
 * inactivo se monta pero va con `hidden`, así que sale del árbol de accesibilidad y `getByRole` NO
 * lo encuentra: la prueba tiene que abrir la pestaña igual que el operador. Eso es a propósito —
 * una prueba que encontrara la matriz sin abrirla estaría verde con la pestaña rota.
 */
async function openMatrix(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
}

it('la matriz vive DENTRO de «Cuentas y cuotas», sin segunda ruta y sin segundo h1', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  const headings = await screen.findAllByRole('heading', { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent(/cuentas y cuotas/i);

  // Las tres mitades, en la misma pantalla y a un clic: consumo, inventario y techo por alias.
  await user.click(screen.getByRole('tab', { name: 'Inventario' }));
  expect(screen.getByRole('heading', { name: /inventario de cuentas/i })).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
  expect(screen.getByRole('heading', { name: /techo por alias/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /ruteo: qué cuenta puede usar cada agente/i })).toBeInTheDocument();
});

it('muestra el techo por alias y el orden de fallback derivado de los bindings habilitados', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  expect(await screen.findByRole('button', { name: /Steven\/kant × codex-steven: #1 · prio 10/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i })).toBeInTheDocument();

  const fallback = within(screen.getByRole('list', { name: /orden de fallback por agente/i }));
  expect(fallback.getByText(/1\. codex-steven \(prio 10\)/)).toBeInTheDocument();
  expect(fallback.getByText(/sin binding habilitado: minimax-pablo/i)).toBeInTheDocument();
});

it('dice que el intento 1 no pasa por el pool, porque el main del harness no es una fila de estas tablas', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  expect(await screen.findByText(/sin ningún override de entorno/i)).toBeInTheDocument();
  expect(screen.getByText(/reintentos/i)).toBeInTheDocument();
});

it('marca la cuenta ajena como prestada usando el pagador que informa el servidor', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.click(await screen.findByRole('tab', { name: 'Inventario' }));
  expect(await screen.findAllByText('prestada')).not.toHaveLength(0);
});

it('declara no disponible cada sección que el gateway no publica', async () => {
  configuration({ alias_routing_ceiling: undefined, agent_account_bindings: undefined });
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/no disponible/i);
  expect(alert).toHaveTextContent('alias_routing_ceiling');
  expect(alert).toHaveTextContent('agent_account_bindings');
});

it('otorga un techo con dry-run previo y una sola mutación de alias_routing_ceiling', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: sin techo/i }));
  await user.click(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]).toEqual({
    dry_run: true,
    expected_revision: 4,
    mutation: { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo' },
  });

  await user.click(assignmentActions().getByRole('button', { name: /^aplicar$/i }));
  expect(await screen.findByText(/aplicado en revisión 5/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
});

it('el dry-run de una mitad no habilita el apply de la otra: cada formulario tiene su propio runner', async () => {
  const changes: ChangeRequest[] = [];
  configuration({ alias_routing_ceiling: [], agent_account_bindings: [] });
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  // Se deja el alta de cuenta lista para enviarse, pero se previsualiza la ASIGNACIÓN.
  // Y de paso queda fijado que cambiar de pestaña NO tira lo escrito en el otro formulario: los
  // paneles se montan siempre y el inactivo va con `hidden`. Si alguien los volviera a montar
  // condicionalmente, el `expect` del final vería un dry-run de alta vacío.
  await user.click(await screen.findByRole('tab', { name: 'Inventario' }));
  await user.type(await screen.findByLabelText(/id externo de la suscripción/i), 'org-9f21');
  await user.type(screen.getByLabelText(/tenant pagador/i), 'Steven');
  await user.click(screen.getByRole('tab', { name: 'Asignaciones' }));
  await user.click(screen.getByRole('button', { name: /Steven\/kant × minimax-pablo: sin techo/i }));
  await user.click(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes).toHaveLength(1);
  expect(changes[0]?.mutation).toMatchObject({ resource: 'alias_routing_ceiling' });

  await user.click(screen.getByRole('tab', { name: 'Inventario' }));
  const accountActions = within(screen.getByRole('group', { name: /acciones de alta de cuenta/i }));
  expect(accountActions.getByRole('button', { name: /^aplicar$/i })).toBeDisabled();
  // Y lo escrito antes de irse a la otra pestaña sigue ahí: el panel se ocultó, no se desmontó.
  expect(screen.getByLabelText(/id externo de la suscripción/i)).toHaveValue('org-9f21');
});

it('ordena el fallback con una mutación de binding que lleva prioridad y estado', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '20');
  await user.click(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'agent_account_binding', action: 'update', tenant_id: 'Steven',
    agent_alias: 'kant', account_id: 'minimax-pablo', value: { priority: 20, enabled: true },
  });
});

it('no convierte una prioridad vacía en 0, que es la más alta', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  // `Number('')` es 0 y 0 pasaba `Number.isInteger(n) && n >= 0`: vaciar el campo armaba
  // silenciosamente la prioridad más alta en vez de pedir un valor.
  await user.clear(screen.getByLabelText(/prioridad/i));

  expect(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i })).toBeDisabled();
  expect(screen.getByText(/la prioridad debe ser un entero entre 0 y 32767/i)).toBeInTheDocument();
  expect(changes).toHaveLength(0);
});

it('tampoco acepta una prioridad de puros espacios', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '   ');

  expect(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i })).toBeDisabled();
  expect(changes).toHaveLength(0);
});

it('sigue aceptando la prioridad 0 cuando el operador la escribe de verdad', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '0');
  await user.click(assignmentActions().getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'agent_account_binding', action: 'update', tenant_id: 'Steven',
    agent_alias: 'kant', account_id: 'minimax-pablo', value: { priority: 0, enabled: true },
  });
});

it('avisa que revocar el techo cascadea el binding', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await user.selectOptions(await screen.findByLabelText(/operación/i), 'revoke-ceiling');
  expect(screen.getByText(/borra en cascada el binding/i)).toBeInTheDocument();
});

it('lee el snapshot UNA sola vez para las dos mitades', async () => {
  let configReads = 0;
  server.use(http.get('http://localhost/v3/console/config', () => {
    configReads += 1;
    return HttpResponse.json({
      revision: 4, observed_at: new Date().toISOString(), tenants: [{ id: 'Steven' }],
      rooms: [], memberships: [], acl_edges: [], harness_definitions: [], role_policies: [], revisions: [],
      agents: [{ tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true }],
      provider_accounts: accounts, alias_routing_ceiling: [], agent_account_bindings: [],
    });
  }));
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await openMatrix(user);
  await screen.findByRole('heading', { name: /techo por alias/i });
  // Antes de la fusión eran dos rutas con su propio `useResource`, que no comparte caché: montar
  // las dos mitades pedía `/v3/console/config` dos veces. Ahora la matriz lo recibe por props.
  expect(configReads).toBe(1);
});
