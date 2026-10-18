import { act, screen, waitFor } from '@testing-library/react';
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

const PERMISOS = /acceso y roles/i;

type Usuario = ReturnType<typeof userEvent.setup>;

async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
  // Sections load lazily: the panel is only usable once its chunk has arrived.
  await waitFor(() => { expect(screen.queryAllByText(/cargando sección/i)).toHaveLength(0); });
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

function appliedReadReceipt(body: ChangeRequest, revision: number) {
  return HttpResponse.json({
    applied: true, dry_run: false, revision, mutation: body.mutation,
    inverse_mutation: {
      resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Miguel',
      value: { enabled: true, allow_route: true, allow_read: false, allow_control: false },
    },
    rolled_back_revision_id: null, summary: 'permiso actualizado',
  }, { status: 201 });
}

// --- What Steven asked for: switches, not buttons --------------------------------------------

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });

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

it('conserva el valor pedido en vuelo y respeta un snapshot más nuevo al terminar con una relectura fallida', async () => {
  let current = snapshot(1);
  let failRead = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.get('*/v3/console/config', () => failRead
      ? HttpResponse.json({ error: 'internal', message: 'snapshot unavailable' }, { status: 500 })
      : HttpResponse.json(current)),
    http.post('*/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeRequest;
      await pending;
      failRead = true;
      return appliedReadReceipt(body, 2);
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, PERMISOS);
  await user.click(screen.getByRole('switch', { name: LECTURA }));
  expect(screen.getByRole('switch', { name: LECTURA })).toHaveAttribute('aria-busy', 'true');

  current = snapshot(3, { allow_route: false, allow_read: false });
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  await waitFor(() => { expect(screen.getByRole('switch', { name: RUTA })).not.toBeChecked(); });
  expect(screen.getByRole('switch', { name: LECTURA })).toBeChecked();
  expect(screen.getByRole('switch', { name: LECTURA })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('switch', { name: LECTURA })).toBeDisabled();

  await act(async () => { release(); await pending; });
  await waitFor(() => { expect(screen.getByRole('switch', { name: LECTURA })).not.toHaveAttribute('aria-busy'); });
  expect(screen.getByRole('switch', { name: LECTURA })).not.toBeChecked();
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
