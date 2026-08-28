import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  irA, recordChanges, snapshotDeConfig, snapshotConAudit, servirConfig,
  MEMBERSHIP_JANUS, type ChangeRequest,
} from './ConfigPage.test-helpers';

const HISTORIAL = /historial y json/i;
const JANUS_APAGADA = /Quitar Habilitado en la membresía Miguel\/grp\.miguel\/janus: aplicado/i;

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion;
}

it('previews and applies a default-deny ACL mutation through the protected API', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('heading', { level: 1, name: /ajustes/i })).toBeInTheDocument();
  expect(await screen.findByText(/RBAC/i)).toBeInTheDocument();

  await irA(user, HISTORIAL);
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  expect(await screen.findByLabelText(/resultado de preview/i)).toHaveTextContent('"dry_run": true');
  expect(screen.getByLabelText(/resultado de preview/i)).toHaveTextContent('"allow_route": false');

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  expect(await screen.findByText(/cambio atómico aplicado/i)).toBeInTheDocument();
});

it('no acredita preview ni apply cuando un 2xx omite el recibo exacto de configuración', async () => {
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    const dryRun = input.dry_run === true;
    return HttpResponse.json({
      applied: !dryRun, dry_run: dryRun, revision: dryRun ? 1 : 2,
      summary: 'respuesta truncada',
    }, { status: dryRun ? 200 : 201 });
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  expect(await screen.findByText(/2xx sin el recibo exacto del dry-run/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/resultado de preview/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  expect(await screen.findByText(/puede haberse aplicado/i)).toBeInTheDocument();
  expect(screen.queryByText(/cambio atómico aplicado/i)).not.toBeInTheDocument();
}, 20_000);

it('lleva el wizard hasta el dry-run y aplica el primer paso del espacio contra el change endpoint', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: /espacio completo/i }));
  await user.click(await screen.findByRole('button', { name: /5\. dry-run y aplicar/i }));

  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  expect(await screen.findByLabelText(/dry-run del wizard/i)).toHaveTextContent('"dry_run": true');
  expect(changes[0]).toEqual({
    dry_run: true,
    expected_revision: 1,
    mutation: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  });

  await user.click(screen.getByRole('button', { name: /aplicar paso/i }));
  expect(await screen.findByText(/tenant aplicado en revisión 2/i)).toBeInTheDocument();
  expect(changes[1]?.dry_run).toBe(false);
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  expect(screen.getByLabelText(/mutación pendiente del wizard/i)).toHaveTextContent('"resource": "room"');

  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  await screen.findByText(/dry-run de room aceptado/i);
  expect(changes[2]).toEqual({
    dry_run: true,
    expected_revision: 2,
    mutation: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  });
});

it('distingue el 409 por revisión vencida y pide volver a previsualizar', async () => {
  server.use(http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'configuration revision changed: expected 1, current 4' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);
  await user.click(await screen.findByRole('button', { name: /preview \/ dry-run/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/conflicto de revisión/i);
  expect(alert).toHaveTextContent(/revisión 1 y el servidor ya va por la 4/i);
  expect(alert).toHaveTextContent(/volvé a previsualizar/i);
  expect(screen.queryByLabelText(/resultado de preview/i)).not.toBeInTheDocument();
});

it('acepta en el editor los recursos que el servidor acepta y la lista fija rechazaba', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, HISTORIAL);

  await user.selectOptions(screen.getByLabelText('Resource'), 'chain_policy');
  expect(Array.from(screen.getByLabelText('Action').querySelectorAll('option')).map((o) => o.value))
    .toEqual(['update']);
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  await screen.findByLabelText(/resultado de preview/i);
  expect(changes.at(-1)?.mutation).toMatchObject({ resource: 'chain_policy', action: 'update', id: 'default' });

  await user.selectOptions(screen.getByLabelText('Resource'), 'egress_destination');
  expect(Array.from(screen.getByLabelText('Action').querySelectorAll('option')).map((o) => o.value))
    .toEqual(['create', 'update', 'delete']);
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  await screen.findByLabelText(/resultado de preview/i);
  expect(changes.at(-1)?.mutation).toMatchObject({
    resource: 'egress_destination', action: 'update', tenant_id: 'Acme', alias: 'agent', handle: 'owner_dm',
  });
  expect(screen.queryByText(/resource no reconocido/i)).not.toBeInTheDocument();
});

