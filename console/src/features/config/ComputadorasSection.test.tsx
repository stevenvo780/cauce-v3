import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { ConfigurationSnapshot } from '../../api/types';
import { ComputadorasSection } from './ComputadorasSection';

type Host = Record<string, unknown> & { host_id: string; version: number };

function computadora(host_id: string, overrides: Record<string, unknown> = {}): Host {
  return { host_id, display_name: `Equipo ${host_id}`, notes: '', enabled: true, status: 'reachable',
    status_source: 'controller', last_seen_at: '2026-10-08T10:00:00.000Z', registered: true, approved: true,
    version: 2, agents: [], ...overrides };
}

interface Write { method: string; url: string; body?: unknown }

/** The registry as the server serves it; every write is recorded and answered like the gateway does. */
function flota(hosts: Host[]): Write[] {
  const writes: Write[] = [];
  server.use(
    http.get('*/v3/console/fleet/hosts', () => HttpResponse.json({ hosts })),
    http.post('*/v3/console/fleet/hosts', async ({ request }) => {
      const body = await request.json() as { host_id: string; display_name: string };
      writes.push({ method: 'POST', url: request.url, body });
      return HttpResponse.json(computadora(body.host_id, { display_name: body.display_name, version: 1 }), { status: 201 });
    }),
    http.patch('*/v3/console/fleet/hosts/:hostId', async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>;
      writes.push({ method: 'PATCH', url: request.url, body });
      return HttpResponse.json(computadora(String(params.hostId), { version: Number(body.expected_version) + 1 }));
    }),
    http.delete('*/v3/console/fleet/hosts/:hostId', ({ request }) => {
      writes.push({ method: 'DELETE', url: request.url });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return writes;
}

const HUB_SNAPSHOT = {
  revision: 3,
  capabilities: { actor: { tenant_id: 'A', alias: 'hub', is_hub: true, can_control: true },
    resources: [{ resource: 'tenant', actions: ['create', 'update', 'delete'], scope: 'hub' }] },
} as unknown as ConfigurationSnapshot;
// A tenant operator with control gets a tenant-scoped tenants resource: the form gate alone would allow writes.
const TENANT_OPERATOR_SNAPSHOT = {
  revision: 3,
  capabilities: { actor: { tenant_id: 'A', alias: 'op', is_hub: false, can_control: true },
    resources: [{ resource: 'tenant', actions: ['create', 'update', 'delete'], scope: 'tenant', tenant_id: 'A' }] },
} as unknown as ConfigurationSnapshot;
const SIN_CAPACIDADES = { revision: 3 } as unknown as ConfigurationSnapshot;

function tarjeta(nombre: string) {
  return screen.getByRole('article', { name: nombre });
}

it('lista cada computadora con su estado, su fuente, su ejecutor y sus agentes', async () => {
  flota([
    computadora('uno', { agents: [{ tenant_id: 'A', alias: 'worker', enabled: true, online: true }] }),
    computadora('dos', { approved: false, status: 'unknown', status_source: 'none', last_seen_at: null }),
    computadora('tres', { registered: false, approved: false, version: 0, status: 'unknown', status_source: 'none' }),
  ]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);

  expect(await screen.findByText(/solo sus agentes dejan de estar disponibles/i)).toBeInTheDocument();
  const resumen = within(screen.getByRole('list', { name: 'Resumen de la flota' }));
  expect(resumen.getByText('Registradas').nextElementSibling).toHaveTextContent('2');
  expect(resumen.getByText('Sin registrar').nextElementSibling).toHaveTextContent('1');
  expect(resumen.getByText('Agentes').nextElementSibling).toHaveTextContent('1');
  expect(screen.getByRole('heading', { name: 'Detectadas sin registrar (1)' })).toBeInTheDocument();
  const uno = tarjeta('Equipo uno');
  expect(within(uno).getByText('uno')).toBeInTheDocument();
  expect(within(uno).getByText('Conectada')).toBeInTheDocument();
  expect(within(uno).getByText('Estado: según el controlador de flota')).toBeInTheDocument();
  expect(within(uno).getByText('Aprobada para crear agentes')).toBeInTheDocument();
  expect(within(uno).getByText('worker')).toBeInTheDocument();
  expect(within(uno).getByText('A, en línea')).toBeInTheDocument();

  const dos = tarjeta('Equipo dos');
  expect(within(dos).getByText('Sin datos')).toBeInTheDocument();
  expect(within(dos).getByText('Estado: ningún controlador ni agente lo ha reportado')).toBeInTheDocument();
  expect(within(dos).getByText('Pendiente: falta instalar y aprobar el ejecutor en esta computadora')).toBeInTheDocument();
  expect(within(dos).getByText('Nunca')).toBeInTheDocument();

  const tres = tarjeta('Equipo tres');
  expect(within(tres).getByText('Sin registrar')).toBeInTheDocument();
  expect(within(tres).getByText('Registra la computadora para aprobarla.')).toBeInTheDocument();
  expect(within(tres).getByRole('button', { name: 'Registrar' })).toBeEnabled();
  expect(within(tres).queryByRole('checkbox', { name: 'Habilitada' })).not.toBeInTheDocument();
});

it('registra una computadora nueva con su identificador, nombre y notas', async () => {
  const user = userEvent.setup();
  const writes = flota([]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  await user.click(await screen.findByRole('button', { name: 'Registrar computadora' }));
  await user.type(await screen.findByRole('textbox', { name: /identificador/i }), 'nueva-1');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Nueva uno');
  await user.type(screen.getByRole('textbox', { name: 'Notas' }), 'Rack del fondo');
  await user.click(screen.getByRole('button', { name: 'Guardar' }));

  await waitFor(() => { expect(writes).toHaveLength(1); });
  expect(writes[0]).toMatchObject({ method: 'POST', body: { host_id: 'nueva-1', display_name: 'Nueva uno', notes: 'Rack del fondo' } });
});

it('una computadora conocida sin registrar abre el formulario prellenado', async () => {
  const user = userEvent.setup();
  flota([computadora('tres', { registered: false, approved: false, version: 0, display_name: 'tres' })]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  await user.click(await within(await screen.findByRole('article', { name: 'tres' })).findByRole('button', { name: 'Registrar' }));
  expect(await screen.findByRole('form', { name: 'Registrar computadora' })).toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: /identificador/i })).toHaveValue('tres');
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('tres');
});

it('el interruptor de habilitada envía la versión esperada', async () => {
  const user = userEvent.setup();
  const writes = flota([computadora('uno', { version: 4 })]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  await user.click(await within(await screen.findByRole('article', { name: 'Equipo uno' })).findByRole('checkbox', { name: 'Habilitada' }));

  await waitFor(() => { expect(writes).toHaveLength(1); });
  expect(writes[0]).toMatchObject({ method: 'PATCH', body: { expected_version: 4, enabled: false } });
  expect(writes[0]?.url).toContain('/v3/console/fleet/hosts/uno');
});

it('eliminar solo aparece sin agentes y pide confirmación antes de borrar con la versión esperada', async () => {
  const user = userEvent.setup();
  const writes = flota([
    computadora('ocupada', { agents: [{ tenant_id: 'A', alias: 'worker', enabled: true, online: false }] }),
    computadora('vacia', { version: 7 }),
  ]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);

  const ocupada = await screen.findByRole('article', { name: 'Equipo ocupada' });
  expect(within(ocupada).queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
  expect(within(ocupada).getByText('Para eliminarla, quita antes sus agentes.')).toBeInTheDocument();

  await user.click(within(screen.getByRole('article', { name: 'Equipo vacia' })).getByRole('button', { name: 'Eliminar' }));
  const dialogo = await screen.findByRole('alertdialog');
  expect(within(dialogo).getByText(/no desinstala el ejecutor/i)).toBeInTheDocument();
  await user.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));

  await waitFor(() => { expect(writes).toHaveLength(1); });
  expect(writes[0]?.method).toBe('DELETE');
  expect(writes[0]?.url).toContain('/v3/console/fleet/hosts/vacia?expected_version=7');
});

it('un conflicto de versión del servidor se muestra en línea y no cambia la lista', async () => {
  const user = userEvent.setup();
  flota([computadora('uno', { version: 4 })]);
  server.use(http.patch('*/v3/console/fleet/hosts/:hostId', () => HttpResponse.json({ detail: 'version_conflict' }, { status: 409 })));
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  await user.click(await within(await screen.findByRole('article', { name: 'Equipo uno' })).findByRole('checkbox', { name: 'Habilitada' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Otro operador cambió esta computadora; relee.');
});

it('sin permiso de escritura, los controles de escritura quedan inertes', async () => {
  flota([computadora('uno')]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura />);
  expect(await screen.findByRole('button', { name: 'Registrar computadora' })).toBeDisabled();
  expect(await within(await screen.findByRole('article', { name: 'Equipo uno' })).findByRole('checkbox', { name: 'Habilitada' })).toBeDisabled();
});

it.each([
  ['un operador de inquilino con control', TENANT_OPERATOR_SNAPSHOT],
  ['una lectura sin capacidades', SIN_CAPACIDADES],
])('%s no puede escribir computadoras: los controles quedan deshabilitados', async (_, snapshot) => {
  flota([computadora('uno')]);
  renderWithApi(<ComputadorasSection snapshot={snapshot} soloLectura={false} />);
  expect(await screen.findByRole('button', { name: 'Registrar computadora' })).toBeDisabled();
  expect(screen.getByText(/Solo un hub puede registrar o cambiar computadoras/)).toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Equipo uno' })).getByRole('button', { name: 'Editar' })).toBeDisabled();
  expect(within(screen.getByRole('article', { name: 'Equipo uno' })).getByRole('checkbox', { name: 'Habilitada' })).toBeDisabled();
});

it('una lectura 403 muestra un aviso tranquilo de solo lectura, sin error', async () => {
  server.use(http.get('*/v3/console/fleet/hosts', () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  expect(await screen.findByText('Solo el hub administra computadoras.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('un alta con identificador repetido explica el duplicado, no un conflicto de versión', async () => {
  const user = userEvent.setup();
  flota([]);
  server.use(http.post('*/v3/console/fleet/hosts', () => HttpResponse.json({ detail: 'duplicate' }, { status: 409 })));
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  await user.click(await screen.findByRole('button', { name: 'Registrar computadora' }));
  await user.type(await screen.findByRole('textbox', { name: /identificador/i }), 'dup-1');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Duplicada');
  await user.click(screen.getByRole('button', { name: 'Guardar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una computadora con ese identificador.');
});

it('mientras se edita una computadora, su interruptor y su eliminación quedan bloqueados', async () => {
  const user = userEvent.setup();
  flota([computadora('uno', { version: 4 })]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  const tarjeta = await screen.findByRole('article', { name: 'Equipo uno' });
  await user.click(within(tarjeta).getByRole('button', { name: 'Editar' }));
  expect(within(tarjeta).getByRole('checkbox', { name: 'Habilitada', hidden: true })).toBeDisabled();
  expect(within(tarjeta).getByRole('button', { name: 'Eliminar', hidden: true })).toBeDisabled();
});

it('una computadora deshabilitada muestra una sola insignia y muchos agentes se pliegan', async () => {
  const user = userEvent.setup();
  const agentes = Array.from({ length: 9 }, (_, i) => ({ tenant_id: 'A', alias: `ag${String(i)}`, enabled: true, online: i % 2 === 0 }));
  flota([computadora('uno', { enabled: false, agents: agentes })]);
  renderWithApi(<ComputadorasSection snapshot={HUB_SNAPSHOT} soloLectura={false} />);
  const uno = await screen.findByRole('article', { name: 'Equipo uno' });
  expect(within(uno).getByText('Deshabilitada')).toBeInTheDocument();
  expect(within(uno).queryByText('Conectada')).not.toBeInTheDocument();
  expect(within(uno).queryByText('ag8')).not.toBeInTheDocument();
  await user.click(within(uno).getByRole('button', { name: '+3 más' }));
  expect(within(uno).getByText('ag8')).toBeInTheDocument();
});
