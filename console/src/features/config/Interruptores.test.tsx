import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/**
 * Switch testing and optimistic state rollback: guarantees that rejected mutations (e.g. 409)
 * revert optimistic switch toggles, preventing UI desynchronization with the database.
 */

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

const PERMISOS = /^permisos$/i;
const ESPACIOS = /espacios y miembros/i;

type Usuario = ReturnType<typeof userEvent.setup>;

async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

/** The snapshot these tests serve. A single edge, so the table stays readable. */
function snapshot(revision: number, arista: Record<string, unknown> = {}) {
  return {
    revision,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Steven', display_name: 'Steven', is_hub: true, enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    rooms: [],
    memberships: [],
    acl_edges: [{
      from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true,
      allow_route: true, allow_read: false, allow_control: false,
      created_at: '2026-07-01T10:00:00.000Z',
      ...arista,
    }],
    role_policies: [],
    revisions: [],
  };
}

function servirConfig(cuerpo: () => Record<string, unknown>) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(cuerpo())));
}

function registrarCambios(sink: ChangeRequest[], respuesta?: () => Response) {
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    sink.push(await request.json() as ChangeRequest);
    if (respuesta) return respuesta();
    return HttpResponse.json(
      { applied: true, dry_run: false, revision: 2, mutation: {}, summary: 'ok' },
      { status: 201 },
    );
  }));
}

const RUTA = 'Ruta en la arista Steven → Miguel';
const LECTURA = 'Lectura en la arista Steven → Miguel';
const CONTROL = 'Control en la arista Steven → Miguel';

// --- What Steven asked for: switches, not buttons --------------------------------------------

it('los permisos son INTERRUPTORES y la columna de botones ya no existe', async () => {
  servirConfig(() => snapshot(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  const heading = screen.getByRole('heading', { name: /directed acl/i });
  const acl = heading.closest('section');
  expect(acl).not.toBeNull();
  if (acl) {
    // Four switches per edge: the master and the three permissions.
    expect(within(acl).getAllByRole('switch')).toHaveLength(4);
    // And ZERO text buttons: they were "Disable", "Remove allow_route", "Remove allow_read"
    // and "Remove allow_control", stacked in an "Actions" column that stretched the row to 147 px.
    expect(within(acl).queryByRole('button', { name: /^deshabilitar/i })).not.toBeInTheDocument();
    expect(within(acl).queryByRole('button', { name: /quitar allow_/i })).not.toBeInTheDocument();
    expect(within(acl).queryByRole('button', { name: /conceder allow_/i })).not.toBeInTheDocument();
    expect(within(acl).queryByRole('columnheader', { name: /acciones/i })).not.toBeInTheDocument();

    // And the switch STATES the state: no need for a pill next to it repeating it.
    expect(within(acl).getByRole('switch', { name: RUTA })).toBeChecked();
    expect(within(acl).getByRole('switch', { name: LECTURA })).not.toBeChecked();
  }
});

it('las cabeceras dejan de ser nombres de columna de Postgres y explican qué conceden', async () => {
  servirConfig(() => snapshot(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  const heading = screen.getByRole('heading', { name: /directed acl/i });
  const acl = heading.closest('section');
  expect(acl).not.toBeNull();
  if (acl) {
    expect(within(acl).getAllByRole('columnheader').map((celda) => celda.textContent.replace(/[?:].*/s, '').trim()))
      .toEqual(['Arista', 'Habilitado', 'Ruta', 'Lectura', 'Control', 'Alta']);
    // The explanation lives in the DOM itself — not only in a `title` the keyboard cannot reach
    // — so it can be read without a mouse.
    expect(within(acl).getByText(/ESCRIBA sobre el de la derecha/)).toBeInTheDocument();
  }
});

it('un permiso se aplica AL PULSARLO, sin ninguna confirmación en el medio', async () => {
  const cambios: ChangeRequest[] = [];
  servirConfig(() => snapshot(1));
  registrarCambios(cambios);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: LECTURA }));

  // No "are you sure?": the mutation travels with the click.
  await waitFor(() => { expect(cambios).toHaveLength(1); });
  expect(cambios[0]).toEqual({
    dry_run: false,
    expected_revision: 1,
    mutation: {
      resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Miguel',
      value: { allow_read: true },
    },
  });
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
});

// --- THE NEGATIVE CONTROL --------------------------------------------------------------------

it('CONTROL NEGATIVO: si el servidor RECHAZA, el interruptor vuelve SOLO a su valor anterior', async () => {
  servirConfig(() => snapshot(1));
  server.use(http.post('*/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'acl edge has active deliveries' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  const lectura = await screen.findByRole('switch', { name: LECTURA });
  expect(lectura).not.toBeChecked();
  await user.click(lectura);

  // The only thing that cannot be negotiated: the painted state goes back to what the DB has.
  await waitFor(() => { expect(screen.getByRole('switch', { name: LECTURA })).not.toBeChecked(); });

  // And the reason is THE SERVER'S, not a "could not apply" invented by the console.
  const alerta = await screen.findByRole('alert');
  expect(alerta).toHaveTextContent('acl edge has active deliveries');
  expect(alerta).toHaveTextContent(/no se aplicó/i);
  expect(alerta).toHaveTextContent(/volvió solo/i);
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
});

it('CONTROL NEGATIVO: tras un 4xx NINGÚN interruptor de la tabla queda en estado optimista', async () => {
  // Sweep: it is not enough to check the one that was clicked. If the optimistic map were
  // cleaned up poorly, a NEIGHBOUR switch could end up painted with a value nobody saved.
  servirConfig(() => snapshot(1, { enabled: true, allow_route: true, allow_read: false, allow_control: false }));
  server.use(http.post('*/v3/console/config/changes', () => HttpResponse.json(
    { error: 'forbidden', message: 'control permission is required' },
    { status: 403 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  const esperado = new Map([
    ['Habilitado en la arista Steven → Miguel', true],
    [RUTA, true],
    [LECTURA, false],
    [CONTROL, false],
  ]);

  for (const nombre of esperado.keys()) {
    await user.click(screen.getByRole('switch', { name: nombre }));
    await screen.findByRole('alert');
    for (const [otro, valor] of esperado) {
      const interruptor = screen.getByRole('switch', { name: otro });
      if (valor) expect(interruptor).toBeChecked();
      else expect(interruptor).not.toBeChecked();
    }
  }
});

it('«Reintentar» vuelve a mandar la MISMA mutación, no una distinta', async () => {
  const cambios: ChangeRequest[] = [];
  servirConfig(() => snapshot(1));
  let fallar = true;
  registrarCambios(cambios, () => (fallar
    ? HttpResponse.json({ error: 'internal', message: 'store unavailable' }, { status: 500 })
    : HttpResponse.json({ applied: true, dry_run: false, revision: 2, summary: 'ok' }, { status: 201 })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: LECTURA }));
  await screen.findByRole('alert');
  expect(screen.getByRole('switch', { name: LECTURA })).not.toBeChecked();

  fallar = false;
  await user.click(screen.getByRole('button', { name: /reintentar/i }));
  await waitFor(() => { expect(cambios).toHaveLength(2); });
  expect(cambios[1]?.mutation).toEqual(cambios[0]?.mutation);
});

it('mientras la escritura vuela, el interruptor pinta lo pedido y lo declara con aria-busy', async () => {
  servirConfig(() => snapshot(1));
  let soltar: (() => void) | undefined;
  const trabada = new Promise<void>((resolve) => { soltar = resolve; });
  server.use(http.post('*/v3/console/config/changes', async () => {
    await trabada;
    return HttpResponse.json({ applied: true, dry_run: false, revision: 2, summary: 'ok' }, { status: 201 });
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: LECTURA }));
  // The new state is visible instantly — that is the optimistic bit — BUT it says it is not yet
  // confirmed: without `aria-busy`, an unverified value looks identical to a saved one.
  await waitFor(() => { expect(screen.getByRole('switch', { name: LECTURA })).toBeChecked(); });
  expect(screen.getByRole('switch', { name: LECTURA })).toHaveAttribute('aria-busy', 'true');

  soltar?.();
  await waitFor(() => { expect(screen.getByRole('switch', { name: LECTURA })).not.toHaveAttribute('aria-busy'); });
});

it('si el servidor guarda pero la RELECTURA falla, no se afirma que la tabla esté al día', async () => {
  let releer = false;
  server.use(http.get('*/v3/console/config', () => (releer
    ? HttpResponse.json({ error: 'internal', message: 'snapshot unavailable' }, { status: 500 })
    : HttpResponse.json(snapshot(1)))));
  server.use(http.post('*/v3/console/config/changes', () => {
    releer = true;
    return HttpResponse.json({ applied: true, dry_run: false, revision: 2, summary: 'ok' }, { status: 201 });
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: LECTURA }));
  expect(await screen.findByText(/la relectura del snapshot NO llegó/i)).toBeInTheDocument();
});

// --- The only confirmation left -------------------------------------------------------------

it('quitar Control SÍ confirma, y cancelar no manda nada ni mueve el interruptor', async () => {
  const cambios: ChangeRequest[] = [];
  servirConfig(() => snapshot(1, { allow_control: true }));
  registrarCambios(cambios);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: CONTROL }));
  expect(cambios).toEqual([]);
  expect(screen.getByRole('switch', { name: CONTROL })).toBeChecked();
  expect(screen.getByText(/no vas a poder devolvértelo desde acá/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^cancelar$/i }));
  expect(cambios).toEqual([]);
  expect(screen.getByRole('switch', { name: CONTROL })).toBeChecked();

  await user.click(screen.getByRole('switch', { name: CONTROL }));
  await user.click(screen.getByRole('button', { name: /^quitar control$/i }));
  await waitFor(() => { expect(cambios).toHaveLength(1); });
  expect(cambios[0]?.mutation).toMatchObject({ value: { allow_control: false } });
});

it('CONCEDER Control no confirma nada: se deshace con otro clic en el mismo interruptor', async () => {
  const cambios: ChangeRequest[] = [];
  servirConfig(() => snapshot(1));
  registrarCambios(cambios);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  await user.click(await screen.findByRole('switch', { name: CONTROL }));
  await waitFor(() => { expect(cambios).toHaveLength(1); });
  expect(cambios[0]?.mutation).toMatchObject({ value: { allow_control: true } });
});

// --- Spaces and members ----------------------------------------------------------------------

it('«Espacios y miembros» pierde los treinta botones «Deshabilitar» y gana interruptores', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ESPACIOS);
  await screen.findByRole('heading', { name: 'Tenants' });

  const area = screen.getByRole('tabpanel', { name: /espacios y miembros/i });
  expect(within(area).queryAllByRole('button', { name: 'Deshabilitar' })).toHaveLength(0);
  expect(within(area).queryAllByRole('button', { name: 'Habilitar' })).toHaveLength(0);
  // 5 tenants + 8 rooms + 19 memberships from the mocks fixture.
  expect(within(area).getAllByRole('switch').length).toBeGreaterThanOrEqual(32);

  // And the disabled memberships from the fixture appear disabled, not with an "Enable" button.
  expect(within(area).getByRole('switch', { name: 'Habilitado en la membresía Miguel/ops.miguel/atlas' }))
    .not.toBeChecked();
});

