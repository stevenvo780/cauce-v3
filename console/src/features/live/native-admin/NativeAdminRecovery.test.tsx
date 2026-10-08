import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { server } from '../../../mocks/server';
import { renderWithApi, testApi } from '../../../test/render';
import { NativeAdminPanel } from './NativeAdminPanel';
import { clearNativeDrafts } from './drafts';
import type { NativeRead, NativeSaved } from './client';

const path = 'http://localhost/v3/console/tenants/Steven/agents/zeus/native/skill';
const id = 'native-proof'; const operationId = '00000000-0000-4000-8000-000000000065';
const identity = { generation: 'native-generation', container_id: 'native-container', writer_instance_id: '00000000-0000-4000-8000-000000000061' };
const content = '---\nname: native-proof\ndescription: Read carefully\n---\nContent.\n';
const changed = content + 'Changed.\n';
const read = (outcome: NativeRead['outcome']): NativeRead => ({ tenant_id: 'Steven', alias: 'zeus', harness: 'codex', kinds: ['skill', 'mcp'], can_write: true, identity, outcome });
const piece = (text: string | undefined, sha = 'a'.repeat(64)) => read({ type: 'piece', piece: { kind: 'skill', id, sha: text === undefined ? null : sha, editable: true,
  ...(text === undefined ? {} : { value: { content: text } }) } });
const saved = (action: 'put' | 'delete' = 'put'): NativeSaved => ({ tenant_id: 'Steven', alias: 'zeus', state: 'written_pending_reload', action,
  receipt: { type: 'receipt', state: 'done', kind: 'skill', id, operation_id: operationId, operation_generation: '00000000-0000-4000-8000-000000000066',
    identity, path: '/home/dev/account/skills/native-proof/SKILL.md', sha: action === 'delete' ? null : 'b'.repeat(64), bytes: action === 'delete' ? 0 : new TextEncoder().encode(changed).length,
    backup_id: '00000000-0000-4000-8000-000000000067' } });
