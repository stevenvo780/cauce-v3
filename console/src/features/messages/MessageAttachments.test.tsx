import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { CauceApi, cauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { MessageAttachments } from './MessageAttachments';

it('renders metadata without exposing its digest or requesting hidden media', () => {
  const fetchAttachment = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
  render(<MessageAttachments messageId="m-1" files={[{ name: 'informe.pdf', mime_type: 'application/pdf', file_size: 1_500, sha256: 'f'.repeat(64) }]} />);
  expect(screen.getByRole('list', { name: 'Archivos del mensaje' })).toBeVisible();
  expect(screen.getByText('informe.pdf')).toBeVisible();
  expect(screen.getByText('1,5 kB')).toBeVisible();
  expect(document.body.textContent).not.toContain('f'.repeat(64));
  expect(fetchAttachment).not.toHaveBeenCalled();
  fetchAttachment.mockRestore();
});

it.each([null, {}, 'unknown', [null, 3, []]])('ignores a historical unknown list without breaking the conversation: %j', (files) => {
  render(<MessageAttachments files={files} />);
  expect(screen.queryByRole('list', { name: 'Archivos del mensaje' })).not.toBeInTheDocument();
});

it('keeps incomplete historical metadata readable with its fallback', () => {
  render(<MessageAttachments files={[{ name: { invalid: true }, mime_type: null, file_size: -1 }]} />);
  expect(screen.getByText('Archivo')).toBeVisible();
  expect(screen.getByText('Tamaño no disponible')).toBeVisible();
});

it('plays audio only after an explicit request, with preload disabled', async () => {
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(new Blob(['sound'], { type: 'audio/mpeg' }));
  const urls = { createObjectURL: vi.fn(() => 'blob:audio'), revokeObjectURL: vi.fn() };
  render(<MessageAttachments messageId="message-audio" files={[{ name: 'nota.mp3', mime_type: 'audio/mpeg' }]} urls={urls} />);
  expect(getAttachment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  await waitFor(() => { expect(screen.getByLabelText('Audio: nota.mp3')).toBeInTheDocument(); });
  expect(screen.getByLabelText('Audio: nota.mp3')).toHaveAttribute('preload', 'none');
  expect(screen.getByLabelText('Audio: nota.mp3')).not.toHaveAttribute('autoplay');
  expect(getAttachment.mock.calls.at(0)?.slice(0, 2)).toEqual(['message-audio', 0]);
  expect(getAttachment.mock.calls.at(0)?.[2]?.signal).toBeInstanceOf(AbortSignal);
  getAttachment.mockRestore();
});

it('usa el índice original al filtrar adjuntos históricos nulos y revoca la URL al cerrar el mensaje', async () => {
  const urls = { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() };
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  const view = render(<MessageAttachments messageId="message-image" files={[null, { name: 'foto.png', mime_type: 'image/png' }]} urls={urls} />);
  const previewButton = screen.getByRole('button', { name: 'Vista previa' });
  previewButton.focus();
  fireEvent.click(previewButton);
  const dialog = await screen.findByRole('dialog', { name: 'Vista previa: foto.png' });
  expect(getAttachment).toHaveBeenCalledWith('message-image', 1, expect.any(Object));
  expect(screen.getByRole('button', { name: 'Ampliar imagen: foto.png' })).toBeVisible();
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Cerrar vista previa' })).toHaveFocus(); });
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Cerrar vista previa' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Vista previa' })).toHaveFocus();
  view.unmount();
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:test-image');
  getAttachment.mockRestore();
});

it('muestra el reproductor de video solo tras cargarlo y no inicia reproducción automática', async () => {
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }));
  const urls = { createObjectURL: vi.fn(() => 'blob:video'), revokeObjectURL: vi.fn() };
  render(<MessageAttachments api={cauceApi} urls={urls} messageId="message-video" files={[{ name: 'clip.mp4', mime_type: 'video/mp4' }]} />);
  expect(getAttachment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  const player = await screen.findByLabelText('Video: clip.mp4');
  expect(player).toHaveAttribute('preload', 'metadata');
  expect(player).toHaveAttribute('playsinline');
  expect(player).not.toHaveAttribute('autoplay');
  getAttachment.mockRestore();
});

