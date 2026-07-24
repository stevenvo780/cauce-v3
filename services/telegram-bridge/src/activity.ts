import { validTelegramChatId, validTelegramMessageId } from './telegram.js';
import type { TelegramApi, TelegramReactionEmoji } from './types.js';

export interface TelegramActivityTarget {
  alias: string;
  api: TelegramApi;
  chatId: string;
  messageId: string;
}

export type TelegramTerminalOutcome = 'done' | 'failed' | 'dead';

export interface TelegramActivity {
  begin(target: TelegramActivityTarget): void;
  finish(target: TelegramActivityTarget, outcome: TelegramTerminalOutcome): void;
  stop(): void;
}

export interface TelegramActivityIndicatorOptions {
  typingIntervalMs?: number;
  maxLifetimeMs?: number;
  terminalTombstoneMs?: number;
}

interface ActivityState {
  readonly key: string;
  readonly chatKey: string;
  readonly target: TelegramActivityTarget;
  readonly controller: AbortController;
  reactionTail: Promise<void>;
  expires: ReturnType<typeof setTimeout> | undefined;
}

interface ChatActivityState {
  readonly key: string;
  readonly api: TelegramApi;
  readonly chatId: string;
  readonly controller: AbortController;
  readonly messages: Set<string>;
  pulsePending: boolean;
  wake: (() => void) | undefined;
}

interface TerminalTombstone {
  expires: ReturnType<typeof setTimeout> | undefined;
  reactionTail: Promise<void>;
}

