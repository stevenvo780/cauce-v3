import { useEffect } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import type { OfficeRoom } from '../../api/client/company-client';
import { renderWithApi } from '../../test/render';
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
  await user.click(room.getByRole('button', { name: /worker/u })); expect(onAgent).toHaveBeenCalledWith('Two/worker');
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
  view.unmount(); renderWithApi(workspace(vi.fn(), 'reader')); await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  expect(await screen.findByRole('button', { name: 'General One' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
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