it('no convierte los demás 409 en el mensaje de revisión ni los vuelve genéricos', async () => {
  server.use(http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'ACL edge already exists' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);
  await user.click(await screen.findByRole('button', { name: /preview \/ dry-run/i }));

  expect(await screen.findByText('ACL edge already exists')).toBeInTheDocument();
  expect(screen.queryByText(/conflicto de revisión/i)).not.toBeInTheDocument();
});

it('crea una arista ACL desde el formulario, sin que el operador tipee una sola llave', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Recurso a crear'), 'acl_edge');
  await user.type(screen.getByLabelText('Desde el tenant'), 'Steven');
  await user.type(screen.getByLabelText('Hacia el tenant'), 'Isa');
  await user.click(screen.getByRole('checkbox', { name: 'Ruta' }));
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));

  expect(changes[0]).toEqual({
    dry_run: false,
    expected_revision: 1,
    mutation: {
      resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Isa',
      value: { enabled: true, allow_route: true, allow_read: false, allow_control: false },
    },
  });
  expect(await screen.findByText(/creado en la revisión 2/i)).toBeInTheDocument();
});

it('crea una membership desde el formulario y bloquea el alta que el gateway rechazaría', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.type(await screen.findByLabelText('Tenant'), 'Miguel');
  await user.type(screen.getByLabelText('Room'), 'grp.miguel');
  await user.type(screen.getByLabelText('Alias'), 'Atlas');
  expect(screen.getByRole('button', { name: /^Crear$/ })).toBeDisabled();
  expect(screen.getByText(/alias debe ser minúsculas/i)).toBeInTheDocument();

  await user.clear(screen.getByLabelText('Alias'));
  await user.type(screen.getByLabelText('Alias'), 'atlas');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'atlas', value: { role: 'agent', enabled: true },
  });
});

it('FAMILIA 1: el desenlace de un rollback aplicado se lee SIN abrir ningún desplegable', async () => {
  servirConfig(() => snapshotConAudit(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(await screen.findByRole('button', { name: /^Rollback$/ }));

  const aviso = await screen.findByText(/rollback atómico de la revisión 1 aplicado/i);
  expect(aviso.closest('details')).toBeNull();
  expect(panelDe(/audit trail/i)).toContainElement(aviso);
});

it('FAMILIA 1: no acredita un receipt válido que corresponde a otra revisión', async () => {
  servirConfig(() => snapshotConAudit(1));
  server.use(http.post('*/v3/console/config/revisions/:id/rollback', () => HttpResponse.json({
    applied: true,
    dry_run: false,
    revision: 3,
    rolled_back_revision_id: 2,
    summary: 'rollback 2: update tenant Steven',
    mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } },
    inverse_mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: false } },
  }, { status: 201 })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(await screen.findByRole('button', { name: /^Rollback$/ }));

  expect(await screen.findByText(/2xx sin el recibo durable exacto del rollback 1/i))
    .toBeInTheDocument();
  expect(screen.queryByText(/rollback atómico de la revisión 1 aplicado/i)).not.toBeInTheDocument();
});

