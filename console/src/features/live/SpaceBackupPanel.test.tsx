import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpaceBackup } from '../../api/client/space-backups-client';
import type { ConsoleAuthState } from '../../api/types';
import { ApiError } from '../../api/client/core';
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
let clicked: string[] = [];
function panel(session: ConsoleAuthState = state) { return <CompanySessionProvider state={session}><SpaceBackupPanel tenantId="One" alias="agent" /></CompanySessionProvider>; }
beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href); });
});
afterEach(() => { vi.useRealTimers(); });
it('muestra pending y permite descargar únicamente ready después de releer el estado', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue(pending); vi.spyOn(testApi, 'getSpaceBackup').mockResolvedValue(ready);
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByText('Backup pendiente')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado del backup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descargar backup ZIP' }));
  expect(await screen.findByText(/Descarga iniciada/u)).toBeVisible(); expect(screen.getByText(ready.sha256 ?? '')).toBeVisible();
  expect(clicked).toHaveLength(1); expect(clicked[0]).toContain(`/backups/${pending.id}/download`);
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
it('error failed no ofrece descarga hasta que una relectura devuelve ready', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue({ ...pending, status: 'failed', error: 'EXPIRED' });
  const read = vi.spyOn(testApi, 'getSpaceBackup').mockResolvedValue(ready);
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('El backup venció'); expect(screen.queryByRole('button', { name: 'Descargar backup ZIP' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado del backup' }));
  expect(await screen.findByRole('button', { name: 'Descargar backup ZIP' })).toBeVisible(); expect(read).toHaveBeenCalledOnce(); expect(clicked).toHaveLength(0);
});
it('un backup de 100 MiB se muestra y se descarga por enlace', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue({ ...ready, bytes: 100 * 1024 * 1024 });
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByText(/100\.00 MiB/u)).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Descargar backup ZIP' }));
  expect(clicked).toHaveLength(1);
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
it('avisa de lo que no viaja y cómo comparar el SHA-256 sin decir descargado antes de pulsar', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockResolvedValue(ready);
  renderWithApi(panel());
  const panelText = screen.getByLabelText('Backup del espacio');
  expect(panelText).toHaveTextContent(/sin \.git: los commits sin publicar no viajan/u);
  expect(panelText).toHaveTextContent(/contenido que es un secreto literal/u);
  expect(panelText).toHaveTextContent(/space-manifest\.json/u);
  fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByText('sha256sum archivo.zip')).toBeVisible();
  expect(screen.getByText('shasum -a 256 archivo.zip')).toBeVisible();
  expect(screen.getByText('Get-FileHash archivo.zip -Algorithm SHA256')).toBeVisible();
  expect(document.body.textContent).not.toContain('ZIP descargado'); expect(screen.queryByText(/Descarga iniciada/u)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Descargar backup ZIP' }));
  expect(await screen.findByText(/si no aparece, la copia pudo vencer o no tienes permiso; vuelve a generarla/u)).toBeVisible();
});
it('no depende de AbortSignal.any y explica un 409 del servidor en español', async () => {
  vi.stubGlobal('AbortSignal', Object.assign(function Signal() { return undefined; }, { timeout: AbortSignal.timeout.bind(AbortSignal) }));
  try {
    vi.spyOn(testApi, 'createSpaceBackup').mockRejectedValue(new ApiError('space backup host is unavailable', 409));
    renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no tiene ejecutor disponible/u);
    expect(screen.queryByText(/space backup/u)).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});
it('explica un 404 con un mensaje específico', async () => {
  vi.spyOn(testApi, 'createSpaceBackup').mockRejectedValue(new ApiError('a placed space backup target is required', 404));
  renderWithApi(panel()); fireEvent.click(screen.getByRole('button', { name: 'Crear backup del espacio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/No se encontró el agente, su ubicación/u);
});
