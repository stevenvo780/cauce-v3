import { afterEach, expect, it, vi } from 'vitest';
import { focusWritablePty } from './pty-focus';
import type { PtyEntry } from './pty-types';

afterEach(() => { document.body.replaceChildren(); });

function fixture() {
  const mount = document.createElement('div');
  mount.className = 'pty-mount';
  const container = document.createElement('div');
  mount.append(container);
  document.body.append(mount);
  vi.spyOn(mount, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const focus = vi.fn();
  const entry = { container, readOnly: false, view: { state: 'open' }, terminal: { focus } } as unknown as PtyEntry;
  return { entry, mount, container, focus };
}

it('enfoca una toma explícita sobre la terminal visible y abierta', () => {
  const { entry, focus } = fixture();
  focusWritablePty(entry);
  expect(focus).toHaveBeenCalledOnce();
});

it.each(['readonly', 'attaching', 'detached', 'hidden'] as const)('no roba foco a un formulario con la terminal %s', (state) => {
  const { entry, mount, container, focus } = fixture();
  const form = document.createElement('input');
  document.body.append(form);
  form.focus();
  if (state === 'readonly') entry.readOnly = true;
  if (state === 'attaching') entry.view.state = 'attaching';
  if (state === 'detached') document.body.append(container);
  if (state === 'hidden') vi.spyOn(mount, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
  focusWritablePty(entry);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(form);
});
