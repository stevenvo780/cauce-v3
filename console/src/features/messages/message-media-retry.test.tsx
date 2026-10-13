import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../api/client/core';
import { afterEach, expect, it, vi } from 'vitest';
import type { CauceApi } from '../../api/client';
import { MessageMedia } from './message-media';
import type { AttachmentSummary } from './message-attachment-list';

afterEach(() => vi.restoreAllMocks());

function deferred<Value>() {
  const callbacks: { resolve?: (value: Value) => void; reject?: (reason: Error) => void } = {};
  const promise = new Promise<Value>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return {
    promise,
    resolve: (value: Value) => callbacks.resolve?.(value),
    reject: (reason: Error) => callbacks.reject?.(reason),
  };
}

function fixture(mediaKind: AttachmentSummary['mediaKind'], name: string, mimeType: string) {
  const getMessageAttachment = vi.fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValue(new Blob(['media'], { type: mimeType }));
  const api = { getMessageAttachment } as unknown as CauceApi;
  const urls = { createObjectURL: vi.fn(() => 'blob:media'), revokeObjectURL: vi.fn() };
  const attachment: AttachmentSummary = { attachmentIndex: 0, name, mediaKind, mimeType, image: mediaKind === 'image', size: 5 };
  return { api, attachment, getMessageAttachment, urls };
}

it('reintenta descargar una imagen cuando falló la descarga', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const { api, attachment, getMessageAttachment, urls } = fixture('image', 'photo.png', 'image/png');
  const user = userEvent.setup();
  render(<MessageMedia messageId="message-1" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Descargar' }));
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(getMessageAttachment).toHaveBeenCalledTimes(2);
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('indica renovar la sesión o pedir permiso cuando el gateway devuelve 403', async () => {
  const api = { getMessageAttachment: vi.fn().mockRejectedValue(new ApiError('read permission is required', 403, 'forbidden')) } as unknown as CauceApi;
  const attachment: AttachmentSummary = { attachmentIndex: 0, name: 'photo.png', mediaKind: 'image', mimeType: 'image/png', image: true, size: 5 };
  const urls = { createObjectURL: vi.fn(() => 'blob:media'), revokeObjectURL: vi.fn() };
  const user = userEvent.setup();
  render(<MessageMedia messageId="message-1" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Descargar' }));
  const error = await screen.findByRole('status');
  expect(error).toHaveTextContent(/Renueva tu sesión o pide permiso de lectura/u);
  expect(error.textContent).not.toContain('read permission is required');
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
});

it.each([
  { mediaKind: 'audio' as const, mimeType: 'audio/mpeg', name: 'sound.mp3', role: 'Audio: sound.mp3' },
  { mediaKind: 'video' as const, mimeType: 'video/mp4', name: 'clip.mp4', role: 'Video: clip.mp4' },
])('reintenta cargar el reproductor $mediaKind cuando falló esa acción', async ({ mediaKind, mimeType, name, role }) => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const { api, attachment, getMessageAttachment, urls } = fixture(mediaKind, name, mimeType);
  const user = userEvent.setup();
  render(<MessageMedia messageId="message-1" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(getMessageAttachment).toHaveBeenCalledTimes(2);
  expect(await screen.findByLabelText(role)).toBeInTheDocument();
  expect(click).not.toHaveBeenCalled();
});

it('mantiene la vista previa de imagen cuando esa fue la acción elegida', async () => {
  const { api, attachment, getMessageAttachment, urls } = fixture('image', 'photo.png', 'image/png');
  getMessageAttachment.mockReset().mockResolvedValue(new Blob(['media'], { type: 'image/png' }));
  const user = userEvent.setup();
  render(<MessageMedia messageId="message-1" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Vista previa' }));
  expect(await screen.findByRole('dialog', { name: 'Vista previa: photo.png' })).toBeInTheDocument();
  expect(getMessageAttachment).toHaveBeenCalledOnce();
});

it('no borra la acción nueva cuando una solicitud anterior abortada rechaza tarde', async () => {
  const first = deferred<Blob>();
  const second = deferred<Blob>();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const { api, attachment, getMessageAttachment, urls } = fixture('audio', 'sound.mp3', 'audio/mpeg');
  getMessageAttachment.mockReset()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(new Blob(['media'], { type: 'audio/mpeg' }));
  const user = userEvent.setup();
  const view = render(<MessageMedia messageId="message-1" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  view.rerender(<MessageMedia messageId="message-2" attachment={attachment} api={api} urls={urls} />);
  await user.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  await act(async () => { first.reject(new Error('aborted request')); await first.promise.catch(() => undefined); });
  await act(async () => { second.reject(new Error('current request failed')); await second.promise.catch(() => undefined); });
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(getMessageAttachment).toHaveBeenCalledTimes(3);
  expect(await screen.findByLabelText('Audio: sound.mp3')).toBeInTheDocument();
  expect(click).not.toHaveBeenCalled();
});
