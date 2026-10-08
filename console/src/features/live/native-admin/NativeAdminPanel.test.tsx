import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { server } from '../../../mocks/server';
import { renderWithApi, testApi } from '../../../test/render';
import { NativeAdminPanel } from './NativeAdminPanel';
import type { NativeRead } from './client';
import { clearNativeDrafts } from './drafts';

beforeEach(() => { clearNativeDrafts(testApi); });

const path = 'http://localhost/v3/console/tenants/Steven/agents/zeus/native/skill';
const identity = { generation: 'native-generation', container_id: 'native-container', writer_instance_id: '00000000-0000-4000-8000-000000000061' };
const content = '---\nname: native-proof\ndescription: Read carefully\n---\nContent.\n';
const read = (outcome: NativeRead['outcome'], canWrite = true): NativeRead => ({ tenant_id: 'Steven', alias: 'zeus',
  harness: 'codex', kinds: ['skill', 'mcp'], can_write: canWrite, identity, outcome });
async function open() {
  const view = renderWithApi(<NativeAdminPanel tenantId="Steven" alias="zeus" permission="allowed" />);
  const details = view.container.querySelector('details'); if (!details) throw new Error('fixture details missing'); details.open = true; fireEvent(details, new Event('toggle'));
  const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Leer inventario nativo' }));
  return { user, view };
}
function routes(canWrite = true) {
  server.use(http.get(path, () => HttpResponse.json(read({ type: 'inventory', kind: 'skill', items: [{ id: 'native-proof', editable: true }], truncated: false }, canWrite))),
    http.get(path + '/native-proof', () => HttpResponse.json(read({ type: 'piece', piece: { kind: 'skill', id: 'native-proof', sha: 'a'.repeat(64), editable: true, value: { content } } }, canWrite))));
}
it('mantiene edición bloqueada cuando la autoridad medida de la API no permite escribir', async () => {
  routes(false); const { user } = await open(); await user.click(await screen.findByRole('button', { name: 'native-proof' }));
  expect(await screen.findByLabelText('Contenido Markdown')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Guardar pieza nativa' })).toBeDisabled();
});
it('conserva texto y motivo ante conflicto CAS y no acredita aplicación', async () => {
  routes(); server.use(http.put(path + '/native-proof', () => HttpResponse.json({ error: 'conflict' }, { status: 409 })));
  const { user } = await open(); await user.click(await screen.findByRole('button', { name: 'native-proof' }));
  const field = await screen.findByLabelText('Contenido Markdown'); await user.type(field, 'Draft.');
  await user.type(screen.getByLabelText('Motivo del cambio nativo'), 'Modificar skill con evidencia');
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/huella o el runtime cambió/);
  expect(field).toHaveValue(content + 'Draft.'); expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('Modificar skill con evidencia');
  expect(screen.queryByText(/Guardado con respaldo/)).toBeNull();
});
it('retiene borrador al cerrar y reabrir el panel pero lo borra al cambiar cuenta', async () => {
  routes(); const { user, view } = await open(); await user.click(await screen.findByRole('button', { name: 'native-proof' }));
  await user.type(await screen.findByLabelText('Contenido Markdown'), 'Private draft.');
  const details = view.container.querySelector('details'); if (!details) throw new Error('fixture details missing'); details.open = false; fireEvent(details, new Event('toggle'));
  details.open = true; fireEvent(details, new Event('toggle'));
  expect(await screen.findByLabelText('Contenido Markdown')).toHaveValue(content + 'Private draft.');
  await act(async () => { await testApi.logout().catch(() => undefined); });
  expect(await screen.findByLabelText('Contenido Markdown')).toHaveValue('');
});
it('exige relectura exacta tras 202 y no limpia el motivo ante recibo ajeno', async () => {
  routes(); server.use(http.put(path + '/native-proof', () => HttpResponse.json({ tenant_id: 'Other', alias: 'zeus', action: 'put', state: 'written_pending_reload', receipt: {} }, { status: 202 })));
  const { user } = await open(); await user.click(await screen.findByRole('button', { name: 'native-proof' }));
  await user.type(await screen.findByLabelText('Motivo del cambio nativo'), 'Guardar pieza con recibo claro');
  await user.click(screen.getByRole('button', { name: 'Guardar pieza nativa' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('Motivo del cambio nativo')).toHaveValue('Guardar pieza con recibo claro');
  expect(screen.queryByText(/Guardado con respaldo/)).toBeNull();
});
