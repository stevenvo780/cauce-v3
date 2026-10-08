import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { ChangeRequest } from './ConfigPage.test-helpers';

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });

async function openAdministration() {
  await screen.findByRole('tablist', { name: 'Secciones de ajustes' });
}
async function roundtrip(user: ReturnType<typeof userEvent.setup>) {
  const active = screen.getByRole('tablist', { name: 'Secciones de ajustes' }).querySelector('[aria-selected="true"]');
  const name = active?.textContent ?? 'Espacios y salas';
  await user.click(screen.getByRole('tab', { name: 'Agentes' }));
  await user.click(screen.getByRole('tab', { name }));
}

it('conserva el JSON editado y su pestaña al salir de administración y volver', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await openAdministration();
  await user.click(screen.getByRole('tab', { name: 'Avanzado' }));
  const draft = '{"resource":"tenant","action":"update","id":"Steven","value":{"enabled":false}}';
  await user.clear(screen.getByLabelText('Mutación JSON'));
  await user.type(screen.getByLabelText('Mutación JSON'), draft.replaceAll('{', '{{'));
  await roundtrip(user);
  expect(screen.getByRole('tab', { name: 'Avanzado' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Mutación JSON')).toHaveValue(draft);
});

it('conserva borradores del alta rápida y del wizard durante sus propias idas y vueltas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await openAdministration();
  await user.type(screen.getByLabelText('Alias'), 'pendiente');
  await roundtrip(user);
  expect(screen.getByLabelText('Alias')).toHaveValue('pendiente');
  await user.click(screen.getByRole('button', { name: 'Espacio completo, paso a paso' }));
  await user.clear(screen.getByLabelText('Tenant id'));
  await user.type(screen.getByLabelText('Tenant id'), 'DraftTenant');
  await roundtrip(user);
  expect(screen.getByLabelText('Tenant id')).toHaveValue('DraftTenant');
});

it('mantiene el bloqueo del POST pendiente y presenta su recibo al volver, sin reenviar', async () => {
  const user = userEvent.setup();
  const requests: ChangeRequest[] = [];
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    requests.push(input);
    await pending;
    return HttpResponse.json({
      applied: true, dry_run: false, revision: 2, mutation: input.mutation,
      inverse_mutation: input.mutation, rolled_back_revision_id: null, summary: 'alta confirmada',
    }, { status: 201 });
  }));
  renderWithApi(<ConfigPage />);
  await openAdministration();
  await user.type(screen.getByLabelText('Tenant'), 'Miguel');
  await user.type(screen.getByLabelText('Room'), 'grp.miguel');
  await user.type(screen.getByLabelText('Alias'), 'new_alias');
  await user.click(screen.getByRole('button', { name: 'Crear' }));
  await waitFor(() => { expect(requests).toHaveLength(1); });
  await roundtrip(user);
  expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Crear' }));
  expect(requests).toHaveLength(1);
  await user.click(screen.getByRole('tab', { name: 'Agentes' }));
  await act(async () => { release?.(); await pending; });
  await waitFor(() => {
    expect(screen.getByLabelText('Alias', { selector: 'input' })).toHaveValue('');
  });
  await user.click(screen.getByRole('tab', { name: 'Espacios y salas' }));
  expect(await screen.findByText(/creado en la revisión 2/)).toHaveTextContent('alta confirmada');
  expect(screen.getByLabelText('Alias')).toHaveValue('');
  expect(requests).toHaveLength(1);
});

it('cancela la confirmación al cambiar de sección y permite revisar otra intención', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await openAdministration();
  await user.selectOptions(screen.getByLabelText('Rol de permisos de Miguel/grp.miguel/janus'), 'operator');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
  await roundtrip(user);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Rol de permisos de Miguel/grp.miguel/janus'), 'operator');
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
});
