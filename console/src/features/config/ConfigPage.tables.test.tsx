import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
} from '../../navigation';
import {
  irA, recordChanges, snapshotDeConfig, snapshotConAudit, servirConfig,
  MEMBERSHIP_JANUS, type ChangeRequest,
} from './ConfigPage.test-helpers';

const HISTORIAL = /historial y json/i;
const AGENTES = /agentes y cuentas/i;

function rotulo(celda: HTMLElement): string {
  return (celda.textContent ?? '').replace(/[?:].*/s, '').trim();
}

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion as HTMLElement;
}

it('pinta cada colección como TABLA con columnas de verdad y deja el JSON crudo detrás del desplegable', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const memberships = panelDe(/memberships/i);
  expect(within(memberships).getAllByRole('columnheader').map((celda) => rotulo(celda)))
    .toEqual(['Tenant', 'Room', 'Alias', 'Rol', 'Habilitado', 'Alta']);
  expect(within(memberships).getByText('janus')).toBeInTheDocument();

  const tenants = panelDe(/^Tenants$/);
  expect(within(tenants).getAllByRole('columnheader').map((celda) => rotulo(celda)))
    .toEqual(['Id', 'Nombre', 'Hub', 'Habilitado', 'Alta']);
  expect(within(tenants).getByText(/ver crudo/i)).toBeInTheDocument();
});

it('deshabilita una membership a un clic, manda la mutación exacta y recién después lo afirma', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  await waitFor(() => expect(changes).toHaveLength(1));
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

it('cancela un cambio de rol sin escribir nada y deja la fila como estaba', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator');
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(changes).toEqual([]);
  expect(screen.queryByLabelText('Mutación a aplicar')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Rol de Miguel/grp.miguel/janus')).toHaveValue('agent');
});

it('sin config.write se ve TODO en solo lectura y lo dice, en vez de esconder la vista', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
  })));
  renderWithApi(<ConfigPage />);

  expect(await screen.findByText(new RegExp(`Solo lectura: ${CONFIG_SIN_CONTROL_REASON}`, 'i')))
    .toBeInTheDocument();
  expect(within(panelDe(/memberships/i)).getByText('janus')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: MEMBERSHIP_JANUS })).toBeDisabled();
  expect(screen.getByLabelText('Rol de Miguel/grp.miguel/janus')).toBeDisabled();
  await irA(userEvent.setup(), HISTORIAL);
  expect(screen.getByRole('button', { name: /aplicar atómico/i })).toBeDisabled();
});

it('con config.write desconocido conserva la vista pero no permite ningún POST ni PUT', async () => {
  servirConfig(() => snapshotConAudit(1));
  server.use(http.get('*/v3/console/access', () => HttpResponse.json(
    { error: 'internal', message: 'RBAC no disponible' }, { status: 500 },
  )));
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  expect(await screen.findByText(new RegExp(CONFIG_WRITE_NO_ACREDITADO_REASON, 'i')))
    .toBeInTheDocument();
  expect(within(panelDe(/memberships/i)).getByText('janus')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: HISTORIAL })).toBeEnabled();

  const interruptor = screen.getByRole('switch', { name: MEMBERSHIP_JANUS });
  const crear = screen.getByRole('button', { name: /^Crear$/ });
  expect(interruptor).toBeDisabled();
  expect(screen.getByLabelText('Recurso a crear')).toBeDisabled();
  expect(crear).toBeDisabled();
  await user.click(interruptor);
  await user.click(crear);

  await irA(user, HISTORIAL);
  const rollback = screen.getByRole('button', { name: /^Rollback$/ });
  const previewRollback = screen.getByRole('button', { name: /^Preview$/ });
  const aplicar = screen.getByRole('button', { name: /aplicar atómico/i });
  expect(rollback).toBeDisabled();
  expect(previewRollback).toBeDisabled();
  expect(aplicar).toBeDisabled();
  expect(screen.getByRole('button', { name: /preview \/ dry-run/i })).toBeDisabled();
  expect(screen.getByLabelText('Mutación JSON')).toBeDisabled();
  await user.click(rollback);
  await user.click(previewRollback);
  await user.click(aplicar);

  const unsafe = fetchSpy.mock.calls.filter(([input, init]) => {
    const method = (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase();
    return method === 'POST' || method === 'PUT';
  });
  expect(unsafe).toEqual([]);
});

