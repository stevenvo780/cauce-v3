import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpaceBackup } from '../../api/client/space-backups-client';
import { ApiError } from '../../api/client/core';
import type { ConsoleAuthState } from '../../api/types';
import { ApiProvider } from '../../api/context';
import { renderWithApi, testApi } from '../../test/render';
import { CompanySessionProvider } from '../auth/company-session';
import { SpaceBackupPanel } from './SpaceBackupPanel';
import { canBackupSpace } from './space-backup-authority';

const state = { authenticated: true, subject: 'owner@example.test', home_tenant: 'One', authority: { role: 'company_owner', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } } satisfies ConsoleAuthState;
const pending: SpaceBackup = { id: '00000000-0000-4000-8000-000000000050', company_id: 'one', tenant_id: 'One', alias: 'agent',
  status: 'pending', sha256: null, manifest_sha256: null, bytes: null, error: null, download_url: null };
const ready: SpaceBackup = { ...pending, status: 'ready', sha256: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64), bytes: 22,
  download_url: `/v3/console/spaces/One/agent/backups/${pending.id}/download` };
const createUrl = vi.fn(() => 'blob:backup'); const revokeUrl = vi.fn();
function panel(session: ConsoleAuthState = state) { return <CompanySessionProvider state={session}><SpaceBackupPanel tenantId="One" alias="agent" /></CompanySessionProvider>; }
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); });
it('muestra pending y permite descargar únicamente ready después de releer el estado', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue(pending); vi.spyOn(testApi, 'getSpaceBackup').mockResolvedValue(ready);
  const blob = new Blob(['zip'], { type: 'application/zip' }); const download = vi.spyOn(testApi, 'downloadSpaceBackup').mockResolvedValue(blob);
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByText('Backup pendiente')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado del backup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descargar backup ZIP' }));
  expect(await screen.findByText(/Descarga preparada/u)).toBeVisible(); expect(download).toHaveBeenCalledWith(ready, expect.any(AbortSignal));
  expect(createUrl).toHaveBeenCalledWith(blob); await waitFor(() => { expect(revokeUrl).toHaveBeenCalledWith('blob:backup'); });
});
it('conserva idempotency_key tras una respuesta incierta y genera otra sólo para un nuevo backup', async () => {
  const create = vi.spyOn(testApi, 'createSpaceBackup').mockRejectedValueOnce(new Error('PRIVATE_PATH')).mockResolvedValue(ready);
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('PRIVATE_PATH');
  fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' })); await screen.findByText('Backup disponible');
  expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Crear otro backup' })); await waitFor(() => { expect(create).toHaveBeenCalledTimes(3); });
  expect(create.mock.calls[2]?.[1]).not.toBe(create.mock.calls[1]?.[1]);
});
it('error failed no ofrece descarga y una denegación al descargar retira el receipt disponible', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue({ ...pending, status: 'failed', error: 'EXPIRED' });
  const read = vi.spyOn(testApi, 'getSpaceBackup').mockResolvedValue(ready);
  vi.spyOn(testApi, 'downloadSpaceBackup').mockRejectedValue(new ApiError('PRIVATE_PERMISSION', 403, 'forbidden'));
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('El backup venció'); expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado del backup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descargar backup ZIP' })); await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
  }); expect(read).toHaveBeenCalledOnce(); expect(createUrl).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('PRIVATE_PERMISSION');
});
it('cambiar de empresa durante la descarga aborta el cuerpo y no crea URL local del archivo anterior', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue(ready); let release: ((blob: Blob) => void) | undefined; let signal: AbortSignal | undefined;
  vi.spyOn(testApi, 'downloadSpaceBackup').mockImplementation(async (_backup, value) => { signal = value; return new Promise<Blob>(resolve => { release = resolve; }); });
  const view = renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descargar backup ZIP' }));
  view.rerender(<ApiProvider api={testApi}>{panel({ ...state, authority: { ...state.authority, acting_company: 'other' } })}</ApiProvider>);
  expect(signal?.aborted).toBe(true); await act(async () => { release?.(new Blob(['private'], { type: 'application/zip' })); });
  expect(createUrl).not.toHaveBeenCalled(); expect(screen.queryByText('Backup disponible')).not.toBeInTheDocument();
});
it('consulta la operación pendiente y detiene el sondeo al llegar a ready', async () => {
  vi.useFakeTimers(); vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue(pending); const read = vi.spyOn(testApi, 'getSpaceBackup').mockResolvedValue(ready);
  renderWithApi(panel()); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); expect(read).toHaveBeenCalledOnce();
  expect(screen.getByText('Backup disponible')).toBeVisible(); await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(read).toHaveBeenCalledOnce();
});
it('reader no crea backups y tenant_operator sólo habilita su tenant acreditado por sesión', () => {
  const reader = { ...state, authority: { ...state.authority, role: 'reader' as const } };
  const view = renderWithApi(panel(reader)); expect(screen.getByRole('button', { name: 'Crear backup del espacio' })).toBeDisabled();
  const operator = { ...state, subject: 'operator@example.test', authority: { ...state.authority, role: 'tenant_operator' as const, scope: 'tenant' as const } };
  expect(canBackupSpace(operator, 'One')).toBe(true); expect(canBackupSpace(operator, 'Other')).toBe(false);
  expect(canBackupSpace({ ...operator, home_tenant: undefined }, 'One')).toBe(false);
  expect(canBackupSpace({ ...operator, home_tenant: 'Other' }, 'One')).toBe(false);
  expect(canBackupSpace({ ...operator, home_tenant: undefined, subject: 'One:operator' }, 'One')).toBe(false);
  view.rerender(<ApiProvider api={testApi}>{panel(operator)}</ApiProvider>);
  expect(screen.getByRole('button', { name: 'Crear backup del espacio' })).toBeEnabled();
  view.rerender(<ApiProvider api={testApi}>{panel({ ...operator, home_tenant: undefined })}</ApiProvider>);
  expect(screen.getByRole('button', { name: 'Crear backup del espacio' })).toBeDisabled();
});
it('explica el límite de tamaño sin ofrecer una descarga parcial', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue({ ...pending, status: 'failed', error: 'LIMIT_EXCEEDED' });
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se creó una copia incompleta');
  expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
});
it('running con hashes aún no permite descargar el ZIP', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue({ ...ready, status: 'running', download_url: null });
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByText('Preparando backup')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
});
