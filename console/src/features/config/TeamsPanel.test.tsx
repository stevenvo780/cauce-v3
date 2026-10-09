import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ConfigPage } from './ConfigPage';
import { recordChanges, servirConfig, snapshotDeConfig, type ChangeRequest } from './ConfigPage.test-helpers';

const HUB = { actor: { tenant_id: 'Miguel', alias: 'janus', is_hub: true, can_control: true },
  resources: [{ resource: 'room', actions: ['create', 'update', 'delete', 'retire', 'restore'], scope: 'hub' },
    { resource: 'membership', actions: ['create', 'update', 'delete'], scope: 'hub' }] };

function serveTeams(extra: Record<string, unknown> = {}, permissions = ['config.read', 'config.write']) {
  servirConfig(() => ({ ...snapshotDeConfig(4), agents: [{ tenant_id: 'Miguel', alias: 'janus', display_name: 'Janus', harness_id: 'codex', enabled: true }],
    rooms: [{ id: 'grp.miguel', tenant_id: 'Miguel', display_name: 'Equipo Miguel', enabled: true },
      { id: 'ops.miguel', tenant_id: 'Miguel', display_name: 'Operaciones', enabled: true }],
    capabilities: HUB, ...extra }));
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: 'Hub:operator', roles: ['operator'], permissions })),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['retire', 'restore', 'purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
}
function team(id: string) {
  const element = document.querySelector<HTMLElement>(`[data-team="${id}"]`);
  if (!element) throw new Error(`team ${id} not rendered`);
  return within(element);
}

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

it('lists each team with its member count next to the agents', async () => {
  serveTeams();
  renderWithApi(<ConfigPage />);
  const list = await screen.findByRole('list', { name: 'Equipos configurados' });
  expect(within(list).getByText('Equipo Miguel')).toBeInTheDocument();
  expect(team('Miguel/grp.miguel').getByText(/1 miembro/)).toBeInTheDocument();
  expect(team('Miguel/ops.miguel').getByText(/0 miembros/)).toBeInTheDocument();
});

it('«Nuevo equipo» opens the typed form in a dialog and sends the existing room create mutation', async () => {
  serveTeams();
  const sink: ChangeRequest[] = [];
  recordChanges(sink);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const create = await screen.findByRole('button', { name: 'Nuevo equipo' });
  await waitFor(() => { expect(create).toBeEnabled(); });
  await user.click(create);
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('heading', { name: 'Nuevo equipo' })).toBeInTheDocument();
  await user.type(dialog.getByRole('combobox', { name: 'Espacio' }), 'Miguel');
  await user.type(dialog.getByRole('textbox', { name: 'Id de la sala/grupo' }), 'grp.nuevo');
  await user.click(dialog.getByRole('button', { name: 'Previsualizar cambio' }));
  await waitFor(() => { expect(sink).toHaveLength(1); });
  expect(sink[0]).toMatchObject({ dry_run: true, mutation: { resource: 'room', action: 'create', tenant_id: 'Miguel', id: 'grp.nuevo' } });
});

it('«Editar» opens the team editor with its members, and «Eliminar» the delete confirmation', async () => {
  serveTeams();
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const edit = await screen.findByRole('button', { name: 'Editar equipo Miguel/grp.miguel' });
  await waitFor(() => { expect(edit).toBeEnabled(); });
  await user.click(edit);
  let dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('heading', { name: 'Editar equipo' })).toBeInTheDocument();
  expect(dialog.getByText('Miembros de esta sala/grupo')).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });

  await user.click(screen.getByRole('button', { name: 'Eliminar equipo Miguel/ops.miguel' }));
  dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('heading', { name: 'Eliminar equipo' })).toBeInTheDocument();
  expect(dialog.getByText(/El servidor comprueba sus dependencias/)).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'Confirmar eliminación' })).toBeDisabled();
});

