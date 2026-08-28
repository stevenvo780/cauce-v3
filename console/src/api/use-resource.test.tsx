import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { useResource } from './use-resource';

it('runs at most one load concurrently and coalesces reloads into one pending load', async () => {
  let active = 0;
  let maximumActive = 0;
  const resolveLoads: (() => void)[] = [];
  const loader = vi.fn(() => new Promise<number>((resolve) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const value = loader.mock.calls.length;
    resolveLoads.push(() => {
      active -= 1;
      resolve(value);
    });
  }));

  function Probe() {
    const resource = useResource('probe', loader);
    return <><button type="button" onClick={resource.reload}>reload</button><output>{resource.data ?? 'loading'}</output></>;
  }

  render(<Probe />);
  await waitFor(() => { expect(loader).toHaveBeenCalledTimes(1); });

  fireEvent.click(screen.getByRole('button', { name: 'reload' }));
  fireEvent.click(screen.getByRole('button', { name: 'reload' }));
  fireEvent.click(screen.getByRole('button', { name: 'reload' }));
  expect(loader).toHaveBeenCalledTimes(1);
  expect(maximumActive).toBe(1);

  await act(async () => resolveLoads.shift()?.());
  await waitFor(() => { expect(loader).toHaveBeenCalledTimes(2); });
  expect(maximumActive).toBe(1);

  await act(async () => resolveLoads.shift()?.());
  expect(await screen.findByText('2')).toBeInTheDocument();
  expect(maximumActive).toBe(1);
});

it('never exposes the previous key data while the next key is still loading', async () => {
  const resolveLoads = new Map<string, (value: string) => void>();
  const loader = vi.fn((resourceKey: string) => new Promise<string>((resolve) => {
    resolveLoads.set(resourceKey, resolve);
  }));

  function Probe({ resourceKey }: { resourceKey: string }) {
    const resource = useResource(`probe-${resourceKey}`, () => loader(resourceKey));
    return (
      <output>
        {resource.loading && resource.data === undefined ? `loading-${resourceKey}` : resource.data}
      </output>
    );
  }

  const view = render(<Probe resourceKey="A" />);
  await waitFor(() => { expect(loader).toHaveBeenCalledWith('A'); });
  await act(async () => resolveLoads.get('A')?.('data-A'));
  expect(await screen.findByText('data-A')).toBeInTheDocument();

  view.rerender(<Probe resourceKey="B" />);
  expect(screen.queryByText('data-A')).not.toBeInTheDocument();
  expect(screen.getByText('loading-B')).toBeInTheDocument();

  await waitFor(() => { expect(loader).toHaveBeenCalledWith('B'); });
  expect(screen.queryByText('data-A')).not.toBeInTheDocument();
  await act(async () => resolveLoads.get('B')?.('data-B'));
  expect(await screen.findByText('data-B')).toBeInTheDocument();
});
