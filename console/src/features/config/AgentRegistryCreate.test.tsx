import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';

beforeEach(() => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })));
});

interface ChangeBody {
  dry_run: boolean;
  expected_revision: number;
  mutation: Record<string, unknown>;
}

const initial: ConfigurationSnapshot = {
  revision: 4, tenants: [{ id: 'A', display_name: 'Tenant A' }],
  agents: [], memberships: [], rooms: [], harness_definitions: [{ id: 'codex' }],
};

function access(permissions: string[] = ['config.read', 'config.write']) {
  return http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'Tenant:operator', roles: ['operator'], permissions,
  }));
}

function receipt(body: ChangeBody, applied: boolean, revision = 4) {
  return {
    applied, dry_run: !applied, revision, rolled_back_revision_id: null,
    summary: applied ? 'create agent A/worker' : 'create agent A/worker',
    mutation: body.mutation,
    inverse_mutation: { resource: 'agent', action: 'delete', tenant_id: 'A', alias: 'worker' },
  };
}

function renderSettings(snapshot = initial) {
  return renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
}

async function openAndFill() {
  renderSettings();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  return user;
}

it('is read-only when config.write is absent or unknown', async () => {
  server.use(access(['config.read']));
  renderSettings();
  await screen.findByRole('button', { name: 'Añadir agente' });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Añadir agente' }));
  expect(await screen.findByText(/Tu cuenta no tiene permiso para modificar este registro/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar alta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('fails closed when the permission snapshot cannot be read', async () => {
  server.use(http.get('http://localhost/v3/console/access', () =>
    HttpResponse.json({ error: 'unavailable' }, { status: 500 })));
  renderSettings();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  expect(await screen.findByText(/Tu cuenta no tiene permiso para modificar este registro, o no pudimos verificarlo/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar alta' })).toBeDisabled();
});

it('sends a record create after an exact dry-run and closes with focus returned', async () => {
  const changes: ChangeBody[] = [];
  server.use(
    access(),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      changes.push(body);
      return HttpResponse.json(receipt(body, !body.dry_run, body.dry_run ? 4 : 5), { status: body.dry_run ? 200 : 201 });
    }),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({ ...initial, revision: 5 })),
  );
  const user = await openAndFill();
  expect(screen.getByText(/El servidor lo verifica al previsualizar/)).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' })).toHaveValue(2);
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  expect(await screen.findByLabelText('Preview del alta de agente')).toHaveTextContent('"action": "create"');
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByText('Registro creado: A/worker.')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Terminar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(screen.getByRole('button', { name: 'Añadir agente' })).toHaveFocus();
  expect(changes.map(({ dry_run, expected_revision }) => [dry_run, expected_revision])).toEqual([[true, 4], [false, 4]]);
  expect(changes[0]?.mutation).toMatchObject({
    resource: 'agent', action: 'create', tenant_id: 'A', alias: 'worker',
    value: { display_name: 'Worker', enabled: false, max_concurrent_deliveries: 2 },
  });
  expect(changes[0]?.mutation).not.toHaveProperty('room_id');
});

it('invalidates the exact preview after a draft edit', async () => {
  server.use(access(), http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const body = await request.json() as ChangeBody;
    return HttpResponse.json(receipt(body, false));
  }));
  const user = await openAndFill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), ' revisado');
  expect(screen.queryByLabelText('Preview del alta de agente')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('reports a hub-only 403 from the server and never enables apply', async () => {
  server.use(access(), http.post('http://localhost/v3/console/config/changes', () =>
    HttpResponse.json({ error: 'forbidden', message: 'operator must be hub' }, { status: 403 })));
  const user = await openAndFill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/operator must be hub/);
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('reports a 409 conflict and invalidates the preview', async () => {
  server.use(
    access(),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      return body.dry_run
        ? HttpResponse.json(receipt(body, false))
        : HttpResponse.json({ error: 'conflict', message: 'revision changed: expected 4, current 5' }, { status: 409 });
    }),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({ ...initial, revision: 5 })),
  );
  const user = await openAndFill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Conflicto de revisión/);
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('reports an accepted registration as partial when snapshot reload fails', async () => {
  server.use(
    access(),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      return HttpResponse.json(receipt(body, !body.dry_run, body.dry_run ? 4 : 5), { status: body.dry_run ? 200 : 201 });
    }),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({ error: 'unavailable' }, { status: 503 })),
  );
  const user = await openAndFill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  expect(await screen.findByText(/relectura del inventario no llegó/i)).toBeInTheDocument();
  expect(screen.getByText('Registro creado: A/worker.')).toBeInTheDocument();
});

it('closes with Escape and restores focus to the opener', async () => {
  server.use(access());
  renderSettings();
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Añadir agente' });
  await user.click(trigger);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('opens on the alias field and keeps the advanced inputs folded until asked', async () => {
  server.use(access());
  renderSettings();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Alias' })).toHaveFocus(); });
  const details = screen.getByText('Entorno de ejecución (opcional)').closest('details');
  expect(details).not.toHaveAttribute('open');
  await user.click(screen.getByText('Entorno de ejecución (opcional)'));
  expect(details).toHaveAttribute('open');
});

it('keeps every field of the dialog disabled in read-only mode', async () => {
  server.use(access(['config.read']));
  renderSettings();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Alias' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previsualizar alta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
});

it('reopens with an empty draft and uses the newer prop snapshot over an older reread', async () => {
  server.use(
    access(),
    http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
      const body = await request.json() as ChangeBody;
      return HttpResponse.json(receipt(body, !body.dry_run, body.dry_run ? 4 : 5), { status: body.dry_run ? 200 : 201 });
    }),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json({
      ...initial, revision: 5, tenants: [{ id: 'A', display_name: 'Old tenant' }],
    })),
  );
  const view = renderSettings();
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Añadir agente' });
  await user.click(trigger);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  await user.click(screen.getByRole('button', { name: 'Previsualizar alta' }));
  await screen.findByLabelText('Preview del alta de agente');
  await user.click(screen.getByRole('button', { name: 'Crear registro' }));
  await screen.findByText('Registro creado: A/worker.');
  await user.click(screen.getByRole('button', { name: 'Terminar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });

  view.rerender(<ConsoleAccessBoundary><AgentesSection snapshot={{
    ...initial, revision: 6, tenants: [{ id: 'B', display_name: 'New tenant' }],
    harness_definitions: [{ id: 'gemini' }],
  }} /></ConsoleAccessBoundary>);
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  expect(screen.getByRole('textbox', { name: 'Alias' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('');
  expect(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' })).toHaveValue(2);
  expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toHaveDisplayValue('Elige un espacio de trabajo');
  expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toHaveTextContent('New tenant');
  expect(screen.getByRole('combobox', { name: 'Tipo de agente (opcional)' })).toHaveTextContent('gemini');
});

it('preserves the draft when the operator cancels and reopens', async () => {
  server.use(access());
  renderSettings();
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Añadir agente' });
  await user.click(trigger);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  await user.keyboard('{Escape}');
  await user.click(trigger);
  expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toHaveValue('A');
  expect(screen.getByRole('textbox', { name: 'Alias' })).toHaveValue('worker');
  expect(screen.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Worker');
});
