import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }

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
  await user.click(await screen.findByRole('button', { name: /preview \/ dry-run/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/conflicto de revisión/i);
  expect(alert).toHaveTextContent(/revisión 1 y el servidor ya va por la 4/i);
  expect(alert).toHaveTextContent(/volvé a previsualizar/i);
  expect(screen.queryByLabelText(/resultado de preview/i)).not.toBeInTheDocument();
});

it('muestra las colecciones que el servidor publica más allá de las seis históricas', async () => {
  renderWithApi(<ConfigPage />);

  // Las dos que la lista fija de ConfigPage dejaba invisibles aunque el snapshot las trae.
  expect(await screen.findByRole('heading', { name: /chain visibility policy/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /proactive egress allowlist/i })).toBeInTheDocument();
  expect(screen.getByText(/"cycle_cut_enabled":true/)).toBeInTheDocument();
  expect(screen.getByText(/steven_dm/)).toBeInTheDocument();
});

it('no confunde una clave que el gateway no publica con una colección vacía', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: [], revisions: [],
  })));
  renderWithApi(<ConfigPage />);

  const tenants = (await screen.findByRole('heading', { name: 'Tenants' })).closest('section');
  expect(tenants).toHaveTextContent(/sin registros/i);
  const chain = screen.getByRole('heading', { name: /chain visibility policy/i }).closest('section');
  expect(chain).toHaveTextContent(/no publica esta colección/i);
});

it('acepta en el editor los recursos que el servidor acepta y la lista fija rechazaba', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /configuración/i });

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
  await user.click(await screen.findByRole('button', { name: /preview \/ dry-run/i }));

  expect(await screen.findByText('ACL edge already exists')).toBeInTheDocument();
  expect(screen.queryByText(/conflicto de revisión/i)).not.toBeInTheDocument();
});
