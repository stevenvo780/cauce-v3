import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSelectedMedia } from './chat-selected-media';

afterEach(() => { vi.restoreAllMocks(); });

function installObjectUrls() {
  const create = vi.fn().mockReturnValue('blob:preview');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  return { create, revoke };
}

it('crea una miniatura para PNG y revoca el object URL al desmontar', () => {
  const { create, revoke } = installObjectUrls();
  const view = render(<ul><ChatSelectedMedia file={new File(['png'], 'foto.png', { type: 'image/png' })} disabled={false} onRemove={vi.fn()} /></ul>);
  expect(create).toHaveBeenCalledOnce();
  expect(view.container.querySelector('img')).toHaveAttribute('src', 'blob:preview');
  view.unmount();
  expect(revoke).toHaveBeenCalledWith('blob:preview');
});

it('previsualiza video y audio con controles manuales y sin autoplay', () => {
  installObjectUrls();
  render(<ul>
    <ChatSelectedMedia file={new File(['v'], 'clip.mp4', { type: 'video/mp4' })} disabled={false} onRemove={vi.fn()} />
    <ChatSelectedMedia file={new File(['a'], 'voz.ogg', { type: 'audio/ogg' })} disabled={false} onRemove={vi.fn()} />
  </ul>);
  expect(screen.getByLabelText('Vista previa de clip.mp4')).toHaveAttribute('controls');
  expect(screen.getByLabelText('Vista previa de clip.mp4')).not.toHaveAttribute('autoplay');
  expect(screen.getByLabelText('Vista previa de voz.ogg')).toHaveAttribute('controls');
  expect(screen.getByLabelText('Vista previa de voz.ogg')).not.toHaveAttribute('autoplay');
});

it('no monta SVG en una imagen ejecutable y permite quitar el archivo de forma explícita', () => {
  const { create } = installObjectUrls();
  const onRemove = vi.fn();
  render(<ul><ChatSelectedMedia file={new File(['<svg/>'], 'dibujo.svg', { type: 'image/svg+xml' })} disabled={false} onRemove={onRemove} /></ul>);
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Quitar dibujo.svg' }));
  expect(onRemove).toHaveBeenCalledOnce();
});
