import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';
import type { JobLane } from '../../api/types';

interface ConversationDraft {
  text: string;
  files: File[];
  lane: JobLane;
  roomId?: string;
  sending: boolean;
  notice?: { tone: 'success' | 'error' | 'parcial'; text: string };
}
const EMPTY_DRAFT: ConversationDraft = { text: '', files: [], lane: 'interactive', sending: false };
type DraftUpdate = (current: ConversationDraft) => ConversationDraft;

export class ConversationDraftStore {
  private drafts = new Map<string, ConversationDraft>();
  private listeners = new Set<() => void>();
  constructor(private readonly persistent = false) {}
  get(key: string, persistenceKey?: string) {
    const existing = this.drafts.get(key);
    if (existing) return existing;
    let draft = EMPTY_DRAFT;
    if (this.persistent && persistenceKey) {
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(`cauce.chat-draft.v1:${persistenceKey}`) ?? 'null');
        if (saved && typeof saved === 'object' && 'text' in saved && typeof saved.text === 'string'
          && 'lane' in saved && (saved.lane === 'interactive' || saved.lane === 'batch')
          && (!('roomId' in saved) || typeof saved.roomId === 'string')) {
          draft = { ...EMPTY_DRAFT, text: saved.text, lane: saved.lane,
            ...('roomId' in saved ? { roomId: saved.roomId as string } : {}) };
        }
      } catch { /* Storage can be unavailable in private browsing or when its quota is exhausted. */ }
    }
    this.drafts.set(key, draft);
    return draft;
  }
  update(key: string, update: DraftUpdate, persistenceKey?: string) {
    const next = update(this.get(key, persistenceKey));
    this.drafts.set(key, next);
    if (this.persistent && persistenceKey) {
      try {
        const storageKey = `cauce.chat-draft.v1:${persistenceKey}`;
        if (!next.text && !next.roomId && next.lane === 'interactive') sessionStorage.removeItem(storageKey);
        else sessionStorage.setItem(storageKey, JSON.stringify({ text: next.text, lane: next.lane, roomId: next.roomId }));
      } catch { /* Draft editing must remain available when storage is unavailable. */ }
    }
    this.listeners.forEach((listener) => { listener(); });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

export const ConversationDrafts = createContext<ConversationDraftStore | undefined>(undefined);

export function useConversationDraft(key: string, persistenceKey?: string) {
  const shared = useContext(ConversationDrafts);
  const [local] = useState(() => new ConversationDraftStore());
  const store = shared ?? local;
  const get = useCallback(() => store.get(key, persistenceKey), [store, key, persistenceKey]);
  const draft = useSyncExternalStore(store.subscribe, get, get);
  const update = useCallback((next: DraftUpdate) => { store.update(key, next, persistenceKey); }, [store, key, persistenceKey]);
  return [draft, update] as const;
}
