import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { webcrypto } from 'node:crypto';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { ConfigPage } from './ConfigPage';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { servirConfig, snapshotDeConfig } from './ConfigPage.test-helpers';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const actor = { tenant_id: 'Miguel', alias: 'janus', is_hub: false, can_control: true };
const roomCapability = { resource: 'room', actions: ['create', 'update'], scope: 'tenant', tenant_id: 'Miguel' };

it('bloquea eliminar cuando capabilities sólo acredita creación y edición', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), capabilities: { actor, resources: [roomCapability] } }));
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Crear espacio' })).toBeDisabled();
});

it('mantiene el espacio propio fijo al crear una sala y bloquea edición fuera del scope', async () => {
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    rooms: [...snapshotDeConfig(1).rooms, { tenant_id: 'Steven', id: 'grp.steven', display_name: 'Steven', enabled: true }],
    capabilities: { actor, resources: [roomCapability] },
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('button', { name: 'Editar sala/grupo Steven/grp.steven' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Crear sala/grupo' }));
  const form = within(screen.getByRole('form', { name: 'Crear sala/grupo' }));
  expect(form.getByLabelText('Espacio')).toHaveValue('Miguel');
  expect(form.getByLabelText('Espacio')).toBeDisabled();
});

it('no acredita alcance ante capabilities malformadas', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), capabilities: { actor, resources: 'invalid' } }));
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('button', { name: 'Crear espacio' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
});

it('ofrece restaurar incluso cuando no quedan salas activas', async () => {
  servirConfig(() => ({
    ...snapshotDeConfig(1), rooms: [],
    retired: { rooms: [{ tenant_id: 'Miguel', id: 'grp.retired', enabled: false }], tenants: [], memberships: [], agents: [] },
    capabilities: { actor, resources: [{ ...roomCapability, actions: ['restore'] }] },
  }));
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('button', { name: 'Restaurar sala/grupo Miguel/grp.retired' })).toBeEnabled();
});

it('previsualiza retiro y restauración por el contrato durable de flota', async () => {
  const changes: FleetOperationRequest[] = [];
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    retired: { rooms: [{ tenant_id: 'Miguel', id: 'grp.retired', display_name: 'Retirada', enabled: false }], tenants: [], memberships: [], agents: [] },
    capabilities: { actor, resources: [{ ...roomCapability, actions: ['create', 'update', 'retire', 'restore'] }] },
  }));
  server.use(http.get('*/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['retire', 'restore'], placements: [] })),
    http.get('*/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('*/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest;
      changes.push(input);
      return HttpResponse.json({ request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
        expected_revision: input.expected_revision, steps: ['prepare'], dependencies: [], can_apply: true });
    }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Retirar sala/grupo Miguel/grp.miguel' }));
  let dialog = within(await screen.findByRole('dialog'));
  await waitFor(() => { expect(dialog.getByRole('button', { name: 'Previsualizar retiro' })).toBeEnabled(); });
  await user.click(dialog.getByRole('button', { name: 'Previsualizar retiro' }));
  await dialog.findByLabelText('Previsualización operativa');
  expect(changes[0]).toMatchObject({ kind: 'retire', target: { resource: 'room', tenant_id: 'Miguel', room_id: 'grp.miguel' } });
  await user.click(dialog.getByRole('button', { name: 'Cerrar retiro y recuperación' }));
  await user.click(screen.getByRole('button', { name: 'Restaurar sala/grupo Miguel/grp.retired' }));
  dialog = within(await screen.findByRole('dialog'));
  await waitFor(() => { expect(dialog.getByRole('button', { name: 'Previsualizar restauración' })).toBeEnabled(); });
  await user.click(dialog.getByRole('button', { name: 'Previsualizar restauración' }));
  await dialog.findByLabelText('Previsualización operativa');
  expect(changes[1]).toMatchObject({ kind: 'restore', target: { resource: 'room', tenant_id: 'Miguel', room_id: 'grp.retired' } });
  expect(screen.queryByRole('button', { name: 'Editar sala/grupo Miguel/grp.retired' })).not.toBeInTheDocument();
});

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });
