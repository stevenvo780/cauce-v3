import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

type Usuario = ReturnType<typeof userEvent.setup>;

/**
 * Abre una pestaña de `/config`.
 *
 * `/config` era UN scroll con dieciséis paneles seguidos y ahora son seis pestañas. Nada se
 * escondió: lo que cambió es que hay que decir a cuál se entra, y estas pruebas lo dicen — así
 * queda escrito en el propio test EN QUÉ pestaña vive cada cosa, que es la pregunta que el dueño
 * hizo cuando no encontraba «Alta rápida».
 */
async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

const ESPACIOS = /espacios y miembros/i;
const PERMISOS = /^permisos$/i;
const ROLES = /roles de agente/i;
const AGENTES = /agentes y cuentas/i;
const AVISOS = /avisos y cadena/i;
const HISTORIAL = /historial y json/i;

function recordChanges(sink: ChangeRequest[]) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 1 : 2, mutation: input.mutation, summary: 'mock configuration validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

it('previews and applies a default-deny ACL mutation through the protected API', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('heading', { level: 1, name: /configuración/i })).toBeInTheDocument();
  expect(await screen.findByText(/RBAC/i)).toBeInTheDocument();

  await irA(user, HISTORIAL);
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  expect(await screen.findByLabelText(/resultado de preview/i)).toHaveTextContent('"dry_run": true');
  expect(screen.getByLabelText(/resultado de preview/i)).toHaveTextContent('"allow_route": false');

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  expect(await screen.findByText(/cambio atómico aplicado/i)).toBeInTheDocument();
});

it('lleva el wizard hasta el dry-run y aplica el primer paso del espacio contra el change endpoint', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
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
  // El apply del room queda otra vez bloqueado: exige su propio dry-run sobre la nueva revisión.
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

it('muestra las colecciones que el servidor publica más allá de las seis históricas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  // Las dos viven en «Avisos y cadena»: es la pestaña que agrupa lo que un bot ve de su propia
  // cadena y a qué conversaciones humanas se le permite escribir sin que nadie le pregunte.
  await irA(user, AVISOS);

  // Las dos que la lista fija de ConfigPage dejaba invisibles aunque el snapshot las trae.
  expect(await screen.findByRole('heading', { name: /chain visibility policy/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /proactive egress allowlist/i })).toBeInTheDocument();
  // El JSON crudo sigue publicándose, ahora detrás del desplegable «ver crudo» de cada panel.
  expect(screen.getByText(/"cycle_cut_enabled":true/)).toBeInTheDocument();
  // Y el mismo dato se ve además como celda de la tabla, que es lo primero que el operador mira.
  expect(screen.getByText('steven_dm')).toBeInTheDocument();
});

it('no confunde una clave que el gateway no publica con una colección vacía', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: [], revisions: [],
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  const tenants = (await screen.findByRole('heading', { name: 'Tenants' })).closest('section');
  expect(tenants).toHaveTextContent(/sin registros/i);
  await irA(user, AVISOS);
  const chain = screen.getByRole('heading', { name: /chain visibility policy/i }).closest('section');
  expect(chain).toHaveTextContent(/no publica esta colección/i);
});

it('acepta en el editor los recursos que el servidor acepta y la lista fija rechazaba', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });
  await irA(user, HISTORIAL);

  await user.selectOptions(screen.getByLabelText('Resource'), 'chain_policy');
  // `chain_policy` es un singleton que sólo admite update: la UI no debe ofrecer create ni delete.
  expect(Array.from(screen.getByLabelText('Action').querySelectorAll('option')).map((o) => o.value))
    .toEqual(['update']);
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  await screen.findByLabelText(/resultado de preview/i);
  expect(changes.at(-1)?.mutation).toMatchObject({ resource: 'chain_policy', action: 'update', id: 'default' });

  await user.selectOptions(screen.getByLabelText('Resource'), 'egress_destination');
  // La acción elegida sobrevive al cambio de recurso mientras siga siendo válida, y el recurso
  // vuelve a ofrecer las tres porque no es un singleton.
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

// ---------------------------------------------------------------------------------------------
// La vista dejó de ser JSON crudo de sólo lectura. Lo que sigue prueba, comportamiento por
// comportamiento, que se ve como tabla, que las operaciones frecuentes están a un clic, y —sobre
// todo— que la pantalla NO afirma nada que no haya comprobado contra el servidor.

const MEMBERSHIP_JANUS = 'Deshabilitar la membership Miguel/grp.miguel/janus';

/** Snapshot mínimo con la forma real del gateway, para los tests que necesitan mover la revisión. */
function snapshotDeConfig(revision: number) {
  return {
    revision,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Miguel', display_name: 'Miguel', is_hub: false, enabled: true }],
    rooms: [{ id: 'grp.miguel', tenant_id: 'Miguel', display_name: 'grp.miguel', enabled: true }],
    memberships: [{ tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }],
    acl_edges: [],
    role_policies: [{ role: 'agent' }, { role: 'operator' }],
    revisions: [],
  };
}

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion as HTMLElement;
}

it('pinta cada colección como TABLA con columnas de verdad y deja el JSON crudo detrás del desplegable', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  const memberships = panelDe(/memberships/i);
  expect(within(memberships).getAllByRole('columnheader').map((celda) => celda.textContent))
    .toEqual(['Tenant', 'Room', 'Alias', 'Rol', 'Habilitado', 'Alta', 'Acciones']);
  // El alias se lee como celda, no dentro de un `{"tenant_id":"Miguel",...}`.
  expect(within(memberships).getByText('janus')).toBeInTheDocument();

  const tenants = panelDe(/^Tenants$/);
  expect(within(tenants).getAllByRole('columnheader').map((celda) => celda.textContent))
    .toEqual(['Id', 'Nombre', 'Hub', 'Habilitado', 'Alta', 'Acciones']);
  // El crudo no se borró: sigue estando, un escalón más abajo.
  expect(within(tenants).getByText(/ver crudo/i)).toBeInTheDocument();
});

it('deshabilita una membership a un clic: confirma primero, manda la mutación exacta y recién después lo afirma', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  // Nada viajó todavía: primero la confirmación, con la mutación exacta a la vista.
  expect(changes).toEqual([]);
  expect(screen.getByLabelText('Mutación a aplicar')).toHaveTextContent('"enabled": false');

  await user.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(changes[0]).toEqual({
    dry_run: false,
    expected_revision: 1,
    mutation: {
      resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
      alias: 'janus', value: { enabled: false },
    },
  });
  expect(await screen.findByText(/aplicado en la revisión 2/i)).toBeInTheDocument();
});

it('cambia el rol de una membership desde su propia columna, con el mismo camino de escritura', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator');
  expect(changes).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { role: 'operator' },
  });
});

it('cancela sin escribir nada y deja la fila como estaba', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(changes).toEqual([]);
  expect(screen.queryByLabelText('Mutación a aplicar')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: MEMBERSHIP_JANUS })).toBeInTheDocument();
});

it('sin config.write se ve TODO en solo lectura y lo dice, en vez de esconder la vista', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
  })));
  renderWithApi(<ConfigPage />);

  expect(await screen.findByText(new RegExp(`Solo lectura: ${CONFIG_SIN_CONTROL_REASON}`, 'i')))
    .toBeInTheDocument();
  // Los datos siguen a la vista; lo que queda inerte es todo lo que escribe.
  expect(within(panelDe(/memberships/i)).getByText('janus')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: MEMBERSHIP_JANUS })).toBeDisabled();
  expect(screen.getByLabelText('Rol de Miguel/grp.miguel/janus')).toBeDisabled();
  // Las pestañas NO se apagan ni se esconden con el permiso denegado: navegar no escribe nada, y
  // un menú de áreas mutilado no distingue «no tengo permiso» de «esto no existe».
  await irA(userEvent.setup(), HISTORIAL);
  expect(screen.getByRole('button', { name: /aplicar atómico/i })).toBeDisabled();
});

it('muestra el rechazo del servidor en la propia colección y no dice que aplicó nada', async () => {
  server.use(http.post('*/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'membership has active deliveries or a live lease' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent('membership has active deliveries or a live lease');
  expect(aviso).toHaveTextContent(/NO se aplicó/i);
  expect(screen.queryByText(/aplicado en la revisión/i)).not.toBeInTheDocument();
});

it('ante un 409 de revisión relee el snapshot y ESPERA el dato antes de afirmar que recargó', async () => {
  let lecturas = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      lecturas += 1;
      return HttpResponse.json(snapshotDeConfig(lecturas === 1 ? 1 : 7));
    }),
    http.post('*/v3/console/config/changes', () => HttpResponse.json(
      { error: 'conflict', message: 'configuration revision changed: expected 1, current 7' },
      { status: 409 },
    )),
  );
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent(/conflicto de revisión/i);
  // La revisión 7 sólo puede salir de una relectura que llegó: es la prueba de que se esperó el
  // dato y no de que se disparó un reload y se cantó victoria.
  expect(aviso).toHaveTextContent(/releído del servidor: las tablas de abajo están en la revisión 7/i);
  expect(lecturas).toBeGreaterThanOrEqual(2);
});

it('si la relectura posterior falla lo DICE, en vez de afirmar que recargó', async () => {
  let lecturas = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      lecturas += 1;
      return lecturas === 1
        ? HttpResponse.json(snapshotDeConfig(1))
        : HttpResponse.json({ error: 'internal', message: 'config store caído' }, { status: 500 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent(/aplicado en la revisión 2/i);
  expect(aviso).toHaveTextContent(/la relectura del snapshot NO llegó/i);
  expect(aviso).toHaveTextContent(/pueden estar vencidas/i);
});

it('crea una arista ACL desde el formulario, sin que el operador tipee una sola llave', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Recurso a crear'), 'acl_edge');
  await user.type(screen.getByLabelText('Desde el tenant'), 'Steven');
  await user.type(screen.getByLabelText('Hacia el tenant'), 'Isa');
  await user.click(screen.getByRole('checkbox', { name: 'allow_route' }));
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
  // El alias en mayúsculas no pasa AliasSchema: el botón queda inerte con el motivo escrito.
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

// ---------------------------------------------------------------------------------------------
// Lo que sigue son los defectos que el panel de revisión encontró sobre la pantalla ya construida.
// Un test por defecto, con el caso EXACTO que el revisor describió: agruparlos por familia deja
// pasar tres de cada cuatro.

/** Una revisión en el audit trail: sin esto los botones de rollback ni se pintan. */
const REVISIONES = [{
  id: '1', actor_tenant: 'Steven', actor_alias: 'kant',
  summary: 'alta de la arista Steven → Isa', created_at: '2026-08-20T10:00:00.000Z',
}];

function snapshotConAudit(revision: number) {
  return { ...snapshotDeConfig(revision), revisions: REVISIONES };
}

function servirConfig(snapshot: () => Record<string, unknown>) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(snapshot())));
}

// --- FAMILIA 1: la pantalla se calla después de escribir --------------------------------------

it('FAMILIA 1: el desenlace de un rollback aplicado se lee SIN abrir ningún desplegable', async () => {
  servirConfig(() => snapshotConAudit(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  await user.click(await screen.findByRole('button', { name: /^Rollback$/ }));

  const aviso = await screen.findByText(/rollback atómico de la revisión 1 aplicado/i);
  // El cartel vivía dentro de `<details className="config-editor">`, cerrado por defecto: el POST
  // viajaba, el servidor contestaba 201 y la pantalla no decía absolutamente nada.
  expect(aviso.closest('details')).toBeNull();
  // Y está en el MISMO panel que el botón que lo disparó, no tres paneles más abajo.
  expect(panelDe(/audit trail/i)).toContainElement(aviso);
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

// --- FAMILIA 2: carteles que sobreviven a lo que los desmiente --------------------------------

it('FAMILIA 2: el aviso de una acción de tabla NO sobrevive a otra escritura que movió las tablas', async () => {
  // 1ª lectura revisión 1; 2ª (la que sigue al primer cambio) revisión 2; de ahí en más, 3.
  let lecturas = 0;
  servirConfig(() => {
    lecturas += 1;
    return snapshotDeConfig(lecturas <= 1 ? 1 : lecturas === 2 ? 2 : 3);
  });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));
  const aviso = await screen.findByText(/Deshabilitar la membership Miguel\/grp\.miguel\/janus: aplicado en la revisión 2/i);
  expect(aviso).toHaveTextContent(/las tablas de abajo están en la revisión 2/i);

  // Otra escritura, por otro camino, mueve el snapshot a la 3: el cartel afirmaba «revisión 2»
  // sobre unas tablas que ya no estaban en la 2.
  await user.type(screen.getByLabelText('Tenant'), 'Miguel');
  await user.type(screen.getByLabelText('Room'), 'grp.miguel');
  await user.type(screen.getByLabelText('Alias'), 'atlas');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  await screen.findByText(/creado en la revisión 2/i);

  expect(screen.queryByText(/Deshabilitar la membership Miguel\/grp\.miguel\/janus: aplicado/i))
    .not.toBeInTheDocument();
});

it('FAMILIA 2: tocar el JSON del editor crudo se lleva puestos el verde y el preview anteriores', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });
  await irA(user, HISTORIAL);
  const editor = screen.getByLabelText('Mutación JSON');

  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));
  await screen.findByLabelText(/resultado de preview/i);
  await user.type(editor, ' ');
  // El dry-run valía para OTRO texto: dejarlo es prometer sobre algo que el servidor nunca vio.
  expect(screen.queryByLabelText(/resultado de preview/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar atómico/i }));
  await screen.findByText(/cambio atómico aplicado/i);
  await user.type(editor, ' ');
  expect(screen.queryByText(/cambio atómico aplicado/i)).not.toBeInTheDocument();

  // Y cambiar de plantilla también: `selectTemplate` limpiaba el preview pero NO el aviso.
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
  // Y el motivo vuelve a ser una pista, no un grito: el formulario está recién vaciado.
  expect(within(panelDe(/alta rápida/i)).queryByRole('alert')).not.toBeInTheDocument();
  expect(changes).toHaveLength(1);
});

it('FAMILIA 2: cambiar de recurso en el alta no grita un error sobre un formulario recién abierto', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  // Tocar un campo pone el formulario en modo «el operador ya intentó»: el motivo sale como alert.
  await user.type(await screen.findByLabelText('Tenant'), 'Miguel');
  expect(within(panelDe(/alta rápida/i)).getByRole('alert')).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText('Recurso a crear'), 'acl_edge');
  expect(within(panelDe(/alta rápida/i)).queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/completá el formulario para habilitar el alta/i)).toBeInTheDocument();
});

// --- FAMILIA 3: la mutación que viaja no es la que se pidió -----------------------------------

it('FAMILIA 3: la confirmación pendiente se anula cuando «Actualizar» mueve el snapshot debajo', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  let lecturas = 0;
  servirConfig(() => {
    lecturas += 1;
    if (lecturas === 1) return snapshotDeConfig(1);
    // El servidor ya va por la 5 y otro operador dejó esa misma fila DESHABILITADA.
    const posterior = snapshotDeConfig(5);
    posterior.memberships = [{ ...posterior.memberships[0], enabled: false }];
    return posterior;
  });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Actualizar' }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent(/se anuló sola/i);
  expect(aviso).toHaveTextContent(/pasó a la revisión 5 mientras estaba pendiente/i);
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 3: sin tenant_id el selector de rol no se queda mudo: se apaga y DICE por qué', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    // Un gateway que no publica `tenant_id`: la mutación de rol no se puede armar.
    memberships: [{ room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }],
  }));
  renderWithApi(<ConfigPage />);

  const selector = await screen.findByLabelText('Rol de fila-0');
  expect(selector).toBeDisabled();
  expect(selector).toHaveAttribute('title', expect.stringContaining('tenant_id'));
  expect(within(panelDe(/memberships/i)).getByText(/no publica tenant_id en esta fila/i))
    .toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 3: la interfaz dice que deshacer revierte la FILA entera, no el campo que se tocó', async () => {
  servirConfig(() => snapshotConAudit(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });
  await irA(user, HISTORIAL);

  const nota = within(panelDe(/audit trail/i))
    .getByText(/restituye la FILA COMPLETA que había antes de esa revisión/i);
  expect(nota).toHaveTextContent(/no sólo el campo que se tocó/i);
  expect(nota).toHaveTextContent(/ese cambio también se revierte/i);
  // Se lee sin abrir nada: es lo que evita que un operador pise el cambio de otro sin enterarse.
  expect(nota.closest('details')).toBeNull();
});

// --- FAMILIA 4: permiso y presentación --------------------------------------------------------

it('FAMILIA 4: sin config.write el formulario de alta queda INERTE, no lleno y prometiendo', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByText(new RegExp(`Solo lectura: ${CONFIG_SIN_CONTROL_REASON}`, 'i'));

  expect(screen.getByLabelText('Recurso a crear')).toBeDisabled();
  expect(screen.getByLabelText('Tenant')).toBeDisabled();
  expect(screen.getByLabelText('Room')).toBeDisabled();
  expect(screen.getByLabelText('Alias')).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /habilitado/i })).toBeDisabled();

  // Y la mutación en vivo no se mueve: no hay forma de llenarla en una pantalla que no escribe.
  await user.type(screen.getByLabelText('Tenant'), 'Miguel');
  expect(screen.getByLabelText('Mutación del alta')).not.toHaveTextContent('Miguel');
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

  // Botón de un clic: no hay dry-run en este camino.
  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));
  const deLaTabla = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(deLaTabla).toHaveTextContent(/pediste el cambio sobre la revisión 1/i);
  expect(deLaTabla).toHaveTextContent(/volvé a pedir el cambio sobre la revisión nueva/i);
  expect(deLaTabla).not.toHaveTextContent(/volvé a previsualizar/i);

  // Rollback: tampoco previsualiza para aplicar. Vive en «Historial y JSON», que es también donde
  // el propio aviso manda a volver a elegir la revisión.
  await irA(user, HISTORIAL);
  await user.click(screen.getByRole('button', { name: /^Rollback$/ }));
  const delAudit = await within(panelDe(/audit trail/i)).findByRole('alert');
  expect(delAudit).toHaveTextContent(/pediste el rollback sobre la revisión 1/i);
  expect(delAudit).toHaveTextContent(/volvé a elegir en el audit trail la revisión a deshacer/i);
  expect(delAudit).not.toHaveTextContent(/volvé a previsualizar/i);
});

it('FAMILIA 4: el role_brief de «Agent registry» se ve RESUMIDO, no 1200 caracteres en una celda', async () => {
  // Sin espacio al final: `getByTitle` normaliza el texto y un `title` con cola en blanco no casa.
  const brief = Array.from({ length: 27 }, () => 'Sos kant, el hub de coordinación de la flota.').join(' ');
  expect(brief.length).toBeGreaterThan(1200);
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: brief, enabled: true }],
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });
  await irA(user, AGENTES);

  const registro = panelDe(/agent registry/i);
  const celda = within(registro).getByTitle(brief);
  expect(celda.textContent).toBe(`${brief.slice(0, 120)}…`);
  // El texto entero no se pierde —queda en el `title` y en «Ver crudo»— pero no se derrama.
  expect(within(registro).queryByText(brief)).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------------------------
// FAMILIA 5: `/config` en pestañas.
//
// La queja del dueño no fue «faltan cosas» sino «no encuentro nada»: la pantalla era UN scroll con
// dieciséis paneles seguidos —el alta, el wizard, el editor crudo, doce tablas y el audit trail— y
// para tocar una arista de ACL había que pasar por delante del pool de suscripciones de IA. Lo que
// sigue prueba que ahora hay seis áreas, que se entra a UNA por vez, y —sobre todo— que NADA se
// perdió por el camino: «Alta rápida» es exactamente lo que el dueño buscaba y no encontraba.

it('FAMILIA 5: /config son SEIS pestañas reales, en el orden en que se monta una flota', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  const pestanas = within(screen.getByRole('tablist', { name: /áreas de configuración/i }))
    .getAllByRole('tab');
  expect(pestanas.map((boton) => boton.textContent)).toEqual([
    'Espacios y miembros', 'Permisos', 'Roles de agente', 'Agentes y cuentas',
    'Avisos y cadena', 'Historial y JSON',
  ]);
  // Se entra por «Espacios y miembros»: la primera pregunta de un operador es «quién hay».
  expect(pestanas[0]).toHaveAttribute('aria-selected', 'true');
  expect(pestanas.filter((boton) => boton.getAttribute('aria-selected') === 'true')).toHaveLength(1);
});

