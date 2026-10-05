import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { renderWithApi } from '../../test/render';
import { AgentSettings } from './AgentSettings';

const fullAgent = {
  tenant_id: 'A', alias: 'one', display_name: 'Agente uno', harness_id: 'codex', enabled: true,
  max_concurrent_deliveries: 1, container_name: 'agent-one', runtime_user: 'runner',
  home_directory: '/home/runner', state_directory: '/var/lib/runner',
};
const snapshot: ConfigurationSnapshot = { revision: 4, agents: [fullAgent], memberships: [], rooms: [] };

interface ChangeBody { dry_run: boolean; expected_revision: number; mutation: Record<string, unknown> }

function receipt(body: ChangeBody, applied: boolean, revision: number, mutation = body.mutation) {
  return {
    applied, dry_run: !applied, revision, rolled_back_revision_id: null, summary: 'Registro validado',
    mutation, inverse_mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: true } },
  };
}

function renderSettings(initial = snapshot) {
  renderWithApi(<ConsoleAccessBoundary><AgentSettings snapshot={initial} /></ConsoleAccessBoundary>);
}

function registryAccess() {
  return http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
  }));
}

it('previews the fixed row identity, invalidates a stale preview, applies its exact receipt and rereads', async () => {
  let current = snapshot;
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(current)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      if (!body.dry_run) {
        const value = body.mutation.value as Record<string, unknown>;
        current = {
          ...current, revision: 5,
          agents: [{ ...fullAgent, ...value }],
        };
      }
      return HttpResponse.json(receipt(body, !body.dry_run, body.dry_run ? 4 : 5), { status: body.dry_run ? 200 : 201 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  const capacity = screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' });
  await user.clear(capacity);
  await user.type(capacity, '2');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  const preview = await screen.findByLabelText('Preview del registro de agente');
  expect(preview).toHaveTextContent('"tenant_id": "A"');
  expect(preview).toHaveTextContent('"alias": "one"');
  expect(preview).toHaveTextContent('"max_concurrent_deliveries": 2');
  expect(preview).not.toHaveTextContent('"container_name"');
  const apply = screen.getByRole('button', { name: 'Aplicar cambio' });
  expect(apply).toBeEnabled();
  await user.clear(screen.getByRole('textbox', { name: 'Nombre visible' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Agente renovado');
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(apply).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  await user.click(apply);
  await screen.findByText(/Aplicado en revisión 5/);
  await waitFor(() => { expect(screen.getByText('Agente renovado')).toBeInTheDocument(); });
  expect(changes).toHaveLength(3);
  expect(changes.map(({ dry_run, expected_revision }) => [dry_run, expected_revision])).toEqual([
    [true, 4], [true, 4], [false, 4],
  ]);
  expect(changes[0]?.mutation).toMatchObject({ resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { max_concurrent_deliveries: 2 } });
  expect(changes[2]?.mutation).toMatchObject({ resource: 'agent', tenant_id: 'A', alias: 'one', value: { max_concurrent_deliveries: 2, display_name: 'Agente renovado' } });
});

it('keeps placement atomic and rejects a partial edit locally', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({
      ...snapshot, agents: [{ tenant_id: 'A', alias: 'one', enabled: true }],
    })),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      changes.push(await request.json() as ChangeBody);
      return HttpResponse.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  const user = userEvent.setup();
  renderSettings({ ...snapshot, agents: [{ tenant_id: 'A', alias: 'one', enabled: true }] });
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre del contenedor' }), 'container-new');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Placement es atómico/);
  expect(changes).toHaveLength(0);
});

it('sends an explicit null cap and a complete placement tuple when those choices change', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      return HttpResponse.json(receipt(body, false, 4), { status: 200 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  await user.click(screen.getByRole('checkbox', { name: /Sin límite/ }));
  await user.clear(screen.getByRole('textbox', { name: 'Nombre del contenedor' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre del contenedor' }), 'agent-replaced');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  expect(changes).toHaveLength(1);
  expect(changes[0]?.mutation).toMatchObject({
    resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one',
    value: {
      max_concurrent_deliveries: null, container_name: 'agent-replaced', runtime_user: 'runner',
      home_directory: '/home/runner', state_directory: '/var/lib/runner',
    },
  });
});

it('does not offer registry editing for a membership-only identity', async () => {
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({
      revision: 2, agents: [], memberships: [{ tenant_id: 'A', alias: 'member', room_id: 'grp.a' }], rooms: [],
    })),
  );
  renderSettings({ revision: 2, agents: [], memberships: [{ tenant_id: 'A', alias: 'member', room_id: 'grp.a' }], rooms: [] });
  expect(await screen.findByRole('button', { name: 'Abrir contexto de A/member' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Editar registro de A/member' })).not.toBeInTheDocument();
});

it('shows a hub-only 403 from preview and never enables apply', async () => {
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json({
      error: 'forbidden', message: 'agent registry requires hub control',
    }, { status: 403 })),
  );
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Estado del registro' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/403|forbidden|hub control/i);
  expect(screen.getByRole('button', { name: 'Aplicar cambio' })).toBeDisabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('reconciles a stale-revision conflict and does not retain its preview', async () => {
  let current = snapshot;
  const changes: ChangeBody[] = [];
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(current)),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      if (body.dry_run) return HttpResponse.json(receipt(body, false, body.expected_revision), { status: 200 });
      return HttpResponse.json({ error: 'conflict', message: 'revision changed: expected 4, current 5' }, { status: 409 });
    }),
  );
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Estado del registro' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  current = {
    ...snapshot, revision: 5,
    agents: [{ ...fullAgent, display_name: 'Cambio concurrente', max_concurrent_deliveries: 2,
      container_name: 'container-concurrente', runtime_user: 'runner-next', home_directory: '/home/next',
      state_directory: '/var/lib/next' }],
  };
  await user.click(screen.getByRole('button', { name: 'Aplicar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Conflicto de revisión/);
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aplicar cambio' })).toBeDisabled();
  expect(await screen.findByRole('note')).toHaveTextContent(/Se descartó el borrador y se cargaron los valores actuales/);
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Cambio concurrente');
  expect(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' })).toHaveValue(2);
  expect(screen.getByRole('textbox', { name: 'Nombre del contenedor' })).toHaveValue('container-concurrente');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Estado del registro' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  await screen.findByLabelText('Preview del registro de agente');
  expect(changes).toHaveLength(3);
  expect(changes[2]).toMatchObject({ expected_revision: 5, dry_run: true,
    mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: false } } });
  expect(changes[2]?.mutation).not.toHaveProperty('value.display_name');
  expect(changes[2]?.mutation).not.toHaveProperty('value.max_concurrent_deliveries');
  expect(changes[2]?.mutation).not.toHaveProperty('value.container_name');
});

it('does not enable apply when the server preview omits the exact receipt', async () => {
  server.use(
    registryAccess(),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
    http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json({
      applied: false, dry_run: true, revision: 4, summary: 'preview without receipt',
      mutation: { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { enabled: false } },
      inverse_mutation: null,
    }, { status: 200 })),
  );
  const user = userEvent.setup();
  renderSettings();
  await user.click(await screen.findByRole('button', { name: 'Editar registro de A/one' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Estado del registro' }), 'false');
  await user.click(screen.getByRole('button', { name: 'Previsualizar cambio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/recibo exacto/);
  expect(screen.queryByLabelText('Preview del registro de agente')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aplicar cambio' })).toBeDisabled();
});
