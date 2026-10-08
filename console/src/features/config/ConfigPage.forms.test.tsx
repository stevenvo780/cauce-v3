import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigAdministration } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { irA, snapshotDeConfig, servirConfig, type ChangeRequest } from './ConfigPage.test-helpers';

function configSnapshot(revision = 1) {
  return {
    ...snapshotDeConfig(revision),
    harness_definitions: [{ id: 'codex', display_name: 'Codex', capabilities: ['tools'], enabled: true }],
    acl_edges: [{ from_tenant: 'Miguel', to_tenant: 'Steven', enabled: true, allow_route: false, allow_read: false, allow_control: false }],
    role_policies: [{ role: 'agent', allow_route: false, allow_read: false, allow_control: false, allow_notify: false }],
    chain_policies: [{ id: 'default', progress_relay_enabled: true, progress_relay_max_events: 8, cycle_cut_enabled: true }],
    egress_destinations: [{ tenant_id: 'Miguel', alias: 'janus', handle: 'owner_dm', adapter: 'telegram', channel: 'telegram', conversation_id: '123', conversation_kind: 'dm', enabled: true }],
  };
}

function serveChanges(changes: ChangeRequest[], options: { status?: number; reloadFails?: boolean; receiptMissing?: boolean } = {}) {
  let applied = false;
  server.use(http.get('*/v3/console/config', () => applied && options.reloadFails
    ? HttpResponse.json({ message: 'relectura indisponible' }, { status: 503 })
    : HttpResponse.json(configSnapshot(applied ? 2 : 1))));
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    changes.push(input);
    if (!input.dry_run && options.status) return HttpResponse.json({ error: 'rejected', message: options.status === 409 ? 'room has memberships' : 'config.write denied' }, { status: options.status });
    if (!input.dry_run) applied = true;
    return HttpResponse.json({
      applied: !input.dry_run, dry_run: input.dry_run, revision: input.dry_run ? 1 : 2,
      summary: 'cambio validado', rolled_back_revision_id: null,
      ...(!options.receiptMissing || input.dry_run ? { mutation: input.mutation, inverse_mutation: input.mutation } : {}),
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

it('crea un tenant con campos visibles y exige otro dry-run al editar el nombre', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Crear espacio' }));
  const form = within(screen.getByRole('form', { name: 'Crear espacio' }));
  await user.type(form.getByLabelText('Id del espacio'), 'Nuevo');
  await user.type(form.getByLabelText('Nombre visible'), 'Equipo nuevo');
  expect(form.getByRole('button', { name: 'Confirmar creación' })).toBeDisabled();
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[0]).toMatchObject({ dry_run: true, expected_revision: 1, mutation: { resource: 'tenant', action: 'create', id: 'Nuevo', value: { display_name: 'Equipo nuevo', enabled: true, is_hub: false } } });
  await user.type(form.getByLabelText('Nombre visible'), ' editado');
  expect(form.getByRole('button', { name: 'Confirmar creación' })).toBeDisabled();
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  await user.click(form.getByRole('button', { name: 'Confirmar creación' }));
  await form.findByText(/inventario releído en revisión 2/i);
  expect(changes[2]).toMatchObject({ dry_run: false, expected_revision: 1, mutation: { value: { display_name: 'Equipo nuevo editado' } } });
});

it('edita el nombre visible del grupo sin cambiar su identidad ni otros campos', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' }));
  const form = within(screen.getByRole('form', { name: 'Editar sala/grupo' }));
  expect(form.getByLabelText('Id de la sala/grupo')).toBeDisabled();
  await user.clear(form.getByLabelText('Nombre visible'));
  await user.type(form.getByLabelText('Nombre visible'), 'Mesa técnica');
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[0]?.mutation).toEqual({ resource: 'room', action: 'update', tenant_id: 'Miguel', id: 'grp.miguel', value: { display_name: 'Mesa técnica' } });
  await user.click(form.getByRole('button', { name: 'Confirmar edición' }));
  await form.findByText(/inventario releído/i);
});

const editableRows = [
  ['espacio', 'Miguel', /espacios y miembros/i],
  ['membresía', 'Miguel/grp.miguel/janus', /espacios y miembros/i],
  ['ACL', 'Miguel/Steven', /permisos/i],
  ['política de rol', 'agent', /permisos/i],
  ['harness', 'codex', /^agentes$/i],
  ['destino de avisos', 'Miguel/janus/owner_dm', /avisos y cadena/i],
] as const;