it('«Eliminar» on a team with running agents goes through the retirement dialog, never a generic delete', async () => {
  serveTeams({ agents: [{ tenant_id: 'Miguel', alias: 'janus', runtime_key: 'janus', primary_room_id: 'grp.miguel' }] });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const remove = await screen.findByRole('button', { name: 'Eliminar equipo Miguel/grp.miguel' });
  await waitFor(() => { expect(remove).toBeEnabled(); });
  expect(remove).toHaveAttribute('title', expect.stringContaining('se retira primero'));
  await user.click(remove);
  expect(await screen.findByRole('dialog')).toHaveTextContent('Retirar o eliminar grupo');
  expect(screen.getByRole('button', { name: 'Previsualizar retiro' })).toBeInTheDocument();
});

it('the team buttons are disabled with the permission reason when the account cannot write', async () => {
  serveTeams({}, ['config.read']);
  renderWithApi(<ConfigPage />);
  const create = await screen.findByRole('button', { name: 'Nuevo equipo' });
  await waitFor(() => { expect(create).toBeDisabled(); expect(create).toHaveAttribute('title', expect.stringMatching(/permiso|control/i)); });
  for (const name of ['Editar equipo Miguel/grp.miguel', 'Eliminar equipo Miguel/grp.miguel', 'Retiro y recuperación del equipo Miguel/grp.miguel']) {
    expect(screen.getByRole('button', { name })).toBeDisabled();
  }
});

it('the Grupos tab of an agent has a shortcut that opens its team editor', async () => {
  serveTeams();
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Abrir agente Miguel/janus' }));
  const sheet = within(await screen.findByRole('dialog'));
  await user.click(sheet.getByRole('tab', { name: 'Grupos' }));
  const shortcut = await sheet.findByRole('button', { name: 'Editar equipo grp.miguel' });
  await waitFor(() => { expect(shortcut).toBeEnabled(); });
  await user.click(shortcut);
  expect(await screen.findByRole('heading', { name: 'Editar equipo' })).toBeInTheDocument();
});

it('asks inside the dialog before discarding an edited team form, and closes at once when nothing changed', async () => {
  serveTeams();
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const edit = await screen.findByRole('button', { name: 'Editar equipo Miguel/grp.miguel' });
  await waitFor(() => { expect(edit).toBeEnabled(); });
  await user.click(edit);
  await screen.findByRole('heading', { name: 'Editar equipo' });
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });

  await user.click(edit);
  const name = await screen.findByRole('textbox', { name: 'Nombre visible' });
  await user.type(name, ' nuevo');
  await user.keyboard('{Escape}');
  expect(await screen.findByText(/Tenés cambios sin guardar/)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Seguir editando' }));
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Equipo Miguel nuevo');
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  await user.click(await screen.findByRole('button', { name: 'Descartar y cerrar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
});

it('retire and purge buttons follow the retire/restore capability, not just read-only mode', async () => {
  serveTeams({
    capabilities: { ...HUB, resources: [{ resource: 'room', actions: ['create', 'update', 'delete'], scope: 'hub' }] },
    retired: { tenants: [], memberships: [], agents: [], rooms: [{ tenant_id: 'Miguel', id: 'old', enabled: false }] },
  });
  renderWithApi(<ConfigPage />);
  const edit = await screen.findByRole('button', { name: 'Editar equipo Miguel/grp.miguel' });
  await waitFor(() => { expect(edit).toBeEnabled(); });
  for (const name of ['Retiro y recuperación del equipo Miguel/grp.miguel', 'Eliminar definitivamente el equipo Miguel/old', 'Restaurar equipo Miguel/old']) {
    const button = screen.getByRole('button', { name });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('no acredita'));
  }
});

it('the Grupos shortcut is disabled with the reason when the server does not allow editing the team', async () => {
  serveTeams({ capabilities: { ...HUB, resources: [{ resource: 'room', actions: ['create'], scope: 'hub' }] } });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Abrir agente Miguel/janus' }));
  const sheet = within(await screen.findByRole('dialog'));
  await user.click(sheet.getByRole('tab', { name: 'Grupos' }));
  const shortcut = await sheet.findByRole('button', { name: 'Editar equipo grp.miguel' });
  expect(shortcut).toBeDisabled();
  expect(shortcut).toHaveAttribute('title', expect.stringContaining('no acredita'));
});
