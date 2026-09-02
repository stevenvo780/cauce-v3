import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { usePolling } from './use-polling';

function Probe({ reload, ms, paused }: { reload: () => void; ms: number; paused?: boolean }) {
  usePolling(reload, ms, { pausedWhile: paused });
  return null;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('calls reload once per elapsed period', () => {
  const reload = vi.fn();
  render(<Probe reload={reload} ms={1000} />);

  act(() => { vi.advanceTimersByTime(3000); });

  expect(reload).toHaveBeenCalledTimes(3);
});

it('registers no interval while paused', () => {
  const registrar = vi.spyOn(window, 'setInterval');
  const reload = vi.fn();
  render(<Probe reload={reload} ms={1000} paused />);

  act(() => { vi.advanceTimersByTime(5000); });

  expect(registrar).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it('registers no interval for a non-positive period', () => {
  const registrar = vi.spyOn(window, 'setInterval');
  const reload = vi.fn();
  const view = render(<Probe reload={reload} ms={0} />);
  view.rerender(<Probe reload={reload} ms={-1000} />);

  act(() => { vi.advanceTimersByTime(5000); });

  expect(registrar).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it('stops polling once the caller unmounts', () => {
  const reload = vi.fn();
  const view = render(<Probe reload={reload} ms={1000} />);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(reload).toHaveBeenCalledTimes(1);

  view.unmount();
  act(() => { vi.advanceTimersByTime(5000); });

  expect(reload).toHaveBeenCalledTimes(1);
});

it('starts polling when the pause is lifted', () => {
  const reload = vi.fn();
  const view = render(<Probe reload={reload} ms={1000} paused />);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(reload).not.toHaveBeenCalled();

  view.rerender(<Probe reload={reload} ms={1000} paused={false} />);
  act(() => { vi.advanceTimersByTime(2000); });

  expect(reload).toHaveBeenCalledTimes(2);
});
