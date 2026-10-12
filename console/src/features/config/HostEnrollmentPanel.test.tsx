import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { HostEnrollmentPanel } from './HostEnrollmentPanel';

const path = '*/v3/console/fleet/hosts/enrollments';
const id = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
it('invita desde la consola, conserva el token sólo en memoria y cancela con receipt verificado', async () => {
  let rows: Record<string, unknown>[] = [];
  const writes: unknown[] = [];
  let revoked = '';
  server.use(http.get(path, () => HttpResponse.json({ enrollments: rows })),
    http.post(path, async ({ request }) => {
      const input = await request.json() as { host_id: string; display_name: string }; writes.push(input);
      const invitation = { enrollment_id: id, company_id: 'one', host_id: input.host_id, nonce: 'b'.repeat(64),
        invitation_token: token, expires_at: '2099-10-11T00:10:00Z', state: 'pending' };
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
  expect(await list.findByText(/Identidad confirmada; falta preparar el ejecutor con cauce hosts setup/u)).toBeVisible();
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
  expect(await list.findByText(/Portátil · one-laptop · Ejecutor listo: puede crear agentes/u)).toBeVisible();
  expect(list.getByText(/Torre · one-desk · Identidad confirmada; falta preparar el ejecutor/u)).toBeVisible();
  expect(screen.getByText(`cauce hosts setup --signer-fingerprint ${fingerprint}`)).toBeVisible();
});
it('no muestra una huella malformada como ancla', async () => {
  server.use(http.get(path, () => HttpResponse.json({ setup_signer_fingerprint: 'not-a-fingerprint', enrollments: [] })));
  renderWithApi(<HostEnrollmentPanel canEnroll />);
  expect(await screen.findByText('Aún no hay invitaciones.')).toBeVisible();
  expect(screen.queryByText(/--signer-fingerprint/u)).not.toBeInTheDocument();
});