it('«Alta rápida» y el wizard dejan de estar los dos abiertos: son dos modos del MISMO alta', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ESPACIOS);

  // On entering, ONE is visible. The other is not hidden: it is one click away, with a label
  // that says when it is the right call.
  expect(await screen.findByRole('heading', { name: /alta rápida/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /wizard de espacios/i })).not.toBeInTheDocument();

  // Segmented, not a tab: see `AltaDeEspacios`.
  await user.click(screen.getByRole('button', { name: /espacio completo/i }));
  expect(await screen.findByRole('heading', { name: /wizard de espacios/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /alta rápida/i })).not.toBeInTheDocument();
});

it('el JSON crudo del alta deja de estar abierto por defecto', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ESPACIOS);

  const crudo = (await screen.findByLabelText('Mutación del alta')).closest('details');
  expect(crudo).not.toBeNull();
  expect(crudo).not.toHaveAttribute('open');
});

// --- Read-only --------------------------------------------------------------------------------

it('sin config.write los interruptores se ven y quedan INERTES, con el motivo escrito', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
  })));
  servirConfig(() => snapshot(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);

  // The data is still visible: a missing control does not distinguish "no permission" from "does not exist".
  const lectura = await screen.findByRole('switch', { name: LECTURA });
  expect(lectura).toBeInTheDocument();
  expect(lectura).toBeDisabled();
  expect(screen.getByText(/^Solo lectura:/)).toBeInTheDocument();
});
