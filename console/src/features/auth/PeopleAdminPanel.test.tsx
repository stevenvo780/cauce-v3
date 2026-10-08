import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ManagedPerson, PersonValues } from '../../api/client/people-admin-client';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import { PeopleAdminPanel } from './PeopleAdminPanel';

const id = '11111111-1111-4111-8111-111111111111';
const person: ManagedPerson = { id, email: 'one@example.test', display_name: 'Una persona', role: 'reader', tenant_id: 'A', alias: 'worker', active: true, revision: '1791321600123456' };
const capabilities = { create: true, update: true, retire: true, restore: true, purge: true };
const config = { revision: 4, tenants: [{ id: 'A', display_name: 'Espacio A', enabled: true }],
  rooms: [{ tenant_id: 'A', id: 'group', enabled: true }],
  agents: [{ tenant_id: 'A', alias: 'worker', enabled: true }, { tenant_id: 'A', alias: 'disabled', enabled: false }],
  memberships: [{ tenant_id: 'A', room_id: 'group', alias: 'worker', enabled: true }] };
function serve(items: () => ManagedPerson[] = () => [person], caps = capabilities) {
  server.use(http.get('http://localhost/v3/console/people', () => HttpResponse.json({ items: items(), capabilities: caps })),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(config)));
}
it('creates a person with a current catalog identity and writes the password without displaying it', async () => {
  const rows: ManagedPerson[] = [];
  serve(() => rows);
  let submitted: PersonValues | undefined;
  server.use(http.post('http://localhost/v3/console/people', async ({ request }) => {
    submitted = await request.json() as PersonValues;
    rows.push({ ...person, email: submitted.email, display_name: submitted.display_name, role: submitted.role, active: submitted.active });
    return HttpResponse.json(rows[0], { status: 201 });
  }));
  const user = userEvent.setup(); renderWithApi(<PeopleAdminPanel />);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Crear persona' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Crear persona' }));
  await user.type(screen.getByRole('textbox', { name: 'Correo de acceso' }), 'new@example.test');
  await user.type(screen.getByRole('textbox', { name: 'Nombre de persona' }), 'Nueva persona');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de la persona' }), 'A');
  expect(screen.getByRole('combobox', { name: 'Identidad de la persona' })).not.toHaveTextContent('disabled');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Identidad de la persona' }), 'worker');
  await user.type(screen.getByLabelText('Contraseña inicial'), 'private-password');
  expect(screen.queryByText('private-password')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Crear cuenta de persona' }));
  expect(await screen.findByText('Persona creada. Inventario releído.')).toBeInTheDocument();
  expect(submitted).toEqual({ email: 'new@example.test', display_name: 'Nueva persona', role: 'reader', tenant_id: 'A', alias: 'worker', active: true, password: 'private-password' });
  expect(screen.queryByLabelText('Contraseña inicial')).not.toBeInTheDocument();
});
it('updates with exact CAS, omits an empty password and requires a reread after a conflict', async () => {
  let row = { ...person };
  serve(() => [row]);
  const submitted: Record<string, unknown>[] = [];
  server.use(http.patch(`http://localhost/v3/console/people/${id}`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>; submitted.push(body);
    if (submitted.length === 1) return HttpResponse.json({ message: 'private-error-secret' }, { status: 409 });
    row = { ...row, display_name: String(body.display_name), revision: '1791321600123458' }; return HttpResponse.json(row);
  }));
  const user = userEvent.setup(); renderWithApi(<PeopleAdminPanel />);
  await user.click(await screen.findByRole('button', { name: 'Editar persona one@example.test' }));
  await user.clear(screen.getByRole('textbox', { name: 'Nombre de persona' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre de persona' }), 'Otro nombre');
  await user.click(screen.getByRole('button', { name: 'Guardar persona' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/revisión cambió/);
  expect(screen.getByRole('alert')).not.toHaveTextContent('private-error-secret');
  expect(screen.getByRole('button', { name: 'Editar persona one@example.test' })).toBeDisabled();
  expect(submitted[0]).toEqual({ expected_revision: person.revision, email: person.email, display_name: 'Otro nombre', role: 'reader', tenant_id: 'A', alias: 'worker' });
  row = { ...row, revision: '1791321600123457' };
  await user.click(screen.getByRole('button', { name: 'Releer personas y permisos' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Editar persona one@example.test' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Editar persona one@example.test' }));
  await user.clear(screen.getByRole('textbox', { name: 'Nombre de persona' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre de persona' }), 'Otro nombre');
  await user.click(screen.getByRole('button', { name: 'Guardar persona' }));
  await screen.findByText('Persona actualizada. Inventario releído.');
  expect(submitted[1]?.expected_revision).toBe('1791321600123457');
});
it('retires, restores and purges with confirmation and the current durable revision', async () => {
  let row = { ...person }; let rows = [row];
  serve(() => rows);
  const submitted: unknown[] = [];
  server.use(http.delete(`http://localhost/v3/console/people/${id}`, async ({ request }) => {
    submitted.push(await request.json()); row = { ...row, active: false, revision: String(BigInt(row.revision) + 1n) }; rows = [row]; return HttpResponse.json(row);
  }), http.post(`http://localhost/v3/console/people/${id}/restore`, async ({ request }) => {
    submitted.push(await request.json()); row = { ...row, active: true, revision: String(BigInt(row.revision) + 1n) }; rows = [row]; return HttpResponse.json(row);
  }), http.delete(`http://localhost/v3/console/people/${id}/purge`, async ({ request }) => {
    submitted.push(await request.json()); rows = []; return HttpResponse.json({ id, revision: row.revision, purged: true });
  }));
  const user = userEvent.setup(); renderWithApi(<PeopleAdminPanel />);
  async function action(label: string) {
    await user.click(await screen.findByRole('button', { name: `${label} persona one@example.test` }));
    await user.click(within(screen.getByRole('region', { name: 'Confirmar cambio de acceso' })).getByRole('button', { name: 'Confirmar cambio de persona' }));
  }
  await action('Retirar'); await screen.findByText('Acceso de persona retirado. Inventario releído.');
  await action('Restaurar'); await screen.findByText('Acceso de persona restaurado. Inventario releído.');
  await action('Retirar'); await screen.findByText('Acceso de persona retirado. Inventario releído.');
  await action('Purgar'); await screen.findByText('Registro de persona purgado. Inventario releído.');
  expect(submitted).toEqual([{ expected_revision: person.revision }, { expected_revision: '1791321600123457' },
    { expected_revision: '1791321600123458' }, { expected_revision: '1791321600123459' }]);
  expect(screen.queryByText('one@example.test')).not.toBeInTheDocument();
});
it('keeps protected last-admin failures visible and blocks writes when capability or session is unconfirmed', async () => {
  serve();
  server.use(http.delete(`http://localhost/v3/console/people/${id}`, () => HttpResponse.json({ message: 'private-last-admin-detail' }, { status: 409 })));
  const user = userEvent.setup(); renderWithApi(<PeopleAdminPanel />);
  await user.click(await screen.findByRole('button', { name: 'Retirar persona one@example.test' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar cambio de persona' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('último administrador');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private-last-admin-detail');
  expect(screen.getByRole('button', { name: 'Crear persona' })).toBeDisabled();
  serve(() => [person], { ...capabilities, create: false, retire: false });
  await user.click(screen.getByRole('button', { name: 'Releer personas y permisos' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Editar persona one@example.test' })).toBeEnabled(); });
  expect(screen.getByRole('button', { name: 'Crear persona' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retirar persona one@example.test' })).toBeDisabled();
  server.use(http.post('http://localhost/v3/auth/login', () => HttpResponse.json({ authenticated: true, subject: 'changed', csrf_token: 'changed' })));
  await act(async () => { await testApi.login('changed@example.test', 'test-password'); });
  expect(screen.getByRole('alert')).toHaveTextContent('La sesión cambió');
  expect(screen.getByRole('button', { name: 'Editar persona one@example.test' })).toBeDisabled();
});
it('fails closed without the people endpoint and never infers permission from the configuration inventory', async () => {
  serve();
  server.use(http.get('http://localhost/v3/console/people', () => HttpResponse.json({}, { status: 404 })));
  renderWithApi(<PeopleAdminPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('administración no está disponible');
  expect(screen.getByRole('button', { name: 'Crear persona' })).toBeDisabled();
});
