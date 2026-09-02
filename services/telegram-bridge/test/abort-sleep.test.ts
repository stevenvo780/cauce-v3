import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { sleep } from '../src/abort-sleep.js';

describe('sleep', () => {
  it('removes its abort listener once the timeout resolves it', async () => {
    const controller = new AbortController();
    await sleep(5, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('resolves early and removes its listener when the signal aborts first', async () => {
    const controller = new AbortController();
    const pending = sleep(30_000, controller.signal);
    controller.abort();
    await pending;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not accumulate abort listeners across a poller-shaped loop on one long-lived signal', async () => {
    const controller = new AbortController();
    for (let iteration = 0; iteration < 50; iteration += 1) {
      await sleep(1, controller.signal);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
