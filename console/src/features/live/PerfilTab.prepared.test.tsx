import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfil, AgentPerfilCampos, AgentPerfilValor } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';
import { perfilAplicado, RUTA_PERFIL } from './perfil-fixtures';
import type { ProfileDraft } from './profile-draft';
import { desiredProfileReceipt } from './profile-save-receipt';

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

function pendingProfile() {
  return perfilAplicado(4, { applied_revision: 3, runtime_state: 'pending', runtime_verification: null, runtime_adoption: null });
}
function desiredReceipt() {
  return { ok: true, state: 'pending_session_refresh', tenant_id: 'Steven', alias: 'kant', revision: 5,
    applied_revision: 3, acknowledgements: [], runtime_verification: null, runtime_adoption: null };
}

it('confirma los siete campos deseados sin sonda y limpia el borrador sin acreditar archivos ni adopción', async () => {
  let current = pendingProfile();
  let body: unknown;
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(current)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const input = await request.json() as { profile: AgentPerfilValor };
      body = input;
      current = { ...current, revision: 5, perfil: input.profile };
      return HttpResponse.json(desiredReceipt(), { status: 202 });
    }));
  const user = userEvent.setup(); renderWithApi(<View />);
  const purpose = await screen.findByLabelText(/^Identidad y propósito/i);
  for (const [label, value] of [
    [/^Identidad y propósito/i, 'Coordinar'], [/^Rol declarado/i, 'Revisar'],
    [/^Tu humano y cómo tratarlo/i, 'Ser claro'], [/^Responsabilidades/i, 'Documentar'],
    [/^Restricciones/i, 'Conservar datos'], [/^Herramientas declaradas/i, 'Consola'],
    [/^Instrucciones fijas/i, 'Verificar resultados'],
  ] as const) await user.type(screen.getByLabelText(label), value);
  await user.type(screen.getByLabelText(/Motivo de este cambio de perfil/i), reason);
  await user.click(screen.getByRole('button', { name: 'Guardar y aplicar perfil' }));
  expect(await screen.findByText(/Perfil deseado guardado en la revisión 5/i)).toHaveTextContent(/pendiente de aplicar en el próximo turno/i);
  expect(body).toMatchObject({ expected_revision: 4, reason, profile: {
    purpose: 'Coordinar', role_summary: 'Revisar', human_brief: 'Ser claro', responsibilities: ['Documentar'],
    restrictions: ['Conservar datos'], tools: ['Consola'], operating_rules: ['Verificar resultados'],
  } });
  expect(purpose).toHaveValue('Coordinar');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Descartar borrador de perfil y releer' })).toBeDisabled();
  expect(screen.queryByText(/El servidor no acreditó el guardado completo/i)).toBeNull();
  expect(screen.queryByText(/El perfil cambió mientras editabas/i)).toBeNull();
  expect(screen.queryByText(/^Aplicado:/)).toBeNull();
  expect(screen.queryByText(/los archivos del agente quedaron actualizados/i)).toBeNull();
});

it('exige recibo desired estricto y relectura del mismo contenido con aplicado sin avanzar', () => {
  const before: AgentPerfil = { publicado: true, ...pendingProfile() };
  const fields: AgentPerfilCampos = { purpose: 'Coordinar', role_summary: '', human_brief: '',
    responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
  const refreshed: AgentPerfil = { ...before, revision: 5, perfil: { ...before.perfil, purpose: fields.purpose } };
  expect(desiredProfileReceipt(desiredReceipt(), before, refreshed, fields, 'Steven', 'kant'))
    .toEqual({ revision: 5, appliedRevision: 3 });
  for (const extra of [{ alias: 'other' }, { tenant_id: 'other' }, { revision: 6 }, { applied_revision: 5 },
    { acknowledgements: [{}] }, { runtime_verification: {} }, { runtime_adoption: {} }, { state: 'applied' },
    { desired_revision: 5 }]) {
    expect(desiredProfileReceipt({ ...desiredReceipt(), ...extra }, before, refreshed, fields, 'Steven', 'kant')).toBeUndefined();
  }
  for (const extra of [{ alias: 'other' }, { tenant_id: 'other' }, { revision: 6 }, { applied_revision: 5 },
    { agent_enabled: false }, { exists: false }, { runtime_state: 'applied' as const },
    { runtime_verification: before.runtime_verification ?? undefined },
    { perfil: { ...refreshed.perfil, purpose: 'Otro contenido' } },
    { perfil: { ...refreshed.perfil, tools: ['Otra herramienta'] } }]) {
    expect(desiredProfileReceipt(desiredReceipt(), before, { ...refreshed, ...extra }, fields, 'Steven', 'kant')).toBeUndefined();
  }
  const initial = { ...before, exists: false, revision: null, applied_revision: null };
  expect(desiredProfileReceipt({ ...desiredReceipt(), revision: 1, applied_revision: null }, initial,
    { ...refreshed, revision: 1, applied_revision: null }, fields, 'Steven', 'kant'))
    .toEqual({ revision: 1, appliedRevision: null });
});
