import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CompanySessionProvider } from '../auth/company-session';
import { HostEnrollmentPanel } from './HostEnrollmentPanel';

const path = '*/v3/console/fleet/hosts/enrollments';
const id = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
const signer = 'e'.repeat(64);
it('invita desde la consola, conserva el token sólo en memoria y cancela con receipt verificado', async () => {
  let rows: Record<string, unknown>[] = [];
  const writes: unknown[] = [];
  let revoked = '';
  server.use(http.get(path, () => HttpResponse.json({ enrollments: rows })),
    http.post(path, async ({ request }) => {
      const input = await request.json() as { host_id: string; display_name: string }; writes.push(input);
      const invitation = { enrollment_id: id, company_id: 'one', host_id: input.host_id, nonce: 'b'.repeat(64),
        invitation_token: token, expires_at: '2099-10-11T00:10:00Z', state: 'pending', setup_signer_fingerprint: signer };
      rows = [{ ...invitation, invitation_token: undefined, nonce: undefined, display_name: input.display_name, enrolled_at: null }];
      return HttpResponse.json(invitation, { status: 201 });
    }), http.delete(path + '/:id', ({ params }) => {
      revoked = String(params.id); rows = rows.map(row => ({ ...row, state: 'revoked' }));
      return HttpResponse.json({ enrollment_id: revoked, state: 'revoked' });
    }));
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  const user = userEvent.setup(); const view = renderWithApi(<HostEnrollmentPanel canEnroll />);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  await user.type(screen.getByRole('textbox', { name: 'Identificador del ordenador' }), 'equipo-1');
  await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Portátil');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  const invitation = await screen.findByRole('textbox', { name: 'Invitación del ordenador' });
  expect((invitation as HTMLTextAreaElement).value).toContain(token);
  expect(screen.getByLabelText('Comando de enrolamiento')).toHaveTextContent('cauce hosts enroll --gateway');
  expect(screen.getByLabelText('Comando de preparación')).toHaveTextContent(/^cauce hosts setup$/u);
  expect(screen.getByText(/Python 3\.12 con PyYAML y OpenSSL instalados, y desde un usuario del sistema dedicado a esta empresa/u)).toBeVisible();
  expect(writes).toEqual([{ host_id: 'equipo-1', display_name: 'Portátil' }]);
  expect(screen.getByText(/Pendiente de uso/u)).toBeVisible();
  expect(storageWrite).not.toHaveBeenCalled();
  view.unmount(); renderWithApi(<HostEnrollmentPanel canEnroll />);
  expect(await screen.findByText(/Pendiente de uso/u)).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Invitación del ordenador' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancelar invitación de Portátil' }));
  expect(await screen.findByText('Invitación cancelada.')).toBeVisible(); expect(revoked).toBe(id);
  expect(storageWrite).not.toHaveBeenCalled();
});
it('un receipt incompleto no acredita una invitación y un lector no puede crear ni cancelar', async () => {
  server.use(http.post(path, () => HttpResponse.json({ state: 'pending', invitation_token: token }, { status: 201 })));
  const user = userEvent.setup(); const view = renderWithApi(<HostEnrollmentPanel canEnroll />);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  await user.type(screen.getByRole('textbox', { name: 'Identificador del ordenador' }), 'equipo-1');
  await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Portátil');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó la invitación');
  expect(screen.queryByRole('textbox', { name: 'Invitación del ordenador' })).not.toBeInTheDocument();
  view.unmount();
  server.use(http.get(path, () => HttpResponse.json({ enrollments: [{ enrollment_id: id, company_id: 'one', host_id: 'equipo-1',
    display_name: 'Portátil', state: 'enrolled', expires_at: '2099-10-11T00:10:00Z', enrolled_at: '2026-10-11T00:03:00Z' }] })));
  renderWithApi(<HostEnrollmentPanel canEnroll={false} />);
  const list = within(await screen.findByRole('list', { name: 'Invitaciones de ordenadores' }));
  expect(await list.findByText(/Identidad confirmada; el ejecutor aún no está listo/u)).toBeVisible();
  expect(screen.queryByText(/cauce hosts setup/u)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Cancelar invitación de/u })).not.toBeInTheDocument();
});
it('muestra el ejecutor listo de cada ordenador y la huella para anclar identidades antiguas', async () => {
  const fingerprint = 'e'.repeat(64);
  const row = { enrollment_id: id, company_id: 'one', host_id: 'one-laptop', display_name: 'Portátil', state: 'enrolled',
    expires_at: '2099-10-11T00:10:00Z', enrolled_at: '2026-10-11T00:03:00Z' };
  server.use(http.get(path, () => HttpResponse.json({ setup_signer_fingerprint: fingerprint, enrollments: [
    { ...row, executor_ready: true }, { ...row, enrollment_id: '22222222-2222-4222-8222-222222222222', host_id: 'one-desk', display_name: 'Torre', executor_ready: false },
  ] })));
  renderWithApi(<HostEnrollmentPanel canEnroll />);
  const list = within(await screen.findByRole('list', { name: 'Invitaciones de ordenadores' }));
  expect(await list.findByText(/Portátil · one-laptop · Ejecutor listo(?!:)/u)).toBeVisible();
  expect(list.getByText(/Torre · one-desk · Identidad confirmada; falta preparar el ejecutor con cauce hosts setup/u)).toBeVisible();
  expect(screen.getByText(`cauce hosts setup --signer-fingerprint ${fingerprint}`)).toBeVisible();
});
it('no muestra una huella malformada como ancla', async () => {
  server.use(http.get(path, () => HttpResponse.json({ setup_signer_fingerprint: 'not-a-fingerprint', enrollments: [] })));
  renderWithApi(<HostEnrollmentPanel canEnroll />);
  expect(await screen.findByText('Aún no hay invitaciones.')).toBeVisible();
  expect(screen.queryByText(/--signer-fingerprint/u)).not.toBeInTheDocument();
});

