import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import type { VersionedContextSnapshot } from '../../api/client/context-versions-client';
import { ContextVersionsPanel } from './ContextVersionsPanel';

const base = '*/v3/console/context/agents/One/worker';
function snapshot(): VersionedContextSnapshot { return { version: 2, files: [{ path: 'context/directivas.md', content: 'Versión actual' }],
  desired_version: 2, applied_version: 1, application: { state: 'pending', last_error: null }, sync: { state: 'error', git_commit: null, pushed_at: null, last_error: 'GitHub no disponible' } }; }
function handlers(current: () => VersionedContextSnapshot) {
  server.use(http.get(base, () => HttpResponse.json(current())), http.get(base + '/history', () => HttpResponse.json({ entries: [
    { version: 2, source: 'ui', restored_from: null, created_at: '2026-10-11T00:00:00Z', actor_human_id: '11111111-1111-4111-8111-111111111111', actor_alias: 'dueno', actor_name: 'Dueño', digest: 'digest' },
    { version: 1, source: 'cli', restored_from: null, created_at: '2026-10-10T00:00:00Z', actor_human_id: null, actor_alias: 'dueno', digest: 'earlier' },
  ], next_cursor: null })));
}
it('restaurar crea nueva versión con CAS y no la presenta usada o sincronizada antes de verificarse', async () => {
  let current = snapshot(); const restored: unknown[] = [];
  handlers(() => current);
  server.use(http.get(base + '/diff', ({ request }) => {
    const params = new URL(request.url).searchParams; expect(params.get('from')).toBe('1'); expect(params.get('to')).toBe('2');
    return HttpResponse.json({ from: 1, to: 2, files: [{ path: 'context/directivas.md', change: 'modified', before: 'Anterior', after: 'Versión actual' }] }); }),
  http.post(base + '/restore', async ({ request }) => {
    restored.push(await request.json()); current = { ...current, version: 3, desired_version: 3, files: [{ path: 'context/directivas.md', content: 'Anterior' }],
      sync: { ...current.sync, state: 'pending', last_error: null } }; return HttpResponse.json(current, { status: 202 }); }));
  const user = userEvent.setup(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  expect(await screen.findByText(/El agente aún no acredita la versión 2/u)).toBeVisible();
  expect(screen.getByText('Error de sincronización')).toBeVisible();
  await user.click(await screen.findByRole('button', { name: 'Ver diferencias de versión 1' }));
  const differences = within(await screen.findByRole('region', { name: 'Diferencias de contexto' }));
  expect(differences.getByText('Anterior')).toBeVisible(); expect(differences.getByText('Versión actual')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Restaurar versión 1' })); expect(restored).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Confirmar restauración' }));
  expect(await screen.findByText('Restauración guardada como una versión nueva.')).toBeVisible();
  expect(restored).toEqual([{ expected_version: 2, version: 1 }]);
  expect(screen.getByText(/El agente aún no acredita la versión 3/u)).toBeVisible();
  expect(screen.getByText('Pendiente')).toBeVisible(); expect(screen.queryByText('Sincronizado')).not.toBeInTheDocument();
});
it('un conflicto conserva el texto y versión del borrador; lectores solo consultan', async () => {
  handlers(snapshot); const writes: unknown[] = [];
  server.use(http.put(base, async ({ request }) => { writes.push(await request.json()); return HttpResponse.json({ message: 'Conflicto de versión: el contexto cambió.' }, { status: 409 }); }));
  const user = userEvent.setup(); const view = renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  const text = await screen.findByRole('textbox', { name: 'Contenido de context/directivas.md' });
  await user.clear(text); await user.type(text, 'Borrador recuperable'); await user.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Conflicto de versión'); expect(text).toHaveValue('Borrador recuperable');
  expect(writes).toEqual([{ expected_version: 2, files: [{ path: 'context/directivas.md', content: 'Borrador recuperable' }], source: 'ui' }]);
  view.unmount(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite={false} />);
  await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Contenido de context/directivas.md' })).toBeDisabled(); });
  expect(screen.getByRole('button', { name: 'Aplicar al agente' })).toBeDisabled();
});
it('muestra origen y autor de cada versión, incluidas las nativas del agente', async () => {
  handlers(() => ({ ...snapshot(), version: 3, desired_version: 3 }));
  server.use(http.get(base + '/history', () => HttpResponse.json({ entries: [
    { version: 3, source: 'native', restored_from: null, created_at: '2026-10-12T00:00:00Z', actor_human_id: null, actor_alias: 'worker', digest: 'native-digest' },
    { version: 2, source: 'ui', restored_from: null, created_at: '2026-10-11T00:00:00Z', actor_human_id: '11111111-1111-4111-8111-111111111111', actor_alias: 'dueno', actor_name: 'Dueño', digest: 'digest' },
  ], next_cursor: null })));
  renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  expect(await screen.findByText(/Versión 3 · Nativo \(en el espacio\) · agente worker/u)).toBeVisible();
  expect(screen.getByText(/Versión 2 · Consola · Dueño/u)).toBeVisible();
  expect(screen.queryByText('11111111-1111-4111-8111-111111111111')).not.toBeInTheDocument();
});
it('un conflicto de ingesta nativa se explica en español y se resuelve creando un borrador', async () => {
  handlers(() => ({ ...snapshot(), application: { state: 'error', last_error: 'native_context_conflict' } }));
  const user = userEvent.setup(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Conflicto de ingesta nativa');
  expect(banner).toHaveTextContent('No se perdió nada');
  await user.click(within(banner).getByRole('button', { name: 'Resolver desde esta ficha' }));
  expect(await screen.findByText(/Borrador sin guardar, basado en la versión 2/u)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar nueva versión' })).toBeEnabled();
});
it.each([
  ['context_runtime_unsupported', /adaptador antiguo: actualiza su paquete; Muse sin terminal compartida/u, 'Error de aplicación'],
  ['context_runtime_attempts_exhausted', /Se agotaron los reintentos/u, 'Error de aplicación'],
  ['context_version_unreadable', /La versión actual no se puede leer\. Restaura una versión anterior desde el historial\./u, 'Error de aplicación'],
  ['context_runtime_offline', /desconectado: la versión se aplicará cuando vuelva/u, 'Aplicación pendiente'],
  ['context_runtime_verification_failed', /próximo turno/u, 'Aplicación pendiente'],
])('traduce %s a español y solo lo marca como error si exige acción', async (code, text, state) => {
  handlers(() => ({ ...snapshot(), application: { state: 'error', last_error: code } }));
  renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  expect(await screen.findByText(text)).toBeVisible();
  expect(screen.queryByText(code)).not.toBeInTheDocument();
  expect(screen.getByText(state)).toBeVisible();
});
it('un error del servidor se muestra por código, no con su mensaje en inglés', async () => {
  handlers(snapshot);
  server.use(http.post(base + '/apply', () => HttpResponse.json({ error: 'context_runtime_unavailable', message: 'runtime sink missing' }, { status: 503 })));
  const user = userEvent.setup(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  await user.click(await screen.findByRole('button', { name: 'Aplicar al agente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible');
  expect(screen.queryByText(/runtime sink missing/u)).not.toBeInTheDocument();
});
it('una petición con versión ilegible indica restaurar y conserva la acción del historial', async () => {
  handlers(snapshot);
  server.use(http.post(base + '/apply', () => HttpResponse.json({ error: 'context_version_unreadable', message: 'stored version is unreadable' }, { status: 422 })));
  const user = userEvent.setup(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  await user.click(await screen.findByRole('button', { name: 'Aplicar al agente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La versión actual no se puede leer. Restaura una versión anterior desde el historial.');
  const history = within(screen.getByRole('region', { name: 'Historial de versiones' }));
  await user.click(history.getByRole('button', { name: 'Restaurar versión 1' }));
  expect(screen.getByRole('button', { name: 'Confirmar restauración' })).toBeEnabled();
  expect(screen.queryByText(/stored version is unreadable/u)).not.toBeInTheDocument();
});
it('una escritura sin confirmar explica el bloqueo y se comprueba desde la ficha', async () => {
  const write = { operation_id: '22222222-2222-4222-8222-222222222222', created_at: '2026-10-25T10:00:00Z', dispatch: 'authorized' as const,
    operation: 'profile' as const, sealed_plan: false };
  let current: VersionedContextSnapshot = { ...snapshot(), pending_writes: [write] }; const recoveries: string[] = []; let attempts = 0;
  handlers(() => current);
  server.use(http.post(base + '/writes/:operation/recover', ({ params }) => {
    recoveries.push(String(params.operation)); attempts += 1;
    if (attempts === 1) return HttpResponse.json({ error: 'context_write_recovery_unproven', operation_id: write.operation_id }, { status: 409 });
    current = { ...snapshot(), pending_writes: [] };
    return HttpResponse.json({ operation_id: write.operation_id, resolution: 'target' });
  }));
  const user = userEvent.setup(); renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Hay una escritura del perfil sin confirmar');
  expect(banner).toHaveTextContent('el agente no recibe mensajes');
  await user.click(within(banner).getByRole('button', { name: 'Comprobar y resolver' }));
  expect(await screen.findByText(/todavía no confirma el resultado de esa escritura/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Comprobar y resolver' }));
  expect(await screen.findByText(/el agente tiene la escritura y quedó registrada/u)).toBeVisible();
  expect(recoveries).toEqual([write.operation_id, write.operation_id]);
  expect(screen.queryByRole('button', { name: 'Comprobar y resolver' })).not.toBeInTheDocument();
});
it('quien solo lee ve la escritura pendiente pero no puede resolverla', async () => {
  handlers(() => ({ ...snapshot(), pending_writes: [{ operation_id: '33333333-3333-4333-8333-333333333333', created_at: '2026-10-25T10:00:00Z',
    dispatch: 'authorized', operation: 'unknown', sealed_plan: false }] }));
  renderWithApi(<ContextVersionsPanel tenantId="One" alias="worker" canWrite={false} />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Hay una escritura de ficheros del agente sin confirmar');
  expect(within(banner).getByRole('button', { name: 'Comprobar y resolver' })).toBeDisabled();
});
