import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ApiProvider } from '../../api/context';
import { CauceApi } from '../../api/client';
import { server } from '../../mocks/server';
import { AgentContextPanel } from './AgentContextPanel';
import { RUTA_PERFIL, ackAplicado, perfilAplicado } from './perfil-fixtures';
import { profileIsAdopted } from './profile-save-receipt';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { useContextEditorStore } from './context-editor-store';
import { ProfileStatus } from './ProfileStatus';
import type { AgentPerfil } from '../../api/types';

function NavigationHarness({ api }: { api: CauceApi }) {
  const [view, setView] = useState<'panel' | 'hidden'>('panel');
  return <ApiProvider api={api}>
    <button onClick={() => { setView('hidden'); }}>Cerrar configuración</button>
    <button onClick={() => { setView('panel'); }}>Volver a configuración</button>
    {view === 'panel' ? <AgentContextPanel tenantId="Steven" alias="kant" /> : null}
  </ApiProvider>;
}

it.each(['applied', 'pending', 'error'] as const)('settles %s after closing the profile panel and retains the outcome', async (mode) => {
  let actual = perfilAplicado();
  let release!: () => void;
  let started = false;
  let acknowledged = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(actual)),
    http.get(`${RUTA_PERFIL}/revisions`, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', observed_at: '2026-08-26T00:00:00Z',
      entries: [{ ...perfilAplicado().perfil, id: '1', revision: 1, operation: 'insert', actor_tenant: null, actor_alias: null, changed_at: '2026-08-25T00:00:00Z' }],
    })),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: typeof actual.perfil };
      started = true;
      await pending;
      if (mode === 'error') {
        acknowledged = true;
        return HttpResponse.json({ error: 'unavailable', message: 'canal de prueba no disponible' }, { status: 503 });
      }
      actual = perfilAplicado(5, { perfil: body.profile, ...(mode === 'pending' ? { runtime_state: 'pending_session_refresh', applied_revision: 4, runtime_adoption: null } : {}) });
      acknowledged = true;
      return HttpResponse.json(mode === 'applied' ? ackAplicado(5) : {
        ...ackAplicado(5), state: 'pending_session_refresh', applied_revision: 4, runtime_adoption: null,
        runtime_verification: { ...actual.runtime_verification, documents: actual.runtime_verification?.documents.map((document) => ({ ...document, expected_bytes: 18, observed_bytes: 18 })) },
      }, { status: mode === 'pending' ? 202 : 200 });
    }),
  );
  const user = userEvent.setup();
  render(<NavigationHarness api={new CauceApi('http://localhost')} />);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'texto que debe sobrevivir');
  await user.type(screen.getByLabelText(/Motivo de este cambio/i), 'guardar antes de volver al chat');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await waitFor(() => { expect(started).toBe(true); });
  await user.click(screen.getByRole('button', { name: 'Cerrar configuración' }));
  await act(async () => { release(); await pending; });
  await waitFor(() => { expect(acknowledged).toBe(true); });
  await user.click(screen.getByRole('button', { name: 'Volver a configuración' }));
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toHaveValue('texto que debe sobrevivir');
  if (mode === 'error') {
    expect(await screen.findByText(/canal de prueba no disponible/)).toBeInTheDocument();
    expect(screen.getByText(/Borrador sin guardar/)).toBeInTheDocument();
  } else {
    expect(await screen.findByText(mode === 'applied' ? /Aplicado: desired y runtime/ : /Desired y ficheros del runtime quedaron actualizados/)).toBeInTheDocument();
    expect(screen.queryByText(/Borrador sin guardar/)).not.toBeInTheDocument();
    expect(screen.queryByText('El perfil cambió mientras editabas.')).not.toBeInTheDocument();
  }
});

it('keeps the in-flight lock and draft when the page is left and opened again', async () => {
  let actual = perfilAplicado();
  let release!: () => void;
  let writes = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(actual)),
    http.get(`${RUTA_PERFIL}/revisions`, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', observed_at: '2026-08-26T00:00:00Z',
      entries: [{ ...perfilAplicado().perfil, id: '1', revision: 1, operation: 'insert', actor_tenant: null, actor_alias: null, changed_at: '2026-08-25T00:00:00Z' }],
    })),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: typeof actual.perfil };
      writes += 1;
      await pending;
      actual = perfilAplicado(5, { perfil: body.profile });
      return HttpResponse.json(ackAplicado(5));
    }),
  );
  const user = userEvent.setup();
  render(<NavigationHarness api={new CauceApi('http://localhost')} />);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'borrador común');
  await user.type(screen.getByLabelText(/Motivo de este cambio/i), 'una sola escritura en curso');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await waitFor(() => { expect(writes).toBe(1); });
  await user.click(screen.getByRole('button', { name: 'Cerrar configuración' }));
  await user.click(screen.getByRole('button', { name: 'Volver a configuración' }));
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toHaveValue('borrador común');
  expect(screen.getByLabelText(/^Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Aplicando…' })).toBeDisabled();
  await user.click(screen.getByRole('tab', { name: /^Historial/ }));
  await screen.findByText(/Alta del perfil · revisión 1/);
  expect(screen.queryByRole('button', { name: /Restaurar esta revisión/i })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: /^Perfil/ }));
  await act(async () => { release(); await pending; });
  expect(await screen.findByText(/Aplicado: desired y runtime/)).toBeInTheDocument();
  expect(screen.queryByText('El perfil cambió mientras editabas.')).not.toBeInTheDocument();
  expect(writes).toBe(1);
});

it('does not let an older settlement erase a replacement draft', async () => {
  function StoreProbe() {
    const { state, update, settle } = useContextEditorStore('Steven', 'kant');
    return <>
      <button onClick={() => {
        const original = { purpose: 'submitted' };
        update({ profile: original });
        update({ profile: { purpose: 'newer restoration' } });
        settle({ expectedDraft: original, draft: undefined, outcome: { tone: 'success', text: 'older outcome' } });
      }}>Resolver escritura vieja</button>
      <p>{state.profile?.purpose}</p>
      <p>{state.outcome?.text}</p>
    </>;
  }
  const user = userEvent.setup();
  render(<ApiProvider api={new CauceApi('http://localhost')}><ConsoleAccessBoundary><StoreProbe /></ConsoleAccessBoundary></ApiProvider>);
  await user.click(screen.getByRole('button', { name: 'Resolver escritura vieja' }));
  expect(screen.getByText('newer restoration')).toBeInTheDocument();
  expect(screen.queryByText('older outcome')).not.toBeInTheDocument();
});

it.each(['generation', 'date', 'revision', 'documents'] as const)('fails closed on incomplete adoption %s evidence', (missing) => {
  const profile = { ...perfilAplicado(), publicado: true } as AgentPerfil;
  if (missing === 'generation') {
    Reflect.deleteProperty(profile.runtime_verification ?? {}, 'generation');
    Reflect.deleteProperty(profile.runtime_adoption ?? {}, 'generation');
  }
  if (missing === 'date') Reflect.deleteProperty(profile.runtime_adoption ?? {}, 'adopted_at');
  if (missing === 'revision') profile.applied_revision = 3;
  if (missing === 'documents' && profile.runtime_adoption) profile.runtime_adoption.documents = [];
  expect(profileIsAdopted(profile)).toBe(false);
  render(<ProfileStatus profile={profile} />);
  expect(screen.getByText('Adopción no acreditada')).toBeInTheDocument();
  expect(screen.queryByText('Adopción acreditada')).not.toBeInTheDocument();
});
