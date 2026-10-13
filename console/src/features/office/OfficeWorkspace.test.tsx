import { useEffect } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import type { OfficeRoom } from '../../api/client/company-client';
import { ApiProvider } from '../../api/context';
import { renderWithApi, testApi } from '../../test/render';
import { server } from '../../mocks/server';
import { CompanySessionProvider } from '../auth/company-session';
import { OfficeWorkspace } from './OfficeWorkspace';

const topology = { tenants: [{ id: 'One', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] },
  { id: 'Two', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] }] };
function workspace(onAgent = vi.fn(), role: 'company_owner' | 'reader' = 'company_owner') {
  return <CompanySessionProvider state={{ authenticated: true, authority: { role, scope: role === 'reader' ? 'tenant' : 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <OfficeWorkspace campus={<p>Campus actual</p>} topology={topology} agents={[]} onAgent={onAgent} /></CompanySessionProvider>;
}
it('edita sólo la sala compuesta elegida, persiste partes y relee al volver a abrir', async () => {
  let version = 0; let rooms: OfficeRoom[] = []; const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
      expect(input.expected_version).toBe(version); rooms = input.rooms; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms }); }));
  const user = userEvent.setup(); const onAgent = vi.fn(); const view = renderWithApi(workspace(onAgent));
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  const room = within(await screen.findByRole('region', { name: 'Sala Two/General' }));
  await waitFor(() => { expect(room.getByRole('button', { name: 'General Two' })).toBeEnabled(); });
  await user.click(room.getByRole('button', { name: 'General Two' }));
  const editor = within(screen.getByRole('region', { name: 'Editar sala Two/General' }));
  await user.clear(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }));
  await user.type(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }), '760');
  await user.click(editor.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes[0].rooms.find(value => value.tenant_id === 'Two')).toMatchObject({ room_id: 'general', x: 760, parts: [{ label: 'Nueva parte' }] });
  expect(writes[0].rooms.find(value => value.tenant_id === 'One')?.x).toBe(0);
  const roster = within(screen.getByRole('region', { name: 'Agentes de sala Two/General' }));
  expect(room.queryByRole('button', { name: /worker/u })).not.toBeInTheDocument();
  await user.click(roster.getByRole('button', { name: /worker/u })); expect(onAgent).toHaveBeenCalledWith('Two/worker');
  view.unmount(); renderWithApi(workspace()); await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('region', { name: 'Sala Two/General' })).toHaveStyle({ left: '760px' }); });
  expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
});
it('un conflicto conserva el borrador y un lector no puede editar ni guardar', async () => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json({ message: 'La versión cambió. Relee y reintenta.' }, { status: 409 })));
  const user = userEvent.setup(); const view = renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La versión cambió'); expect(screen.getByText('Plano sin guardar')).toBeVisible();
  view.unmount(); const onAgent = vi.fn(); renderWithApi(workspace(onAgent, 'reader')); await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await user.click(await screen.findByRole('button', { name: 'General One' }));
  expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
  expect(screen.queryByRole('region', { name: 'Editar sala One/General' })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('region', { name: 'Agentes de sala One/General' })).getByRole('button', { name: /worker/u }));
  expect(onAgent).toHaveBeenCalledWith('One/worker');
});
it.each([
  ['company_switch_in_flight', 'Hay un cambio de empresa en curso. Espera su confirmación antes de otra operación.'],
  ['company_scope_unverified', 'No se pudo verificar la empresa de la sesión. Relee la sesión antes de escribir.'],
  ['session_changed', 'La sesión cambió antes de enviar la operación. Reintentá desde la cuenta actual.'],
])('un 409 de sesión %s no se presenta como conflicto de versión y deja reintentar el guardado', async (code, message) => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json({ error: code, message }, { status: 409 })));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(alert.textContent).not.toMatch(/Otro operador/u);
  expect(within(alert).getByText(code, { selector: 'code' })).toBeVisible();
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  expect(screen.getByText('Guarda o descarta los cambios de plano antes de releerlo.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeDisabled();
});
it('tras un conflicto relee la versión y guarda las salas del borrador sin sustituirlas por las del servidor', async () => {
  let version = 0; let rooms: OfficeRoom[] = []; const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
      if (writes.length === 1) {
        version = 7; rooms = [{ tenant_id: 'One', room_id: 'general', x: 600, y: 300, width: 300, height: 200, parts: [] }];
        return HttpResponse.json({ error: 'conflict', message: 'office layout version changed; reload and retry' }, { status: 409 });
      }
      if (input.expected_version !== version) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
      rooms = input.rooms; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms });
    }));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General Two' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General Two' }));
  const editor = within(screen.getByRole('region', { name: 'Editar sala Two/General' }));
  await user.clear(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }));
  await user.type(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }), '760');
  await user.click(editor.getByRole('button', { name: 'Añadir parte' }));
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeDisabled();
  expect(screen.getByText('Guarda o descarta los cambios de plano antes de releerlo.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Relee el plano y vuelve a guardar/u);
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  expect(screen.queryByText('Plano de oficina guardado para esta empresa.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Sala Two/General' })).toHaveStyle({ left: '760px' });
  expect(screen.getByRole('region', { name: 'Sala One/General' })).toHaveStyle({ left: '0px' });
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[0].expected_version).toBe(0); expect(writes[1].expected_version).toBe(7);
  expect(writes[1].rooms).toEqual(writes[0].rooms);
  expect(writes[1].rooms.find(room => room.tenant_id === 'Two')).toMatchObject({ x: 760, parts: [{ label: 'Nueva parte' }] });
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
});
it('una relectura fallida tras el conflicto conserva el aviso y el borrador hasta recuperar la versión', async () => {
  let reads = 0; const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  server.use(http.get('*/v3/console/office/layout', () => {
    reads += 1;
    if (reads === 2) return HttpResponse.json({ error: 'internal', message: 'Internal Server Error' }, { status: 500 });
    return HttpResponse.json({ company_id: 'one', version: reads === 1 ? 0 : 9, rooms: writes[1]?.rooms ?? [] });
  }), http.put('*/v3/console/office/layout', async ({ request }) => {
    const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
    return writes.length === 1 || input.expected_version !== 9
      ? HttpResponse.json({ message: 'La versión cambió. Relee y reintenta.' }, { status: 409 })
      : HttpResponse.json({ company_id: 'one', version: 9, rooms: input.rooms });
  }));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La versión cambió');
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(reads).toBe(2); expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeEnabled(); });
  expect(screen.getByRole('alert')).toHaveTextContent('La versión cambió');
  expect(screen.getByText('Plano sin guardar')).toBeVisible(); expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled(); expect(writes).toHaveLength(1);
  expect(screen.queryByText('Plano de oficina guardado para esta empresa.')).not.toBeInTheDocument();
  expect(screen.queryByText(/El plano se guardó/u)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes[1].expected_version).toBe(9); expect(writes[1].rooms).toEqual(writes[0].rooms);
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
});
it('explica en español la falta de autoridad al leer el plano', async () => {
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'forbidden', message: 'company office authority is required' }, { status: 403 },
  )));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Pide acceso a un administrador de la empresa/u);
  expect(screen.getByRole('alert').textContent).not.toContain('company office authority');
});
it('conserva el motivo concreto de un 403 al guardar y mantiene el borrador', async () => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'forbidden', message: 'La sala One/general ya no está disponible en la empresa activa.' }, { status: 403 },
  )));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Pide acceso a un administrador de la empresa/u);
  expect(alert).toHaveTextContent('La sala One/general ya no está disponible en la empresa activa.');
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
});
it('no muestra la frase HTTP genérica de un 403 al guardar', async () => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'forbidden', message: 'Forbidden' }, { status: 403 },
  )));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Pide acceso a un administrador de la empresa/u);
  expect(alert.textContent).not.toContain('Forbidden');
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
});
it('mapea una solicitud de plano inválida sin mostrar el mensaje inglés del gateway', async () => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'invalid_request', message: 'invalid office layout' }, { status: 400 },
  )));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Revisa las posiciones y tamaños/u);
  expect(alert.textContent).not.toContain('invalid office layout');
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
});
it('distingue un guardado confirmado cuya relectura falla y no conserva el borrador', async () => {
  let reads = 0;
  server.use(http.get('*/v3/console/office/layout', () => {
    reads += 1;
    return reads === 1
      ? HttpResponse.json({ company_id: 'one', version: 0, rooms: [] })
      : HttpResponse.json({ error: 'internal', message: 'Internal Server Error' }, { status: 500 });
  }),
  http.put('*/v3/console/office/layout', async ({ request }) => {
    const input = await request.json() as { rooms: OfficeRoom[] };
    return HttpResponse.json({ company_id: 'one', version: 1, rooms: input.rooms });
  }));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/El plano se guardó, pero no se pudo releer/u);
  expect(alert.textContent).not.toContain('Internal Server Error');
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
  expect(screen.queryByText('Plano de oficina guardado para esta empresa.')).not.toBeInTheDocument();
});
it('retira el aviso cuando una relectura posterior al guardado confirmado llega', async () => {
  let reads = 0; let saved: { company_id: string; version: number; rooms: OfficeRoom[] } | undefined;
  server.use(http.get('*/v3/console/office/layout', () => {
    reads += 1;
    if (reads === 1) return HttpResponse.json({ company_id: 'one', version: 0, rooms: [] });
    if (reads === 2 || !saved) return HttpResponse.json({ error: 'internal', message: 'Internal Server Error' }, { status: 500 });
    return HttpResponse.json(saved);
  }),
  http.put('*/v3/console/office/layout', async ({ request }) => {
    const input = await request.json() as { rooms: OfficeRoom[] };
    saved = { company_id: 'one', version: 1, rooms: input.rooms };
    return HttpResponse.json(saved);
  }));
  const user = userEvent.setup(); renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/El plano se guardó, pero no se pudo releer/u);
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
  expect(screen.queryByText('Plano de oficina guardado para esta empresa.')).not.toBeInTheDocument();
});
it('vuelve a montar el campus tras guardar el plano para que lea el plano nuevo', async () => {
  let version = 0;
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms: [] })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { rooms: OfficeRoom[] }; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms: input.rooms }); }));
  const mounts = vi.fn();
  function Campus() { useEffect(() => { mounts(); }, []); return <p>Campus actual</p>; }
  const user = userEvent.setup();
  renderWithApi(<CompanySessionProvider state={{ authenticated: true, authority: { role: 'company_owner', scope: 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <OfficeWorkspace campus={<Campus />} topology={topology} agents={[]} onAgent={vi.fn()} /></CompanySessionProvider>);
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' })); await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  expect(mounts).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(mounts).toHaveBeenCalledTimes(2);
});
it('sin salas explica qué hacer en lugar de un mapa vacío y anuncia la lectura de la topología', async () => {
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version: 0, available: [], rooms: [] })));
  const authority = { role: 'company_owner' as const, scope: 'company' as const, home_company: 'one', acting_company: 'one', platform_override: false };
  const office = (map?: typeof topology) => <CompanySessionProvider state={{ authenticated: true, authority }}>
    <OfficeWorkspace campus={<p>Campus actual</p>} topology={map} agents={[]} onAgent={vi.fn()} /></CompanySessionProvider>;
  const user = userEvent.setup(); const view = renderWithApi(office());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  expect(screen.getByText('Leyendo salas…')).toBeVisible();
  expect(screen.queryByText(/Aún no hay salas/u)).not.toBeInTheDocument();
  view.rerender(<ApiProvider api={testApi}>{office(topology)}</ApiProvider>);
  expect(await screen.findByText('Aún no hay salas. Crea una desde «Gestionar salas y asignaciones».')).toBeVisible();
  expect(screen.queryByLabelText('Mapa de salas y agentes')).not.toBeInTheDocument();
});
