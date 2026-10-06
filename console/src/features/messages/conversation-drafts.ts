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
  get(key: string) { return this.drafts.get(key) ?? EMPTY_DRAFT; }
  update(key: string, update: DraftUpdate) {
    this.drafts.set(key, update(this.get(key)));
    this.listeners.forEach((listener) => { listener(); });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

export const ConversationDrafts = createContext<ConversationDraftStore | undefined>(undefined);

export function useConversationDraft(key: string) {
  const shared = useContext(ConversationDrafts);
  const [local] = useState(() => new ConversationDraftStore());
  const store = shared ?? local;
  const get = useCallback(() => store.get(key), [store, key]);
  const draft = useSyncExternalStore(store.subscribe, get, get);
  const update = useCallback((next: DraftUpdate) => { store.update(key, next); }, [store, key]);
  return [draft, update] as const;
}