it.each(editableRows)('presenta edición y eliminación visibles para %s', async (label, id, tab) => {
  servirConfig(() => configSnapshot());
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, tab);
  expect(await screen.findByRole('button', { name: `Editar ${label} ${id}` })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: `Eliminar ${label} ${id}` }));
  const form = within(screen.getByRole('form', { name: `Eliminar ${label}` }));
  expect(form.getByLabelText('Mutación propuesta')).toHaveTextContent('"action": "delete"');
  expect(form.getByRole('button', { name: 'Confirmar eliminación' })).toBeDisabled();
});

it('ofrece sólo edición del singleton de cadena con sus límites numéricos', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /avisos y cadena/i);
  expect(screen.queryByRole('button', { name: 'Crear política de cadena' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Eliminar política de cadena default' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Editar política de cadena default' }));
  const form = within(screen.getByRole('form', { name: 'Editar política de cadena' }));
  await user.clear(form.getByLabelText('Máximo de eventos de progreso'));
  await user.type(form.getByLabelText('Máximo de eventos de progreso'), '12');
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[0]?.mutation).toEqual({ resource: 'chain_policy', action: 'update', id: 'default', value: { progress_relay_max_events: 12 } });
});

it.each([403, 409])('no acredita eliminación cuando apply devuelve %s', async (status) => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes, { status });
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' }));
  const form = within(screen.getByRole('form', { name: 'Eliminar sala/grupo' }));
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  await user.click(form.getByRole('button', { name: 'Confirmar eliminación' }));
  await form.findByRole('alert');
  expect(form.queryByText(/aplicado en revisión/i)).not.toBeInTheDocument();
  expect(changes.at(-1)?.mutation).toEqual({ resource: 'room', action: 'delete', tenant_id: 'Miguel', id: 'grp.miguel' });
});

it('señala relectura incierta tras eliminar y no afirma retirada física', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes, { reloadFails: true });
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' }));
  const form = within(screen.getByRole('form', { name: 'Eliminar sala/grupo' }));
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  await user.click(form.getByRole('button', { name: 'Confirmar eliminación' }));
  expect(await form.findByRole('alert')).toHaveTextContent(/relectura.*no llegó/i);
  expect(form.queryByText(/eliminado|retirada física/i)).not.toBeInTheDocument();
});

it('mantiene controles visibles y bloqueados si console-access no acredita config.write', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({ subject: 'Miguel:janus', roles: ['reader'], permissions: [] })));
  servirConfig(() => configSnapshot());
  renderWithApi(<ConfigAdministration />);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Crear espacio' })).toBeDisabled(); });
  expect(screen.getByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' })).toBeDisabled();
});

it('no envía alta de harness sin su nombre obligatorio', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /^agentes$/i);
  await user.click(screen.getByRole('button', { name: 'Crear harness' }));
  const form = within(screen.getByRole('form', { name: 'Crear harness' }));
  await user.type(form.getByLabelText('Id del harness'), 'custom');
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  expect(await form.findByRole('alert')).toHaveTextContent(/nombre visible/i);
  expect(changes).toHaveLength(0);
});

it('añade un miembro desde su sala sin pedir identidades en JSON', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Editar sala/grupo Miguel/grp.miguel' }));
  await user.click(screen.getByRole('button', { name: 'Añadir miembro a esta sala/grupo' }));
  const form = within(screen.getByRole('form', { name: 'Crear membresía' }));
  expect(form.getByLabelText('Espacio')).toHaveValue('Miguel');
  expect(form.getByLabelText('Sala/grupo')).toHaveValue('grp.miguel');
  await user.type(form.getByLabelText('Alias del agente'), 'nuevo');
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  expect(changes[0]?.mutation).toEqual({ resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'nuevo', value: { role: 'agent', enabled: true } });
});

it('rechaza un recibo incompleto de eliminación y no lo acredita como aplicado', async () => {
  const changes: ChangeRequest[] = [];
  serveChanges(changes, { receiptMissing: true });
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await user.click(await screen.findByRole('button', { name: 'Eliminar sala/grupo Miguel/grp.miguel' }));
  const form = within(screen.getByRole('form', { name: 'Eliminar sala/grupo' }));
  await user.click(form.getByRole('button', { name: 'Previsualizar cambio' }));
  await form.findByText(/dry-run aceptado/i);
  await user.click(form.getByRole('button', { name: 'Confirmar eliminación' }));
  expect(await form.findByRole('alert')).toHaveTextContent(/puede haberse aplicado/i);
  expect(form.queryByText(/aplicado en revisión/i)).not.toBeInTheDocument();
  expect(form.getByRole('button', { name: 'Confirmar eliminación' })).toBeDisabled();
});
