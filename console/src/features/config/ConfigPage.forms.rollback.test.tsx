import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigAdministration } from './ConfigPage';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { irA, servirConfig, snapshotDeConfig } from './ConfigPage.test-helpers';

const retired = { resource: 'room', action: 'retire', tenant_id: 'Miguel', id: 'grp.miguel' };
const restored = { ...retired, action: 'restore' };

it.each([retired, { resource: 'batch', action: 'apply', mutations: [retired] }])('previsualiza rollback de un cambio lógico permitido', async (operation) => {
  servirConfig(() => ({ ...snapshotDeConfig(1), revisions: [{ id: '1', operation }] }));
  server.use(http.post('*/v3/console/config/revisions/1/rollback', () => HttpResponse.json({
    applied: false, dry_run: true, revision: 1, summary: 'rollback validado', rolled_back_revision_id: 1,
    mutation: restored, inverse_mutation: retired,
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /historial y json/i);
  await user.click(screen.getByRole('button', { name: /^Preview$/ }));
  expect(await screen.findByText(/preview del rollback de la revisión 1 aceptado/i)).toBeInTheDocument();
});

it('bloquea rollback de batch con autoridad de cuentas y de batches anidados', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), revisions: [
    { id: '1', operation: { resource: 'batch', action: 'apply', mutations: [{ resource: 'provider_account', action: 'delete', id: 'account' }] } },
    { id: '2', operation: { resource: 'batch', action: 'apply', mutations: [{ resource: 'batch', action: 'apply', mutations: [retired] }] } },
  ] }));
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /historial y json/i);
  const audit = screen.getByRole('heading', { name: 'Audit trail de configuración' }).closest('section');
  if (!audit) throw new Error('Audit panel missing');
  expect(within(audit).queryByRole('button', { name: /^Rollback$/ })).not.toBeInTheDocument();
  expect(within(audit).getByRole('link', { name: /abrir cuentas y cuotas/i })).toBeInTheDocument();
});

it('previsualiza un rollback de 200 cambios del historial con recibo completo', async () => {
  const mutations = Array.from({ length: 200 }, (_, index) => ({ ...retired, id: `group-${String(index)}` }));
  const operation = { resource: 'batch', action: 'apply', mutations };
  const inverse = { ...operation, mutations: mutations.map((mutation) => ({ ...mutation, action: 'restore' })) };
  servirConfig(() => ({ ...snapshotDeConfig(1), revisions: [{ id: '1', operation }] }));
  server.use(http.post('*/v3/console/config/revisions/1/rollback', () => HttpResponse.json({
    applied: false, dry_run: true, revision: 1, summary: 'rollback de 200 cambios validado', rolled_back_revision_id: 1,
    mutation: inverse, inverse_mutation: operation,
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /historial y json/i);
  await user.click(screen.getByRole('button', { name: /^Preview$/ }));
  expect(await screen.findByText(/preview del rollback de la revisión 1 aceptado/i)).toBeInTheDocument();
});

it('conserva el bloqueo de cuentas dentro de una revisión de 200 cambios', async () => {
  const operation = { resource: 'batch', action: 'apply', mutations: [
    ...Array.from({ length: 199 }, (_, index) => ({ ...retired, id: `group-${String(index)}` })),
    { resource: 'provider_account', action: 'delete', id: 'account-a' },
  ] };
  servirConfig(() => ({ ...snapshotDeConfig(1), revisions: [{ id: '1', operation }] }));
  const user = userEvent.setup();
  renderWithApi(<ConfigAdministration />);
  await irA(user, /historial y json/i);
  const audit = screen.getByRole('heading', { name: 'Audit trail de configuración' }).closest('section');
  if (!audit) throw new Error('Audit panel missing');
  expect(within(audit).queryByRole('button', { name: /^Rollback$/ })).not.toBeInTheDocument();
  expect(within(audit).getByRole('link', { name: /abrir cuentas y cuotas/i })).toBeInTheDocument();
});