it('muestra el rechazo del servidor en la propia colección y no dice que aplicó nada', async () => {
  server.use(http.post('*/v3/console/config/changes', () => HttpResponse.json(
    { error: 'conflict', message: 'membership has active deliveries or a live lease' },
    { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent('membership has active deliveries or a live lease');
  expect(aviso).toHaveTextContent(/NO se aplicó/i);
  expect(screen.queryByText(/aplicado en la revisión/i)).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: MEMBERSHIP_JANUS })).toBeChecked();
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

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('alert');
  expect(aviso).toHaveTextContent(/conflicto de revisión/i);
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

  await user.click(await screen.findByRole('switch', { name: MEMBERSHIP_JANUS }));

  const aviso = await within(panelDe(/memberships/i)).findByRole('status');
  expect(aviso).toHaveTextContent(/el servidor lo aplicó en la revisión 2/i);
  expect(aviso).toHaveTextContent(/la relectura del snapshot NO llegó/i);
  expect(aviso).toHaveTextContent(/pueden estar vencidas/i);
});

it('FAMILIA 3: la confirmación pendiente se anula cuando «Actualizar» mueve el snapshot debajo', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  let lecturas = 0;
  servirConfig(() => {
    lecturas += 1;
    if (lecturas === 1) return snapshotDeConfig(1);
    const posterior = snapshotDeConfig(5);
    posterior.memberships = [{ ...posterior.memberships[0], enabled: false }];
    return posterior;
  });
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator');
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

  await user.type(screen.getByLabelText('Tenant'), 'Miguel');
  expect(screen.getByLabelText('Mutación del alta')).not.toHaveTextContent('Miguel');
});

it('FAMILIA 4: el role_brief de «Agent registry» se ve RESUMIDO, no 1200 caracteres en una celda', async () => {
  const brief = Array.from({ length: 27 }, () => 'Sos kant, el hub de coordinación de la flota.').join(' ');
  expect(brief.length).toBeGreaterThan(1200);
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: brief, enabled: true }],
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });
  await irA(user, AGENTES);

  const registro = panelDe(/agent registry/i);
  const celda = within(registro).getByTitle(brief);
  expect(celda.textContent).toBe(`${brief.slice(0, 120)}…`);
  expect(within(registro).queryByText(brief)).not.toBeInTheDocument();
});

it('FAMILIA 7: la confirmación es un diálogo de verdad — el foco entra, ESC la cierra y el fondo queda inerte', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><ConfigPage /></div>);

  const selector = await screen.findByLabelText('Rol de Miguel/grp.miguel/janus');
  await user.selectOptions(selector, 'operator');

  const dialogo = screen.getByRole('dialog');
  expect(dialogo).toHaveAttribute('aria-modal', 'true');
  expect(dialogo.contains(document.activeElement)).toBe(true);
  expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
  expect(document.querySelector('.app-shell')!.contains(dialogo)).toBe(false);

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert');
  expect(document.activeElement).toBe(selector);
  expect(changes).toEqual([]);
});

it('FAMILIA 7: el JSON va detrás de un desplegable cerrado y los dos botones viven fuera de él', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.selectOptions(await screen.findByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator');

  const dialogo = screen.getByRole('dialog');
  expect(dialogo).toHaveTextContent(/Confirmá el cambio/i);

  const detalle = dialogo.querySelector('details');
  expect(detalle, 'el JSON tiene que estar detrás de un desplegable').not.toBeNull();
  expect(detalle!.open).toBe(false);
  expect(detalle!.contains(screen.getByLabelText('Mutación a aplicar'))).toBe(true);

  for (const nombre of ['Confirmar', 'Cancelar']) {
    expect(detalle!.contains(screen.getByRole('button', { name: nombre }))).toBe(false);
  }
});
