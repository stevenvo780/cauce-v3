import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigAdministration } from './ConfigPage';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { servirConfig, snapshotDeConfig, type ChangeRequest } from './ConfigPage.test-helpers';

const actor = { tenant_id: 'Miguel', alias: 'janus', is_hub: false, can_control: true };
const roomCapability = { resource: 'room', actions: ['create', 'update'], scope: 'tenant', tenant_id: 'Miguel' };

it('bloquea eliminar cuando capabilities sólo acredita creación y edición', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), capabilities: { actor, resources: [roomCapability] } }));
  renderWithApi(<ConfigAdministration />);
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
  renderWithApi(<ConfigAdministration />);
  expect(await screen.findByRole('button', { name: 'Editar sala/grupo Steven/grp.steven' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Crear sala/grupo' }));
  const form = within(screen.getByRole('form', { name: 'Crear sala/grupo' }));
  expect(form.getByLabelText('Espacio')).toHaveValue('Miguel');
  expect(form.getByLabelText('Espacio')).toBeDisabled();
});

it('no acredita alcance ante capabilities malformadas', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), capabilities: { actor, resources: 'invalid' } }));
  renderWithApi(<ConfigAdministration />);
  expect(await screen.findByRole('button', { name: 'Crear espacio' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
});

it('ofrece restaurar incluso cuando no quedan salas activas', async () => {
  servirConfig(() => ({
    ...snapshotDeConfig(1), rooms: [],
    retired: { rooms: [{ tenant_id: 'Miguel', id: 'grp.retired', enabled: false }] },
    capabilities: { actor, resources: [{ ...roomCapability, actions: ['restore'] }] },
  }));
  renderWithApi(<ConfigAdministration />);
  expect(await screen.findByRole('button', { name: 'Restaurar sala/grupo Miguel/grp.retired' })).toBeEnabled();
});

it('previsualiza retiro lógico y restauración sólo cuando el servidor los acredita', async () => {
  const changes: ChangeRequest[] = [];
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    retired: { rooms: [{ tenant_id: 'Miguel', id: 'grp.retired', display_name: 'Retirada', enabled: false }], tenants: [], memberships: [], agents: [] },
    capabilities: { actor, resources: [{ ...roomCapability, actions: ['create', 'update', 'retire', 'restore'] }] },
  }));
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    changes.push(input);
    return HttpResponse.json({ applied: false, dry_run: true, revision: 1, summary: 'retiro validado', mutation: input.mutation, inverse_mutation: input.mutation, rolled_back_revision_id: null });
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Retirar sala/grupo Miguel/grp.miguel' }));
  let form = within(screen.getByRole('form', { name: 'Retirar sala/grupo' }));
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[0]?.mutation).toEqual({ resource: 'room', action: 'retire', tenant_id: 'Miguel', id: 'grp.miguel' });
  await user.click(form.getByRole('button', { name: 'Cancelar' }));
  await user.click(screen.getByRole('button', { name: 'Restaurar sala/grupo Miguel/grp.retired' }));
  form = within(screen.getByRole('form', { name: 'Restaurar sala/grupo' }));
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[1]?.mutation).toEqual({ resource: 'room', action: 'restore', tenant_id: 'Miguel', id: 'grp.retired' });
  expect(screen.queryByRole('button', { name: 'Editar sala/grupo Miguel/grp.retired' })).not.toBeInTheDocument();
});