beforeEach(() => { clearNativeDrafts(testApi); vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId); });
async function open(existing = true, onReload?: () => Promise<void>) {
  server.use(http.get(path, () => HttpResponse.json(read({ type: 'inventory', kind: 'skill', items: existing ? [{ id, editable: true }] : [], truncated: false }))),
    http.get(path + '/' + id, () => HttpResponse.json(piece(existing ? content : undefined))),
    http.post(path + '/' + id + '/discover', async ({ request }) => {
      const body = await request.json() as { operation_id: string; identity: typeof identity };
      return HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', identity: body.identity, state: 'pending', operation_id: body.operation_id });
    }));
  const view = renderWithApi(<NativeAdminPanel tenantId="Steven" alias="zeus" permission="allowed" {...(onReload ? { onReload } : {})} />);
  const details = view.container.querySelector('details'); if (!details) throw new Error('fixture details missing'); details.open = true; fireEvent(details, new Event('toggle'));
  const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Leer inventario nativo' }));
  if (existing) await user.click(await screen.findByRole('button', { name: id }));
  else { await user.type(screen.getByLabelText('Nombre de pieza'), id); await user.click(screen.getByRole('button', { name: 'Leer o preparar pieza' })); }
  await user.type(await screen.findByLabelText('Contenido Markdown'), existing ? 'Changed.\n' : changed);
  await user.type(screen.getByLabelText('Motivo del cambio nativo'), 'Modificar skill con evidencia');
  return { user, view, details };
}
async function unknown() {
  const f = await open();
  server.use(http.put(path + '/' + id, () => HttpResponse.json({ state: 'effect_unknown', operation_id: operationId }, { status: 503 })));
  await f.user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  await screen.findByRole('button', { name: 'Verificar operación nativa pendiente' });
  return f;
}
it('acredita guardado, relectura y reconocimiento sin afirmar adopción de la sesión abierta', async () => {
  const { user } = await open();
  server.use(http.put(path + '/' + id, () => HttpResponse.json(saved(), { status: 202 })),
    http.get(path + '/' + id, () => HttpResponse.json(piece(changed, 'b'.repeat(64)))),
    http.post(path + '/' + id + '/recognize', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', identity,
      outcome: { type: 'recognition', kind: 'skill', id, sha: 'b'.repeat(64), state: 'available_for_new_session', reason: 'provider_read_verified' } })));
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByText(/Guardado con respaldo privado y SHA/)).toBeInTheDocument();
  expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'Verificar reconocimiento del proveedor' }));
  expect(await screen.findByText(/la sesión abierta requiere recarga/)).toBeInTheDocument();
});
it('crea una pieza únicamente desde ausencia medida y CAS null', async () => {
  const { user } = await open(false);
  server.use(http.put(path + '/' + id, async ({ request }) => {
    const body = await request.json() as { mutation: { expected_sha: string | null; value: { content: string } } };
    expect(body.mutation.expected_sha).toBeNull(); expect(body.mutation.value.content).toBe(changed);
    return HttpResponse.json(saved(), { status: 202 });
  }), http.get(path + '/' + id, () => HttpResponse.json(piece(changed, 'b'.repeat(64)))));
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByText(/Guardado con respaldo privado y SHA/)).toBeInTheDocument();
});
it('conserva la operación pendiente al reabrir y sólo libera un reintento tras cercado old', async () => {
  const { user, details } = await unknown();
  expect(screen.getByLabelText('Tipo de pieza')).toBeDisabled(); expect(screen.getByLabelText('Nombre de pieza')).toBeDisabled();
  details.open = false; fireEvent(details, new Event('toggle')); details.open = true; fireEvent(details, new Event('toggle'));
  await user.click(await screen.findByRole('button', { name: 'Leer inventario nativo' }));
  expect(screen.getByLabelText('Contenido Markdown')).toHaveValue(changed);
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeDisabled();
  server.use(http.post(path + '/' + id + '/recover', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', state: 'not_applied', operation_id: operationId })));
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByText(/cercada sin aplicar cambios/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeEnabled();
  expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('Modificar skill con evidencia');
  expect(screen.queryByText(/Guardado recuperado/)).toBeNull();
});
it('mantiene la operación pendiente si la recuperación target no coincide con el archivo y permite verificar de nuevo', async () => {
  const { user } = await unknown();
  server.use(http.post(path + '/' + id + '/recover', () => HttpResponse.json(saved())),
    http.get(path + '/' + id, () => HttpResponse.json(piece('Unrelated text', 'b'.repeat(64)))));
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La relectura no acreditó la recuperación');
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeDisabled();
  server.use(http.get(path + '/' + id, () => HttpResponse.json(piece(changed, 'b'.repeat(64)))));
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByText(/Guardado recuperado con recibo durable/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verificar operación nativa pendiente' })).toBeNull();
});
it('conserva el recibo de una escritura cuando la relectura se pierde y exige recuperación', async () => {
  const { user } = await open();
  server.use(http.put(path + '/' + id, () => HttpResponse.json(saved(), { status: 202 })),
    http.get(path + '/' + id, () => HttpResponse.json({ error: 'unavailable' }, { status: 503 })));
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByRole('button', { name: 'Verificar operación nativa pendiente' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeDisabled();
  expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('Modificar skill con evidencia');
});
it('borra sólo tras confirmación y acredita ausencia mediante relectura', async () => {
  const { user } = await open();
  server.use(http.put(path + '/' + id, async ({ request }) => {
    const body = await request.json() as { mutation: { action: string; expected_sha: string } };
    expect(body.mutation.action).toBe('delete'); expect(body.mutation.expected_sha).toBe('a'.repeat(64));
    return HttpResponse.json(saved('delete'), { status: 202 });
  }), http.get(path + '/' + id, () => HttpResponse.json(piece(undefined))));
  await user.click(screen.getByRole('button', { name: 'Borrar pieza nativa' }));
  expect(screen.queryByText(/Pieza borrada y ausencia/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Confirmar borrado de pieza' }));
  expect(await screen.findByText(/Pieza borrada y ausencia verificada/)).toBeInTheDocument();
});
it('descubre el ID guardado antes del PUT cuando el transporte pierde toda la respuesta y cerca old sin perder borrador', async () => {
  const { user, details } = await open();
  let intended: unknown;
  server.use(http.put(path + '/' + id, async ({ request }) => { intended = await request.json(); return HttpResponse.error(); }),
    http.post(path + '/' + id + '/recover', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', state: 'not_applied', operation_id: operationId })));
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByRole('button', { name: 'Verificar operación nativa pendiente' })).toBeInTheDocument();
  expect(intended).toMatchObject({ identity, operation_id: operationId, mutation: { expected_sha: 'a'.repeat(64) } });
  details.open = false; fireEvent(details, new Event('toggle')); details.open = true; fireEvent(details, new Event('toggle'));
  await user.click(await screen.findByRole('button', { name: 'Leer inventario nativo' }));
  expect(screen.getByLabelText('Contenido Markdown')).toHaveValue(changed);
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByText(/cercada sin aplicar cambios/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeEnabled();
  expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('Modificar skill con evidencia');
});
it('rechaza descubrimientos con otro escritor o tokens y mantiene el bloqueo original', async () => {
  const { user } = await unknown();
  server.use(http.post(path + '/' + id + '/discover', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus',
    identity: { ...identity, writer_instance_id: '00000000-0000-4000-8000-000000000099' }, state: 'pending', operation_id: operationId })));
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/otro destino o runtime/);
  expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeDisabled();
  server.use(http.post(path + '/' + id + '/discover', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', identity,
    state: 'pending', operation_id: operationId, operation_token: 'PRIVATE_SENTINEL' })));
  await user.click(screen.getByRole('button', { name: 'Verificar operación nativa pendiente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/incompatible/);
  expect(screen.queryByText('PRIVATE_SENTINEL')).toBeNull();
});
it('acredita nuevo escritor con generation igual y reconocimiento ligado a ese escritor sin inferir adopción de sesión', async () => {
  const nextIdentity = { ...identity, writer_instance_id: '00000000-0000-4000-8000-000000000098' };
  const reload = vi.fn(async () => {
    server.use(http.get(path + '/' + id, () => HttpResponse.json({ ...piece(changed, 'b'.repeat(64)), identity: nextIdentity })),
      http.post(path + '/' + id + '/recognize', () => HttpResponse.json({ tenant_id: 'Steven', alias: 'zeus', identity: nextIdentity,
        outcome: { type: 'recognition', kind: 'skill', id, sha: 'b'.repeat(64), state: 'available_for_new_session', reason: 'provider_read_verified' } })));
  });
  const { user } = await open(true, reload);
  server.use(http.put(path + '/' + id, () => HttpResponse.json(saved(), { status: 202 })),
    http.get(path + '/' + id, () => HttpResponse.json(piece(changed, 'b'.repeat(64)))));
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' })); await screen.findByText(/Guardado con respaldo privado/);
  await user.click(screen.getByRole('button', { name: 'Reiniciar este agente y verificar archivos' }));
  expect(await screen.findByText(/nuevo escritor y archivo exacto reconocido/)).toHaveTextContent(/adopción por una sesión sigue pendiente/);
  expect(reload).toHaveBeenCalledOnce();
});