it('deja reintentar tras un error y no inserta SVG en un visor', async () => {
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
  const urls = { createObjectURL: vi.fn(() => 'blob:svg'), revokeObjectURL: vi.fn() };
  render(<MessageAttachments api={cauceApi} urls={urls} messageId="message-file" files={[{ name: 'vector.svg', mime_type: 'image/png' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
  await screen.findByText('No se pudo cargar el archivo.');
  fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
  await waitFor(() => { expect(getAttachment).toHaveBeenCalledTimes(2); });
  expect(document.querySelector('img, audio, video, iframe, object, embed')).toBeNull();
  getAttachment.mockRestore();
});

it('al cambiar la sesión retira de inmediato la vista previa cargada', async () => {
  const urls = { createObjectURL: vi.fn(() => 'blob:account-image'), revokeObjectURL: vi.fn() };
  const api = new CauceApi('http://localhost', async () => Response.json({ authenticated: true, subject: 'next' }));
  const getAttachment = vi.spyOn(api, 'getMessageAttachment').mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  const view = render(<MessageAttachments api={api} urls={urls} messageId="message-image" files={[{ name: 'foto.png', mime_type: 'image/png' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Vista previa' }));
  await screen.findByRole('dialog', { name: 'Vista previa: foto.png' });
  await act(async () => { await api.login('next@example.test', 'password'); });
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:account-image');
  view.unmount();
  getAttachment.mockRestore();
});

it.each([
  { name: 'nota.mp3', mime: 'audio/mpeg', label: 'Audio: nota.mp3' },
  { name: 'clip.mp4', mime: 'video/mp4', label: 'Video: clip.mp4' },
  { name: 'foto.png', mime: 'image/png', label: 'Vista previa: foto.png' },
])('descargar $name conserva el reproductor o visor y su URL', async ({ name, mime, label }) => {
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(new Blob(['media'], { type: mime }));
  const urls = { createObjectURL: vi.fn().mockReturnValueOnce('blob:preview').mockReturnValueOnce('blob:download'), revokeObjectURL: vi.fn() };
  const view = render(<MessageAttachments messageId="media" files={[{ name, mime_type: mime }]} urls={urls} />);
  fireEvent.click(screen.getByRole('button', { name: mime.startsWith('image/') ? 'Vista previa' : 'Cargar reproductor' }));
  const preview = mime.startsWith('image/') ? await screen.findByAltText(label) : await screen.findByLabelText(label);
  expect(preview).toHaveAttribute('src', 'blob:preview');
  fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
  await waitFor(() => { expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:download'); });
  expect(preview).toBeInTheDocument();
  expect(preview).toHaveAttribute('src', 'blob:preview');
  expect(urls.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview');
  expect(getAttachment).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  getAttachment.mockRestore();
});

it('liga los bytes de respuesta a la entrega e intento efectivos y limpia al cambiar esa referencia', async () => {
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment');
  const getReplyAttachment = vi.spyOn(cauceApi, 'getMessageReplyAttachment').mockResolvedValue(new Blob(['sound'], { type: 'audio/mpeg' }));
  const urls = { createObjectURL: vi.fn(() => 'blob:reply'), revokeObjectURL: vi.fn() };
  const files = [{ name: 'respuesta.mp3', mime_type: 'audio/mpeg' }];
  const view = render(<MessageAttachments messageId="human-root" files={files} replySource={{ deliveryId: 'final-delivery', attempt: 2 }} urls={urls} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  await screen.findByLabelText('Audio: respuesta.mp3');
  expect(getReplyAttachment.mock.calls.at(0)?.slice(0, 4)).toEqual(['human-root', 'final-delivery', 2, 0]);
  expect(getAttachment).not.toHaveBeenCalled();
  view.rerender(<MessageAttachments messageId="human-root" files={files} replySource={{ deliveryId: 'next-delivery', attempt: 3 }} urls={urls} />);
  expect(screen.queryByLabelText('Audio: respuesta.mp3')).not.toBeInTheDocument();
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:reply');
  view.unmount();
  getAttachment.mockRestore();
  getReplyAttachment.mockRestore();
});

it('no descarga bytes invalidados al cambiar la referencia mientras continúa el gesto', async () => {
  const getReplyAttachment = vi.spyOn(cauceApi, 'getMessageReplyAttachment').mockResolvedValue(new Blob(['private-A'], { type: 'audio/mpeg' }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const urls = { createObjectURL: vi.fn(() => 'blob:private-A'), revokeObjectURL: vi.fn() };
  const files = [{ name: 'respuesta.mp3', mime_type: 'audio/mpeg' }];
  const view = render(<MessageAttachments messageId="root-A" files={files} replySource={{ deliveryId: 'delivery-A', attempt: 0 }} urls={urls} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cargar reproductor' }));
  await screen.findByLabelText('Audio: respuesta.mp3');
  fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
  view.rerender(<MessageAttachments messageId="root-B" files={files} replySource={{ deliveryId: 'delivery-B', attempt: 1 }} urls={urls} />);
  await act(async () => { await Promise.resolve(); });
  expect(click).not.toHaveBeenCalled();
  expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:private-A');
  expect(screen.queryByLabelText('Audio: respuesta.mp3')).not.toBeInTheDocument();
  view.unmount();
  click.mockRestore();
  getReplyAttachment.mockRestore();
});

it('usa la API del contexto y revoca la vista previa al cambiar su sesión', async () => {
  const api = new CauceApi('http://other-console.test', async () => Response.json({ authenticated: true, subject: 'next' }));
  const blob = new Blob(['private-context'], { type: 'image/png' });
  const scopedGet = vi.spyOn(api, 'getMessageAttachment').mockResolvedValue(blob);
  const defaultGet = vi.spyOn(cauceApi, 'getMessageAttachment').mockResolvedValue(blob);
  const urls = { createObjectURL: vi.fn(() => 'blob:scoped'), revokeObjectURL: vi.fn() };
  const view = render(<ApiProvider api={api}><MessageAttachments messageId="context-root" files={[{ name: 'foto.png', mime_type: 'image/png' }]} urls={urls} /></ApiProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Vista previa' }));
    await screen.findByRole('dialog', { name: 'Vista previa: foto.png' });
    expect(scopedGet).toHaveBeenCalledOnce();
    expect(defaultGet).not.toHaveBeenCalled();
    await act(async () => { await api.login('next@example.test', 'password'); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:scoped');
  } finally {
    view.unmount();
    scopedGet.mockRestore();
    defaultGet.mockRestore();
  }
});
