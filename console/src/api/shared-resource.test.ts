import { afterEach, expect, it, vi } from 'vitest';
import { SharedResource } from './shared-resource';

afterEach(() => { vi.useRealTimers(); });

it('lee una vez para varios suscriptores, sondea mientras haya alguno y reutiliza la lectura al reabrir', async () => {
  vi.useFakeTimers();
  let value = 0; const loader = vi.fn(async () => { value += 1; return value; });
  const shared = new SharedResource(loader, 30_000);
  const first = shared.subscribe(() => undefined); const second = shared.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(shared.getSnapshot()).toMatchObject({ data: 1, loading: false });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loader).toHaveBeenCalledTimes(2);
  first(); second();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(loader).toHaveBeenCalledTimes(2);
  const again = shared.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(loader).toHaveBeenCalledTimes(3);
  again();
  const reopened = shared.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(loader).toHaveBeenCalledTimes(3);
  reopened();
});

it('una recarga pedida durante otra lectura responde con la lectura siguiente y un fallo conserva los datos', async () => {
  let release: (value: string) => void = () => undefined;
  const loader = vi.fn()
    .mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }))
    .mockResolvedValueOnce('second')
    .mockRejectedValueOnce(new Error('sin red'));
  const shared = new SharedResource<string>(loader, 30_000);
  const initial = shared.reload();
  const queued = shared.reload();
  await vi.waitFor(() => { expect(loader).toHaveBeenCalledTimes(1); });
  release('first');
  await expect(initial).resolves.toEqual({ data: 'first' });
  await expect(queued).resolves.toEqual({ data: 'second' });
  await expect(shared.reload()).resolves.toMatchObject({ error: new Error('sin red') });
  expect(shared.getSnapshot()).toMatchObject({ data: 'second', loading: false, error: new Error('sin red') });
});