const company = (role: 'company_owner' | 'platform_admin', element = <HostEnrollmentPanel canEnroll />) => <CompanySessionProvider state={{ authenticated: true,
  authority: { role, scope: role === 'platform_admin' ? 'platform' : 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>{element}</CompanySessionProvider>;
it('precarga el prefijo de la empresa y rechaza ids fuera de su partición con un mensaje en español', async () => {
  const writes: unknown[] = [];
  server.use(http.get(path, () => HttpResponse.json({ enrollments: [] })),
    http.post(path, async ({ request }) => { writes.push(await request.json()); return HttpResponse.json({}, { status: 500 }); }));
  const user = userEvent.setup(); renderWithApi(company('company_owner'));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  const id = screen.getByRole('textbox', { name: 'Identificador del ordenador' });
  expect(id).toHaveValue('');
  expect(screen.getByText('one-')).toBeVisible();
  expect(id).toHaveAttribute('pattern', '[a-z0-9_]+');
  expect(new RegExp(`^(?:${String(id.getAttribute('pattern'))})$`, 'v').test('torre_2')).toBe(true);
  expect(new RegExp(`^(?:${String(id.getAttribute('pattern'))})$`, 'v').test('torre-2')).toBe(false);
  await user.type(id, 'torre-2'); await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Torre');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  expect(id).toHaveAttribute('title', expect.stringContaining('será one-nombre'));
  expect((id as HTMLInputElement).validity.patternMismatch).toBe(true);
  expect(writes).toEqual([]);
});
it('la plataforma conserva nombres libres y sin firma de preparación no ofrece cauce hosts setup', async () => {
  server.use(http.get(path, () => HttpResponse.json({ enrollments: [] })),
    http.post(path, async ({ request }) => { const input = await request.json() as { host_id: string };
      return HttpResponse.json({ enrollment_id: id, company_id: 'one', host_id: input.host_id, nonce: 'b'.repeat(64), invitation_token: token,
        expires_at: '2099-10-11T00:10:00Z', state: 'pending' }, { status: 201 }); }));
  const user = userEvent.setup(); renderWithApi(company('platform_admin'));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  const field = screen.getByRole('textbox', { name: 'Identificador del ordenador' });
  expect(field).toHaveValue(''); expect(field.getAttribute('pattern')).toBe('[a-z][a-z0-9_\\-]{0,63}');
  await user.type(field, 'libre-1'); await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Libre');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  await screen.findByRole('textbox', { name: 'Invitación del ordenador' });
  expect(screen.getByLabelText('Comando de enrolamiento')).toBeVisible();
  expect(screen.queryByLabelText('Comando de preparación')).not.toBeInTheDocument();
  expect(screen.queryByText(/cauce hosts setup|huella/u)).not.toBeInTheDocument();
});
it('la invitación copiada conserva la huella del firmante', async () => {
  server.use(http.get(path, () => HttpResponse.json({ enrollments: [] })),
    http.post(path, async ({ request }) => { const input = await request.json() as { host_id: string };
      return HttpResponse.json({ enrollment_id: id, company_id: 'one', host_id: input.host_id, nonce: 'b'.repeat(64), invitation_token: token,
        expires_at: '2099-10-11T00:10:00Z', state: 'pending', setup_signer_fingerprint: signer }, { status: 201 }); }));
  const user = userEvent.setup(); renderWithApi(<HostEnrollmentPanel canEnroll />);
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  await user.type(screen.getByRole('textbox', { name: 'Identificador del ordenador' }), 'equipo-1');
  await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Portátil');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  await user.click(await screen.findByRole('button', { name: 'Copiar invitación' }));
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ setup_signer_fingerprint: signer, invitation_token: token });
});
it('un ejecutor que estuvo listo y dejó de publicar capacidades se muestra como que no responde', async () => {
  const row = { enrollment_id: id, company_id: 'one', host_id: 'one-laptop', display_name: 'Portátil', state: 'enrolled',
    expires_at: '2099-10-11T00:10:00Z', enrolled_at: '2026-10-11T00:03:00Z' };
  let ready = true;
  server.use(http.get(path, () => HttpResponse.json({ setup_signer_fingerprint: signer, enrollments: [{ ...row, executor_ready: ready }] })));
  const user = userEvent.setup(); renderWithApi(<HostEnrollmentPanel canEnroll />);
  expect(await screen.findByText(/Portátil · one-laptop · Ejecutor listo/u)).toBeVisible();
  ready = false; await user.click(screen.getByRole('button', { name: 'Releer invitaciones' }));
  expect(await screen.findByText(/el ejecutor no responde/u)).toBeVisible();
  expect(screen.queryByText(/falta preparar/u)).not.toBeInTheDocument();
});
it('envía el prefijo de la empresa y traduce los rechazos del servidor sin mostrar el inglés', async () => {
  const bodies: { host_id: string }[] = []; let status = 403;
  server.use(http.get(path, () => HttpResponse.json({ enrollments: [] })),
    http.post(path, async ({ request }) => { bodies.push(await request.json() as { host_id: string });
      return HttpResponse.json({ message: status === 403 ? 'host id must be one-<name>, with lowercase letters' : 'host is already registered' }, { status }); }));
  const user = userEvent.setup(); renderWithApi(company('company_owner'));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Añadir ordenador' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Añadir ordenador' }));
  await user.type(screen.getByRole('textbox', { name: 'Identificador del ordenador' }), 'torre_2');
  await user.type(screen.getByRole('textbox', { name: 'Nombre del ordenador' }), 'Torre');
  await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/debe llamarse one-nombre/u);
  expect(bodies).toEqual([{ host_id: 'one-torre_2', display_name: 'Torre' }]);
  status = 409; await user.click(screen.getByRole('button', { name: 'Crear invitación' }));
  await waitFor(() => { expect(screen.getByRole('alert')).toHaveTextContent(/ya pertenece a un ordenador registrado/u); });
  expect(screen.queryByText(/host is already registered/u)).not.toBeInTheDocument();
});