it('FAMILIA 5: el render es CONDICIONAL, no un scroll con todo pintado y un ancla', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  // Estando en «Espacios y miembros», lo de las otras áreas NO está en el documento. Si estuviera
  // —oculto por CSS, o simplemente más abajo— esto seguiría siendo el scroll de dieciséis paneles
  // con pestañas de adorno, que es exactamente lo que se vino a arreglar.
  expect(screen.getByRole('heading', { name: /memberships/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /directed acl/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /agent registry/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Mutación JSON')).not.toBeInTheDocument();

  await irA(user, PERMISOS);
  expect(screen.getByRole('heading', { name: /directed acl/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /memberships/i })).not.toBeInTheDocument();
});

it('FAMILIA 5: «Alta rápida» NO se perdió: vive en «Espacios y miembros» y sigue dando de alta', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  // Está montada en la pestaña de entrada, sin tener que buscarla: es lo que el dueño no encontraba.
  const alta = panelDe(/alta rápida/i);
  expect(alta).toBeInTheDocument();
  expect(within(alta).getByLabelText('Recurso a crear')).toBeInTheDocument();

  // Y no es un cartel: da de alta de verdad, por el mismo camino versionado.
  await user.type(within(alta).getByLabelText('Tenant'), 'Miguel');
  await user.type(within(alta).getByLabelText('Room'), 'grp.miguel');
  await user.type(within(alta).getByLabelText('Alias'), 'atlas');
  await user.click(within(alta).getByRole('button', { name: /^Crear$/ }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'atlas', value: { role: 'agent', enabled: true },
  });

  // Y se fue de las demás pestañas: si estuviera repetida, dos formularios distintos escribirían
  // lo mismo y el operador no sabría cuál acaba de usar.
  await irA(user, HISTORIAL);
  expect(screen.queryByLabelText('Recurso a crear')).not.toBeInTheDocument();
  await irA(user, ESPACIOS);
  expect(screen.getByLabelText('Recurso a crear')).toBeInTheDocument();
});

it('FAMILIA 5: el cambio de rol por columna y el JSON crudo por fila siguen en «Espacios y miembros»', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  const memberships = panelDe(/memberships/i);
  // El JSON crudo por fila: no se borró al ordenar la pantalla, sigue un escalón más abajo.
  expect(within(memberships).getByText(/ver crudo/i)).toBeInTheDocument();

  // Y el rol se cambia desde su propia columna, con confirmación y con la mutación exacta.
  await user.selectOptions(
    within(memberships).getByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator',
  );
  await user.click(within(memberships).getByRole('button', { name: 'Confirmar' }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { role: 'operator' },
  });
});

it('FAMILIA 5: cambiar de pestaña con una confirmación pendiente la ANULA, no la deja escondida', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: MEMBERSHIP_JANUS }));
  expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();

  // Si la confirmación sobreviviera al cambio de pestaña, el operador volvería mucho después a un
  // «Confirmar» cuyo `<pre>` ya no recuerda haber leído, y lo firmaría igual.
  await irA(user, PERMISOS);
  await irA(user, ESPACIOS);
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 5: una colección que la consola no sabe clasificar aparece en «Otros», no desaparece', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), gizmos: [{ id: 'g1', enabled: true }] }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

  // La pestaña sólo existe porque hay algo que no se supo clasificar: sin `gizmos` no sale, y una
  // pestaña vacía permanente enseña a ignorarla justo antes del día en que importa.
  await irA(user, /^otros$/i);
  expect(screen.getByRole('heading', { name: 'gizmos' })).toBeInTheDocument();
});

// --- FAMILIA 6: la pestaña «Roles de agente» ---------------------------------------------------

/** Un snapshot con registro de agentes: sin él no hay roles que catalogar. */
function snapshotConAgentes() {
  return {
    ...snapshotDeConfig(1),
    agents: [
      { tenant_id: 'Steven', alias: 'zeus', role_brief: 'Sos el orquestador de la flota.', enabled: true },
      { tenant_id: 'Steven', alias: 'kant', role_brief: 'Sos el orquestador de la flota.', enabled: true },
      { tenant_id: 'Steven', alias: 'argos', role_brief: null, enabled: true },
    ],
  };
}

