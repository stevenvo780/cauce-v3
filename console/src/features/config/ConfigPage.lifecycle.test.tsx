import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { agentAction, openPrepareAgent } from './agent-menu.test-helpers';
import { ConfigPage } from './ConfigPage';

const snapshot = { revision: 4, role_policies: [{ role: 'agent' }], tenants: [{ id: 'A' }], rooms: [{ tenant_id: 'A', id: 'grp.a' }],
  agents: [{ tenant_id: 'A', alias: 'active', runtime_key: 'active', enabled: true }], memberships: [],
  harness_definitions: [{ id: 'codex' }], retired: { tenants: [], rooms: [], memberships: [],
    agents: [{ tenant_id: 'A', alias: 'retired', runtime_key: 'retired', enabled: false }] } };
const capability = { available: true, actions: ['create', 'update', 'stop', 'retire', 'restore', 'purge'],
  placements: [{ host_id: 'test-host', modes: ['container'], runtime_users: ['runner'], systemd_users: [],
    home_roots: ['/home/runner'], state_roots: ['/state'] }] };

function serve(previews: FleetOperationRequest[], accepted: FleetOperationRequest[]) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(snapshot)),
    http.get('*/v3/console/access', () => HttpResponse.json({ subject: 'A:operator', roles: ['operator'],
      permissions: ['config.read', 'config.write'] })),
    http.get('*/v3/console/fleet/capability', () => HttpResponse.json(capability)),
    http.get('*/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('*/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest; previews.push(input);
      return HttpResponse.json({ request_sha256: await fleetRequestHash(input), kind: input.kind,
        target: input.target, expected_revision: input.expected_revision, steps: ['prepare', 'verify'],
        dependencies: [], can_apply: true });
    }),
    http.post('*/v3/console/fleet/operations', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest; accepted.push(input);
      const id = '11111111-1111-4111-8111-111111111111';
      return HttpResponse.json({ operation_id: id, status: 'queued', operation: {
        id, request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
        status: 'queued', version: 0, actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4,
        desired_revision: 5, applied_revision: null, steps: [{ name: 'prepare', status: 'pending' }],
        error: null, created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z',
      } }, { status: 202 });
    }));
}

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

it('prepara un contenedor desde la sección visible y acredita sólo el encolado exacto', async () => {
  const previews: FleetOperationRequest[] = [], accepted: FleetOperationRequest[] = [];
  serve(previews, accepted);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await openPrepareAgent(user);
  const form = within(screen.getByRole('region', { name: 'Alta operativa de agente' }));
  await waitFor(() => { expect(form.getByRole('combobox', { name: 'Host operativo' })).toHaveTextContent('test-host'); });
  await user.selectOptions(form.getByRole('combobox', { name: 'Espacio de trabajo operativo' }), 'A');
  await user.type(form.getByRole('textbox', { name: 'Alias operativo' }), 'new-worker');
  await user.type(form.getByRole('textbox', { name: 'Clave física de ejecución' }), 'new-worker');
  await user.selectOptions(form.getByRole('combobox', { name: 'Arnés operativo' }), 'codex');
  await user.click(form.getByRole('checkbox', { name: 'Incluir grp.a · "grp.a"' }));
  expect(form.getByRole('combobox', { name: 'Rol en "grp.a"' })).toHaveValue('agent');
  await user.selectOptions(form.getByRole('combobox', { name: 'Grupo primario' }), 'grp.a');
  await user.selectOptions(form.getByRole('combobox', { name: 'Host operativo' }), 'test-host');
  await user.selectOptions(form.getByRole('combobox', { name: 'Modo de ejecución' }), 'container');
  await user.type(form.getByRole('textbox', { name: 'Contenedor operativo' }), 'new-worker');
  await user.selectOptions(form.getByRole('combobox', { name: 'Usuario operativo' }), 'runner');
  await user.type(form.getByRole('textbox', { name: 'Directorio personal operativo' }), '/home/runner');
  await user.type(form.getByRole('textbox', { name: 'Directorio de estado operativo' }), '/state/new-worker');
  expect(form.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.click(form.getByRole('button', { name: 'Previsualizar operación' }));
  await form.findByLabelText('Previsualización operativa');
  await user.click(form.getByRole('button', { name: 'Encolar operación' }));
  expect(await form.findByLabelText('Operación de flota')).toHaveTextContent('En cola');
  expect(accepted).toEqual(previews);
  expect(accepted[0]).toMatchObject({ kind: 'create', target: { tenant_id: 'A', alias: 'new-worker' },
    parameters: { placement: { mode: 'container', container_name: 'new-worker' } } });
});

it.each([['active', 'stop'], ['retired', 'purge']])('ofrece %s por su identidad exacta al operar %s', async (alias, kind) => {
  const previews: FleetOperationRequest[] = [];
  serve(previews, []);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  if (alias === 'active') await agentAction(user, `A/${alias}`, 'Operar agente');
  else await user.click(await screen.findByRole('button', { name: `Operar agente A/${alias}` }));
  const form = within(screen.getByRole('region', { name: `Operación de A/${alias}` }));
  await user.selectOptions(form.getByRole('combobox', { name: 'Acción operativa' }), kind);
  await waitFor(() => { expect(form.getByRole('button', { name: 'Previsualizar operación' })).toBeEnabled(); });
  await user.click(form.getByRole('button', { name: 'Previsualizar operación' }));
  await form.findByLabelText('Previsualización operativa');
  expect(previews[0]).toMatchObject({ kind, target: { resource: 'agent', tenant_id: 'A', alias } });
});

it('expone administración de personas al entrar en Acceso y roles', async () => {
  serve([], []);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('tab', { name: 'Acceso y roles' }));
  expect(screen.getByRole('heading', { name: 'Personas' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Administrar personas' })).toBeEnabled();
});
