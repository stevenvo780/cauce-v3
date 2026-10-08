import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CauceApi } from '../../api/client';
import { ApiError } from '../../api/client/core';
import { ApiProvider } from '../../api/context';
import type { ClientConnection, ClientConnectionsPage } from '../../api/types/client-delegations';
import { ClientConnectionsPanel } from './ClientConnectionsPanel';

const firstRef = 'a'.repeat(64), secondRef = 'b'.repeat(64);
const binding = '11111111-1111-4111-8111-111111111111';
const newBinding = '22222222-2222-4222-8222-222222222222';
function row(reference = firstRef): ClientConnection {
  return { connection_ref: reference, client_id: 'https://chatgpt.com/oauth/client.json',
    created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked: false,
    binding_id: null, label: null, display_label: null, basis: 'owner_declared_grant', instance: 'unknown',
    last_publication_at: null, last_use_at: null, last_use_observed: false };
}
function fixture(page: ClientConnectionsPage = { items: [row(), row(secondRef)], truncated: false }) {
  const api = new CauceApi('http://localhost');
  const list = vi.spyOn(api, 'listClientConnections').mockResolvedValue(page);
  const create = vi.spyOn(api, 'createClientDeclaration').mockImplementation(async input => ({ ...awaitableResult(),
    connection_ref: input.connection_ref, label: input.label, display_label: `${input.label} por cuenta de Steven` }));
  const rename = vi.spyOn(api, 'renameClientDeclaration').mockImplementation(async (_id, input) => ({ ...awaitableResult(),
    binding_id: newBinding, label: input.label, display_label: `${input.label} por cuenta de Steven` }));
  const revoke = vi.spyOn(api, 'revokeClientDeclaration').mockImplementation(async bindingId => ({ ...awaitableResult(),
    binding_id: bindingId, label: 'Dots 2', display_label: 'Dots 2 por cuenta de Steven', revoked: true }));
  const mount = (key = 'owner-a') => <ApiProvider api={api}><ClientConnectionsPanel key={key} active disabled={false} /></ApiProvider>;
  const view = render(mount());
  return { api, list, create, rename, revoke, mount, ...view };
}
function awaitableResult() {
  return { binding_id: binding, connection_ref: firstRef, owner_human_id: binding, owner_tenant_id: 'Steven', label: 'Dots',
    display_label: 'Dots por cuenta de Steven', basis: 'owner_declared_grant' as const, instance: 'unknown' as const, revoked: false };
}
async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  await screen.findAllByRole('radio');
  return user;
}
async function select(user: ReturnType<typeof userEvent.setup>, position = 0) {
  await user.click(screen.getAllByRole('radio')[position]);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('distinguishes two grants for one client and never declares or selects implicitly', async () => {
  const f = fixture(); const user = await open();
  expect(screen.getByText(firstRef)).toBeVisible(); expect(screen.getByText(secondRef)).toBeVisible();
  expect(screen.getAllByText(row().client_id)).toHaveLength(2);
  for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  expect(f.create).not.toHaveBeenCalled();
  await select(user, 1);
  expect(screen.getByRole('textbox', { name: 'Etiqueta declarada' })).toHaveValue('Dots');
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await waitFor(() => { expect(f.list).toHaveBeenCalledTimes(2); });
  expect(f.create.mock.calls[0][0]).toMatchObject({ connection_ref: secondRef, label: 'Dots' });
  expect(f.create.mock.calls[0][0].request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('drops an old selected reference after a truncated reload without selecting any replacement', async () => {
  const f = fixture(); const user = await open(); await select(user);
  f.list.mockResolvedValue({ items: Array.from({ length: 100 }, (_, i) => row(i.toString(16).padStart(64, '0'))), truncated: true });
  await user.click(screen.getByRole('button', { name: 'Recargar conexiones' }));
  await screen.findByText(/Lista limitada a 100/);
  expect(screen.getAllByRole('radio')).toHaveLength(100);
  for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  expect(screen.queryByRole('button', { name: 'Guardar declaración' })).toBeNull();
  expect(f.create).not.toHaveBeenCalled();
});

it('escapes hostile stored labels and rejects hostile input before writing', async () => {
  const f = fixture({ items: [{ ...row(), display_label: '<img src=x onerror=alert(1)>' }], truncated: false });
  const user = await open();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(document.querySelector('[data-client-connections] img')).toBeNull();
  await select(user);
  await user.clear(screen.getByRole('textbox', { name: 'Etiqueta declarada' }));
  await user.type(screen.getByRole('textbox', { name: 'Etiqueta declarada' }), '<script>');
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  expect(screen.getByRole('alert')).toHaveTextContent('etiqueta ASCII'); expect(f.create).not.toHaveBeenCalled();
});

it('shows grant expiry and does not permit declaring an expired or revoked grant', async () => {
  const f = fixture({ items: [{ ...row(), expires_at: '2000-01-01T00:00:00Z' }, { ...row(secondRef), revoked: true }], truncated: false });
  const user = await open(); expect(screen.getByText('2000-01-01T00:00:00Z')).toBeVisible();
  await select(user); expect(screen.getByRole('button', { name: 'Guardar declaración' })).toBeDisabled();
  await select(user, 1); expect(screen.getByRole('button', { name: 'Guardar declaración' })).toBeDisabled();
  expect(f.create).not.toHaveBeenCalled();
});

it('rechecks expiry at submit even when a previously enabled form has not rerendered', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const f = fixture({ items: [{ ...row(), expires_at: new Date(2000).toISOString() }], truncated: false });
  const user = await open(); await select(user);
  const submit = screen.getByRole('button', { name: 'Guardar declaración' });
  expect(submit).toBeEnabled(); clock.mockReturnValue(2000);
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('conexión vigente');
  expect(f.create).not.toHaveBeenCalled();
});

it('replays an uncertain command with the same key after expiry rather than validating it as a fresh declaration', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const f = fixture({ items: [{ ...row(), expires_at: new Date(2000).toISOString() }], truncated: false });
  const user = await open(); await select(user);
  f.create.mockRejectedValueOnce(new TypeError('Lost response'));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('alert'); const original = f.create.mock.calls[0][0];
  clock.mockReturnValue(2000);
  await user.click(screen.getByRole('button', { name: 'Reintentar mismo intento' }));
  await waitFor(() => { expect(f.create).toHaveBeenCalledTimes(2); });
  expect(f.create.mock.calls[1][0]).toBe(original);
});

it('guards duplicate clicks synchronously while the mutation is unresolved', async () => {
  const f = fixture(); const user = await open(); await select(user);
  const response = deferred<ReturnType<typeof awaitableResult>>(); f.create.mockReturnValue(response.promise);
  const button = screen.getByRole('button', { name: 'Guardar declaración' });
  fireEvent.click(button); fireEvent.click(button);
  expect(f.create).toHaveBeenCalledOnce();
  await act(async () => { response.resolve(awaitableResult()); await response.promise; });
});

it('keeps the same request key and body after a lost response and Escape/reopen', async () => {
  const f = fixture(); const user = await open(); await select(user);
  f.create.mockRejectedValueOnce(new TypeError('Lost response'));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('button', { name: 'Reintentar mismo intento' });
  const original = f.create.mock.calls[0][0];
  expect(screen.queryByRole('textbox', { name: 'Etiqueta declarada' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Conexiones MCP' })).toHaveFocus();
  await open();
  await user.click(screen.getByRole('button', { name: 'Reintentar mismo intento' }));
  await waitFor(() => { expect(f.create).toHaveBeenCalledTimes(2); });
  expect(f.create.mock.calls[1][0]).toBe(original);
});

it('stops on 409 and requires manual reload instead of auto-retrying a fresh key', async () => {
  const f = fixture(); const user = await open(); await select(user);
  f.create.mockRejectedValue(new ApiError('conflict', 409));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByText(/La declaración cambió/);
  expect(f.create).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Reintentar mismo intento' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Guardar declaración' })).toBeNull();
});

it.each([401, 403, 404])('represents HTTP %s without a fallback target or new mutation', async status => {
  const f = fixture(); const user = await open(); await select(user); f.create.mockRejectedValue(new ApiError('fixture', status));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('alert'); expect(f.create).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Guardar declaración' })).toBeNull();
});

it('keeps write success separate from reload failure and never sends the write again', async () => {
  const f = fixture(); const user = await open(); await select(user);
  f.list.mockRejectedValueOnce(new Error('Reload failed'));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByText(/Declaración guardada/); expect(screen.getByRole('alert')).toHaveTextContent('Reload failed');
  expect(screen.queryByRole('button', { name: 'Reintentar mismo intento' })).toBeNull();
  f.list.mockResolvedValue({ items: [{ ...row(), binding_id: binding, label: 'Dots' }], truncated: false });
  await user.click(screen.getByRole('button', { name: 'Recargar conexiones' }));
  await screen.findByRole('button', { name: 'Renombrar declaración' }); expect(f.create).toHaveBeenCalledOnce();
});

it('uses the reloaded binding after rename and does not treat declaration revocation as grant revocation', async () => {
  const f = fixture({ items: [{ ...row(), binding_id: binding, label: 'Dots' }], truncated: false });
  const user = await open(); await select(user);
  f.list.mockResolvedValue({ items: [{ ...row(), binding_id: newBinding, label: 'Dots 2', display_label: 'Dots 2' }], truncated: false });
  await user.clear(screen.getByRole('textbox', { name: 'Etiqueta declarada' }));
  await user.type(screen.getByRole('textbox', { name: 'Etiqueta declarada' }), 'Dots 2');
  await user.click(screen.getByRole('button', { name: 'Renombrar declaración' }));
  await waitFor(() => { expect(f.list).toHaveBeenCalledTimes(2); });
  f.list.mockResolvedValue({ items: [row()], truncated: false });
  await user.click(await screen.findByRole('button', { name: 'Quitar declaración' }));
  await screen.findByRole('button', { name: 'Guardar declaración' });
  expect(f.rename.mock.calls[0][0]).toBe(binding); expect(f.revoke.mock.calls[0][0]).toBe(newBinding);
  expect(Object.keys(f.revoke.mock.calls[0][1])).toEqual(['request_id']);
  expect(f.revoke.mock.calls[0][1].request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(screen.getByText('Grant vigente según expiración')).toBeVisible();
});

it('discards a late list from the old account', async () => {
  const f = fixture(); const response = deferred<ClientConnectionsPage>(); f.list.mockReturnValueOnce(response.promise);
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  f.rerender(f.mount('owner-b')); await open();
  await act(async () => { response.resolve({ items: [row('c'.repeat(64))], truncated: false }); await response.promise; });
  expect(screen.queryByText('c'.repeat(64))).toBeNull(); expect(screen.getByText(firstRef)).toBeVisible();
});

it('discards a late mutation result from the old account without reloading it', async () => {
  const f = fixture(); const user = await open(); await select(user);
  const response = deferred<ReturnType<typeof awaitableResult>>(); f.create.mockReturnValueOnce(response.promise);
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  f.rerender(f.mount('owner-b')); await open(); const loads = f.list.mock.calls.length;
  await act(async () => { response.resolve(awaitableResult()); await response.promise; });
  expect(screen.queryByText(/Declaración guardada/)).toBeNull(); expect(f.list).toHaveBeenCalledTimes(loads);
});

it('bounds mobile scrolling, wraps complete refs and returns focus with Escape', async () => {
  fixture(); const user = await open();
  expect(screen.getByRole('heading', { name: 'Declaraciones de cliente' })).toHaveFocus();
  // The panel scrolls on its own and never lets a long reference widen the popover.
  const body = screen.getByRole('region');
  expect(body.className).toContain('max-[760px]:max-h-[45dvh]');
  expect(body.className).toContain('overflow-y-auto');
  expect(body.className).toContain('[overflow-wrap:anywhere]');
  await user.keyboard('{Escape}'); expect(screen.queryByRole('region')).toBeNull();
  expect(screen.getByRole('button', { name: 'Conexiones MCP' })).toHaveFocus();
});


it('pastes one verified reference among 100 grants sharing the same client without a fallback', async () => {
  const items = Array.from({ length: 100 }, (_, i) => row(i.toString(16).padStart(64, '0')));
  const f = fixture({ items, truncated: true }); const user = await open();
  const input = screen.getByRole('textbox', { name: 'connection_ref verificada' });
  await user.click(input); await user.paste(items[99].connection_ref);
  expect(screen.getAllByRole('radio').filter(radio => (radio as HTMLInputElement).checked)).toHaveLength(1);
  expect(screen.getAllByRole('radio')[99]).toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByText(/Declaración guardada/);
  expect(f.create.mock.calls[0][0].connection_ref).toBe(items[99].connection_ref);
});
it.each([
  ['invalid', false, 'exactamente'], [firstRef.toUpperCase(), false, 'exactamente'], [` ${firstRef}`, false, 'exactamente'],
  ['c'.repeat(64), false, 'no se encontró'], ['c'.repeat(64), true, '100 conexiones'],
])('clears the selected grant when pasted ref %s is invalid or absent (truncated=%s)', async (reference, truncated, message) => {
  const f = fixture({ items: [row()], truncated }); const user = await open(); await select(user);
  fireEvent.change(screen.getByRole('textbox', { name: 'connection_ref verificada' }), { target: { value: reference } });
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('radio')).not.toBeChecked();
  expect(screen.queryByRole('button', { name: 'Guardar declaración' })).toBeNull();
  expect(f.create).not.toHaveBeenCalled();
});
it('refuses duplicate exact references without checking both radios or choosing a replacement', async () => {
  fixture({ items: [row(), row()], truncated: false }); await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'connection_ref verificada' }), { target: { value: firstRef } });
  expect(screen.getByRole('alert')).toHaveTextContent('ambigua');
  for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
});
it.each([{}, { ...awaitableResult(), connection_ref: secondRef }, { ...awaitableResult(), revoked: true },
  { ...awaitableResult(), label: 'Other', display_label: 'Other por cuenta de Steven' }])('reloads authority after ambiguous 2xx %j without inventing success and preserves exact retry', async result => {
  const f = fixture(); const user = await open(); await select(user);
  f.create.mockResolvedValueOnce(result as ReturnType<typeof awaitableResult>);
  f.list.mockResolvedValue({ items: [{ ...row(), binding_id: newBinding, label: 'Actual', display_label: 'Actual por cuenta de Steven' }], truncated: false });
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('alert'); await waitFor(() => { expect(f.list).toHaveBeenCalledTimes(2); });
  expect(screen.queryByText(/Declaración guardada/)).toBeNull();
  expect(screen.getByText('Actual por cuenta de Steven')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Renombrar declaración' })).toBeNull();
  const original = f.create.mock.calls[0][0];
  await user.click(screen.getByRole('button', { name: 'Reintentar mismo intento' }));
  await screen.findByText(/Declaración guardada/);
  expect(f.create.mock.calls[1][0]).toBe(original);
});
it('requires an authoritative reload before replaying an ambiguous 2xx when automatic reload fails', async () => {
  const f = fixture(); const user = await open(); await select(user);
  f.create.mockResolvedValueOnce({} as ReturnType<typeof awaitableResult>);
  f.list.mockRejectedValueOnce(new Error('Reload failed'));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Reintentar mismo intento' })).toBeDisabled();
  expect(screen.queryByText(/Declaración guardada/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Recargar conexiones' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Reintentar mismo intento' })).toBeEnabled(); });
  expect(f.create).toHaveBeenCalledOnce();
});
