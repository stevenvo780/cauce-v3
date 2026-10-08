import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfilValor } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';
import { perfilAplicado, RUTA_PERFIL } from './perfil-fixtures';
import type { ProfileDraft } from './profile-draft';

const reason = 'Preparar contexto antes de iniciar';
function View({ permission = 'allowed' }: { permission?: 'allowed' | 'denied' | 'unknown' }) {
  const [draft, setDraft] = useState<ProfileDraft>();
  return <PerfilTab tenantId="Steven" alias="kant" borrador={draft} onBorrador={setDraft} configWritePermission={permission} />;
}
function disabledProfile() {
  return perfilAplicado(4, { agent_enabled: false, can_prepare_draft: true, runtime_state: 'disabled',
    applied_revision: 3, runtime_verification: null, runtime_adoption: null, ficheros: [] });
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  const field = await screen.findByLabelText(/^Identidad y propósito/i);
  await user.type(field, 'Coordinar la flota');
  await user.type(screen.getByLabelText(/Motivo de este cambio de perfil/i), reason);
  await user.click(screen.getByRole('button', { name: 'Preparar perfil para el inicio' }));
  return field;
}
function preparedReceipt(profile: AgentPerfilValor) {
  return { ok: true, state: 'prepared_disabled', tenant_id: 'Steven', alias: 'kant', agent_enabled: false,
    revision: 5, desired_revision: 5, applied_revision: 3, perfil: { ...profile, tenant_id: 'Steven', alias: 'kant' } };
}

it('prepara desired sin archivos, conserva aplicado y no afirma aplicación de runtime', async () => {
  let current = disabledProfile();
  let body: unknown;
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(current)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const input = await request.json() as { profile: AgentPerfilValor };
      body = input;
      current = { ...current, revision: 5, perfil: input.profile };
      return HttpResponse.json(preparedReceipt(input.profile), { status: 202 });
    }));
  const user = userEvent.setup(); renderWithApi(<View />);
  await prepare(user);
  expect(await screen.findByText(/Perfil deseado preparado; se aplicará al iniciar/i)).toHaveTextContent(/aplicado 3/);
  expect(body).toMatchObject({ expected_revision: 4, reason, profile: { purpose: 'Coordinar la flota' } });
  expect(screen.getByRole('button', { name: 'Preparar perfil para el inicio' })).toBeDisabled();
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue('');
  expect(screen.queryByText(/^Aplicado:/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Recargar contexto/i })).toBeNull();
});

it.each([false, undefined])('bloquea edición sin autoridad explícita can_prepare_draft=%s', async (can_prepare_draft) => {
  let writes = 0;
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json({ ...disabledProfile(), can_prepare_draft })),
    http.put(RUTA_PERFIL, () => { writes += 1; return HttpResponse.json({}); }));
  renderWithApi(<View />);
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toBeDisabled();
  expect(writes).toBe(0);
});

it.each(['denied', 'unknown'] as const)('no habilita preparación si config.write está %s', async (permission) => {
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(disabledProfile())));
  renderWithApi(<View permission={permission} />);
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preparar perfil para el inicio' })).toBeDisabled();
});

it.each([
  { alias: 'other' }, { applied_revision: 5 }, { revision: 6, desired_revision: 6 },
  { acknowledgements: [] }, { state: 'applied' }, { desired_revision: 4 },
])('conserva borrador ante un 202 que no prueba preparación exacta: %j', async (extra) => {
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(disabledProfile())),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: AgentPerfilValor };
      return HttpResponse.json({ ...preparedReceipt(body.profile), ...extra }, { status: 202 });
    }));
  const user = userEvent.setup(); renderWithApi(<View />);
  const field = await prepare(user);
  expect(await screen.findByText(/El servidor no acreditó la misma revisión/i)).toBeInTheDocument();
  expect(field).toHaveValue('Coordinar la flota');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue(reason);
  expect(screen.queryByText(/Perfil deseado preparado;/i)).toBeNull();
});

it('conserva el motivo de denegación del backend y el texto al caducar la autoridad', async () => {
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(disabledProfile())),
    http.put(RUTA_PERFIL, () => HttpResponse.json({ error: 'forbidden', message: 'La sesión ya no puede configurar este agente.' }, { status: 403 })));
  const user = userEvent.setup(); renderWithApi(<View />);
  const field = await prepare(user);
  expect(await screen.findByText(/La sesión ya no puede configurar este agente/i)).toBeInTheDocument();
  expect(field).toHaveValue('Coordinar la flota');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue(reason);
});

it('conserva borrador si la relectura habilita el agente después de preparar desired', async () => {
  let current = disabledProfile();
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(current)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: AgentPerfilValor };
      current = { ...current, revision: 5, perfil: body.profile, agent_enabled: true, can_prepare_draft: false, runtime_state: 'pending' };
      return HttpResponse.json(preparedReceipt(body.profile), { status: 202 });
    }));
  const user = userEvent.setup(); renderWithApi(<View />);
  const field = await prepare(user);
  await waitFor(() => { expect(screen.getByText(/El servidor no acreditó la misma revisión/i)).toBeInTheDocument(); });
  expect(field).toHaveValue('Coordinar la flota');
  expect(screen.queryByText(/Perfil deseado preparado;/i)).toBeNull();
});