function validAlias(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validTarget(target: TelegramActivityTarget): boolean {
  return validAlias(target.alias) &&
    validTelegramChatId(target.chatId) &&
    validTelegramMessageId(target.messageId);
}

function messageKey(target: TelegramActivityTarget): string {
  return `${target.alias}\u0000${target.chatId}\u0000${target.messageId}`;
}

function activityChatKey(target: TelegramActivityTarget): string {
  return `${target.alias}\u0000${target.chatId}`;
}

/**
 * Human-facing Telegram activity is deliberately isolated from the durable bus.
 * Every Bot API side effect is best-effort and is never awaited by poller/egress.
 */
export class TelegramActivityIndicator implements TelegramActivity {
  private readonly typingIntervalMs: number;
  private readonly maxLifetimeMs: number;
  private readonly terminalTombstoneMs: number;
  private readonly states = new Map<string, ActivityState>();
  private readonly chats = new Map<string, ChatActivityState>();
  private readonly terminals = new Map<string, TerminalTombstone>();
  private readonly pending = new Set<Promise<void>>();
  private readonly lifecycle = new AbortController();
  private stopped = false;

  constructor(options: TelegramActivityIndicatorOptions = {}) {
    this.typingIntervalMs = options.typingIntervalMs ?? 4_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? 30 * 60_000;
    this.terminalTombstoneMs = options.terminalTombstoneMs ?? this.maxLifetimeMs;
    if (!Number.isInteger(this.typingIntervalMs) ||
        this.typingIntervalMs < 1 || this.typingIntervalMs > 5_000) {
      throw new Error('Telegram typing interval must be between 1 and 5000 milliseconds');
    }
    if (!Number.isInteger(this.maxLifetimeMs) || this.maxLifetimeMs < 1) {
      throw new Error('Telegram activity lifetime must be a positive integer');
    }
    if (!Number.isInteger(this.terminalTombstoneMs) || this.terminalTombstoneMs < 1) {
      throw new Error('Telegram terminal tombstone lifetime must be a positive integer');
    }
  }

  private invoke(call: () => Promise<void>): Promise<void> {
    return Promise.resolve().then(call).catch(() => undefined);
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task)
    );
  }

  private queueReaction(
    state: ActivityState,
    reaction: TelegramReactionEmoji,
    signal: AbortSignal
  ): void {
    const task = state.reactionTail.then(() => this.invoke(
      () => state.target.api.setMessageReaction(
        state.target.chatId,
        state.target.messageId,
        reaction,
        signal
      )
    ));
    state.reactionTail = task;
    this.track(task);
  }

  private async typingLoop(state: ChatActivityState): Promise<void> {
    while (!state.controller.signal.aborted &&
           this.chats.get(state.key) === state &&
           state.messages.size > 0) {
      const action = this.invoke(() => state.api.sendChatAction(
        state.chatId,
        'typing',
        state.controller.signal
      ));
      this.track(action);
      await action;
      await this.waitForNextTyping(state);
    }
  }

  private waitForNextTyping(state: ChatActivityState): Promise<void> {
    if (state.controller.signal.aborted) return Promise.resolve();
    if (state.pulsePending) {
      state.pulsePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.controller.signal.removeEventListener('abort', done);
        if (state.wake === done) state.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.typingIntervalMs);
      timer.unref();
      state.wake = done;
      state.controller.signal.addEventListener('abort', done, { once: true });
    });
  }

  private addToChat(state: ActivityState): void {
    const existing = this.chats.get(state.chatKey);
    if (existing) {
      existing.messages.add(state.key);
      return;
    }
    const chat: ChatActivityState = {
      key: state.chatKey,
      api: state.target.api,
      chatId: state.target.chatId,
      controller: new AbortController(),
      messages: new Set([state.key]),
      pulsePending: false,
      wake: undefined
    };
    this.chats.set(state.chatKey, chat);
    void this.typingLoop(chat);
  }

  private removeActive(state: ActivityState): void {
    if (this.states.get(state.key) !== state) return;
    this.states.delete(state.key);
    if (state.expires) clearTimeout(state.expires);
    state.controller.abort();
    const chat = this.chats.get(state.chatKey);
    if (!chat) return;
    chat.messages.delete(state.key);
    if (chat.messages.size > 0) {
      // Telegram clears typing when a response arrives; pulse immediately for work
      // that remains instead of waiting for the next four-second renewal.
      if (chat.wake) chat.wake();
      else chat.pulsePending = true;
      return;
    }
    this.chats.delete(state.chatKey);
    chat.controller.abort();
  }

  private markTerminal(stateKey: string, initialTail: Promise<void>): TerminalTombstone {
    const marker = this.terminals.get(stateKey) ?? {
      expires: undefined,
      reactionTail: initialTail
    };
    if (marker.expires) clearTimeout(marker.expires);
    const expires = setTimeout(() => {
      if (this.terminals.get(stateKey) === marker) this.terminals.delete(stateKey);
    }, this.terminalTombstoneMs);
    expires.unref();
    marker.expires = expires;
    this.terminals.set(stateKey, marker);
    return marker;
  }

  begin(target: TelegramActivityTarget): void {
    if (this.stopped || !validTarget(target)) return;
    const stateKey = messageKey(target);
    if (this.terminals.has(stateKey) || this.states.has(stateKey)) return;
    const controller = new AbortController();
    const state: ActivityState = {
      key: stateKey,
      chatKey: activityChatKey(target),
      target,
      controller,
      reactionTail: Promise.resolve(),
      expires: undefined
    };
    const expires = setTimeout(() => {
      if (this.states.get(stateKey) !== state) return;
      this.removeActive(state);
    }, this.maxLifetimeMs);
    expires.unref();
    state.expires = expires;
    this.states.set(stateKey, state);
    this.addToChat(state);
    this.queueReaction(state, '👀', controller.signal);
    this.queueReaction(state, '🤔', controller.signal);
  }

  finish(target: TelegramActivityTarget, outcome: TelegramTerminalOutcome): void {
    if (this.stopped || !validTarget(target)) return;
    const stateKey = messageKey(target);
    const state = this.states.get(stateKey);
    if (state) this.removeActive(state);
    const marker = this.markTerminal(stateKey, state?.reactionTail ?? Promise.resolve());
    const reaction: TelegramReactionEmoji = outcome === 'done' ? '👍' : '👎';
    const task = marker.reactionTail.then(() => this.invoke(
      () => target.api.setMessageReaction(
        target.chatId,
        target.messageId,
        reaction,
        this.lifecycle.signal
      )
    ));
    marker.reactionTail = task;
    this.track(task);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycle.abort();
    for (const state of this.states.values()) {
      if (state.expires) clearTimeout(state.expires);
      state.controller.abort();
    }
    for (const chat of this.chats.values()) chat.controller.abort();
    for (const marker of this.terminals.values()) {
      if (marker.expires) clearTimeout(marker.expires);
    }
    this.states.clear();
    this.chats.clear();
    this.terminals.clear();
  }

  /** Waits only for already-started API calls; it never waits for the next typing renewal. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
