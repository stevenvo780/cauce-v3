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
