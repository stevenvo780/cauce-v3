import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';

const CHANGES = 'http://localhost/v3/console/config/changes';
const CONFIG = 'http://localhost/v3/console/config';
const HOSTS = 'http://localhost/v3/console/fleet/hosts';

interface ChangeBody { dry_run: boolean; expected_revision: number; mutation: Record<string, unknown> }

const base: ConfigurationSnapshot = {
  revision: 4,
  tenants: [{ id: 'A', display_name: 'Tenant A' }],
  agents: [], memberships: [], rooms: [{ tenant_id: 'A', id: 'grp.a', display_name: 'Grupo A' }],
  harness_definitions: [{ id: 'codex' }],
};

function host(hostId: string, overrides: Record<string, unknown> = {}) {
  return {
    host_id: hostId, display_name: hostId.toUpperCase(), notes: '', enabled: true, status: 'reachable',
    status_source: 'controller', last_seen_at: null, registered: true, approved: true, version: 1, agents: [],
    ...overrides,
  };
}

beforeEach(() => {
  server.use(
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
      available: false, actions: [], placements: [], reason: 'executor_unconfigured',
    })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
});

function access(permissions = ['config.read', 'config.write']) {
  return http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'Tenant:operator', roles: ['operator'], permissions,
  }));
}

function receipt(body: ChangeBody, revision: number) {
  return {
    applied: !body.dry_run, dry_run: body.dry_run, revision, rolled_back_revision_id: null,
    summary: `${String(body.mutation.resource)} ${String(body.mutation.action)}`, mutation: body.mutation,
    inverse_mutation: { resource: 'agent', action: 'delete', tenant_id: 'A', alias: 'worker' },
  };
}

function renderSection(snapshot: ConfigurationSnapshot) {
  return renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
}

it('creates the registry row on its computer, then the initial room membership, in that order', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    access(),
    http.get(HOSTS, () => HttpResponse.json({ hosts: [host('edge-1')] })),
    http.post(CHANGES, async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      const revision = body.dry_run ? body.expected_revision : body.expected_revision + 1;
      return HttpResponse.json(receipt(body, revision), { status: body.dry_run ? 200 : 201 });
    }),
    http.get(CONFIG, () => HttpResponse.json({ ...base, revision: 5 })),
  );
  renderSection(base);
  const user = userEvent.setup();
  await openDialog(user);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Computadora (opcional)' }), 'edge-1');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Sala inicial (opcional)' }), 'grp.a');
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByText('Sala inicial: Grupo A, creada.')).toBeInTheDocument();
  expect(screen.getByText('Computadora: EDGE-1')).toBeInTheDocument();
  expect(changes.map(({ dry_run, mutation, expected_revision }) => [mutation.resource, dry_run, expected_revision])).toEqual([
    ['agent', true, 4], ['agent', false, 4], ['membership', true, 5], ['membership', false, 5],
  ]);
  expect(changes[0]?.mutation).toMatchObject({ action: 'create', alias: 'worker', value: { host_id: 'edge-1' } });
  expect(changes[2]?.mutation).toEqual({
    resource: 'membership', action: 'create', tenant_id: 'A', room_id: 'grp.a', alias: 'worker', value: { role: 'agent', enabled: true },
  });
});

it('keeps unusable computers visible but disabled, with the reason', async () => {
  server.use(
    access(),
    http.get(HOSTS, () => HttpResponse.json({
      hosts: [host('edge-1'), host('edge-2', { status: 'unreachable' }), host('edge-3', { enabled: false })],
    })),
  );
  renderSection(base);
  const user = userEvent.setup();
  await openDialog(user);
  expect(await screen.findByRole('option', { name: 'EDGE-1' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'EDGE-2 · sin conexión' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'EDGE-3 · deshabilitada' })).toBeDisabled();
});

it('replaces the create and edit actions with the hub reason when the capability denies agents', async () => {
  const gated = {
    ...base,
    capabilities: {
      actor: { tenant_id: 'A', is_hub: false, can_control: true },
      resources: [{ resource: 'agent', actions: ['create', 'update', 'delete'], scope: 'hub' }],
    },
  } as unknown as ConfigurationSnapshot;
  server.use(access(), http.get(HOSTS, () => HttpResponse.json({ hosts: [] })));
  renderSection(gated);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  expect(screen.getByText('Solo el hub administra agentes')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar alta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('explains in Spanish why preparing on the computer is unavailable after the registry row is created', async () => {
  server.use(
    access(),
    http.get(HOSTS, () => HttpResponse.json({ hosts: [host('edge-1')] })),
    http.post(CHANGES, async ({ request }) => {
      const body = await request.json() as ChangeBody;
      return HttpResponse.json(receipt(body, body.dry_run ? body.expected_revision : body.expected_revision + 1),
        { status: body.dry_run ? 200 : 201 });
    }),
    http.get(CONFIG, () => HttpResponse.json({ ...base, revision: 5 })),
  );
  renderSection(base);
  const user = userEvent.setup();
  await openDialog(user);
  await screen.findByRole('option', { name: 'EDGE-1' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computadora (opcional)' }), 'edge-1');
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByText('El ejecutor de flota no está configurado en el servidor.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preparar en la computadora' })).not.toBeInTheDocument();
});

it('sin computadora elegida, el resultado pide asignarla en Editar registro antes de preparar', async () => {
  server.use(
    access(),
    http.get(HOSTS, () => HttpResponse.json({ hosts: [host('edge-1')] })),
    http.post(CHANGES, async ({ request }) => {
      const body = await request.json() as ChangeBody;
      return HttpResponse.json(receipt(body, body.dry_run ? body.expected_revision : body.expected_revision + 1),
        { status: body.dry_run ? 200 : 201 });
    }),
    http.get(CONFIG, () => HttpResponse.json({ ...base, revision: 5 })),
  );
  renderSection(base);
  const user = userEvent.setup();
  await openDialog(user);
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByText('Asigna una computadora en Editar registro para prepararlo.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preparar en la computadora' })).not.toBeInTheDocument();
});

it('una lectura 403 de computadoras no muestra error en el alta', async () => {
  server.use(access(), http.get(HOSTS, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
  renderSection(base);
  const user = userEvent.setup();
  await openDialog(user);
  expect(screen.getByRole('combobox', { name: 'Computadora (opcional)' })).toHaveValue('');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/No se pudo leer el registro de computadoras/)).not.toBeInTheDocument();
});