it('FAMILIA 1: un rollback que FALLA no se ve igual que uno que funciona', async () => {
  servirConfig(() => snapshotConAudit(1));
  server.use(http.post('*/v3/console/config/revisions/:id/rollback', () => HttpResponse.json(
    { error: 'internal', message: 'rollback store caído' }, { status: 500 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(await screen.findByRole('button', { name: /^Rollback$/ }));

  const aviso = await screen.findByText(/rollback store caído/i);
  expect(aviso.closest('details')).toBeNull();
  expect(aviso).toHaveClass('notice', 'error');
  expect(screen.queryByText(/rollback atómico de la revisión 1 aplicado/i)).not.toBeInTheDocument();
});

it('FAMILIA 1: el preview de un rollback también se pinta junto al botón que lo pidió', async () => {
  servirConfig(() => snapshotConAudit(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(await screen.findByRole('button', { name: /^Preview$/ }));

  const aviso = await screen.findByText(/preview del rollback de la revisión 1 aceptado/i);
  expect(aviso.closest('details')).toBeNull();
  expect(aviso).toHaveTextContent(/no se escribió nada todavía/i);
  const crudo = screen.getByLabelText('Preview del rollback');
  expect(crudo.closest('details')).toBeNull();
  expect(panelDe(/audit trail/i)).toContainElement(crudo);
});

it('FAMILIA 2: el aviso de una acción de tabla NO sobrevive a otra escritura que movió las tablas', async () => {
  let lecturas = 0;
  servirConfig(() => {
    lecturas += 1;
    return snapshotDeConfig(lecturas <= 1 ? 1 : lecturas === 2 ? 2 : 3);
  });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));
  const aviso = await screen.findByText(JANUS_APAGADA);
  expect(aviso).toHaveTextContent(/aplicado en la revisión 2/i);
  expect(aviso).toHaveTextContent(/las tablas de abajo están en la revisión 2/i);

  await user.type(screen.getByLabelText('Tenant'), 'Miguel');
  await user.type(screen.getByLabelText('Room'), 'grp.miguel');
  await user.type(screen.getByLabelText('Alias'), 'atlas');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  await screen.findByText(/creado en la revisión 2/i);

  expect(screen.queryByText(JANUS_APAGADA)).not.toBeInTheDocument();
});

it('FAMILIA 2: tocar el JSON del editor crudo se lleva puestos el verde y el preview anteriores', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, HISTORIAL);
  const editor = screen.getByLabelText('Mutación JSON');

  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  await screen.findByLabelText(/resultado de preview/i);
  await user.type(editor, ' ');
  expect(screen.queryByLabelText(/resultado de preview/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  await screen.findByText(/cambio atómico aplicado/i);
  await user.type(editor, ' ');
  expect(screen.queryByText(/cambio atómico aplicado/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  await screen.findByText(/cambio atómico aplicado/i);
  await user.selectOptions(screen.getByLabelText('Resource'), 'tenant');
  expect(screen.queryByText(/cambio atómico aplicado/i)).not.toBeInTheDocument();
});

it('FAMILIA 2: tras un alta exitosa el formulario queda VACÍO y «Crear» no se rearma sobre lo que ya existe', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.type(await screen.findByLabelText('Tenant'), 'Miguel');
  await user.type(screen.getByLabelText('Room'), 'grp.miguel');
  await user.type(screen.getByLabelText('Alias'), 'atlas');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  expect(await screen.findByText(/creado en la revisión 2/i)).toBeInTheDocument();

  expect(screen.getByLabelText('Tenant')).toHaveValue('');
  expect(screen.getByLabelText('Room')).toHaveValue('');
  expect(screen.getByLabelText('Alias')).toHaveValue('');
  expect(screen.getByRole('button', { name: /^Crear$/ })).toBeDisabled();
  expect(within(panelDe(/alta rápida/i)).queryByRole('alert')).not.toBeInTheDocument();
  expect(changes).toHaveLength(1);
});

it('FAMILIA 2: cambiar de recurso en el alta no grita un error sobre un formulario recién abierto', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.type(await screen.findByLabelText('Tenant'), 'Miguel');
  expect(within(panelDe(/alta rápida/i)).getByRole('alert')).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText('Recurso a crear'), 'acl_edge');
  expect(within(panelDe(/alta rápida/i)).queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/completá el formulario para habilitar el alta/i)).toBeInTheDocument();
});

it('FAMILIA 3: la interfaz dice que deshacer revierte la FILA entera, no el campo que se tocó', async () => {
  servirConfig(() => snapshotConAudit(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, HISTORIAL);

  const nota = within(panelDe(/audit trail/i))
    .getByText(/restituye la FILA COMPLETA que había antes de esa revisión/i);
  expect(nota).toHaveTextContent(/no sólo el campo que se tocó/i);
  expect(nota).toHaveTextContent(/ese cambio también se revierte/i);
  expect(nota.closest('details')).toBeNull();
});

it('FAMILIA 4: el 409 no manda a «volver a previsualizar» a los caminos que no previsualizan', async () => {
  servirConfig(() => snapshotConAudit(1));
  const conflicto = () => HttpResponse.json(
    { error: 'conflict', message: 'configuration revision changed: expected 1, current 9' },
    { status: 409 },
  );
  server.use(
    http.post('*/v3/console/config/changes', conflicto),
    http.post('*/v3/console/config/revisions/:id/rollback', conflicto),
  );
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));
  const deLaTabla = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(deLaTabla).toHaveTextContent(/pediste el cambio sobre la revisión 1/i);
  expect(deLaTabla).toHaveTextContent(/volvé a pedir el cambio sobre la revisión nueva/i);
  expect(deLaTabla).not.toHaveTextContent(/volvé a previsualizar/i);

  await irA(user, HISTORIAL);
  await user.click(screen.getByRole('button', { name: /^Rollback$/ }));
  const delAudit = await within(panelDe(/audit trail/i)).findByRole('alert');
  expect(delAudit).toHaveTextContent(/pediste el rollback sobre la revisión 1/i);
  expect(delAudit).toHaveTextContent(/volvé a elegir en el audit trail la revisión a deshacer/i);
  expect(delAudit).not.toHaveTextContent(/volvé a previsualizar/i);
});