it('FAMILIA 6: «Roles de agente» cataloga los roles en uso y dice quién lleva cada uno', async () => {
  servirConfig(snapshotConAgentes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  const enUso = panelDe(/roles en uso/i);
  expect(within(enUso).getByRole('heading', { name: /sos el orquestador de la flota/i })).toBeInTheDocument();
  expect(within(enUso).getByText('Steven/zeus')).toBeInTheDocument();
  expect(within(enUso).getByText('Steven/kant')).toBeInTheDocument();
  // El título es un RESUMEN del texto, no un nombre guardado: decir lo contrario mandaría al
  // operador a buscar «orquestador» en una tabla que hoy no existe.
  expect(within(enUso).getByText(/no un nombre guardado/i)).toBeInTheDocument();
  // Y el bot sin rol declarado no se pierde: se lista aparte, que es de donde sale el trabajo.
  expect(within(panelDe(/bots sin rol declarado/i)).getByText('Steven/argos')).toBeInTheDocument();
});

it('FAMILIA 6: aplicar un rol a otro bot manda la mutación versionada exacta y dice dónde deshacerla', async () => {
  const changes: ChangeRequest[] = [];
  servirConfig(snapshotConAgentes);
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  await user.selectOptions(
    await screen.findByLabelText(/bot que recibirá el rol/i), 'Steven/argos',
  );
  await user.click(screen.getByRole('button', { name: /aplicar el rol a ese bot/i }));

  expect(changes[0]).toEqual({
    dry_run: false,
    expected_revision: 1,
    mutation: {
      resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'argos',
      value: { role_brief: 'Sos el orquestador de la flota.' },
    },
  });
  const aviso = await screen.findByText(/rol aplicado a Steven\/argos/i);
  // El desenlace se lee EN la pestaña de roles, sin abrir nada, y dice dónde está la marcha atrás.
  expect(aviso.closest('details')).toBeNull();
  expect(aviso).toHaveTextContent(/se puede deshacer desde «Historial y JSON»/i);
});

it('FAMILIA 6: un rol pasado del tope NO se puede aplicar a otro bot: lo dejaría SORDO', async () => {
  const changes: ChangeRequest[] = [];
  // 1150 puntos de código pero 2300 unidades UTF-16: la base lo acepta y el adaptador desplegado
  // rechaza cada sobre de ese alias en silencio. Es el fallo que no da ningún error.
  const conEmojis = '🙂'.repeat(1150);
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    agents: [
      { tenant_id: 'Steven', alias: 'zeus', role_brief: conEmojis, enabled: true },
      { tenant_id: 'Steven', alias: 'argos', role_brief: null, enabled: true },
    ],
  }));
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  await user.selectOptions(await screen.findByLabelText(/bot que recibirá el rol/i), 'Steven/argos');
  expect(screen.getByRole('button', { name: /aplicar el rol a ese bot/i })).toBeDisabled();
  expect(screen.getByText(/lo dejaría SORDO/i)).toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 6: un gateway que no publica el registro de agentes no inventa un catálogo vacío', async () => {
  servirConfig(() => snapshotDeConfig(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  // Clave ausente no es lista vacía: «ningún bot tiene rol» sería una afirmación que nadie midió.
  expect(await screen.findByText(/no publica el registro de agentes/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar el rol a ese bot/i })).not.toBeInTheDocument();
});

/**
 * 🔴 **`/config` abierto por marcador sin permiso `control`.**
 *
 * La barra lateral ya decía la verdad —entrada inerte con `CONFIG_SIN_CONTROL_REASON`— pero quien
 * llega por URL directa se salta el menú entero, y la página le contestaba «No se pudo leer Cauce
 * V3 / Forbidden / Reintentar». Cauce se leía perfectamente; lo que faltaba era el permiso.
 */
describe('llegar a /config por URL directa sin permiso de control', () => {
  function servir403() {
    server.use(
      http.get('http://localhost/v3/console/config', () => HttpResponse.json(
        { error: 'forbidden', message: 'control permission is required' }, { status: 403 },
      )),
      http.get('http://localhost/v3/console/access', () => HttpResponse.json({
        subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
      })),
    );
  }

  it('dice LO MISMO que la barra lateral, y no que no se pudo leer Cauce', async () => {
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(CONFIG_SIN_CONTROL_REASON)).toBeInTheDocument();
    expect(screen.queryByText('No se pudo leer Cauce V3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();
  });

  it('cita el 403 crudo del servidor y ofrece una salida real en vez de un reintento imposible', async () => {
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(/El servidor contestó 403/)).toBeInTheDocument();
    expect(screen.getByText('control permission is required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ir a la portada/i })).toHaveAttribute('href', '/');
  });

  it('un fallo que NO es de permiso sigue cayendo en el error genérico con su reintento', async () => {
    server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json(
      { error: 'internal', message: 'la base no responde' }, { status: 500 },
    )));
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText('No se pudo leer Cauce V3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.queryByText(CONFIG_SIN_CONTROL_REASON)).not.toBeInTheDocument();
  });
});
