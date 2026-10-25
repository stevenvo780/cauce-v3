import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  irA, recordChanges, snapshotDeConfig, snapshotConAudit, servirConfig,
  type ChangeRequest,
} from './ConfigPage.test-helpers';

const HISTORIAL = /^avanzado$/i;

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion;
}

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });

it('previews and applies a default-deny ACL mutation through the protected API', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('heading', { level: 1, name: /ajustes/i })).toBeInTheDocument();
  expect(await screen.findByText(/Rol de esta sesión/i)).toBeInTheDocument();

  await irA(user, HISTORIAL);
  await user.click(screen.getByRole('button', { name: /previsualizar cambio/i }));
  expect(await screen.findByLabelText(/resultado de la vista previa/i)).toHaveTextContent('"dry_run": true');
  expect(screen.getByLabelText(/resultado de la vista previa/i)).toHaveTextContent('"allow_route": false');

  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  expect(await screen.findByText(/cambio aplicado/i)).toBeInTheDocument();
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

  await user.click(screen.getByRole('button', { name: /previsualizar cambio/i }));
  expect(await screen.findByText(/respondió sin el recibo exacto de la vista previa/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/resultado de la vista previa/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  expect(await screen.findByText(/puede haberse aplicado/i)).toBeInTheDocument();
  expect(screen.queryByText(/cambio aplicado/i)).not.toBeInTheDocument();
}, 20_000);

it('distingue el 409 por revisión vencida y pide volver a previsualizar', async () => {
  server.use(http.post('http://localhost/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'configuration revision changed: expected 1, current 4' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);
  await user.click(await screen.findByRole('button', { name: /previsualizar cambio/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/conflicto de revisión/i);
  expect(alert).toHaveTextContent(/revisión 1 y el servidor ya va por la 4/i);
  expect(alert).toHaveTextContent(/vuelve a previsualizar/i);
  expect(screen.queryByLabelText(/resultado de la vista previa/i)).not.toBeInTheDocument();
});

it('rechaza agents.role_brief localmente y no emite ni preview ni apply', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, HISTORIAL);

  fireEvent.change(screen.getByLabelText('Mutación JSON'), { target: { value: JSON.stringify({
    resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'kant',
    value: { role_brief: 'Eres kant.' },
  }) } });

  await user.click(screen.getByRole('button', { name: /previsualizar cambio/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/proyección diagnóstica de solo lectura/i);
  expect(screen.getByRole('alert')).toHaveTextContent(/«Perfil y contexto»/);
  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  expect(changes).toEqual([]);
});

it('centraliza cuentas, techos y bindings en /accounts: no repite tablas ni acepta JSON crudo', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  await irA(user, /^agentes$/i);
  expect(screen.getByRole('link', { name: /ir a cuentas/i })).toHaveAttribute('href', '/accounts');
  expect(screen.queryByRole('heading', { name: /provider accounts/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /alias routing ceiling/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /account bindings/i })).not.toBeInTheDocument();

  await irA(user, HISTORIAL);
  fireEvent.change(screen.getByLabelText('Mutación JSON'), { target: { value: JSON.stringify({
    resource: 'provider_account', action: 'delete', id: 'codex-steven',
  }) } });
  await user.click(screen.getByRole('button', { name: /previsualizar cambio/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/únicamente en «Cuentas»/i);
  expect(screen.getByRole('alert')).toHaveTextContent(/\/accounts/);
  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  expect(changes).toEqual([]);
});

it('bloquea fail-closed el rollback de cuentas y solo ejecuta una revisión no-account', async () => {
  const rollbackRequests: string[] = [];
  servirConfig(() => ({
    ...snapshotDeConfig(9),
    revisions: [
      {
        id: '7', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'retiro de cuenta',
        operation: { resource: 'provider_account', action: 'delete', id: 'codex-steven' },
      },
      {
        id: '8', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'retiro de techo',
        operation: {
          resource: 'alias_routing_ceiling', action: 'delete', tenant_id: 'Steven', alias: 'kant',
        },
      },
      {
        id: '9', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'retiro de binding',
        operation: {
          resource: 'agent_account_binding', action: 'delete', tenant_id: 'Steven', alias: 'kant',
          account_id: 'codex-steven',
        },
      },
      {
        id: '10', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'operación ausente',
        operation: null,
      },
      {
        id: '11', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'cambio de tenant permitido',
        operation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } },
      },
    ],
  }));
  server.use(http.post('*/v3/console/config/revisions/:id/rollback', ({ params }) => {
    rollbackRequests.push(String(params.id));
    return HttpResponse.json({
      applied: false, dry_run: true, revision: 9, rolled_back_revision_id: 11,
      summary: 'preview rollback 11',
      mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: false } },
      inverse_mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } },
    });
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  const audit = within(panelDe(/historial de revisiones/i));
  for (const summary of ['retiro de cuenta', 'retiro de techo', 'retiro de binding', 'operación ausente']) {
    const row = audit.getByText(summary).closest('tr');
    expect(row).not.toBeNull();
    if (row) expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  }
  expect(audit.getAllByText(/su única autoridad es Cuentas/i)).toHaveLength(3);
  expect(audit.getAllByRole('link', { name: /abrir cuentas/i })).toHaveLength(3);
  expect(audit.getByText(/no publica una operación reconocible/i)).toBeInTheDocument();

  const allowedRow = audit.getByText('cambio de tenant permitido').closest('tr');
  expect(allowedRow).not.toBeNull();
  if (allowedRow) await user.click(within(allowedRow).getByRole('button', { name: /^Previsualizar$/ }));
  expect(await audit.findByText(/vista previa para deshacer la revisión 11 aceptada/i)).toBeInTheDocument();
  expect(rollbackRequests).toEqual(['11']);
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

  await user.click(await screen.findByRole('button', { name: /^Deshacer$/ }));

  expect(await screen.findByText(/respondió sin el recibo exacto de la reversión 1/i))
    .toBeInTheDocument();
  expect(screen.queryByText(/reversión de la revisión 1 aplicada/i)).not.toBeInTheDocument();
});

it('FAMILIA 2: tocar el JSON del editor crudo se lleva puestos el verde y el preview anteriores', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, HISTORIAL);
  const editor = screen.getByLabelText('Mutación JSON');

  await user.click(screen.getByRole('button', { name: /previsualizar cambio/i }));
  await screen.findByLabelText(/resultado de la vista previa/i);
  await user.type(editor, ' ');
  expect(screen.queryByLabelText(/resultado de la vista previa/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  await screen.findByText(/cambio aplicado/i);
  await user.type(editor, ' ');
  expect(screen.queryByText(/cambio aplicado/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /aplicar cambio/i }));
  await screen.findByText(/cambio aplicado/i);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Recurso' }), 'tenant');
  expect(screen.queryByText(/cambio aplicado/i)).not.toBeInTheDocument();
});
