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
function workspace(onAgent = vi.fn(), role: 'company_owner' | 'reader' = 'company_owner', map: typeof topology = topology) {
  return <CompanySessionProvider state={{ authenticated: true, authority: { role, scope: role === 'reader' ? 'tenant' : 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <OfficeWorkspace campus={<p>Campus actual</p>} topology={map} agents={[]} onAgent={onAgent} /></CompanySessionProvider>;
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
  expect(room.getByRole('button', { name: /worker/u })).toBeInTheDocument();
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
  expect(await screen.findByRole('group', { name: 'Conflicto de versión' })).toHaveTextContent('Otra persona guardó una versión nueva del plano');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByText('Plano sin guardar')).toBeVisible();
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
  expect(alert.textContent).not.toMatch(/Otra persona/u);
  expect(screen.queryByRole('group', { name: 'Conflicto de versión' })).not.toBeInTheDocument();
  expect(within(alert).getByText(code, { selector: 'code' })).toBeVisible();
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  expect(screen.getByText('Guarda o descarta los cambios de plano antes de releerlo.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeDisabled();
});
function conflictingServer(theirs: OfficeRoom[]) {
  let version = 0; let rooms: OfficeRoom[] = []; const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
      if (writes.length === 1) {
        version = 7; rooms = theirs;
        return HttpResponse.json({ error: 'conflict', message: 'office layout version changed; reload and retry' }, { status: 409 });
      }
      if (input.expected_version !== version) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
      rooms = input.rooms; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms });
    }));
  return writes;
}
async function conflictedDraft(user: ReturnType<typeof userEvent.setup>) {
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
  const choice = await screen.findByRole('group', { name: 'Conflicto de versión' });
  expect(choice).toHaveTextContent(/Otra persona guardó una versión nueva del plano/u);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('Código:');
  expect(choice).toHaveTextContent('Tu borrador se conserva en el formulario');
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
  return within(choice);
}
it('tras un conflicto reaplica sólo lo que cambió el borrador y conserva lo que guardó la otra persona', async () => {
  const writes = conflictingServer([{ tenant_id: 'One', room_id: 'general', x: 600, y: 300, width: 300, height: 200, parts: [] }]);
  const user = userEvent.setup(); renderWithApi(workspace());
  const choice = await conflictedDraft(user);
  await user.click(choice.getByRole('button', { name: 'Releer y reintentar con mis cambios' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByRole('status')).toHaveTextContent('Tu borrador se reaplicó sobre la versión nueva sin tocar lo que cambió la otra persona.');
  expect(screen.queryByRole('group', { name: 'Conflicto de versión' })).not.toBeInTheDocument();
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Sala Two/General' })).toHaveStyle({ left: '760px' });
  expect(screen.getByRole('region', { name: 'Sala One/General' })).toHaveStyle({ left: '600px', top: '300px', height: '200px' });
  expect(writes).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[0].expected_version).toBe(0); expect(writes[1].expected_version).toBe(7);
  expect(writes[1].rooms.find(room => room.tenant_id === 'One')).toEqual({ tenant_id: 'One', room_id: 'general', x: 600, y: 300, width: 300, height: 200, parts: [] });
  expect(writes[1].rooms.find(room => room.tenant_id === 'Two')).toMatchObject({ x: 760, parts: [{ label: 'Nueva parte' }] });
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
});
it('un borrador no vuelve a guardar una sala que la topología ya retiró', async () => {
  let version = 0; let stored: OfficeRoom[] = [];
  const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  const available = [{ tenant_id: 'One', room_id: 'general' }, { tenant_id: 'Two', room_id: 'general' }];
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms: stored, available })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
      if (input.expected_version !== version) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
      stored = input.rooms; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms: stored, available });
    }));
  const user = userEvent.setup();
  const view = renderWithApi(workspace());
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General Two' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General Two' }));
  const editor = within(screen.getByRole('region', { name: 'Editar sala Two/General' }));
  await user.clear(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }));
  await user.type(editor.getByRole('spinbutton', { name: 'Posición horizontal de General' }), '760');
  const retired = { tenants: [{ id: 'Two', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] }] };
  view.rerender(<ApiProvider api={testApi}>{workspace(vi.fn(), 'company_owner', retired)}</ApiProvider>);
  expect(screen.queryByRole('region', { name: 'Sala One/General' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Sala One/general' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Sala Two/General' })).toHaveStyle({ left: '760px' });
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].rooms.map(room => `${room.tenant_id}/${room.room_id}`)).toEqual(['Two/general']);
});
it('una sala reaplicada que la topología ya listó no vuelve al guardarse si luego se retira', async () => {
  const nueva: OfficeRoom = { tenant_id: 'One', room_id: 'nueva', x: 111, y: 222, width: 280, height: 210,
    parts: [{ id: 'mesa-nueva', label: 'Mesa nueva', x: 5, y: 6, width: 40, height: 50 }] };
  let version = 0; let rooms: OfficeRoom[] = []; let available: { tenant_id: string; room_id: string }[] | undefined;
  const writes: { expected_version: number; rooms: OfficeRoom[] }[] = [];
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'one', version, rooms, ...(available ? { available } : {}) })),
    http.put('*/v3/console/office/layout', async ({ request }) => {
      const input = await request.json() as { expected_version: number; rooms: OfficeRoom[] }; writes.push(input);
      if (writes.length === 1) {
        version = 7; rooms = [{ tenant_id: 'One', room_id: 'general', x: 600, y: 300, width: 300, height: 200, parts: [] }, nueva];
        available = [{ tenant_id: 'One', room_id: 'general' }, { tenant_id: 'One', room_id: 'nueva' }, { tenant_id: 'Two', room_id: 'general' }];
        return HttpResponse.json({ error: 'conflict', message: 'office layout version changed; reload and retry' }, { status: 409 });
      }
      if (input.expected_version !== version) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
      rooms = input.rooms; version += 1;
      return HttpResponse.json({ company_id: 'one', version, rooms });
    }));
  const user = userEvent.setup(); const view = renderWithApi(workspace());
  const choice = await conflictedDraft(user);
  await user.click(choice.getByRole('button', { name: 'Releer y reintentar con mis cambios' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByRole('region', { name: 'Sala One/nueva' })).toBeVisible();
  const listed = { tenants: [{ id: 'One', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] },
    { id: 'nueva', label: 'Nueva', members: [] }] },
  { id: 'Two', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] }] };
  view.rerender(<ApiProvider api={testApi}>{workspace(vi.fn(), 'company_owner', listed)}</ApiProvider>);
  expect(screen.getByRole('region', { name: 'Sala One/Nueva' })).toBeVisible();
  view.rerender(<ApiProvider api={testApi}>{workspace(vi.fn(), 'company_owner', topology)}</ApiProvider>);
  expect(screen.queryByRole('region', { name: 'Sala One/Nueva' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Sala One/nueva' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1].expected_version).toBe(7);
  expect(writes[1].rooms.map(room => `${room.tenant_id}/${room.room_id}`)).toEqual(['One/general', 'Two/general']);
});
it('tras un conflicto puede cargar la versión de la otra persona y descartar el borrador sin escribir nada', async () => {
  const writes = conflictingServer([{ tenant_id: 'Two', room_id: 'general', x: 500, y: 40, width: 300, height: 260, parts: [] }]);
  const user = userEvent.setup(); renderWithApi(workspace());
  const choice = await conflictedDraft(user);
  await user.click(choice.getByRole('button', { name: 'Descartar mis cambios' }));
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
  expect(screen.getByRole('status')).toHaveTextContent('Se cargó el plano que guardó la otra persona y se descartó tu borrador.');
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Parte Nueva parte')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Sala Two/General' })).toHaveStyle({ left: '500px', top: '40px' });
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeEnabled();
  expect(writes).toHaveLength(1);
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
  expect(await screen.findByRole('group', { name: 'Conflicto de versión' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  const reapply = screen.getByRole('button', { name: 'Releer y reintentar con mis cambios' });
  expect(reapply).toBeEnabled(); expect(screen.getByRole('button', { name: 'Releer plano y cuotas' })).toBeDisabled();
  await waitFor(() => { expect(reads).toBe(2); });
  expect(screen.getByRole('group', { name: 'Conflicto de versión' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Plano sin guardar')).toBeVisible(); expect(screen.getByLabelText('Parte Nueva parte')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled(); expect(writes).toHaveLength(1);
  expect(screen.queryByText('Plano de oficina guardado para esta empresa.')).not.toBeInTheDocument();
  expect(screen.queryByText(/El plano se guardó/u)).not.toBeInTheDocument();
  await user.click(reapply);
  await waitFor(() => { expect(screen.queryByRole('group', { name: 'Conflicto de versión' })).not.toBeInTheDocument(); });
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  expect(await screen.findByText('Plano de oficina guardado para esta empresa.')).toBeVisible();
  expect(writes[1].expected_version).toBe(9); expect(writes[1].rooms).toEqual(writes[0].rooms);
  expect(screen.queryByText('Plano sin guardar')).not.toBeInTheDocument();
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
