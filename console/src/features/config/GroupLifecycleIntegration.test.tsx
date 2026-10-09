import { webcrypto } from 'node:crypto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ConfigPage } from './ConfigPage';
import { servirConfig, snapshotDeConfig, type ChangeRequest } from './ConfigPage.test-helpers';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
it('opens a physical group retirement from the existing table and never sends generic delete', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(4), agents: [{ tenant_id: 'Miguel', alias: 'janus', runtime_key: 'janus', primary_room_id: 'grp.miguel' }],
    capabilities: { actor: { tenant_id: 'Miguel', alias: 'janus', is_hub: true, can_control: true },
      resources: [{ resource: 'room', actions: ['update', 'delete', 'retire'], scope: 'hub' }] } }));
  const submitted: FleetOperationRequest[] = [];
  server.use(http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['retire'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest; submitted.push(input);
      return HttpResponse.json({ request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
        expected_revision: input.expected_revision, steps: ['fence', 'stop'], dependencies: [], can_apply: true });
    }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retirar sala/grupo Miguel/grp.miguel' }));
  const dialog = within(await screen.findByRole('dialog'));
  await user.click(await dialog.findByRole('button', { name: 'Previsualizar retiro' }));
  await dialog.findByLabelText('Previsualización operativa');
  expect(submitted[0]).toMatchObject({ kind: 'retire', target: { resource: 'room', tenant_id: 'Miguel', room_id: 'grp.miguel' } });
  expect(submitted[0]?.target).not.toHaveProperty('alias');
});
it('offers durable history and purge for a retired group even without active groups', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(4), rooms: [], memberships: [], agents: [], retired: {
    rooms: [{ tenant_id: 'Miguel', id: ' Sala ', enabled: false }], memberships: [], tenants: [], agents: [] },
    capabilities: { actor: { tenant_id: 'Miguel', alias: 'janus', is_hub: true, can_control: true },
      resources: [{ resource: 'room', actions: ['restore'], scope: 'hub' }] } }));
  server.use(http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['restore', 'purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: /Historial y purga de sala\/grupo Miguel\/ Sala/u }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('"room_id":" Sala "');
  expect(screen.getByRole('button', { name: 'Previsualizar eliminación definitiva' })).toBeEnabled();
});

function movementSnapshot(runtimeKey: string | null) {
  return { ...snapshotDeConfig(4),
    rooms: [{ tenant_id: 'Miguel', id: ' Sala ', display_name: 'Origen', enabled: true },
      { tenant_id: 'Miguel', id: 'Sala', display_name: 'Destino', enabled: true }],
    memberships: [{ tenant_id: 'Miguel', room_id: ' Sala ', alias: 'janus', role: 'agent', enabled: true }],
    agents: [{ tenant_id: 'Miguel', alias: 'janus', runtime_key: runtimeKey, primary_room_id: ' Sala ',
      harness_id: 'codex', host_id: 'test-host', runtime_mode: 'native', runtime_user: 'runner',
      home_directory: '/home/janus', state_directory: runtimeKey ? `/state/${runtimeKey}` : '/state/janus' }],
    harness_definitions: [{ id: 'codex' }],
    capabilities: { actor: { tenant_id: 'Miguel', alias: 'janus', is_hub: true, can_control: true },
      resources: [{ resource: 'room', actions: ['update'], scope: 'hub' }] },
  };
}
async function openMovement() {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: /Editar sala\/grupo Miguel\/ Sala/u }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Miembro a mover' }), 'janus');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Grupo de destino' }), 'Sala');
  return user;
}
it('moves a draft membership and primary room in one accepted batch from the existing editor', async () => {
  servirConfig(() => movementSnapshot(null));
  const submitted: ChangeRequest[] = [];
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest; submitted.push(input);
    return HttpResponse.json({ revision: input.dry_run ? 4 : 5, dry_run: input.dry_run === true,
      applied: input.dry_run !== true, mutation: input.mutation, inverse_mutation: input.mutation,
      rolled_back_revision_id: null, summary: 'movement accepted' }, { status: input.dry_run ? 200 : 201 });
  }));
  const user = await openMovement();
  expect(screen.getByRole('button', { name: 'Confirmar movimiento atómico' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar movimiento atómico' }));
  await screen.findByLabelText('Movimiento atómico propuesto');
  await user.click(screen.getByRole('button', { name: 'Confirmar movimiento atómico' }));
  await waitFor(() => { expect(submitted).toHaveLength(2); });
  expect(submitted.map((row) => row.expected_revision)).toEqual([4, 4]);
  expect(submitted[1]?.mutation).toEqual({ resource: 'batch', action: 'apply', mutations: [
    { resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'Sala', alias: 'janus', value: { role: 'agent', enabled: true } },
    { resource: 'agent', action: 'update', tenant_id: 'Miguel', alias: 'janus', value: { primary_room_id: 'Sala' } },
    { resource: 'membership', action: 'delete', tenant_id: 'Miguel', room_id: ' Sala ', alias: 'janus' },
  ] });
});
it('prepares physical membership movement as a fleet update without any generic change', async () => {
  servirConfig(() => movementSnapshot('physical-janus'));
  const submitted: FleetOperationRequest[] = [];
  const generic: ChangeRequest[] = [];
  server.use(http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['update'],
    placements: [{ host_id: 'test-host', modes: ['native'], runtime_users: ['runner'], systemd_users: [], home_roots: ['/home/janus'], state_roots: ['/state'] }] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => { generic.push(await request.json() as ChangeRequest); return HttpResponse.json({}); }),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest; submitted.push(input);
      return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: 4,
        request_sha256: await fleetRequestHash(input), steps: ['prepare', 'verify'], dependencies: [], can_apply: true });
    }));
  const user = await openMovement();
  await user.click(screen.getByRole('button', { name: 'Preparar movimiento operativo' }));
  expect(screen.getByText(/la membresía de origen se conserva deshabilitada/)).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  expect(generic).toEqual([]);
  expect(submitted[0]).toMatchObject({ kind: 'update', target: { resource: 'agent', tenant_id: 'Miguel', alias: 'janus' },
    parameters: { runtime_key: 'physical-janus', primary_room_id: 'Sala', memberships: [{ room_id: 'Sala', role: 'agent', enabled: true }] } });
});

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });
