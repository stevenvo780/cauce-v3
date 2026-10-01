import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';
import { RUTA_PERFIL, perfilAplicado } from './perfil-fixtures';
import { draftFields, editProfileDraft, type ProfileDraft } from './profile-draft';
import { destinosDelArnes } from './perfil';
import { FicherosTab, type BorradorDeFichero } from './FicherosTab';
import { AgentContextPanel } from './AgentContextPanel';
import { ApiProvider } from '../../api/context';
import { CauceApi } from '../../api/client';

function ProfileHarness() {
  const [draft, setDraft] = useState<ProfileDraft>();
  const [open, setOpen] = useState(true);
  return <>
    <button onClick={() => { setOpen(!open); }}>Cambiar vista</button>
    {open ? <PerfilTab tenantId="Steven" alias="kant" borrador={draft} onBorrador={setDraft} configWritePermission="allowed" /> : null}
  </>;
}

it('keeps the original profile revision and all original fields across a newer read', async () => {
  let current = perfilAplicado(4, { perfil: { ...perfilAplicado().perfil, role_summary: 'rol inicial' } });
  let writes = 0;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(current)),
    http.put(RUTA_PERFIL, () => { writes += 1; return HttpResponse.json({}); }),
  );
  const user = userEvent.setup();
  renderWithApi(<ProfileHarness />);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'mi borrador');
  await user.click(screen.getByRole('button', { name: 'Cambiar vista' }));
  current = perfilAplicado(5, { perfil: { ...current.perfil, role_summary: 'rol de otra persona' } });
  await user.click(screen.getByRole('button', { name: 'Cambiar vista' }));
  expect(await screen.findByText('El perfil cambió mientras editabas.')).toBeInTheDocument();
  expect(screen.getByLabelText(/^Identidad y propósito/i)).toHaveValue('mi borrador');
  expect(screen.getByLabelText(/^Rol declarado/i)).toHaveValue('rol inicial');
  await user.type(screen.getByLabelText(/Motivo de este cambio/i), 'revisar antes de guardar');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
  expect(writes).toBe(0);
  await user.click(screen.getByRole('button', { name: /Descartar borrador de perfil/i }));
  await waitFor(() => { expect(screen.getByLabelText(/^Rol declarado/i)).toHaveValue('rol de otra persona'); });
  expect(screen.getByLabelText(/Motivo de este cambio/i)).toHaveValue('');
});

it('does not silently retry a conflicted draft with the latest revision', async () => {
  let current = perfilAplicado(4);
  const revisions: unknown[] = [];
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(current)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      revisions.push((await request.json() as { expected_revision: unknown }).expected_revision);
      current = perfilAplicado(5, { perfil: { ...current.perfil, purpose: 'cambio remoto' } });
      return HttpResponse.json({ error: 'profile_revision_conflict', message: 'conflicto de revisión' }, { status: 409 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<ProfileHarness />);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'mi borrador');
  await user.type(screen.getByLabelText(/Motivo de este cambio/i), 'cambio que quiero guardar');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await screen.findByText('El perfil cambió mientras editabas.');
  expect(revisions).toEqual([4]);
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
  expect(screen.getByLabelText(/^Identidad y propósito/i)).toHaveValue('mi borrador');
});

it('rejects an incomplete pending receipt without claiming the desired was saved', async () => {
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado())),
    http.put(RUTA_PERFIL, () => HttpResponse.json({ state: 'pending_session_refresh' }, { status: 202 })),
  );
  const user = userEvent.setup();
  renderWithApi(<ProfileHarness />);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'conservar borrador');
  await user.type(screen.getByLabelText(/Motivo de este cambio/i), 'motivo que se conserva');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  expect(await screen.findByText(/no acreditó el guardado completo/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/^Identidad y propósito/i)).toHaveValue('conservar borrador');
  expect(screen.getByLabelText(/Motivo de este cambio/i)).toHaveValue('motivo que se conserva');
});

it('keeps absent-profile CAS and maps Muse without inventing OpenCode governance', () => {
  const base = { ...perfilAplicado(), publicado: true, revision: null, exists: false };
  const draft = editProfileDraft(base, undefined, { purpose: 'nuevo' });
  expect(draft.base?.revision).toBeNull();
  expect(draftFields({ ...base, revision: 1, perfil: { ...base.perfil, role_summary: 'remoto' } }, draft).role_summary).toBe('');
  expect(destinosDelArnes('muse', [{ nombre: 'AGENTS.md' }]).purpose).toEqual({ tipo: 'fichero', nombre: 'AGENTS.md' });
  expect(destinosDelArnes('opencode', [{ nombre: 'AGENTS.md' }]).purpose.tipo).toBe('ausente');
});

it('retains panel drafts across close, isolates the operator, and does not claim unsupported OpenCode editing', async () => {
  let actor = 'Steven:first';
  const api = new CauceApi('http://localhost');
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: actor, roles: ['operator'], permissions: ['config.write'] })),
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado())),
  );
  function PanelHarness() {
    const [open, setOpen] = useState(true);
    return <ApiProvider api={api}>
      <button onClick={() => { setOpen(!open); }}>Abrir o cerrar contexto</button>
      {open ? <AgentContextPanel tenantId="Steven" alias="kant" /> : null}
    </ApiProvider>;
  }
  const user = userEvent.setup();
  render(<PanelHarness />);
  const purpose = await screen.findByLabelText(/^Identidad y propósito/i);
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  await user.type(purpose, 'borrador del primer operador');
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Abrir o cerrar contexto' }));
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Abrir o cerrar contexto' }));
  await waitFor(() => { expect(screen.getByLabelText(/^Identidad y propósito/i)).toHaveValue('borrador del primer operador'); });
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Abrir o cerrar contexto' }));
  actor = 'Steven:second';
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado(4, { harness: 'opencode', ficheros: [] }))));
  await user.click(screen.getByRole('button', { name: 'Abrir o cerrar contexto' }));
  await waitFor(() => { expect(screen.getByLabelText(/^Identidad y propósito/i)).toHaveValue(''); });
  expect(await screen.findByText(/OpenCode puede ejecutar tareas y conversar/)).toBeInTheDocument();
  await waitFor(() => { expect(screen.getByLabelText(/^Identidad y propósito/i)).toBeDisabled(); });
});

it('keeps a manual write locked across accordion unmounts and cannot lose newer typing', async () => {
  const root = 'http://localhost/v3/console/tenants/Steven/agents/kant/documents';
  const path = '/home/stev/.claude/CLAUDE.md';
  let release!: () => void;
  let writes = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.get(root, () => HttpResponse.json({ facts_source: 'measured', items: [{ kind: 'directive', label: 'Manual de prueba', path, format: 'markdown', readable: true, editable: true }] })),
    http.get(`${root}/directive/content`, () => HttpResponse.json({ tenant_id: 'Steven', alias: 'kant', kind: 'directive', path, format: 'markdown', exists: true, content: 'base', sha: 'a'.repeat(64), bytes: 4, editable: true, truncated: false, projected: false })),
    http.put(`${root}/directive/content`, async ({ request }) => {
      writes += 1;
      const body = await request.json() as { content: string };
      await pending;
      return HttpResponse.json({ ok: true, state: 'written_pending_session', evidence: 'probe_write_ack', path, sha: 'b'.repeat(64), bytes: new TextEncoder().encode(body.content).byteLength });
    }),
  );
  function ManualHarness() {
    const [draft, setDraft] = useState<BorradorDeFichero>();
    return <FicherosTab tenantId="Steven" alias="kant" mode="manual-editor" configWritePermission="allowed" borradores={{ directive: draft }} onBorrador={(_, next) => { setDraft(next); }} />;
  }
  const user = userEvent.setup();
  renderWithApi(<ManualHarness />);
  await user.click(await screen.findByText('Manual de prueba'));
  await user.type(await screen.findByLabelText('Contenido de Manual de prueba'), ' nuevo');
  await user.type(screen.getByLabelText(/Motivo del guardado/i), 'actualizar manual de prueba');
  await user.click(screen.getByRole('button', { name: /^Guardar$/ }));
  await waitFor(() => { expect(writes).toBe(1); });
  expect(screen.getByLabelText('Contenido de Manual de prueba')).toHaveAttribute('readonly');
  await user.click(screen.getByText('Manual de prueba'));
  await user.click(screen.getByText('Manual de prueba'));
  expect(await screen.findByLabelText('Contenido de Manual de prueba')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  await act(async () => { release(); await pending; });
  await waitFor(() => { expect(screen.getByLabelText('Contenido de Manual de prueba')).not.toHaveAttribute('readonly'); });
  expect(writes).toBe(1);
});
