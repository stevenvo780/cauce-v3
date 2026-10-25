import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { agentAction } from './agent-menu.test-helpers';

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

beforeEach(() => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })));
});

const fullAgent = {
  tenant_id: 'A', alias: 'one', display_name: 'Agente uno', harness_id: 'codex', enabled: true,
  max_concurrent_deliveries: 1, container_name: 'agent-one', runtime_user: 'runner',
  home_directory: '/home/runner', state_directory: '/var/lib/runner',
};
const snapshot: ConfigurationSnapshot = { revision: 4, agents: [fullAgent], memberships: [], rooms: [] };

interface ChangeBody { dry_run: boolean; expected_revision: number; mutation: Record<string, unknown> }

function receipt(body: ChangeBody, applied: boolean, revision: number, mutation = body.mutation) {
  return {
    applied, dry_run: !applied, revision, rolled_back_revision_id: null, summary: 'Registro validado',
    mutation, inverse_mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: true } },
  };
}

function renderSettings(initial = snapshot) {
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={initial} /></ConsoleAccessBoundary>);
}

function registryAccess() {
  return http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
  }));
}

it('previews the fixed row identity, invalidates a stale preview, applies its exact receipt and rereads', async () => {
  let current = snapshot;
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(current)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      if (!body.dry_run) {
        const value = body.mutation.value as Record<string, unknown>;
        current = {
          ...current, revision: 5,
          agents: [{ ...fullAgent, ...value }],
        };
      }
      return HttpResponse.json(receipt(body, !body.dry_run, body.dry_run ? 4 : 5), { status: body.dry_run ? 200 : 201 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  const capacity = screen.getByRole('spinbutton', { name: 'Mensajes a la vez' });
  await user.clear(capacity);
  await user.type(capacity, '2');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  const preview = await screen.findByLabelText('Preview del registro de agente');
  expect(preview).toHaveTextContent('"tenant_id": "A"');
  expect(preview).toHaveTextContent('"alias": "one"');
  expect(preview).toHaveTextContent('"max_concurrent_deliveries": 2');
  expect(preview).not.toHaveTextContent('"container_name"');
  const apply = screen.getByRole('button', { name: 'Aplicar cambio' });
  expect(apply).toBeEnabled();
  await user.clear(screen.getByRole('textbox', { name: 'Nombre visible' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Agente renovado');
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(apply).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  await user.click(apply);
  await screen.findByText(/Aplicado en revisión 5/);
  await waitFor(() => { expect(screen.getByRole('heading', { name: 'Agente renovado' })).toBeInTheDocument(); });
  expect(changes).toHaveLength(3);
  expect(changes.map(({ dry_run, expected_revision }) => [dry_run, expected_revision])).toEqual([
    [true, 4], [true, 4], [false, 4],
  ]);
  expect(changes[0]?.mutation).toMatchObject({ resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { max_concurrent_deliveries: 2 } });
  expect(changes[2]?.mutation).toMatchObject({ resource: 'agent', tenant_id: 'A', alias: 'one', value: { max_concurrent_deliveries: 2, display_name: 'Agente renovado' } });
});

it('routes runtime placement and harness changes through the operational assistant', async () => {
  server.use(registryAccess());
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  expect(screen.queryByRole('textbox', { name: 'Nombre del contenedor' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'ID del arnés' })).not.toBeInTheDocument();
  expect(screen.getByText(/La ubicación, el arnés y la cuenta principal se cambian en «Ejecución»/)).toBeInTheDocument();
});

it('sends an explicit null cap without operational fields', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      return HttpResponse.json(receipt(body, false, 4), { status: 200 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  await user.click(screen.getByRole('checkbox', { name: /Sin límite/ }));
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  expect(changes).toHaveLength(1);
  expect(changes[0]?.mutation).toMatchObject({
    resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one',
    value: {
      max_concurrent_deliveries: null,
    },
  });
});

it('reconciles a stale-revision conflict and does not retain its preview', async () => {
  let current = snapshot;
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(current)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      if (body.dry_run) return HttpResponse.json(receipt(body, false, body.expected_revision), { status: 200 });
      return HttpResponse.json({ error: 'conflict', message: 'revision changed: expected 4, current 5' }, { status: 409 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Recepción de mensajes' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  current = {
    ...snapshot, revision: 5,
    agents: [{ ...fullAgent, display_name: 'Cambio concurrente', max_concurrent_deliveries: 2,
      container_name: 'container-concurrente', runtime_user: 'runner-next', home_directory: '/home/next',
      state_directory: '/var/lib/next' }],
  };
  await user.click(screen.getByRole('button', { name: 'Aplicar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Conflicto de revisión/);
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aplicar cambio' })).toBeDisabled();
  const conflicto = await screen.findByRole('group', { name: 'Conflicto de versión' });
  expect(conflicto).toHaveTextContent('Cambio concurrente');
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Agente uno');
  expect(screen.getByRole('spinbutton', { name: 'Mensajes a la vez' })).toHaveValue(1);
  expect(screen.getByRole('combobox', { name: 'Recepción de mensajes' })).toHaveValue('false');
  expect(screen.queryByRole('textbox', { name: 'Nombre del contenedor' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Releer y reintentar con mis cambios' }));
  await screen.findByLabelText('Preview del registro de agente');
  expect(changes).toHaveLength(3);
  expect(changes[2]).toMatchObject({ expected_revision: 5, dry_run: true,
    mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: false } } });
  expect(changes[2]?.mutation).not.toHaveProperty('value.display_name');
  expect(changes[2]?.mutation).not.toHaveProperty('value.max_concurrent_deliveries');
  expect(changes[2]?.mutation).not.toHaveProperty('value.container_name');
});

it('does not enable apply when the server preview omits the exact receipt', async () => {
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json({
      applied: false, dry_run: true, revision: 4, summary: 'preview without receipt',
      mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: false } },
      inverse_mutation: null,
    }, { status: 200 })),
  );
  const user = userEvent.setup();
  renderSettings();
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Recepción de mensajes' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/recibo exacto/);
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aplicar cambio' })).toBeDisabled();
});

it('deletes an unmanaged registry row only after its exact preview and keeps the durable reread notice', async () => {
  let current = snapshot; const changes: ChangeBody[] = [];
  server.use(registryAccess(), http.get('http://localhost/v3/console/config', () => HttpResponse.json(current)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody; changes.push(body);
      if (!body.dry_run) current = { ...snapshot, revision: 5, agents: [] };
      return HttpResponse.json({ ...receipt(body, !body.dry_run, body.dry_run ? 4 : 5),
        inverse_mutation: { resource: 'agent', action: 'create', tenant_id: 'A', alias: 'one', value: { display_name: 'Agente uno', enabled: false } },
      }, { status: body.dry_run ? 200 : 201 });
    }));
  const user = userEvent.setup(); renderSettings(); await agentAction(user, 'A/one', 'Cambiar ajustes');
  await user.click(screen.getByRole('button', { name: 'Eliminar registro' }));
  const apply = screen.getByRole('button', { name: 'Confirmar eliminación del registro' }); expect(apply).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar eliminación' }));
  await waitFor(() => { expect(apply).toBeEnabled(); }); await user.click(apply);
  expect(await screen.findByRole('status')).toHaveTextContent('Registro de A/one eliminado del inventario en revisión 5');
  expect(screen.queryByRole('button', { name: 'Acciones de A/one' })).not.toBeInTheDocument();
  expect(changes).toEqual([
    { expected_revision: 4, dry_run: true, mutation: { resource: 'agent', action: 'delete', tenant_id: 'A', alias: 'one' } },
    { expected_revision: 4, dry_run: false, mutation: { resource: 'agent', action: 'delete', tenant_id: 'A', alias: 'one' } },
  ]);
});

const host = { host_id: 'torre', display_name: 'Torre', notes: '', enabled: true, status: 'reachable',
  status_source: 'controller', last_seen_at: null, registered: true, approved: true, version: 1, agents: [] };

it('lets a runtime agent without a host receive one and sends host_id', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({
      hosts: [host, { ...host, host_id: 'apagada', display_name: 'Apagada', status: 'unreachable' }],
    })),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      return HttpResponse.json(receipt(body, false, 4), { status: 200 });
    }),
  );
  const user = userEvent.setup();
  renderSettings({ ...snapshot, agents: [{ ...fullAgent, runtime_key: 'runtime-one', host_id: null }] });
  await agentAction(user, 'A/one', 'Cambiar ajustes');
  const select = await screen.findByRole('combobox', { name: /Computadora/ });
  expect(screen.queryByRole('option', { name: 'Sin computadora' })).not.toBeInTheDocument();
  expect(screen.getByText(/Asigna la computadora donde ya corre este agente/)).toBeInTheDocument();
  await waitFor(() => { expect(screen.getByRole('option', { name: 'Torre' })).toBeInTheDocument(); });
  expect(screen.getByRole('option', { name: /Apagada/ })).toBeDisabled();
  await user.selectOptions(select, 'torre');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  expect(changes[0]?.mutation).toMatchObject({
    resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { host_id: 'torre' },
  });
});
