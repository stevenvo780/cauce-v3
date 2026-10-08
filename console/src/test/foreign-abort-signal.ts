/** setup.ts swaps in Node's AbortController, whose signal jsdom's addEventListener refuses; Base UI's
 * context menu passes one for its mouseup listener, so the signal is honoured by hand. */
if (typeof EventTarget !== 'undefined') {
  const add = Reflect.get(EventTarget.prototype, 'addEventListener');
  EventTarget.prototype.addEventListener = function addWithForeignSignal(
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions,
  ): void {
    try {
      add.call(this, type, listener, options);
    } catch (error) {
      if (typeof options !== 'object' || options.signal === undefined) throw error;
      const { signal, ...rest } = options;
      if (signal.aborted) return;
      add.call(this, type, listener, rest);
      signal.addEventListener('abort', () => { this.removeEventListener(type, listener, rest); }, { once: true });
    }
  };
}
