import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ConversationMenu } from './ConversationMenu';

function SyncMenu({ sync }: { sync: () => Promise<void> }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  async function reload() {
    setLoading(true);
    try { await sync(); } catch { setError('No se pudo actualizar la conversación'); }
    finally { setLoading(false); }
  }
  return <>
    <ConversationMenu triggerRef={triggerRef}>
      <button type="button" disabled={loading} onClick={() => { void reload(); }}>Sincronizar</button>
    </ConversationMenu>
    {error ? <p role="alert">{error}</p> : null}
    <textarea aria-label="Mensaje" />
  </>;
}

it('Escape cierra después de un fallo de sincronización aunque el botón deshabilitado haya perdido el foco', async () => {
  const user = userEvent.setup();
  let reject: () => void = () => undefined;
  const sync = vi.fn(() => new Promise<void>((_, fail) => { reject = () => { fail(new Error('sin red')); }; }));
  render(<SyncMenu sync={sync} />);
  const more = screen.getByRole('button', { name: 'Más' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await user.click(more);
    const button = screen.getByRole('button', { name: 'Sincronizar' });
    await user.click(button);
    expect(button).toBeDisabled();
    fireEvent.blur(button, { relatedTarget: null });
    await act(async () => { reject(); });
    await waitFor(() => { expect(button).toBeEnabled(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Más opciones de conversación' })).toBeNull();
    expect(more).toHaveFocus();
    expect(screen.getByRole('alert')).toBeVisible();
  }
  expect(sync).toHaveBeenCalledTimes(2);
});

it('el fallo tardío no vuelve a abrir el menú ni roba el foco del compositor', async () => {
  const user = userEvent.setup();
  let reject: () => void = () => undefined;
  render(<SyncMenu sync={() => new Promise<void>((_, fail) => { reject = () => { fail(new Error('sin red')); }; })} />);
  const more = screen.getByRole('button', { name: 'Más' });
  await user.click(more);
  const button = screen.getByRole('button', { name: 'Sincronizar' });
  await user.click(button);
  fireEvent.blur(button, { relatedTarget: null });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(more).toHaveFocus();
  const composer = screen.getByRole('textbox');
  await user.click(composer);
  await act(async () => { reject(); });
  expect(composer).toHaveFocus();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(more).toHaveAttribute('aria-expanded', 'false');
});
