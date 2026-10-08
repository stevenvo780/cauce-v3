import { expect, it, vi } from 'vitest';

it('remembers the office hint only for the current page session without durable writes', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const remove = vi.spyOn(Storage.prototype, 'removeItem');
  const current = await import('./frame');
  expect(current.hintSeen()).toBe(false);
  current.rememberHint();
  expect(current.hintSeen()).toBe(true);
  current.rememberHint();
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();

  vi.resetModules();
  const reloaded = await import('./frame');
  expect(reloaded.hintSeen()).toBe(false);
});
