import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AssignmentMatrixPage } from './AssignmentMatrixPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

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
      revision: input.dry_run ? 4 : 5, mutation: input.mutation, summary: 'mock registry validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

it('muestra el techo por alias y el orden de fallback derivado de los bindings habilitados', async () => {
  configuration();
  renderWithApi(<AssignmentMatrixPage />);

  expect(await screen.findByRole('heading', { level: 1, name: /matriz agente × cuenta/i })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Steven\/kant × codex-steven: #1 · prio 10/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i })).toBeInTheDocument();

  const fallback = within(screen.getByRole('list', { name: /orden de fallback por agente/i }));
  expect(fallback.getByText(/1\. codex-steven \(prio 10\)/)).toBeInTheDocument();
  expect(fallback.getByText(/sin binding habilitado: minimax-pablo/i)).toBeInTheDocument();
});

it('dice que el intento 1 no pasa por el pool, porque el main del harness no es una fila de estas tablas', async () => {
  configuration();
  renderWithApi(<AssignmentMatrixPage />);

  expect(await screen.findByText(/sin ningún override de entorno/i)).toBeInTheDocument();
  expect(screen.getByText(/reintentos/i)).toBeInTheDocument();
});

it('marca la cuenta ajena como prestada usando el pagador que informa el servidor', async () => {
  configuration();
  renderWithApi(<AssignmentMatrixPage />);

  expect(await screen.findAllByText('prestada')).not.toHaveLength(0);
});

it('declara no disponible cada sección que el gateway no publica', async () => {
  configuration({ alias_routing_ceiling: undefined, agent_account_bindings: undefined });
  renderWithApi(<AssignmentMatrixPage />);

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
  renderWithApi(<AssignmentMatrixPage />);

  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: sin techo/i }));
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]).toEqual({
    dry_run: true,
    expected_revision: 4,
    mutation: { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo' },
  });

  await user.click(screen.getByRole('button', { name: /^aplicar$/i }));
  expect(await screen.findByText(/aplicado en revisión 5/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
});

it('ordena el fallback con una mutación de binding que lleva prioridad y estado', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AssignmentMatrixPage />);

  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '20');
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

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
  renderWithApi(<AssignmentMatrixPage />);

  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  // `Number('')` es 0 y 0 pasaba `Number.isInteger(n) && n >= 0`: vaciar el campo armaba
  // silenciosamente la prioridad más alta en vez de pedir un valor.
  await user.clear(screen.getByLabelText(/prioridad/i));

  expect(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i })).toBeDisabled();
  expect(screen.getByText(/la prioridad debe ser un entero entre 0 y 32767/i)).toBeInTheDocument();
  expect(changes).toHaveLength(0);
});

it('tampoco acepta una prioridad de puros espacios', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AssignmentMatrixPage />);

  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '   ');

  expect(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i })).toBeDisabled();
  expect(changes).toHaveLength(0);
});

it('sigue aceptando la prioridad 0 cuando el operador la escribe de verdad', async () => {
  const changes: ChangeRequest[] = [];
  configuration();
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<AssignmentMatrixPage />);

  await user.click(await screen.findByRole('button', { name: /Steven\/kant × minimax-pablo: binding off · prio 50/i }));
  await user.clear(screen.getByLabelText(/prioridad/i));
  await user.type(screen.getByLabelText(/prioridad/i), '0');
  await user.click(screen.getByRole('button', { name: /previsualizar \(dry-run\)/i }));

  expect(changes[0]?.mutation).toEqual({
    resource: 'agent_account_binding', action: 'update', tenant_id: 'Steven',
    agent_alias: 'kant', account_id: 'minimax-pablo', value: { priority: 0, enabled: true },
  });
});

it('avisa que revocar el techo cascadea el binding', async () => {
  configuration();
  const user = userEvent.setup();
  renderWithApi(<AssignmentMatrixPage />);

  await user.selectOptions(await screen.findByLabelText(/operación/i), 'revoke-ceiling');
  expect(screen.getByText(/borra en cascada el binding/i)).toBeInTheDocument();
});
